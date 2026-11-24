//! Quality gate for Yjs update bytes that reach the worker from outside.
//!
//! An update whose structs or deletions depend on clocks the receiving
//! document does not hold would integrate only partly: yrs keeps the structs
//! pending but applies the deletions at once, so a value the missing update
//! replaced disappears. The gate refuses such an update before anything is
//! applied, and the document is marked broken when an apply still leaves
//! pending state. Nothing is repaired here: the caller surfaces the error.

use std::collections::HashMap;
use std::sync::Mutex;

use yrs::block::{
    ClientID, ItemContent, BLOCK_GC_REF_NUMBER, BLOCK_SKIP_REF_NUMBER, HAS_ORIGIN, HAS_PARENT_SUB,
    HAS_RIGHT_ORIGIN,
};
use yrs::encoding::read::Read;
use yrs::updates::decoder::{Decode, Decoder, DecoderV1};
use yrs::{DeleteSet, OffsetKind, ReadTxn, StateVector, TransactionMut, Update, ID};

/// Prefix of the error string for an update that depends on missing clocks.
pub(crate) const CLOCK_GAP_ERROR: &str = "ClockGapError";
/// Prefix of the error string for a document an earlier apply left damaged.
pub(crate) const BROKEN_DOCUMENT_ERROR: &str = "BrokenDocumentError";

/// Documents whose state can no longer be trusted, with the reason.
static BROKEN_DOCUMENTS: Mutex<Option<HashMap<String, String>>> = Mutex::new(None);

fn clock_gap(document_id: &str, detail: String) -> String {
    format!("{CLOCK_GAP_ERROR}: document {document_id}: {detail}")
}

/// Refuse to touch a document an earlier apply left damaged.
pub(crate) fn assert_document_not_broken(document_id: &str) -> Result<(), String> {
    match BROKEN_DOCUMENTS
        .lock()
        .unwrap()
        .as_ref()
        .and_then(|broken| broken.get(document_id))
    {
        Some(reason) => Err(format!(
            "{BROKEN_DOCUMENT_ERROR}: document {document_id} is broken: {reason}"
        )),
        None => Ok(()),
    }
}

fn mark_document_broken(document_id: &str, reason: &str) {
    BROKEN_DOCUMENTS
        .lock()
        .unwrap()
        .get_or_insert_with(HashMap::new)
        .insert(document_id.to_string(), reason.to_string());
}

/// A document seeded again from a whole state starts clean.
pub(crate) fn clear_broken_document(document_id: &str) {
    if let Some(broken) = BROKEN_DOCUMENTS.lock().unwrap().as_mut() {
        broken.remove(document_id);
    }
}

pub(crate) fn clear_all_broken_documents() {
    *BROKEN_DOCUMENTS.lock().unwrap() = None;
}

/// Err when the document holds structs or deletions waiting for clocks it lacks.
pub(crate) fn assert_no_pending_state<T: ReadTxn>(
    txn: &T,
    document_id: &str,
) -> Result<(), String> {
    let store = txn.store();
    if let Some(pending) = store.pending_update() {
        let missing: Vec<String> = pending
            .missing
            .iter()
            .map(|(client, clock)| format!("client {client} clock {clock}"))
            .collect();
        return Err(clock_gap(
            document_id,
            format!("pending structs wait for {}", missing.join(", ")),
        ));
    }
    if store.pending_ds().is_some() {
        return Err(clock_gap(
            document_id,
            "pending deletions wait for unknown structs".to_string(),
        ));
    }
    Ok(())
}

/// Check that `update` integrates completely into the document `txn` reads:
/// every client's structs start at or below the document's clock, there is
/// no skip, every origin, right origin and parent is known or inside the
/// update, and every deleted range is known or inside the update.
pub(crate) fn assert_update_integrates<T: ReadTxn>(
    txn: &T,
    update: &[u8],
    document_id: &str,
) -> Result<(), String> {
    assert_no_pending_state(txn, document_id)?;
    let local = txn.state_vector();
    check_update_against(&local, update, document_id)
}

fn decode_error(document_id: &str, error: impl std::fmt::Debug) -> String {
    format!("update for document {document_id} does not decode: {error:?}")
}

fn check_update_against(
    local: &StateVector,
    update: &[u8],
    document_id: &str,
) -> Result<(), String> {
    let mut decoder = DecoderV1::from(update);
    let mut ranges: HashMap<ClientID, (u32, u32)> = HashMap::new();
    let mut references: Vec<ID> = Vec::new();

    let clients_len: u32 = decoder
        .read_var()
        .map_err(|error| decode_error(document_id, error))?;
    for _ in 0..clients_len {
        let blocks_len: u32 = decoder
            .read_var()
            .map_err(|error| decode_error(document_id, error))?;
        let client = decoder
            .read_client()
            .map_err(|error| decode_error(document_id, error))?;
        let start: u32 = decoder
            .read_var()
            .map_err(|error| decode_error(document_id, error))?;
        let mut clock = start;
        for _ in 0..blocks_len {
            let info = decoder
                .read_info()
                .map_err(|error| decode_error(document_id, error))?;
            match info {
                BLOCK_SKIP_REF_NUMBER => {
                    return Err(clock_gap(
                        document_id,
                        format!("update skips clocks of client {client} at {clock}"),
                    ));
                }
                BLOCK_GC_REF_NUMBER => {
                    clock += decoder
                        .read_len()
                        .map_err(|error| decode_error(document_id, error))?;
                }
                info => {
                    let cant_copy_parent_info = info & (HAS_ORIGIN | HAS_RIGHT_ORIGIN) == 0;
                    if info & HAS_ORIGIN != 0 {
                        references.push(
                            decoder
                                .read_left_id()
                                .map_err(|error| decode_error(document_id, error))?,
                        );
                    }
                    if info & HAS_RIGHT_ORIGIN != 0 {
                        references.push(
                            decoder
                                .read_right_id()
                                .map_err(|error| decode_error(document_id, error))?,
                        );
                    }
                    if cant_copy_parent_info {
                        let named_parent = decoder
                            .read_parent_info()
                            .map_err(|error| decode_error(document_id, error))?;
                        if named_parent {
                            decoder
                                .read_string()
                                .map_err(|error| decode_error(document_id, error))?;
                        } else {
                            references.push(
                                decoder
                                    .read_left_id()
                                    .map_err(|error| decode_error(document_id, error))?,
                            );
                        }
                        if info & HAS_PARENT_SUB != 0 {
                            decoder
                                .read_string()
                                .map_err(|error| decode_error(document_id, error))?;
                        }
                    }
                    let content = ItemContent::decode(&mut decoder, info)
                        .map_err(|error| decode_error(document_id, error))?;
                    clock += content.len(OffsetKind::Utf16) as u32;
                }
            }
        }
        if clock == start {
            continue;
        }
        let have = local.get(&client);
        if start > have {
            return Err(clock_gap(
                document_id,
                format!("client {client} needs clock {start}, have {have}"),
            ));
        }
        let entry = ranges.entry(client).or_insert((start, clock));
        entry.0 = entry.0.min(start);
        entry.1 = entry.1.max(clock);
    }
    let delete_set =
        DeleteSet::decode(&mut decoder).map_err(|error| decode_error(document_id, error))?;

    // Every update range starts at or below the local clock, so the clocks
    // the document will hold for a client are exactly 0..known_end.
    let known_end = |client: &ClientID| -> u32 {
        let have = local.get(client);
        ranges.get(client).map_or(have, |(_, end)| have.max(*end))
    };
    for id in references {
        if id.clock >= known_end(&id.client) {
            return Err(clock_gap(
                document_id,
                format!(
                    "update references client {} clock {}, have {}",
                    id.client,
                    id.clock,
                    known_end(&id.client)
                ),
            ));
        }
    }
    for (client, range) in delete_set.iter() {
        let end = known_end(client);
        for deleted in range.iter() {
            if deleted.end > end {
                return Err(clock_gap(
                    document_id,
                    format!(
                        "update deletes client {} clocks {}..{}, have {}",
                        client, deleted.start, deleted.end, end
                    ),
                ));
            }
        }
    }
    Ok(())
}

/// Gate, apply and verify one outside update. On a refusal before the apply
/// nothing changes; when the apply still leaves pending state the document
/// is marked broken and every later apply to it is refused.
pub(crate) fn apply_update_with_integrity(
    txn: &mut TransactionMut,
    update: &[u8],
    document_id: &str,
) -> Result<(), String> {
    assert_document_not_broken(document_id)?;
    assert_update_integrates(txn, update, document_id)?;
    let decoded = Update::decode_v1(update).map_err(|error| decode_error(document_id, error))?;
    txn.apply_update(decoded);
    if let Err(error) = assert_no_pending_state(txn, document_id) {
        mark_document_broken(document_id, &error);
        return Err(error);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use yrs::{Doc, Map, Transact};

    fn doc_with_client(client: u64) -> Doc {
        Doc::with_client_id(client)
    }

    fn set_width(doc: &Doc, width: f64) -> Vec<u8> {
        let map = doc.get_or_insert_map("layer");
        let mut txn = doc.transact_mut();
        map.insert(&mut txn, "width", width);
        txn.encode_update_v1()
    }

    #[test]
    fn a_contiguous_update_applies() {
        let author = doc_with_client(1);
        let first = set_width(&author, 500.0);
        let receiver = doc_with_client(2);
        let mut txn = receiver.transact_mut();
        apply_update_with_integrity(&mut txn, &first, "glyph:a").unwrap();
    }

    #[test]
    fn a_missed_packet_is_refused_and_the_width_survives() {
        let author = doc_with_client(11);
        let first = set_width(&author, 500.0);
        let _missed = set_width(&author, 510.0);
        let third = set_width(&author, 520.0);

        let receiver = doc_with_client(12);
        {
            let mut txn = receiver.transact_mut();
            apply_update_with_integrity(&mut txn, &first, "glyph:gap").unwrap();
        }
        let error = {
            let mut txn = receiver.transact_mut();
            apply_update_with_integrity(&mut txn, &third, "glyph:gap").unwrap_err()
        };
        assert!(error.starts_with(CLOCK_GAP_ERROR), "{error}");
        let map = receiver.get_or_insert_map("layer");
        let txn = receiver.transact();
        assert_eq!(
            map.get(&txn, "width").map(|value| value.to_string(&txn)),
            Some("500".to_string())
        );
        assert!(assert_no_pending_state(&txn, "glyph:gap").is_ok());
    }

    #[test]
    fn a_delete_only_packet_for_unknown_structs_is_refused() {
        let author = doc_with_client(21);
        let first = set_width(&author, 500.0);
        let second = set_width(&author, 510.0);
        // The third packet only deletes the width written by `second`.
        let delete_only = {
            let map = author.get_or_insert_map("layer");
            let mut txn = author.transact_mut();
            map.remove(&mut txn, "width");
            txn.encode_update_v1()
        };
        let receiver = doc_with_client(22);
        {
            let mut txn = receiver.transact_mut();
            apply_update_with_integrity(&mut txn, &first, "glyph:del").unwrap();
        }
        let error = {
            let mut txn = receiver.transact_mut();
            apply_update_with_integrity(&mut txn, &delete_only, "glyph:del").unwrap_err()
        };
        assert!(error.contains("deletes"), "{error}");
        let mut txn = receiver.transact_mut();
        apply_update_with_integrity(&mut txn, &second, "glyph:del").unwrap();
        apply_update_with_integrity(&mut txn, &delete_only, "glyph:del").unwrap();
    }

    #[test]
    fn a_packet_from_another_client_that_references_a_missed_struct_is_refused() {
        let author = doc_with_client(31);
        let first = set_width(&author, 500.0);
        let missed = set_width(&author, 510.0);
        let peer = doc_with_client(32);
        {
            let mut txn = peer.transact_mut();
            apply_update_with_integrity(&mut txn, &first, "glyph:x").unwrap();
            apply_update_with_integrity(&mut txn, &missed, "glyph:x").unwrap();
        }
        let peer_overwrite = set_width(&peer, 530.0);

        let receiver = doc_with_client(33);
        {
            let mut txn = receiver.transact_mut();
            apply_update_with_integrity(&mut txn, &first, "glyph:x").unwrap();
        }
        let error = {
            let mut txn = receiver.transact_mut();
            apply_update_with_integrity(&mut txn, &peer_overwrite, "glyph:x").unwrap_err()
        };
        assert!(error.starts_with(CLOCK_GAP_ERROR), "{error}");
        let map = receiver.get_or_insert_map("layer");
        let txn = receiver.transact();
        assert_eq!(
            map.get(&txn, "width").map(|value| value.to_string(&txn)),
            Some("500".to_string())
        );
    }

    #[test]
    fn a_broken_document_refuses_later_applies_until_cleared() {
        mark_document_broken("glyph:broken", "test");
        let author = doc_with_client(41);
        let first = set_width(&author, 500.0);
        let receiver = doc_with_client(42);
        let error = {
            let mut txn = receiver.transact_mut();
            apply_update_with_integrity(&mut txn, &first, "glyph:broken").unwrap_err()
        };
        assert!(error.starts_with(BROKEN_DOCUMENT_ERROR), "{error}");
        clear_broken_document("glyph:broken");
        let mut txn = receiver.transact_mut();
        apply_update_with_integrity(&mut txn, &first, "glyph:broken").unwrap();
    }
}
