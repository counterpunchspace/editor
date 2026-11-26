//! Surgical binary TTF table patching for live outline/width editing.
//!
//! Instead of re-running full `fontc` across the entire editing subset (rebuilding
//! `GSUB`, `GPOS`, `GDEF`, `cmap`, `fvar`, `avar`, `STAT`, `name`, `OS/2`, `post`,
//! and every untouched glyph's `glyf`/`gvar`/`hmtx`), this module splices only the
//! 1–4 dirty glyphs' `glyf`, `loca`, `gvar`, and `hmtx` records from a tiny mini-TTF
//! into the cached full-subset TTF while copying all other tables verbatim.

use std::collections::HashMap;

use read_fonts::{
    tables::variations::DeltaSetIndex,
    types::Tag,
    FontRef, TableProvider,
};
use smol_str::SmolStr;
use write_fonts::{
    tables::{
        hvar::Hvar,
        variations::{
            ivs_builder::VariationStoreBuilder, DeltaSetIndexMap, RegionAxisCoordinates,
            VariationRegion,
        },
    },
    FontBuilder,
};

const TAG_GLYF: Tag = Tag::new(b"glyf");
const TAG_LOCA: Tag = Tag::new(b"loca");
const TAG_GVAR: Tag = Tag::new(b"gvar");
const TAG_HMTX: Tag = Tag::new(b"hmtx");
const TAG_HHEA: Tag = Tag::new(b"hhea");
const TAG_HEAD: Tag = Tag::new(b"head");
const TAG_MAXP: Tag = Tag::new(b"maxp");
const TAG_HVAR: Tag = Tag::new(b"HVAR");

// Composite glyph flags (OpenType glyf specification)
const ARG_1_AND_2_ARE_WORDS: u16 = 0x0001;
const WE_HAVE_A_SCALE: u16 = 0x0008;
const MORE_COMPONENTS: u16 = 0x0020;
const WE_HAVE_AN_X_AND_Y_SCALE: u16 = 0x0040;
const WE_HAVE_A_TWO_BY_TWO: u16 = 0x0080;

// gvar TupleVariationHeader flags
const EMBEDDED_PEAK_TUPLE: u16 = 0x8000;
const INTERMEDIATE_REGION: u16 = 0x4000;
const TUPLE_INDEX_MASK: u16 = 0x0FFF;

/// Extract the glyph name order from a compiled TTF's `post` table.
pub fn extract_ttf_glyph_order(ttf_bytes: &[u8]) -> Option<Vec<SmolStr>> {
    let font = FontRef::new(ttf_bytes).ok()?;
    let num_glyphs = font.maxp().ok()?.num_glyphs() as usize;
    let post = font.post().ok()?;
    let mut order = Vec::with_capacity(num_glyphs);
    for gid in 0..num_glyphs {
        let name = post.glyph_name(read_fonts::types::GlyphId16::new(gid as u16))?;
        order.push(SmolStr::from(name));
    }
    Some(order)
}

/// Splice `dirty_glyph_names` from `mini_ttf` into `base_ttf`, copying all
/// layout/metadata tables (`GSUB`, `GPOS`, `GDEF`, `cmap`, `fvar`, `avar`,
/// `STAT`, `name`, `OS/2`, `post`, `HVAR`, `MVAR`, etc.) verbatim.
///
/// Returns `None` if any structural precondition is not met (caller falls back
/// cleanly to full `compile_filtered`).
pub fn splice_glyphs_into_ttf(
    base_ttf: &[u8],
    base_glyph_order: &[SmolStr],
    mini_ttf: &[u8],
    dirty_glyph_names: &[SmolStr],
) -> Option<Vec<u8>> {
    if dirty_glyph_names.is_empty() {
        return None;
    }

    let base_font = FontRef::new(base_ttf).ok()?;
    let mini_font = FontRef::new(mini_ttf).ok()?;

    let mini_glyph_order = extract_ttf_glyph_order(mini_ttf)?;
    let base_name_to_gid: HashMap<&str, u16> = base_glyph_order
        .iter()
        .enumerate()
        .map(|(idx, name)| (name.as_str(), idx as u16))
        .collect();
    let mini_name_to_gid: HashMap<&str, u16> = mini_glyph_order
        .iter()
        .enumerate()
        .map(|(idx, name)| (name.as_str(), idx as u16))
        .collect();

    // Map every mini GID -> base GID (needed for remapping composite component references).
    let mut mini_to_base_gid: HashMap<u16, u16> = HashMap::with_capacity(mini_glyph_order.len());
    for (mini_gid, name) in mini_glyph_order.iter().enumerate() {
        if let Some(&base_gid) = base_name_to_gid.get(name.as_str()) {
            mini_to_base_gid.insert(mini_gid as u16, base_gid);
        }
    }

    // Map dirty base GID -> mini GID.
    let mut dirty_base_to_mini: HashMap<u16, u16> = HashMap::with_capacity(dirty_glyph_names.len());
    for name in dirty_glyph_names {
        let &base_gid = base_name_to_gid.get(name.as_str())?;
        let &mini_gid = mini_name_to_gid.get(name.as_str())?;
        dirty_base_to_mini.insert(base_gid, mini_gid);
    }

    let num_glyphs = base_font.maxp().ok()?.num_glyphs() as usize;
    if num_glyphs != base_glyph_order.len() {
        return None;
    }

    // 1. Read hmtx tables (HVAR advance-width deltas are spliced in step 4b below).
    let base_hmtx_raw = base_font.table_data(TAG_HMTX)?.as_bytes();
    let mini_hmtx_raw = mini_font.table_data(TAG_HMTX)?.as_bytes();
    let base_num_h_metrics = base_font.hhea().ok()?.number_of_h_metrics() as usize;
    let mini_num_h_metrics = mini_font.hhea().ok()?.number_of_h_metrics() as usize;

    // 2. Rebuild glyf + loca (long 32-bit offsets).
    let (new_glyf, new_loca) = splice_glyf_and_loca(
        &base_font,
        &mini_font,
        num_glyphs,
        &dirty_base_to_mini,
        &mini_to_base_gid,
    )?;

    // 3. Rebuild hmtx + hhea.
    let (new_hmtx, new_hhea) = splice_hmtx_and_hhea(
        &base_font,
        base_hmtx_raw,
        base_num_h_metrics,
        mini_hmtx_raw,
        mini_num_h_metrics,
        num_glyphs,
        &dirty_base_to_mini,
    )?;

    // 4. Rebuild gvar if present in base_font.
    let new_gvar = match (
        base_font.table_data(TAG_GVAR),
        mini_font.table_data(TAG_GVAR),
    ) {
        (Some(base_gvar), Some(mini_gvar)) => Some(splice_gvar(
            base_gvar.as_bytes(),
            mini_gvar.as_bytes(),
            num_glyphs,
            &dirty_base_to_mini,
        )?),
        (None, None) => None,
        // Mismatch in variable vs static status — fall back cleanly.
        _ => return None,
    };

    // 4b. Rebuild HVAR if present in base_font so advance-width deltas stay
    //     100% exact at every master and interpolated location (including wght:400).
    let new_hvar = match (
        base_font.table_data(TAG_HVAR),
        mini_font.table_data(TAG_HVAR),
    ) {
        (Some(_), Some(_)) => Some(splice_hvar(
            &base_font,
            &mini_font,
            num_glyphs,
            &dirty_base_to_mini,
        )?),
        (None, None) => None,
        // Mismatch in variable vs static status — fall back cleanly.
        _ => return None,
    };

    // 5. Patch head (indexToLocFormat = 1, checkSumAdjustment = 0 for FontBuilder) and maxp.
    let mut new_head = base_font.table_data(TAG_HEAD)?.as_bytes().to_vec();
    if new_head.len() < 54 {
        return None;
    }
    new_head[8..12].copy_from_slice(&0u32.to_be_bytes());
    new_head[50..52].copy_from_slice(&1u16.to_be_bytes());

    let new_maxp = merge_maxp(
        base_font.table_data(TAG_MAXP)?.as_bytes(),
        mini_font.table_data(TAG_MAXP)?.as_bytes(),
    )?;

    // 6. Assemble output TTF, copying all other tables verbatim.
    let mut builder = FontBuilder::new();
    builder.add_raw(TAG_GLYF, new_glyf);
    builder.add_raw(TAG_LOCA, new_loca);
    builder.add_raw(TAG_HMTX, new_hmtx);
    builder.add_raw(TAG_HHEA, new_hhea);
    builder.add_raw(TAG_HEAD, new_head);
    builder.add_raw(TAG_MAXP, new_maxp);
    if let Some(gvar_bytes) = new_gvar {
        builder.add_raw(TAG_GVAR, gvar_bytes);
    }
    if let Some(hvar_bytes) = new_hvar {
        builder.add_raw(TAG_HVAR, hvar_bytes);
    }
    builder.copy_missing_tables(base_font);
    Some(builder.build())
}

fn read_u16_be(bytes: &[u8], offset: usize) -> Option<u16> {
    let slice = bytes.get(offset..offset + 2)?;
    Some(u16::from_be_bytes([slice[0], slice[1]]))
}

fn read_i16_be(bytes: &[u8], offset: usize) -> Option<i16> {
    let slice = bytes.get(offset..offset + 2)?;
    Some(i16::from_be_bytes([slice[0], slice[1]]))
}

fn read_u32_be(bytes: &[u8], offset: usize) -> Option<u32> {
    let slice = bytes.get(offset..offset + 4)?;
    Some(u32::from_be_bytes([slice[0], slice[1], slice[2], slice[3]]))
}

fn read_hmtx_entry(hmtx: &[u8], num_h_metrics: usize, gid: u16) -> Option<(u16, i16)> {
    if num_h_metrics == 0 {
        return None;
    }
    let g = gid as usize;
    if g < num_h_metrics {
        let off = g * 4;
        Some((read_u16_be(hmtx, off)?, read_i16_be(hmtx, off + 2)?))
    } else {
        let adv = read_u16_be(hmtx, (num_h_metrics - 1) * 4)?;
        let lsb_off = num_h_metrics * 4 + (g - num_h_metrics) * 2;
        Some((adv, read_i16_be(hmtx, lsb_off)?))
    }
}

fn splice_hmtx_and_hhea(
    base_font: &FontRef<'_>,
    base_hmtx: &[u8],
    base_num_h_metrics: usize,
    mini_hmtx: &[u8],
    mini_num_h_metrics: usize,
    num_glyphs: usize,
    dirty_base_to_mini: &HashMap<u16, u16>,
) -> Option<(Vec<u8>, Vec<u8>)> {
    let mut new_hmtx = Vec::with_capacity(num_glyphs * 4);
    for gid in 0..num_glyphs {
        let gid16 = gid as u16;
        let (adv, lsb) = if let Some(&mini_gid) = dirty_base_to_mini.get(&gid16) {
            read_hmtx_entry(mini_hmtx, mini_num_h_metrics, mini_gid)?
        } else {
            read_hmtx_entry(base_hmtx, base_num_h_metrics, gid16)?
        };
        new_hmtx.extend_from_slice(&adv.to_be_bytes());
        new_hmtx.extend_from_slice(&lsb.to_be_bytes());
    }

    let mut new_hhea = base_font.table_data(TAG_HHEA)?.as_bytes().to_vec();
    if new_hhea.len() < 36 {
        return None;
    }
    new_hhea[34..36].copy_from_slice(&(num_glyphs as u16).to_be_bytes());
    Some((new_hmtx, new_hhea))
}

fn parse_loca_offsets(font: &FontRef<'_>, num_glyphs: usize) -> Option<Vec<usize>> {
    let head = font.head().ok()?;
    let loca_bytes = font.table_data(TAG_LOCA)?.as_bytes();
    let is_long = head.index_to_loc_format() == 1;
    let count = num_glyphs + 1;
    let mut offsets = Vec::with_capacity(count);
    if is_long {
        if loca_bytes.len() < count * 4 {
            return None;
        }
        for i in 0..count {
            offsets.push(read_u32_be(loca_bytes, i * 4)? as usize);
        }
    } else {
        if loca_bytes.len() < count * 2 {
            return None;
        }
        for i in 0..count {
            offsets.push((read_u16_be(loca_bytes, i * 2)? as usize) * 2);
        }
    }
    Some(offsets)
}

fn remap_composite_glyf_record(
    record: &[u8],
    mini_to_base_gid: &HashMap<u16, u16>,
) -> Option<Vec<u8>> {
    if record.len() < 10 {
        return Some(record.to_vec());
    }
    let num_contours = read_i16_be(record, 0)?;
    if num_contours >= 0 {
        return Some(record.to_vec());
    }
    // Composite glyph: walk component records starting at offset 10.
    let mut out = record.to_vec();
    let mut pos = 10usize;
    loop {
        let flags = read_u16_be(&out, pos)?;
        let mini_comp_gid = read_u16_be(&out, pos + 2)?;
        let &base_comp_gid = mini_to_base_gid.get(&mini_comp_gid)?;
        out[pos + 2..pos + 4].copy_from_slice(&base_comp_gid.to_be_bytes());
        pos += 4;
        pos += if (flags & ARG_1_AND_2_ARE_WORDS) != 0 {
            4
        } else {
            2
        };
        if (flags & WE_HAVE_A_SCALE) != 0 {
            pos += 2;
        } else if (flags & WE_HAVE_AN_X_AND_Y_SCALE) != 0 {
            pos += 4;
        } else if (flags & WE_HAVE_A_TWO_BY_TWO) != 0 {
            pos += 8;
        }
        if pos > out.len() {
            return None;
        }
        if (flags & MORE_COMPONENTS) == 0 {
            break;
        }
    }
    Some(out)
}

fn splice_glyf_and_loca(
    base_font: &FontRef<'_>,
    mini_font: &FontRef<'_>,
    num_glyphs: usize,
    dirty_base_to_mini: &HashMap<u16, u16>,
    mini_to_base_gid: &HashMap<u16, u16>,
) -> Option<(Vec<u8>, Vec<u8>)> {
    let base_glyf = base_font.table_data(TAG_GLYF)?.as_bytes();
    let mini_glyf = mini_font.table_data(TAG_GLYF)?.as_bytes();
    let base_offsets = parse_loca_offsets(base_font, num_glyphs)?;
    let mini_num_glyphs = mini_font.maxp().ok()?.num_glyphs() as usize;
    let mini_offsets = parse_loca_offsets(mini_font, mini_num_glyphs)?;

    let mut new_glyf = Vec::with_capacity(base_glyf.len() + 1024);
    let mut new_loca = Vec::with_capacity((num_glyphs + 1) * 4);

    for gid in 0..num_glyphs {
        new_loca.extend_from_slice(&(new_glyf.len() as u32).to_be_bytes());
        if let Some(&mini_gid) = dirty_base_to_mini.get(&(gid as u16)) {
            let m = mini_gid as usize;
            let start = *mini_offsets.get(m)?;
            let end = *mini_offsets.get(m + 1)?;
            let raw = mini_glyf.get(start..end)?;
            if !raw.is_empty() {
                let remapped = remap_composite_glyf_record(raw, mini_to_base_gid)?;
                new_glyf.extend_from_slice(&remapped);
                while new_glyf.len() % 4 != 0 {
                    new_glyf.push(0);
                }
            }
        } else {
            let start = *base_offsets.get(gid)?;
            let end = *base_offsets.get(gid + 1)?;
            let raw = base_glyf.get(start..end)?;
            if !raw.is_empty() {
                new_glyf.extend_from_slice(raw);
                while new_glyf.len() % 4 != 0 {
                    new_glyf.push(0);
                }
            }
        }
    }
    new_loca.extend_from_slice(&(new_glyf.len() as u32).to_be_bytes());

    // OpenType spec requires a non-empty glyf table (at least 1 byte when all glyphs empty).
    if new_glyf.is_empty() {
        new_glyf.push(0);
    }

    Some((new_glyf, new_loca))
}

struct ParsedGvar<'a> {
    axis_count: usize,
    shared_tuple_count: usize,
    shared_tuples_raw: &'a [u8],
    glyph_offsets: Vec<usize>,
    data_array: &'a [u8],
}

fn parse_gvar(bytes: &[u8]) -> Option<ParsedGvar<'_>> {
    if bytes.len() < 20 {
        return None;
    }
    let major = read_u16_be(bytes, 0)?;
    let minor = read_u16_be(bytes, 2)?;
    if major != 1 || minor != 0 {
        return None;
    }
    let axis_count = read_u16_be(bytes, 4)? as usize;
    let shared_tuple_count = read_u16_be(bytes, 6)? as usize;
    let shared_tuples_offset = read_u32_be(bytes, 8)? as usize;
    let glyph_count = read_u16_be(bytes, 12)? as usize;
    let flags = read_u16_be(bytes, 14)?;
    let data_array_offset = read_u32_be(bytes, 16)? as usize;

    let shared_len = shared_tuple_count.checked_mul(axis_count)?.checked_mul(2)?;
    let shared_tuples_raw = bytes.get(shared_tuples_offset..shared_tuples_offset + shared_len)?;
    let data_array = bytes.get(data_array_offset..)?;

    let is_long = (flags & 1) != 0;
    let count = glyph_count + 1;
    let mut glyph_offsets = Vec::with_capacity(count);
    let offsets_start = 20usize;
    if is_long {
        for i in 0..count {
            glyph_offsets.push(read_u32_be(bytes, offsets_start + i * 4)? as usize);
        }
    } else {
        for i in 0..count {
            glyph_offsets.push((read_u16_be(bytes, offsets_start + i * 2)? as usize) * 2);
        }
    }

    Some(ParsedGvar {
        axis_count,
        shared_tuple_count,
        shared_tuples_raw,
        glyph_offsets,
        data_array,
    })
}

fn rewrite_gvar_glyph_data(
    mini_data: &[u8],
    axis_count: usize,
    mini_shared_tuples: &[u8],
    base_shared_map: &HashMap<&[u8], u16>,
) -> Option<Vec<u8>> {
    if mini_data.is_empty() {
        return Some(Vec::new());
    }
    if mini_data.len() < 4 {
        return None;
    }
    let tuple_var_count_raw = read_u16_be(mini_data, 0)?;
    let orig_data_offset = read_u16_be(mini_data, 2)? as usize;
    if orig_data_offset > mini_data.len() {
        return None;
    }
    let tuple_count = (tuple_var_count_raw & TUPLE_INDEX_MASK) as usize;
    let tuple_bytes = axis_count * 2;

    let mut new_headers = Vec::with_capacity(orig_data_offset);
    let mut pos = 4usize;

    for _ in 0..tuple_count {
        let var_data_size = read_u16_be(mini_data, pos)?;
        let mut tuple_index = read_u16_be(mini_data, pos + 2)?;
        pos += 4;

        let has_embedded_peak = (tuple_index & EMBEDDED_PEAK_TUPLE) != 0;
        let has_intermediate = (tuple_index & INTERMEDIATE_REGION) != 0;

        let peak_slice: Option<&[u8]> = if has_embedded_peak {
            let s = mini_data.get(pos..pos + tuple_bytes)?;
            pos += tuple_bytes;
            Some(s)
        } else {
            let shared_idx = (tuple_index & TUPLE_INDEX_MASK) as usize;
            let start = shared_idx.checked_mul(tuple_bytes)?;
            let mini_peak = mini_shared_tuples.get(start..start + tuple_bytes)?;
            if let Some(&base_idx) = base_shared_map.get(mini_peak) {
                tuple_index = (tuple_index & !TUPLE_INDEX_MASK) | base_idx;
                None
            } else {
                tuple_index = (tuple_index & !TUPLE_INDEX_MASK) | EMBEDDED_PEAK_TUPLE;
                Some(mini_peak)
            }
        };

        let intermediate_slice: Option<&[u8]> = if has_intermediate {
            let s = mini_data.get(pos..pos + tuple_bytes * 2)?;
            pos += tuple_bytes * 2;
            Some(s)
        } else {
            None
        };

        new_headers.extend_from_slice(&var_data_size.to_be_bytes());
        new_headers.extend_from_slice(&tuple_index.to_be_bytes());
        if let Some(peak) = peak_slice {
            new_headers.extend_from_slice(peak);
        }
        if let Some(inter) = intermediate_slice {
            new_headers.extend_from_slice(inter);
        }
    }

    let new_data_offset = 4usize.checked_add(new_headers.len())?;
    if new_data_offset > u16::MAX as usize {
        return None;
    }
    let serialized_data = mini_data.get(orig_data_offset..)?;

    let mut out = Vec::with_capacity(new_data_offset + serialized_data.len());
    out.extend_from_slice(&tuple_var_count_raw.to_be_bytes());
    out.extend_from_slice(&(new_data_offset as u16).to_be_bytes());
    out.extend_from_slice(&new_headers);
    out.extend_from_slice(serialized_data);
    Some(out)
}

fn splice_gvar(
    base_gvar_bytes: &[u8],
    mini_gvar_bytes: &[u8],
    num_glyphs: usize,
    dirty_base_to_mini: &HashMap<u16, u16>,
) -> Option<Vec<u8>> {
    let base = parse_gvar(base_gvar_bytes)?;
    let mini = parse_gvar(mini_gvar_bytes)?;
    if base.axis_count != mini.axis_count || base.glyph_offsets.len() != num_glyphs + 1 {
        return None;
    }

    let tuple_bytes = base.axis_count * 2;
    let mut base_shared_map: HashMap<&[u8], u16> = HashMap::with_capacity(base.shared_tuple_count);
    for idx in 0..base.shared_tuple_count {
        if let Some(slice) = base
            .shared_tuples_raw
            .get(idx * tuple_bytes..(idx + 1) * tuple_bytes)
        {
            base_shared_map.entry(slice).or_insert(idx as u16);
        }
    }

    let mut new_data_array = Vec::with_capacity(base.data_array.len() + 1024);
    let mut new_offsets: Vec<u32> = Vec::with_capacity(num_glyphs + 1);

    for gid in 0..num_glyphs {
        new_offsets.push(new_data_array.len() as u32);
        if let Some(&mini_gid) = dirty_base_to_mini.get(&(gid as u16)) {
            let m = mini_gid as usize;
            let start = *mini.glyph_offsets.get(m)?;
            let end = *mini.glyph_offsets.get(m + 1)?;
            let raw = mini.data_array.get(start..end)?;
            let rewritten = rewrite_gvar_glyph_data(
                raw,
                base.axis_count,
                mini.shared_tuples_raw,
                &base_shared_map,
            )?;
            new_data_array.extend_from_slice(&rewritten);
            if new_data_array.len() % 2 != 0 {
                new_data_array.push(0);
            }
        } else {
            let start = *base.glyph_offsets.get(gid)?;
            let end = *base.glyph_offsets.get(gid + 1)?;
            let raw = base.data_array.get(start..end)?;
            new_data_array.extend_from_slice(raw);
            if new_data_array.len() % 2 != 0 {
                new_data_array.push(0);
            }
        }
    }
    new_offsets.push(new_data_array.len() as u32);

    // Emit long-offset gvar (flags = 1):
    // header (20) + offsets ((num_glyphs + 1) * 4) + sharedTuples + dataArray
    let offsets_bytes_len = (num_glyphs + 1) * 4;
    let shared_tuples_offset = 20 + offsets_bytes_len;
    let data_array_offset = shared_tuples_offset + base.shared_tuples_raw.len();

    let mut out = Vec::with_capacity(data_array_offset + new_data_array.len());
    out.extend_from_slice(&1u16.to_be_bytes()); // majorVersion
    out.extend_from_slice(&0u16.to_be_bytes()); // minorVersion
    out.extend_from_slice(&(base.axis_count as u16).to_be_bytes());
    out.extend_from_slice(&(base.shared_tuple_count as u16).to_be_bytes());
    out.extend_from_slice(&(shared_tuples_offset as u32).to_be_bytes());
    out.extend_from_slice(&(num_glyphs as u16).to_be_bytes());
    out.extend_from_slice(&1u16.to_be_bytes()); // flags = long offsets
    out.extend_from_slice(&(data_array_offset as u32).to_be_bytes());
    for off in new_offsets {
        out.extend_from_slice(&off.to_be_bytes());
    }
    out.extend_from_slice(base.shared_tuples_raw);
    out.extend_from_slice(&new_data_array);
    Some(out)
}

fn merge_maxp(base_maxp: &[u8], mini_maxp: &[u8]) -> Option<Vec<u8>> {
    let mut out = base_maxp.to_vec();
    if out.len() >= 32 && mini_maxp.len() >= 32 {
        // Version 1.0 TrueType maxp: update maxPoints (6), maxContours (8),
        // maxCompositePoints (10), maxCompositeContours (12),
        // maxComponentElements (28), maxComponentDepth (30).
        for offset in [6usize, 8, 10, 12, 28, 30] {
            let b = read_u16_be(&out, offset)?;
            let m = read_u16_be(mini_maxp, offset)?;
            if m > b {
                out[offset..offset + 2].copy_from_slice(&m.to_be_bytes());
            }
        }
    }
    Some(out)
}

fn convert_variation_regions(
    region_list: &read_fonts::tables::variations::VariationRegionList<'_>,
) -> Option<Vec<VariationRegion>> {
    let mut out = Vec::with_capacity(region_list.region_count() as usize);
    for region in region_list.variation_regions().iter() {
        let region = region.ok()?;
        let coords = region
            .region_axes()
            .iter()
            .map(|axis| {
                RegionAxisCoordinates::new(
                    axis.start_coord(),
                    axis.peak_coord(),
                    axis.end_coord(),
                )
            })
            .collect();
        out.push(VariationRegion::new(coords));
    }
    Some(out)
}

fn extract_hvar_advance_deltas(
    hvar: &read_fonts::tables::hvar::Hvar<'_>,
    ivs: &read_fonts::tables::variations::ItemVariationStore<'_>,
    regions: &[VariationRegion],
    gid: u16,
) -> Option<Vec<(VariationRegion, i32)>> {
    let idx = match hvar.advance_width_mapping() {
        Some(Ok(map)) => map.get(gid as u32).ok()?,
        Some(Err(_)) => return None,
        None => DeltaSetIndex {
            outer: 0,
            inner: gid,
        },
    };
    if idx == DeltaSetIndex::NO_VARIATION_INDEX {
        return Some(Vec::new());
    }
    let data = match ivs.item_variation_data().get(idx.outer as usize) {
        Some(d) => d.ok()?,
        None => return Some(Vec::new()),
    };
    let region_indices = data.region_indexes();
    let mut deltas = Vec::with_capacity(region_indices.len());
    for (region_idx, delta) in region_indices.iter().zip(data.delta_set(idx.inner)) {
        if delta != 0 {
            let region = regions.get(region_idx.get() as usize)?.clone();
            deltas.push((region, delta));
        }
    }
    Some(deltas)
}

fn splice_hvar(
    base_font: &FontRef<'_>,
    mini_font: &FontRef<'_>,
    num_glyphs: usize,
    dirty_base_to_mini: &HashMap<u16, u16>,
) -> Option<Vec<u8>> {
    let base_hvar = base_font.hvar().ok()?;
    let mini_hvar = mini_font.hvar().ok()?;
    if base_hvar.lsb_mapping().is_some()
        || base_hvar.rsb_mapping().is_some()
        || mini_hvar.lsb_mapping().is_some()
        || mini_hvar.rsb_mapping().is_some()
    {
        return None;
    }

    let base_ivs = base_hvar.item_variation_store().ok()?;
    let mini_ivs = mini_hvar.item_variation_store().ok()?;
    let base_region_list = base_ivs.variation_region_list().ok()?;
    let mini_region_list = mini_ivs.variation_region_list().ok()?;
    let axis_count = base_region_list.axis_count();
    if axis_count != mini_region_list.axis_count() {
        return None;
    }

    let base_regions = convert_variation_regions(&base_region_list)?;
    let mini_regions = convert_variation_regions(&mini_region_list)?;

    let mut builder = VariationStoreBuilder::new(axis_count);
    let mut var_idxes = Vec::with_capacity(num_glyphs);
    for gid in 0..num_glyphs {
        let gid16 = gid as u16;
        let deltas = if let Some(&mini_gid) = dirty_base_to_mini.get(&gid16) {
            extract_hvar_advance_deltas(&mini_hvar, &mini_ivs, &mini_regions, mini_gid)?
        } else {
            extract_hvar_advance_deltas(&base_hvar, &base_ivs, &base_regions, gid16)?
        };
        var_idxes.push(builder.add_deltas(deltas));
    }

    let (varstore, varidx_map) = builder.build();
    let varidx_map: DeltaSetIndexMap = var_idxes
        .into_iter()
        .map(|idx| varidx_map.get(idx).unwrap())
        .collect();
    let hvar = Hvar::new(varstore, Some(varidx_map), None, None);
    write_fonts::dump_table(&hvar).ok()
}
