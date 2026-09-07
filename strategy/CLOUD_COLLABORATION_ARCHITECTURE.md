# Cloud Collaboration Architecture

## Status

**v1 is in the editor.** Cloud UI is on (`CLOUD_PLUGIN_UI_ENABLED`). The editor
uses a document set (`font-core`, `font-deps`, `glyph:<id>`), not one whole-font
Y.Doc. Outlines are not dual-written into core.

Supersedes one-room whole-font Y.Doc, R2-via-WebSocket bootstrap, and drafts
that kept full dependency edges in always-resident `font-core`. One DO per
whole font still hits isolate memory (~128 MB); rooms stay per-shard.

The Memory-efficient collab plan
(`.cursor/plans/memory-efficient_collab_92167e9b.plan.md`) is the work order
for nested writes, deps projection, opaque rooms, and capacity benches.
**This file is the normative architecture.** Where the two disagree, follow
this file (capacity numbers and dirty caps come from checked-in benches, not
the plan’s 8 MB placeholder).

**Landed in the client (this cut)**

- `PatchSyncEngine` routes glyph paths to glyph docs; core holds catalog +
  `glyphRevisions` (dirty `{glyphId, revision}`), not outlines.
- Nested JSON is leaf-granular on get and set (symmetric-diff into Y.Maps;
  no whole-subtree `toYType` on dict assign). Outlines use atomic
  `geometryTopology` + packed `nodePositionsById` (see
  `developer-docs/YDOC_SHAPE_IDENTITY_MIGRATION.md`).
- Persistent WebSockets: `font-core` + the current glyph subset only.
- Passive glyphs catch up over HTTP `GET /shards/:path/live` → DO
  `/internal/live-state` (live vector, not stale R2). Access-epoch 403;
  `Cache-Control: no-store`. Four concurrent reads; retry until the glyph
  `sync.revision` stamp matches (or 401/403).
- Commit/undo/redo: stamp glyph `sync.revision` in the same outline
  transaction, then emit one core revision envelope (`onGlyphRevisionSignal`,
  shared `historyItemId`). Catch-up is a document checkpoint
  (`applyDocumentCatchUp`), not history replay. After core hydrate, scan the
  revision map and catch up every glyph whose live revision is newer.
- Linked windows: document-scoped BroadcastChannel; main is the cloud hub;
  inbound MetadataFree glyph packets use catch-up; linked worker seed uses
  `seedWorkerDocumentSet` (`state`, not raw `bytes`).
- `font-deps` is its own Y.Doc: UUID-keyed per-edge CRDT, no stored reverse
  graph, repaired from converged glyph shards.

**Still later:** full opaque-byte FontRoomDO (no Yjs in the room isolate),
CJK working-set hydrate, Fly full-font builder, fat compactor, denser cmap.
Worker-class `compactor` on sharded R2 keys is in v1.

**v1 vs later**

| In v1 | Later |
| --- | --- |
| Per-shard DOs, HTTP seed/hydrate, external Worker compaction | Fat-process compactor for oversized shards |
| Hydrate policy `all` (Basic: 1 font, ≤1000 glyphs) | CJK working-set hydrate + layout-closure UX |
| Owner quotas, 5 MiB per Y.Doc, plugin catalog/deps | Fly/session full-font builder |
| Document-scoped BC `documentId`; linked worker `seedWorkerDocumentSet` | CJK-style selective linked bootstrap |
| compactor as-is (room id + R2 shard keys) | Legacy whole-font room migration |

## Goals

- One architecture for small fonts (&lt;10k glyphs) and extremely large fonts
  (CJK, 100k+ glyphs). Policy differs; code paths do not fork.
- Keep Cloudflare Durable Objects for cheap, low-latency live exchange.
- Move bulk seed and hydrate traffic to HTTP + R2.
- Never require a DO to hold, hydrate, or compact a full font (or a full
  glyph set) in memory.
- Support migrating a font from “small” to “large” without a second product
  mode.

## Reference fonts (later evaluation)

Use these as stress cases when sizing catalog/deps budgets and hydrate UX:

- [Plangothic Project](https://github.com/Fitzgerald-Porthmouth-Koenigsegg/Plangothic_Project)
- [Source Han Sans](https://github.com/adobe-fonts/source-han-sans)

## Decision summary

| Concern | Decision |
| --- | --- |
| Document shape | One Yjs shard per `font-core`, `font-deps`, and `glyph:<glyphId>` |
| Outline CRDT | Atomic `geometryTopology` + `nodePositionsById` packed XY; no nested `shapes[i].nodes` |
| Nested font JSON | Leaf-path records; dict setters symmetric-diff Y.Maps (set and delete) |
| DO identity | One DO room per shard; never one DO for the whole font |
| Bulk transfer | HTTP streams to/from R2 (packs = multi-shard responses) |
| Live transfer | WebSocket to a small set of shard DOs |
| DO memory | Zero-hydration target: auth, ordered durable tail, fan-out, metadata only; no long-lived `Y.Doc` |
| Compaction | External to the room DO; Worker-class for shards, fat host if over recoverability; never in-room encode |
| Discovery | Lean identity catalog in core (incl. cmap) + separate deps index |
| Deps encoding | `edges: Y.Map<sourceUUID, Y.Map<targetUUID, kind>>` + `sourceRevision`; invert reverse in memory |
| Closure (compile) | `close_layout(seeds)` then forward deps; no reverse set |
| Closure (UI sparse hydrate) | Live `font-deps` first; FEA alts of **seeds only**; reverse\* component/`both` from seeds+alts; forward\* **strict component** into working; metrics/`both` stems **hidden**; never GSUB-close the reverse set; one plan, one glyph fetch |
| Linked windows | Main window is sole cloud hub; BC is multi-doc; per-window residency |
| Small vs large | Same machinery; default hydrate policy is `all` vs working-set |
| Full-font compile | Session-scoped Fly Machine (8–16 GB); core dirty + HTTP glyph catch-up (not v1) |
| Quotas | Website is source of truth; **asset owner** subscription; plugin **and** collab enforce |
| Basic plan | 1 owned font, 1000 glyphs (`null` = unlimited for future tiers) |
| Client shard ceiling | 5 MiB encoded per Y.Doc (`MAX_SHARD_BYTES` = 5 242 880); warn at 75%; seed/save/commit block at cap |
| Live Yjs packet | **256 KiB** (`MAX_YJS_PACKET_BYTES`); fail-closed at send (`settings.ts` / `evaluateCollabSubmit`) |
| Dirty tail / compact trigger | Soft **256 KiB** or **64** rows; hard **262 893** B (~257 KiB leftover); then `tail_full`, compact still runs |
| Compaction host | `compactor` Worker-class; recoverable matches the shard ceiling; fold/txn = packet |
| Catalog / deps | Built in CloudPlugin (`prepareToSeed` / `prepareToSave`); live incremental updates |
| Plugin-owned data | Namespaced; stripped on Save As to another plugin (`stripOwnedFontData`) |
| Collab → website | Service-token internal limits API on seed and catalog growth |

## Why one architecture

A Latin font under this design is already sharded. Opening it uses hydrate
policy `all` (one or few packs covering every catalog id). A CJK font uses the
same shards, packs, DOs, and residency model, but seeds a range, text run, or
active glyph and expands a dependency closure first.

Growing past a browser budget does not flip product modes. It only changes
hydrate selectivity and when full builds must run server-side.

## Entitlements (normative)

Website D1 is the **only** source of truth for cloud quotas. The subscription
that counts is the **asset owner’s**, never the accessing collaborator’s.
Client-only checks are not sufficient: the CloudPlugin **and** the collab
Worker/DO must both enforce.

| API | Whose subscription | When |
| --- | --- | --- |
| `GET /api/cloud/eligibility` | Logged-in caller | “Can I host / first Save As?” |
| `GET /api/cloud/assets/:id/limits` | Asset owner | Open cloud font, Save, `canAddGlyphs` |
| `POST /api/cloud/assets/:id/can-add-glyphs` | Asset owner | Before add/duplicate/paste glyphs |
| `GET /api/internal/cloud/assets/:id/limits` | Asset owner (service token) | Collab seed / catalog insert |
| `POST /api/internal/cloud/assets/:id/glyph-count` | Service token | Persist `font_assets.glyph_count` |

**Basic** (and current no-membership cloud grant): `maxFontsOwned = 1`,
`maxGlyphsPerFont = 1000`. Convention: `null` means unlimited.

Glyph count is stored on `font_assets.glyph_count` and in core-shard manifest
metadata. Rooms must **not** hydrate glyph bodies to count glyphs.

## Client shard size gate

Encoded Yjs state per document, independently of the live packet:

- Shard ceiling: **5 242 880 bytes** (5 MiB, `MAX_SHARD_BYTES`) — checkpoint / seed / merged state
- Live packet: **262 144 bytes** (256 KiB, `MAX_YJS_PACKET_BYTES`) — one validator/compactor transaction
- Compact trigger: **262 144 bytes** or **64** dirty rows (`CHECKPOINT_DELTA_*`)
- Tail hard cap: **262 893 bytes** (`MAX_DIRTY_HARD_BYTES`) — leftover under last-OK compact × 0.7 minus a full shard
- Fold / validator txn / compact txn: **262 144 bytes**
- Spool: **524 288 bytes** (two max packets)
- Warning: **75%** of the shard (3 932 160 bytes)
- Applies to `font-core`, `font-deps`, and each `glyph:<id>`

Editor hard limits live in `webapp/js/settings.ts` (`APP_SETTINGS.CLOUD_COLLAB`) and are the fail-closed floor at live commit. Collab protocol constants must match. A plugin or Website `maxPacketBytes` cannot raise the packet cap.

Isolate last-OK on Cloudflare preview was ~7.87 MB compact / ~8.65 MB validate.
Last-OK × 0.7 is **5 505 773 bytes**; the product shard gate is a round **5 MiB** so
the validator and compactor keep headroom. Dense compact first-OOM was **~5.54 MB**,
so a 5 MiB checkpoint plus a 5 MiB edit is forbidden. Approaching 75% shows a Preferences
CRDT warning. At/over the caps:

- **Seed / Save:** `prepareToSave` encodes shards, alerts, and throws at `MAX_SHARD_BYTES`.
- **Live commit:** change-bridge measures packet bytes and an efficient shard
  estimate (cached encode + packet; full encode of that shard only if the
  estimate would reject), then `evaluateCollabSubmit` against **settings**
  (packet 256 KiB, shard 5 MiB) before `canSubmitCollabUpdate`. Reject rolls
  the Yjs transact back immediately, restores font JSON, and alerts. Local
  backends do not enforce this.

Collab `POST .../state` also rejects shard bodies ≥ `MAX_SHARD_BYTES`.
Room writes reject `packet_too_large` or `tail_full` before journal.

Do not encode every glyph on every edit. Cache last admitted encoded size per
shard and only `Y.encodeStateAsUpdate(doc)` the touched shard when the cheap
sum would cross the shard cap.

## Cloud plugin: catalog, hooks, owned data

The lean catalog and deps index are **built in the CloudPlugin**, not in the
room DO.

Hooks on `FilesystemPlugin` (Cloud overrides):

| Hook | Role |
| --- | --- |
| `prepareToSeed()` / `prepareToSave()` | Refresh catalog + deps from the live model **before** `canSave` / seed; Cloud also gates shard bytes |
| `canSave()` | Quota + per-shard size |
| `canAddGlyphs(n)` | Website limits (eligibility if no asset; **owner** limits if open cloud font) |
| `canSubmitCollabUpdate(requests)` | Sync live-commit admit: packet + shard bytes. Cloud rejects at settings envelope (256 KiB packet / 5 MiB shard); Memory/Disk allow |
| `notifyCollabSubmitRejected(decision)` | Visible alert; change-bridge already reverted the commit |
| `stripOwnedFontData(fontJson)` | Restore baseline JSON without this plugin’s catalog/deps |

Keep catalog/deps live on committed changes that affect identity or references
(glyph add/remove/reorder, rename, codepoints, component `reference`,
metrics/sidebearing keys). Incremental patches — not a full rebuild on every
outline edit.

Plugin data lives under a namespaced font field
(`format_specific['com.counterpunch.cloud']`). Save As to Memory/Disk/Glyphs
calls the **source** plugin’s `stripOwnedFontData` so foreign formats never
keep a cloud catalog. Another plugin may then install its own structure.

Editor cloud sessions use a **document set** of Y.Docs (`font-core`,
`font-deps`, `glyph:<id>`), not one merged font CRDT. `PatchSyncEngine` routes
glyph paths to glyph docs and font-wide fields to core. Live WebSockets: core
always + the subsetted glyphs. Other glyphs one-shot HTTP live catch-up
(retry until stamp matches).

## Shard model

```text
asset:<assetId>:font-core          non-glyph font data + lean glyph catalog
asset:<assetId>:font-deps          compact dependency graph (see below)
asset:<assetId>:glyph:<glyphId>    one glyph's editable CRDT state
```

Optional later shards (only if core still grows too large): kerning and/or
feature sources.

### Glyph identity

Glyph CRDT documents are keyed by an **immutable glyph id**, not by name.
Renames update the catalog; they do not move the shard.

### `font-core` (lean)

Always loaded for an editing session. Contains:

- True font-wide fields: UPM, names, axes, masters (without assuming huge
  kerning stays forever), instances, notes, features, etc.
- A **lean glyph catalog** for browse/search/order — not outline data.
- Enough encoding data to resolve characters → glyphs **without hydrating
  glyph shards** (see cmap below).

Catalog entry (illustrative):

```ts
type GlyphCatalogEntry = {
    glyphId: string;
    name: string;
    codepoints: number[]; // required projection; see cmap
    productionName?: string;
    latestGlyphRevision: string;
    exported?: boolean;
    deleted?: boolean;
};
```

#### Cmap / character → glyph mapping

Today, Unicode encodings live only on each glyph (`glyph.codepoints`) inside
the hydrated glyph list. After sharding, that is not available until the glyph
body is loaded — too late for text-run seeding.

`font-core` must therefore carry a cmap-like index derived from those
encodings, updated whenever a glyph’s codepoints change:

- At minimum: every catalog entry’s `codepoints` **and** a reverse lookup
  `codepoint → glyphId[]` stored beside the catalog (v1).
- Optional later: a denser dedicated cmap structure if per-entry lists plus
  scan are too slow for CJK text.

This is how “expand encoded characters into a seed set” works before any
outline hydrate: text → codepoints → catalog/cmap → glyph ids → full closure.

Authoritative per-glyph `codepoints` may still also exist on the glyph shard
for editing; core’s map is the denormalized discovery copy, same pattern as
deps.

**Do not** put full component/metrics dependency lists in always-resident core
by default. That would make core larger than “today’s JSON minus `.glyphs`”
by an O(n) tax that still stresses memory at CJK scale.

Also watch existing core-resident O(n) bombs already in babelfont JSON:

- `first_kern_groups` / `second_kern_groups` membership lists
- `features.classes` / feature code as monolithic AFDKO strings
- `masters[].kerning` (and RTL) pair maps
- `variation_sequences`

`glyphOrder` in the collab Y.Doc is already a `Y.Array` of names derived from
glyph array order. Prefer granular insert/delete of immutable ids; never treat
“replace entire order” as the logical edit.

### `font-deps` (compact dependency index)

Separate Y.Doc / DO / R2 checkpoint from always-on core. Glyph shards are
authoritative; deps is a **denormalized projection**. Do not embed `fontDeps`
in core `format_specific`. Do not persist glyph-order ranks or one packed LWW
adjacency blob (concurrent glyph create across DOs cannot share ranks).

Authoritative live format:

```text
deps.edges:          Y.Map<sourceGlyphUUID, Y.Map<targetGlyphUUID, edgeKind>>
deps.sourceRevision: Y.Map<sourceGlyphUUID, glyphRevisionToken>
edgeKind = component | metrics-key | both
```

- Immutable glyph UUIDs are the only durable identity. Omit empty source maps.
- **No reverse graph is stored.** Invert forward maps in memory when needed.
- Per-edge CRDT keys preserve concurrent add/delete. A repair pass from the
  converged glyph shard removes conservative stale extras.
- `sourceRevision` is equality-only. A loaded glyph whose deps revision
  differs is recomputed with a symmetric per-edge diff.
- Commit order: glyph shard durable first, deps edge diff second, core
  `glyphRevisions` last. Stale extras may temporarily over-hydrate; they must
  never omit a final prerequisite. Sparse hydrate verifies each newly loaded
  source against its deps revision, repairs, and repeats to a fixed point.
  `font-deps` catches up on remote revision change, not only reconnect.

Patch one catalog/cmap entry and one source edge map on identity/reference
edits. Do not rebuild every glyph Y.Doc from `initFromFontJson` on catalog
churn. Narrow `depsNeedUpdate` to component add/remove/`reference` and
metrics-key fields — not arbitrary layers, nodes, or `format_specific`.

Component and metrics-key closure walks this index without opening glyph
Y.Docs. OpenType layout closure is a separate step (`close_layout`) and does
not live in `font-deps`.

### Glyph shards

Each `glyph:<glyphId>` document holds that glyph’s editable state: layers,
components, anchors, local metrics, and **normalized outlines**:

```text
layer.geometryTopology    one versioned atomic JSON string (path grammar)
layer.nodePositionsById   Y.Map<nodeUUID, packedXY>   // one scalar pair, not nested x/y
layer.shapeDataById       Y.Map<shapeUUID, non-topology shape data>
```

Coordinate drags write one packed position. Insert/delete, connect/split,
open/close, reverse, set-start, and node-type conversion replace the complete
topology value in one Yjs transaction (plus add/remove of affected map
entries). Concurrent structural ops therefore cannot interleave into malformed
contours. Unreferenced position entries are orphans; an idempotent repair
deletes them. Browser and Rust reconstruct ordinary `shapes` after a complete
transaction and must fail closed without replacing the last known-good
compiler cache. Details:
[developer-docs/YDOC_SHAPE_IDENTITY_MIGRATION.md](../developer-docs/YDOC_SHAPE_IDENTITY_MIGRATION.md).

Nested font JSON outside outlines (features, kerning, `format_specific`,
names, …) uses the same leaf-write funnel: getters record leaf paths;
setters symmetric-diff existing Y.Maps (set **and** delete). Do not
`toYType` a whole dict because a parent setter ran.

## Residency in the browser

Unloaded ≠ missing.

```ts
type GlyphResidency =
    | { state: 'loaded'; glyphId: string }
    | { state: 'loading'; glyphId: string }
    | { state: 'unloaded'; glyphId: string }
    | { state: 'failed'; glyphId: string; error: string };
```

Code that iterates `font.glyphs` must choose: loaded-only, catalog paging, or
server-side full-font job. Local compile assembles an ephemeral font from core
+ loaded glyphs only, after closure hydration.

## Transport split

```text
Editor ── HTTP binary (seed / hydrate packs) ──► Worker ── stream ──► R2
   │                                              │
   │                                              ▼
   └── WebSocket (live, small working set) ──► per-shard DO
                                                  │
                                                  ▼
                                           SQLite durable tail
                                                  │
                                    External compactor (per shard)
                                    Worker-class | fat if oversized
                                         (baseline promote)
```

### R2

Canonical baseline bytes per shard: core, deps index, each glyph checkpoint.
Immutable objects + manifest pointers. Temporary seed/candidate objects as
needed.

### Durable Object (per shard)

Keeps:

- Auth / access epoch
- Active baseline manifest metadata (keys, log ids, hashes) — not bodies
- Durable incremental tail after the baseline
- Connected peers and one-copy binary fan-out (log IDs on committed chunks)
- SQLite ingress spool (not in-memory chunk maps)

Must not:

- Import Yjs, hold a long-lived `Y.Doc`, or `arrayBuffer()` seed/baseline
  bodies
- Answer generic “diff my arbitrary state vector against a hydrated server doc”
- Run full-state compaction or any in-room `encodeStateAsUpdate` fallback
  (including first seed — seed is R2 PUT + `adopt-baseline` metadata only)
- Generate a server state vector

Websocket sync is **checkpoint-relative**. Clients send
`checkpointLogId` and `appliedLogId` (highest contiguous committed
log id applied). Server:

- If `appliedLogId < currentCheckpointLogId` → `rebaseline-required` (those
  rows were truncated into the newer checkpoint).
- If `currentCheckpointLogId ≤ appliedLogId ≤ lastLogId` → replay
  `id > appliedLogId` page/frame-wise.
- Reject impossible future IDs; never silently clamp them.
- Cold `/live` pins checkpoint `L` and tail high-water `H`; if compaction
  advances past the client before WS join, rebaseline and retry.

A client may advance its baseline token after a promoted checkpoint `H` only
if its contiguous `appliedLogId ≥ H`. Never clear those IDs merely because
the socket closed.

### Compaction (room DO vs external)

Edit durability is always **R2 baseline + acked DO tail**, never “waiting for
compaction.” Compaction only rewrites a new baseline and CAS-promotes the
manifest so tails can shrink.

#### Room DO (never the compactor)

Keeps zero-hydration. For compaction it only:

- Tracks dirty-byte / dirty-row thresholds and schedules work
- Exports the durable tail after the current checkpoint log id
- CAS-promotes a candidate baseline the external host wrote to R2

It must not load checkpoint bodies into a `Y.Doc`, GC-encode full state, or
stack compaction peak on the live WebSocket isolate. There is **no** in-room
encode path for seed or first baseline.

#### Why “external” even when the host is still a Worker

Today’s `compactor` is a **separate Workers isolate**, not unlimited RAM.
It is the v1 **Worker-class per-shard host**: one request = one room’s R2
baseline + DO durable tail. After sharding, `roomId` is
`${assetId}:${shardId}` and R2 keys live under
`font-assets/{assetId}/shards/{shardId}/…`. The compact loop itself does not
need a rewrite — only identity/layout alignment. Externalization is still
the right room design because:

1. Compaction peak must not share the live room heap (fan-out, auth, tail
   append).
2. Zero-hydration DOs cannot compact without rehydrating — which defeats the
   shard memory model.
3. After sharding, recoverable size is per-shard (`checkpoint + dirty tail`),
   not whole-font. Glyph and lean-core shards fit a Worker; whole-font rooms
   do not.

Checked-in benches (plan §5) replace that probe: run
`node scripts/capacity-bench.mjs`, `node scripts/room-capacity-bench.mjs`, and
`node scripts/wrangler-oom-bench.mjs` in the collab repo. Node `heapUsed` is a
lower bound. Gates use last successful **128 MB workerd** compact+validate
minus ≥30% headroom, and **do not shrink** just because a smaller fixture
succeeded. Cloudflare preview isolates reported `Worker exceeded resource
limits`. Last successful compact was 7.87 MB; last successful validate 8.65 MB.
Last-OK × 0.7 = **5 505 773 bytes**. The product admission ceiling is a hard
**5 MiB (5 242 880)** (`HARD_ADMISSION_BYTES`) so Workers keep the rest as
headroom. The old 10 MB target is not raised (7.87 MB is below 10 MB / 0.7).
Leftover on a full shard is **262 893 bytes**; that is `MAX_DIRTY_HARD_BYTES`
and the live packet stays **256 KiB** so compact never applies checkpoint +
tail + one max edit in one session.

Worker recoverable compact is `MAX_COMPACTION_RECOVERABLE_BYTES` (5 242 880
bytes, same as the shard ceiling). Fold and each tail transaction are the
packet cap (262 144). Do not raise recoverable toward 100 MB.

#### Two external host classes

| Host | Role | Memory contract |
| --- | --- | --- |
| **Worker-class compactor** (current `compactor`) | Steady-state per-shard compact | `applyCheckpoint(S)` then tail txns ≤ 256 KiB; fold every 256 KiB; `S + dirty ≤ 5 MiB` encoded by room admission; never `S + T + P` |
| **Fat-process compactor** (same class as full-font builder VM / Containers) | Oversized shards, legacy whole-font migration, pathological cores | May hold multi‑100 MB Yjs GC peaks; not a DO or Worker isolate |

Flow (both hosts):

```text
Room DO alarm / threshold
  → export tail (no Y.Doc hydrate)
  → compactor: R2 baseline + tail → Y.Doc({gc:true}) → encode → R2 candidate
  → room DO: CAS promote manifest → truncate acked tail
```

Refuse to compact oversized recoverable state in a Worker; migrate/shard or
hand off to the fat host. Do not raise the Worker cap to “almost 128 MiB” as
a substitute for sharding — the multiplier and concurrent isolate noise leave
little headroom.

### Packs

A **pack** is only a transport efficiency layer: one HTTP request whose Worker
response multiplexes many shard payloads. It is not a second data model and
not a single live object shared by many DOs.

Worker implementation rules:

- Stream; do not buffer whole packs in memory
- Bounded concurrency when faning out to per-glyph DOs + R2
- Per glyph, recoverable state is `R2 baseline + DO tail` (fresh edits need
  not be compacted to R2 first)
- Cap batch size per request; schedule remaining ids in further batches —
  capping paces work, it does not drop updates

## Who chooses glyphs; who computes closure

### Seeds

The **client** chooses seeds from product intent:

- active glyph
- text-run / paragraph characters, resolved through core’s **cmap/catalog**
  (`codepoint → glyphId`), not by inspecting unloaded glyph shards
- catalog range (Unicode block, filter) via the same encoding index
- policy `all` for small fonts

Without a core-resident character map, encoded text cannot become a seed set
until every possibly matching glyph is already hydrated — which defeats lazy
hydration.

### Full downloadable closure (compile; no outline hydrate)

Local **compile** subset is GSUB + **upstream** components only — the same
algorithm as `close_layout` then `expand_closure_with_component_deps`.
Downstream composites of the seed are **not** in the compile subset.

```text
seeds
  → (A) OpenType layout closure     // features + catalog names
  → (B) forward deps-index expansion  // components, metrics-key edges
  → hydrate missing ids from R2/DOs
```

**(A) Layout closure** uses babelfont’s existing `close_layout` preprocessor
(already used by the browser editing subset / WASM
`prime_layout_closure_cache` path). Inputs:

- feature source from `font-core` (`font.features` → FEA)
- glyph **name** universe from the lean catalog (not outlines)
- seed glyph names

`close_layout` parses the FEA AST and walks GSUB reachability (single /
multiple / alternate / ligature / reverse-chain subst, class defs, multi-round
lookups). Today’s API takes `&Font` for convenience; semantically it only
needs `{ features, glyphNames[], seeds }`. Empty name-only glyph stubs suffice
in babelfont tests — outlines are irrelevant.

**(B) Dependency-index expansion** then (or interleaved to fixpoint) adds
transitive component and metrics-key prerequisites via `font-deps`, matching
what the WASM path today does with `expand_closure_with_component_deps` after
`close_layout` — except the sharded world reads the deps index instead of
walking hydrated layers.

Prefer computing this on the client once core + deps are loaded. A Worker may
run the same algorithm if given seeds, core features/catalog names, and the
deps artifact — still without opening glyph Y.Docs.

### UI sparse hydration (graph sufficiency)

Editing hydrate for a user-chosen seed set is **not** the compile subset.
Compile is layout + **forward** deps only. Editing must also reverse-close
composites (so opening `a` loads `adieresis`) and then forward-close nested
outline parts (so `adieresis` still loads `dieresiscomb`). Sidebearing
sources (`n`, `l`, `o`) load as **hidden** support, not working tiles.

Implementation: `computeSparseHydrationPartition` in
`webapp/js/filesystem-plugins/cloud-font-deps.ts`. Tests:
`webapp/tests/cloud-glyph-catalog.test.js`.

#### Building `font-deps`

Glyph shards are authoritative. `font-deps` is a denormalized forward graph:

```text
deps.edges[sourceUUID][targetUUID] = component | metrics-key | both
```

- **component:** outline `reference` (and catalog `componentIds` when present).
- **metrics-key:** `leftMetricsKey` / `rightMetricsKey` / `widthMetricsKey` and
  Glyphs `metric_left` / `metric_right` / `metric_width`, parsed against
  longest-first glyph names (`=n`, `=|l-5`, `==a@-20`).
- **both:** the same target is a component **and** a metrics key. Do not infer
  edges from glyph names. Unresolved names are omitted. No reverse graph is
  stored; invert in memory.

Write the full index on **cloud seed**. Patch **that source row** on live
component or metrics-key commits (`getPathSegments`, not `split('.')`). Do
not rebuild the whole index on open. Do not rewrite `font-deps` while HTTP
glyph hydrate applies shards. The sparse **working set is in-memory only**
(`PatchSyncEngine`); never persist it in `font-deps`.

#### Which glyphs to hydrate

```text
seeds     = cmap(`?text=`) and/or Download Glyph(s) names
layout    = FEA substitution targets of seeds only   // close_layout(seeds)
origins   = encodedBases(seeds) ∪ layout
            // composite seed adieresis → non-mark component a
            // do not treat layout alts (a.ss03) as encoded-base origins
reverseW  = reverse*(origins) over component and both
            // a → adieresis, aacute, ae; a.ss03 → adieresis.ss03
working   = reverseW, then forward* over strict `component` only
            // nested outline parts (dieresiscomb, e of ae)
            // previous working ids unioned only if they are not
            // metrics-key/both stems of this family
hidden    = forward*(working) over metrics-key and both   // n, l, o
            ∪ reverse metrics inheritors of working       // a.wide keyed to a
            ∪ forward* component of those inheritors
            minus working
load      = working ∪ hidden
```

Hard rules:

- Do **not** `close_layout` (GSUB) the reverse set. OT stays on user-chosen
  seeds only.
- Do **not** reverse-close from hidden metrics sources (`n` must not pull
  `h` / `ntilde`).
- Do **not** put metrics-key or `both` stems in the working set. `a.ss03 → o`
  (`leftMetricsKey: "o"`, often stored as `both`) loads `o` **hidden**. Reverse
  from `o` would walk Latin.
- Forward working close is **strict `component`**, not `both`. Reverse
  working close **does** follow `both` so composites that also inherit
  metrics from their base still reverse-close.
- Hidden glyphs are resident for compile/sidebearings. Overview shows a faint
  tile. Download Glyph(s) may promote a hidden glyph to a seed (then it
  becomes working and reverse-closes *its* family).

#### One plan, one fetch

Sparse `?sparse=true` open:

1. HTTP `font-core` + published `font-deps`.
2. Overlay **live** `GET …/shards/font-deps/live` before planning (published
   deps is often empty or stale).
3. Compute `load` once. Fetch every missing glyph shard. Then show the font.
4. Do **not** paint a seed-only set and expand composites after the live
   WebSocket attaches.

A later body-named component absent from deps may trigger one repair fetch
(fixed point). That is not a second UI stage. Layout closure for arbitrary
CJK feature sets can still explode past browser budget. Bound hydrate size;
beyond budget use subset compile or server preview rather than loading the
world. That budget is a product policy on the *result* of closure, not a
reason to skip layout closure.

### Hydrate and repair

1. **Hydrate** the missing `load` set (parallel per-shard GETs).
2. **Fallback:** if a loaded glyph references an id absent from deps, repair
   (request that id, patch deps). Not the steady-state path.

## Live subscription vs freshness

Persistent WebSocket subscriptions stay tiny:

| Channel | When |
| --- | --- |
| `font-core` | Always |
| Subset glyph DOs | Glyphs in this instance’s live subset |
| Other glyph DOs | No persistent socket |

When a remote edit commits:

1. Writer persists the glyph shard (outline + `sync.revision` stamp) first.
2. Core then publishes `glyphRevisions` (`{ glyphId, revision }[]`) in **one**
   collab envelope.
3. Every cloud-connected instance must catch up — not best-effort. Peers GET
   `/shards/glyph:<id>/live` (DO live state). Apply as a checkpoint; retry
   until the stamp is present. Cap 4 in flight. Broadcast the result to linked
   windows.

Do not catch up from a stale R2 baseline. Switching the active glyph:
subscribe the new shard (catch up first if needed); drop the previous socket.

## Linked windows (same browser)

Main window is the only cloud WebSocket client; it relays to linked windows
over `BroadcastChannel` (`WindowSync`). Packets are document-scoped
(`documentId`: `font-core` | `font-deps` | `glyph:<id>`). Core revision
signals use `onGlyphRevisionSignal`, not `onLocalUpdate` (avoids Yjs client
clock holes on the same core doc).

Each window keeps core + deps always, plus the glyph docs it has applied.
Bootstrap is `full-state-request/response` with a **document set**; the
linked worker is seeded with `seedWorkerDocumentSet`. CJK-scale bootstrap
(core only + selective glyph fetch) is later.

Cloud HTTP catch-up on main is fanned out on BC. A MetadataFree glyph packet
on a linked window is applied as `applyDocumentCatchUp`.

| Path | Linked windows |
| --- | --- |
| Local sync | BC, multi-doc packets |
| Cloud live | Main multiplexes DO sockets for the window group |
| Passive glyphs | Core dirty + HTTP live catch-up, then BC relay |
| Worker seed | `seedYdoc` document set (`state` bytes per shard) |

## Seeding

1. Client (or materializer) uploads shard baselines to R2 (core, deps, glyph
   packs).
2. Worker verifies size/hash; DO **adopts manifest metadata only**.
3. No DO applies full Yjs state into memory.

Initial seed is also when the deps index is first built: the seeder already
has full glyph bodies locally.

## Local vs full compilation

### Local editing compile (browser)

1. Load core (+ deps index as needed)
2. Resolve seeds from UI/text
3. Compute **compile** closure: `close_layout(seeds)` then **forward** deps
   (not `reverse*`)
4. Hydrate missing shards
5. Assemble ephemeral font from loaded shards
6. Existing subset / compile pipeline on that assembly (`RetainGlyphs` et al.)

Never treat unhydrated as absent. **Editing** hydrate (browse/edit a seed)
uses UI sparse hydration (`reverse*` then forward-close). **Compile** uses
the two-phase forward-only algorithm so packs and compiles agree with
`prime_layout_closure_cache`.

### Server full-font compiler (proofing / export)

Full binary builds for fonts over browser policy are a **multi-core VM (or
container) job** — never a Durable Object and never a browser holding the
entire CJK outline set. The builder uses the **same shard model and update
semantics** as the editor; it does **not** open 65k glyph DO WebSockets.

```text
R2 baselines + DO tails
        │
        ▼  hydrate policy `all` (HTTP packs)
Full-font builder VM  ── font-core WS (dirty / revision)
  (multi-core fontc)  ── HTTP catch-up for dirty glyph shards only
        │
        ▼  OTF/TTF artifact
Proofing browser tab  ← stream / poll binary (+ stale/building status)
```

**Rough pipeline**

1. **Cold start:** HTTP hydrate `font-core` + `font-deps` + every
   `glyph:<id>` from R2 packs (Worker-streamed), apply outstanding DO tails
   the same way a client recovers recoverable state (baseline + tail).
2. **Materialize** one in-process babelfont (or fontc IR) for the full font.
3. **Compile** with native fontc using **real multiprocessing** (unavailable
   in browser WASM).
4. **Publish** the binary (R2 object and/or direct stream) with a revision id
   tied to the core/deps/glyph shard manifest used for the build.
5. **Proofing client** loads that binary into HarfBuzz (or downloads for
   export). UI shows building / ready / stale relative to the live room.

**Live updates (same language, different residency)**

| Concern | Editing browser | Full-font builder |
| --- | --- | --- |
| Hydrate policy | Working set (`all` only for small fonts) | Always `all` |
| Live DO sockets | `font-core` + active glyph(s) | `font-core` only (optional build-control channel) |
| Glyph freshness | Dirty signal + HTTP catch-up | Same: patch only touched glyphs, enqueue rebuild |
| Optional trigger | N/A | Commit / compaction hooks enqueue builds without a long-lived subscriber |

Do **not** subscribe the builder to every glyph DO. 65k live sockets would
dwarf the compile cost. Core dirty fan-out + selective glyph catch-up (or a
build queue) is enough and stays aligned with how passive hydrated glyphs
already refresh in the editor.

**Debounce and status.** Full CJK compiles are tens of seconds to minutes.
Debounce rebuilds on edit bursts; proofing tabs must tolerate lag and show
stale-vs-current clearly. Live updates reuse the editor’s **document-patch**
language (core dirty → HTTP glyph catch-up → rematerialize). Expect mostly
**full native fontc recompiles** after that — the warm machine’s win is
avoiding re-hydrate + IR rebuild every edit, not fine-grained fontc IR reuse
(unless measured later).

**Where it runs (recommended infrastructure).**

Never a Durable Object or Worker isolate. Same fat-process class as the
oversized-shard / migration compactor — not the steady-state Worker
compactor.

| Mode | Host | When |
| --- | --- | --- |
| **Interactive proofing (default)** | **Session-scoped Fly Machine** (or equivalent microVM): start when a proofing client attaches, stop/suspend after idle | Needs the full font resident for the editing session |
| One-shot export / offline build | Same image as a queue job; scale to zero after publish | No live listen required |
| Cloudflare Containers | Acceptable CF-native alternative for lighter fonts | Max instance is **12 GiB**; fine for Plangothic-class, tight for heavy multi-master peaks |

**Session model (interactive).** One machine per active proofing session (or
per asset while proofing is open), sized from the RAM table below (**8 GB**
Plangothic-like, **16 GB** heavy CJK VF). Lifecycle:

1. Collab Worker (or proofing control API) starts the machine.
2. Machine cold-hydrates all shards once, materializes IR, compiles, publishes.
3. Stays warm: `font-core` dirty channel + HTTP catch-up for touched glyphs →
   debounced recompile → new binary revision.
4. On proofing disconnect / idle timeout: suspend or destroy. Persist only R2
   shards + last binary artifact — do **not** keep full-font RAM between
   sessions.

**Cost vs spin-up.** Bill **RAM × session hours**, not 24/7 per asset. OS/container
cold start (≈1–3 s, or ~1 s Fly resume-from-suspend) is noise next to first
hydrate of a ~100–450 MB CJK glyph set. Therefore: keep warm for the session;
scale to zero between sessions; never hydrate-from-cold on every edit.

Do **not** use a shared always-on fleet until concurrent CJK proofing rooms
justify it. Do **not** use scale-to-zero **per edit** — that re-pays hydrate
cost and ruins interactive feel.

### Rough RAM estimates (order of magnitude)

Measured compact JSON from the sibling CJK sizing experiment
(`cjk-collab-sizing/results/sizing.md`), ~65k-glyph class:

| Source (compact JSON) | Glyphs | Glyphs JSON | Core JSON | Notes |
| --- | ---: | ---: | ---: | --- |
| Plangothic P1 | 64,579 | ~100 MB | ~6 MB | Single master; sane core |
| Plangothic P2 | 41,994 | ~59 MB | ~4 MB | |
| Source Han Sans SC VF (TTF round-trip) | 65,535 | ~218 MB | ~133 MB | Core almost all enumerated FEA artifact; **not** target shape |
| SHS-like with class kerning (est.) | ~65k | ~218 MB | ~6–10 MB | Source-shaped features; glyphs still heavy |

In-process budgets are larger than compact JSON:

| Stage | Plangothic-like (~65k, 1 master) | Heavy CJK VF (~65k, multi-master, sane FEA) |
| --- | --- | --- |
| Shard payloads on disk / R2 | ~100–160 MB | ~200–450 MB |
| Hydrated source IR in builder | ~0.3–0.8 GB | ~0.8–2 GB |
| Peak during fontc (IR + tables + temps) | ~1–3 GB | ~3–8 GB |
| Output OTF/TTF (order of mag.) | tens of MB | tens–low hundreds of MB |
| **Suggested VM RAM** | **4–8 GB** | **8–16 GB** |

Factors that move the peak: master count, contour density, feature/kerning
complexity, concurrent builds, and whether two revisions overlap in memory.
**Do not** size from TTF-uncompiled feature dumps (~129 MB FEA prefixes alone);
keep source-shaped features in core.

Browser / DO remain unbound by these peaks: they never hold the full outline
set for CJK-scale proofing builds.

## Cross-document operations

Independent Y.Docs cannot atomically span core and glyphs. Use explicit
idempotent multi-doc ops in core for create / rename / delete / dependency
republish. Prefer immutable glyph ids and tombstones.

## Memory budgets (normative intent)

| Component | May scale with | Must not scale with |
| --- | --- | --- |
| Glyph DO | peers, tail, in-flight buffers | other glyphs, full font, compaction peak |
| Core DO | peers, tail, lean catalog churn | glyph outlines, compaction peak |
| Worker-class compactor | one shard’s baseline + dirty tail (+ ~2–4× GC peak) | whole font; any shard over recoverable cap |
| Fat-process compactor / builder VM | oversized shard or full glyph set + fontc peak | DO / Worker isolate limits |
| Worker hydrate | concurrent stream buffers / page size | sum of all pack bytes held at once |
| Browser session | core + deps + working-set glyphs | entire CJK outline set by default |

## Migration sketch

Done in the editor: immutable glyph ids, document-scoped updates, WindowSync
document packets + linked `seedWorkerDocumentSet`, HTTP live catch-up from
the glyph DO, revision stamp-before-core-signal.

Still to do:

1. Residency + hydrate packs: compile closure vs UI sparse hydrate
   (`reverse*` then forward-close) without shipping every glyph on linked open.
2. Finish opaque-byte FontRoomDO (no Yjs import, SQLite spool, isolated
   validator before ACK) and `appliedLogId` reconnect on every shard.
3. External compaction per shard with pinned-H CAS; refuse or hand off
   oversized shards (`needs-fat-compactor` / `tail_full`).
4. Owner-authorized protocol 4 epoch + immutable asset manifests (in
   progress; mixed v3/v4 writers rejected at auth).

## Explicit non-goals (for the first cut)

- Two parallel architectures (small-font mode vs CJK mode)
- Presigned client R2 credentials as the primary design
- Generic server-side Yjs state-vector diff against a hydrated DO doc
- Loading full feature closure into the browser for arbitrary CJK fonts
- DO-owned steady-state full-state checkpointing / GC compaction
- Treating today’s Worker compactor as unlimited RAM (“outside 128 MiB”)

## Open follow-ups

Settled in v1 (do not re-open without a product change):

- Owner-subscription quotas (website source of truth; plugin + collab enforce)
- Basic: 1 font / 1000 glyphs
- Cmap: per-entry `codepoints` **plus** reverse `codepoint → glyphId[]`
- Browser per-shard encoded ceiling: 5 MiB (warn 75%; live commit reverts on reject)
- Worker-class compactor is `compactor` once room IDs/R2 keys are sharded
- Deps: UUID per-edge maps; reverse derived in memory, never stored
- Outlines: atomic topology + packed positions; nested numeric shape writes forbidden
- Nested JSON: leaf getters/setters; dict assign is a symmetric Y.Map diff

Still open:

- Denser cmap for CJK text performance beyond the reverse map
- Linked-window interest protocol: how precisely main aggregates active-glyph
  DO subscriptions across local windows
- Thinner `close_layout` API: `{ features, glyphNames, seeds }` without a full
  `Font` (optional cleanup in babelfont-rs)
- Layout-closure result size budget for CJK working-set hydrate
- Whether kerning / feature sources leave core after v1
- Structured feature-class membership vs AFDKO string leaves
- UX for range hydrate and “server preview required”
- Load measurements against Plangothic and Source Han Sans
- Server builder: measured fontc peak RAM on real Plangothic / SHS-source
  builds; proofing stream protocol; Fly vs CF Containers bake-off at 8–12 GB
- Fat-process compactor: when to enqueue from Worker 413 vs migrate-only;
  shared image/host pool with the session builder or separate

## Zero-hydration rooms (protocol 4)

Peak we are designing for: live DO = sockets + SQLite tail + **one** in-flight
packet ≤ 256 KiB (no long-lived `Y.Doc`). Validator = empty `{gc:true}` doc +
one packet. Compact Worker = `{gc:true}` doc of checkpoint + packet-sized tail
applies and folds — never checkpoint + merged tail + a max live packet at once.

```text
FontRoomDO: SQLite tail → one-copy fan-out
     stream rows id > L
cf-compactor: R2 checkpoint → applyUpdate gc:true drop buffers
            → optional encode-fold → encode destroy put R2
     → DO CAS promote + truncate tail
```

Live Durable Objects are an authenticated opaque-byte journal. They do not
import Yjs, hydrate a long-lived `Y.Doc`, encode snapshots, or merge tails.

**Ingress (hibernation-safe):** (1) DO checks auth, wire types, frame/chunk
bytes, metadata, and quotas. Production tokens require a monotonic
`accessEpoch`; epoch 0/absent cannot bypass a newer room epoch. Website
advances it on revoke/remove/delete and the room fans the epoch out to hub +
known shards, then closes stale sockets. Viewers cannot write. (2) Decode one
frame into `ingress_spool` (`committed=0`) keyed by connection + client seq +
transaction UUID. (3) Isolated `validator` Worker applies a throwaway
`{gc:true}` doc and callbacks digest/size. (4) Only after SQL commit: ACK and
fan-out. Failure deletes spool; no durable tail and no peer exposure.
(5) Duplicate tx/chunk and validator retries are idempotent. Bound peers,
attachments, metadata, spool bytes, dirty rows/bytes, and
`checkpoint + committedDirty + spool + incoming` under the encoded-shard
budget.

Internal manifest/export/promote/adopt routes require service-binding auth
with a scoped secret, not a caller-supplied marker header alone. Strip
internal headers at the public edge. Canonical shard names only
(`font-core`, `font-deps`, `glyph:<UUID>`); seed/create is checked against the
**asset owner’s** Website D1 entitlement and a signed shard manifest.

Writes (`update`, `sync-complete`) only **schedule** compact. They never
compact inline. Soft dirty (256 KiB or 64 rows, or 30 min
`firstDirtyAt`) alarms the Worker; 413 is terminal (`needs-fat-compactor`);
the hard dirty cap is `tail_full` (WS `error.code = tail_full`, read-only)
but compact still runs so the room can drain. Operator inbox: `GET /api/internal/cloud/shard-ops` on Website D1, also listed
on the admin dashboard Cloud Rooms table. Keep the tail; never drop
acknowledged updates.

Compaction pins `(L0, H]` and pages by **byte budget and row cap**. One
versioned length-prefixed binary protocol for `/live`, WS replay, validator
spool, and compactor pages. SQLite `room_state` is the sole authority for the
checkpoint pointer; R2 `current.json` is a post-commit cache. Mutation-history
fetch failure aborts without writing `envelopes: []`.

Existing cloud assets use an owner-authorized schema/protocol 4 migration
epoch: `POST /api/cloud/assets/:id/migrate` quiesces writers (access epoch +
`migration_status=seeding`, seed-only room tokens), the owner reseeds shards,
then `POST /api/cloud/assets/:id/manifests` atomically publishes a new
immutable `font_asset_manifests` row and CAS-switches `manifest_revision`.
Failure leaves the previous pointer readable. Rollback is
`POST .../manifests/rollback` to an earlier revision — checkpoints are not
rewritten. Mixed v3/v4 writers are rejected at auth. Catalog deletes keep
generation tombstones; delayed orphan shard rows use `font_shard_ops` status
`orphan-pending`. Sparse hydrate retries until the published core/deps
revision pair matches.

Reconnect carries `checkpointLogId` and `appliedLogId`. If
`appliedLogId < currentCheckpointLogId`, the client must rebaseline.

`font-core` holds catalog + cmap only. `font-deps` stores UUID edge maps
(`component | metrics-key | both`) and is repaired from converged glyph shards.

Workers live in `counterpunchspace/collab`. Cloudflare **script names** are
`room`, `compactor`, and `validator` (`fonts-room` / `cf-` prefixes are gone).
`FontRoomDO` is declared only on `room`. R2 buckets stay
`fonts-room-state` / `fonts-room-state-preview`. Target layout:

```text
collab/
  packages/protocol/          framing, constants, auth helpers
  workers/room/               public edge + FontRoomDO
  workers/compactor/          compaction isolate
  workers/validator/          Yjs ingress validation isolate
```

Push to `main` deploys callee-first (not atomic): validator, then
compactor, then room. Stop on the first Wrangler failure. Local `npm run
dev` is Wrangler multi-config; room is HTTP on 8787. After the first
production deploy of `compactor`, disable the Deploy workflow on
`yanone/cf-compactor` so two CIs cannot overwrite it. Existing `fonts-room`
Durable Object SQLite does not move automatically.

### Capacity (checked-in Node + Worker benches)

Run in the collab repo (`counterpunchspace/collab`):

- `npm run bench:section5` — Node matrix, room, Chromium `{gc:false}`,
  Worker apply/encode until isolate death, then `apply-capacity-limits`
- `npm run bench:capacity` — full core×kerning×features cartesian (674…20k),
  JSON/encoded/structs/heap/rss/encode-peak, compact tails, Node `{gc:false}`
- `npm run bench:browser` — Chromium page with bundled Yjs `{gc:false}`
- `npm run bench:room` — frames, export/spool pages, FontRoomDO one-copy
  fan-out, slow-peer close, `/live` one-page pull backpressure
- `npm run bench:wrangler-oom` — real **validator** and **compactor**
  bundles (`CompactSession` apply/drop/fold) on **every** §5 fixture.
  `CAPACITY_BENCH_REMOTE=1` runs on Cloudflare preview isolates (128 MB). Local
  `[limits] memory = 128` does not emit `Exceeded Memory`. Local substitute:
  V8 `--max-old-space-size=128` applying **Node-encoded** checkpoints.
  `scripts/apply-capacity-limits.mjs` writes gates when `oomFound` is true.
  This repo’s checked-in gates are from Cloudflare preview
  (`productionOom=true`, `Worker exceeded resource limits`).

Editor production graph samples:
`webapp/tests/section5-capacity.test.js` (`jsonToCoreFontMap`,
`writeFontDepsYMap` component/metrics-key/both, `writeLayerGeometry`,
`{gc:false}` undo/merge/unsent rebaseline). Seed `POST /state` calls
`validator` before R2 put. Preferences shows a live CRDT warning and an
explicit **Clear undo history** control (`truncateUndoHistory()`).

Node `heapUsed` is a lower bound. Cloudflare preview sweep 2026-09-04
(`wrangler-oom.json`, `productionOom: true`): 220 Worker rows; seed 1.43 MB
OK; last successful **validate 8.65 MB**, last successful **compact 7.87 MB**;
first compact death was `Worker exceeded resource limits` on
`compactor-capacity-bench` at 5.54 MB (later larger applies still
succeeded after isolate restart). Lean-core 80k and high-struct 800k also
died. Last-OK × 0.7: **5 505 773 bytes**, **280 000 structs**. Product
admission is **5 242 880 bytes** (5 MiB). 10 MB is not raised (need last OK ≥
~14.3 MB).

| Fixture | Encoded | Structs |
| --- | ---: | ---: |
| V8 baseline empty doc (Worker) | 2 B | 0 |
| font-core current 1000g | 91 KB | 5 004 |
| font-core target 1000g | 57 KB | 3 004 |
| font-core target 20 000g | 1.3 MB | 60 004 |
| kerning 1k / 50k / 200k | 21 KB / 1.2 MB / 5.2 MB | 1 001 / 50 001 / 200 001 |
| features 100 KB / 1 MB | 100 KB / 1.0 MB | 7 / 7 |
| font-deps UUID mixed kinds dense 5000g | 1.2 MB | 45 001 |
| glyph topology+packed 1×5000 | 176 KB | 5 003 |
| glyph flat-nested 2×5000 | 563 KB | 40 013 |
| Node compact + 32 leaf tails | 57 KB | 3 006 |
| font-core target 1000g × 200k kerning × 1 MB features | 6.4 MB | 203 012 |
| font-core current 20 000g × 200k kerning × 1 MB features | 8.35 MB | 300 012 |
| Chromium `{gc:false}` 10k leaf edits | 198 KB | 10 001 |
| glyph packed `{gc:false}` 10k drags undo/redo | 109 KB | 57 |
| validator seed / production-core 1000g+50k+100 KB | 1.43 MB | 53 012 |
| compactor production-core + 32 leaf tails | 1.43 MB | 53 014 |
| validator+compactor production-deps 5000 dense | 1.18 MB | 45 001 |
| validator+compactor production-glyph 2×5000 packed | 356 KB | 10 006 |
| validator+compactor lean-core 80k | 5.31 MB | 240 006 |
| validator+compactor 20k×200k×1 MB (last OK validate) | 8.65 MB | 300 012 |
| compactor last OK | 7.87 MB | — |
| compactor 674g×200k×100 KB (5.54 MB) | isolate death | `Worker exceeded resource limits` |

FontRoomDO at 32 peers: slow peer `1013 slow-peer`, heap delta ≈153 KB, no
per-peer queue. `/live` pull: checkpoint then one concatenated export page
(264 KB for 64×4 KB rows) then remainder then terminal. Packed LWW deps are a
benchmark only.

| Limit | Value | Source |
| --- | --- | --- |
| Client shard encoded ceiling | 5 242 880 B (5 MiB) | Product admit; isolate last-OK × 0.7 was 5.50 MB |
| Live Yjs packet | 262 144 B (256 KiB) | Leftover under compact last-OK × 0.7 minus full shard; `settings.ts` fail-closed |
| Validator / compact transaction | 262 144 B | same as packet |
| Validator / compact decoded structs | 280 000 | last OK 400k structs × 0.7 |
| Worker recoverable compact | 5 242 880 B | 413 → fat-compactor |
| Fold output / fold threshold | 262 144 B | packet-sized fold, never a second 5 MiB copy of pending tail |
| Export / stream page | 512 KB / 64 rows | one in-flight `/live` page |
| SQLite spool | 524 288 B | two max packets |
| Dirty soft / hard | 256 KiB or 64 rows / 262 893 B | alarm vs `tail_full` (compact still runs) |
| Authenticated peers | 32 | FontRoomDO; slow peer closed |
| Unauthenticated sockets | 8 | pre-auth |
| Metadata / attachment | 64 KB / 8 192 B | live extras / hibernation |
| Client `{gc:false}` warning | 80k structs or 3 932 160 B | Preferences; unsent kept; `truncateUndoHistory()` explicit |
| Worker bundle (dry-run) | ~980 KB / ~1.0 MB | validator / compactor |

### Docs and tests (plan §6)

Normative behavior is this file plus collab `packages/protocol` constants.
Checked-in coverage (not a second spec):

| Theme | Where |
| --- | --- |
| Ingress / reconnect / `appliedLogId` / `tail_full` / slow peer / hibernation mid-chunk / duplicate tx ids / validator never ACK | `collab/collab/workers/room/test/font-room-do.test.js`, `workers/room/test/index.test.js` |
| No Yjs in the room DO | `FontRoomDO source does not import yjs` |
| Hostile / oversize Yjs pre-ACK | `validator/test`, `validator failure never journals or ACKs` |
| Pinned compact, malformed/incomplete tail, digest mismatch, CAS 409, mutation-history abort, 413 fat-compactor | `workers/compactor/test/index.test.js`; promote dirty recount + crash-before-`current.json` in FontRoomDO tests |
| Nested writes, outline topology, last-good compile cache | `webapp/tests/nested-json-leaf-writes.test.js`, `layer-geometry-ydoc.test.js`, `babelfont-fontc-build` last-good shapes test |
| Deps repair, over-hydrate never under-hydrate, core has no deps | `webapp/tests/cloud-glyph-catalog.test.js` |
| `appliedLogId` only after apply | `webapp/tests/cloud-adapter.test.js` |
| 256 KiB packet / 5 MiB shard reject + rollback (`settings.ts`) | `webapp/tests/collab-submit-limits.test.js`, `webapp/tests/settings.test.js` |
| Schema migration epoch, immutable manifests, rollback-by-revision | `website/test/cloud-schema-migration.test.js` |
| Catalog generation tombstones, published core/deps hydrate pair | `webapp/tests/cloud-glyph-catalog.test.js` |
| Seed-only live writes during migration | `collab/collab/workers/room/test/font-room-do.test.js` |

Local `npm run dev` in the collab repo starts room + compactor + validator
together (Wrangler multi-config). Fat compact stays out of scope. Set website
`ROOM_WORKER_URL` to the `room` origin.


