/** GENERATED from collab/packages/protocol. Do not edit by hand. */
// @ts-nocheck

/**
 * Keeps collaboration envelopes (room metadata) under MAX_METADATA_BYTES.
 *
 * An envelope only describes an edit; the edit itself travels in the Yjs
 * update. Receivers apply the Yjs update first and then re-read the touched
 * glyphs, layers and top-level keys from the document, so describing a change
 * at a coarser path (a whole layer, a whole glyph, a whole top-level key)
 * converges to the same state. This module shrinks envelopes in steps and
 * stops at the first step that fits. There is deliberately no whole-font step:
 * receivers refuse whole-font syncs, so an envelope that still does not fit
 * after the last step is reported as not fitting. Editor and room share this file, so both
 * sides produce identical results.
 *
 * Paths: `glyphs.<name>:layers.<id>:<rest>` for layer data, `glyphs.<name>:`
 * for a glyph root, otherwise dot-separated with `\.` escaping a literal dot.
 */

/** Keep a margin below the cap for the frame fields wrapped around envelopes. */
export const METADATA_BUDGET_MARGIN_BYTES = 1024;

export const METADATA_FIT_LEVEL = Object.freeze({
  NONE: 0,
  DROP_REPLAY_VALUES: 1,
  SHARE_REPLAY_TARGETS: 2,
  COLLAPSE_TO_LAYERS: 3,
  COLLAPSE_TO_GLYPHS: 4,
  CAP_LISTS: 5,
  TRUNCATE_TARGETS: 6,
});

const MAX_LISTED_NAMES = 200;
const MAX_LABEL_CHARS = 200;
const MAX_TRUNCATED_TARGETS = 500;
const encoder = new TextEncoder();

export function jsonBytes(value) {
  return encoder.encode(JSON.stringify(value ?? null)).length;
}

function isStructuralChange(change) {
  return (
    (Array.isArray(change.glyphRenames) && change.glyphRenames.length > 0) ||
    change.path === "glyphOrder" ||
    change.path.startsWith("glyphOrder.")
  );
}

/** Glyph add/remove (and renames) must keep their exact path. */
function isStructuralGlyphRoot(change) {
  return (
    change.path.startsWith("glyphs.") &&
    change.path.endsWith(":") &&
    change.op !== "set"
  );
}

/** `glyphs.G:layers.L:rest` -> `glyphs.G:layers.L`; null when not layer data. */
function layerPrefix(path) {
  if (!path.startsWith("glyphs.")) return null;
  const first = path.indexOf(":");
  if (first < 0) return null;
  const second = path.indexOf(":", first + 1);
  return second < 0 ? null : path.slice(0, second);
}

/** `glyphs.G:...` -> `glyphs.G:`; null when not glyph data. */
function glyphRoot(path) {
  if (!path.startsWith("glyphs.")) return null;
  const first = path.indexOf(":");
  return first < 0 ? null : path.slice(0, first + 1);
}

function topLevelKey(path) {
  let key = "";
  for (let i = 0; i < path.length; i += 1) {
    const char = path[i];
    if (char === "\\" && i + 1 < path.length) {
      key += path.slice(i, i + 2);
      i += 1;
    } else if (char === ".") {
      return key;
    } else {
      key += char;
    }
  }
  return key;
}

function withChanges(envelope, changes, metadata = envelope.metadata) {
  return { ...envelope, changes, metadata };
}

function dropReplayValues(envelope) {
  return withChanges(
    envelope,
    envelope.changes.map((change) => {
      const { replayOldValue, replayNewValue, ...rest } = change;
      void replayOldValue;
      void replayNewValue;
      return rest;
    }),
  );
}

/** Metadata already holds the union of every change's targets. */
function shareReplayTargets(envelope) {
  const union = new Map();
  for (const target of envelope.metadata.workerReplayTargets || []) {
    union.set(`${target.glyphName}\u0000${target.layerId}`, target);
  }
  for (const change of envelope.changes) {
    for (const target of change.workerReplayTargets || []) {
      union.set(`${target.glyphName}\u0000${target.layerId}`, target);
    }
  }
  return withChanges(
    envelope,
    envelope.changes.map((change) => {
      const { workerReplayTargets, ...rest } = change;
      void workerReplayTargets;
      return rest;
    }),
    { ...envelope.metadata, workerReplayTargets: [...union.values()] },
  );
}

function collapseChanges(envelope, mapPath) {
  const seen = new Set();
  const changes = [];
  for (const change of envelope.changes) {
    if (isStructuralChange(change) || isStructuralGlyphRoot(change)) {
      changes.push(change);
      continue;
    }
    const collapsed = mapPath(change.path);
    if (collapsed === null) {
      changes.push(change);
      continue;
    }
    if (seen.has(collapsed)) continue;
    seen.add(collapsed);
    changes.push({ path: collapsed, op: "set" });
  }
  return withChanges(envelope, changes);
}

function collapseToLayers(envelope) {
  return collapseChanges(envelope, layerPrefix);
}

function collapseToGlyphs(envelope) {
  return collapseChanges(envelope, (path) => {
    const root = glyphRoot(path);
    if (root) return root;
    if (path.startsWith("glyphs.")) return null;
    const key = topLevelKey(path);
    return key && key !== path ? key : null;
  });
}

function capLists(envelope) {
  const count = envelope.changes.length;
  const label =
    typeof envelope.label === "string" && envelope.label.length > MAX_LABEL_CHARS
      ? envelope.label.slice(0, MAX_LABEL_CHARS)
      : envelope.label;
  return {
    ...envelope,
    label,
    summary:
      envelope.summary && envelope.summary.length > MAX_LABEL_CHARS
        ? `${count} changes`
        : envelope.summary,
    metadata: {
      ...envelope.metadata,
      changedGlyphNames: (envelope.metadata.changedGlyphNames || []).slice(
        0,
        MAX_LISTED_NAMES,
      ),
      changedLayerIds: (envelope.metadata.changedLayerIds || []).slice(
        0,
        MAX_LISTED_NAMES,
      ),
    },
  };
}

function truncateTargets(envelope) {
  return {
    ...envelope,
    metadata: {
      ...envelope.metadata,
      workerReplayTargets: (envelope.metadata.workerReplayTargets || []).slice(
        0,
        MAX_TRUNCATED_TARGETS,
      ),
    },
  };
}

const STEPS = [
  [METADATA_FIT_LEVEL.DROP_REPLAY_VALUES, dropReplayValues],
  [METADATA_FIT_LEVEL.SHARE_REPLAY_TARGETS, shareReplayTargets],
  [METADATA_FIT_LEVEL.COLLAPSE_TO_LAYERS, collapseToLayers],
  [METADATA_FIT_LEVEL.COLLAPSE_TO_GLYPHS, collapseToGlyphs],
  [METADATA_FIT_LEVEL.CAP_LISTS, capLists],
  [METADATA_FIT_LEVEL.TRUNCATE_TARGETS, truncateTargets],
];

/**
 * Shrink an array of envelopes until its JSON fits `maxBytes`.
 * Returns the input untouched (level NONE) when it already fits.
 * @param {Array<object>} messages
 * @param {number} maxBytes
 * @returns {{ messages: Array<object>, level: number, bytesBefore: number, bytesAfter: number, fits: boolean }}
 */
export function fitCollaborationMessagesToBudget(messages, maxBytes) {
  const list = Array.isArray(messages) ? messages : [];
  const bytesBefore = jsonBytes(list);
  if (bytesBefore <= maxBytes) {
    return {
      messages: list,
      level: METADATA_FIT_LEVEL.NONE,
      bytesBefore,
      bytesAfter: bytesBefore,
      fits: true,
    };
  }
  let current = list;
  let level = METADATA_FIT_LEVEL.NONE;
  let bytes = bytesBefore;
  for (const [stepLevel, step] of STEPS) {
    current = current.map(step);
    level = stepLevel;
    bytes = jsonBytes(current);
    if (bytes <= maxBytes) break;
  }
  return {
    messages: current,
    level,
    bytesBefore,
    bytesAfter: bytes,
    fits: bytes <= maxBytes,
  };
}

/**
 * Merge several envelopes (one Yjs update spanning several history items)
 * into one. Keeps the first envelope's identity and history metadata.
 * @param {Array<object>} messages
 * @returns {object | null}
 */
export function mergeCollaborationMessages(messages) {
  const list = (Array.isArray(messages) ? messages : []).filter(Boolean);
  if (list.length <= 1) return list[0] ?? null;
  const [first] = list;
  const changes = list.flatMap((message) => message.changes);
  const union = (pick) => [...new Set(list.flatMap((m) => pick(m.metadata)))];
  const targets = new Map();
  for (const message of list) {
    for (const target of message.metadata.workerReplayTargets || []) {
      targets.set(`${target.glyphName}\u0000${target.layerId}`, target);
    }
  }
  return {
    ...first,
    changes,
    metadata: {
      ...first.metadata,
      changedGlyphNames: union((m) => m.changedGlyphNames || []),
      changedLayerIds: union((m) => m.changedLayerIds || []),
      workerReplayTargets: [...targets.values()],
    },
    summary: `${changes.length} changes`,
  };
}
