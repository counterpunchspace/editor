# Graphical code graphs

Standard for architecture snapshots that show how code actually runs — not
class diagrams, not generic flowcharts. Adjust this file as the format
evolves.

Pair a graph with:

1. Standalone HTML under `strategy/graphs/` (JSON in
   `strategy/graphs/data/`, generated page beside it). The engine in
   `strategy/graphs/engine/` inlines styles, runtime, and data so the
   page has no external dependencies. That HTML is the current view;
   git history of the same files is the before/after.
2. A canvas at `~/.cursor/projects/<workspace>/canvases/<name>.canvas.tsx`
   when the graph should stay interactive beside chat.

## When to draw one

Use a graphical code graph when several types, classifiers, or funnels
implement the same product idea. The drawing’s job is to make parallel
paths, empty stages, and real shared chokepoints visible, so a later
commit can show collapse.

## Layout

Combine swimlanes with a merge/fan:

- **Left: stories.** One user-facing action or packet kind per row
  (outline, anchor, sidebearing, …). Columns are per-story stages
  (gesture, live stamp, commit stamp, extra classifier, …).
- **Partial columns are required.** If a stage does not run for that
  story, leave the cell blank. Do not route that row through a leftover
  box sitting in another row.
- **Middle: chokepoints, drawn once.** If many stories call the same
  function, that function is one chip — not a copy on every row. Incoming
  rails merge into it. That is how the drawing proves a lean transformer
  exists (or that a supposed funnel is being skipped).
- **Right: consumers, drawn once.** Modes, listeners, or parsers that
  read the transformer’s output sit after the sink and fan out from it.
- **Footer: shared machinery with edges.** Rust parsers and the like sit
  in a footer band, connected from the sink — not from every story row,
  and not as a disconnected caption.

Live vs commit on the same story are **two identities**, not a
left-to-right rewrite. Fork them from the gesture (a south rail under the
live stamp into the commit stamp). Do not draw live stamp → commit stamp
as if one value became the other.

Read order: left (stories, including JS events) → change bridge
(local fan-out / remote fan-in) → overview filter events → merge
(funnels) → one transformer → `editingFontCompiled` → canvas →
`glyphCanvasRendered`. Rust parsers hang off the transformer (they run
inside it).

Leave **generous gaps** (about 50px columns, 40px rows) so merge rails
can be traced without sitting on chips.

## JS events and overview filters

Place event chips **where they fire**, not in a dumping column at the
end:

- Per-story, after the stamp/classifier: `glyphChanged`,
  `layerFingerprintChanged`, and similar model events (`bolt` icon).
- After the change bridge: overview filter `EVENT_TYPES`
  (`glyph.paths.changed`, `glyph.anchors.changed`, …) from
  `deriveGlyphFilterChangesFromCommittedEntry`. These are Python
  filter subscriptions, not `window` CustomEvents (`filter_list` icon).
  Leave the cell blank when that story does not emit a glyph-content
  filter event (kerning).
- After the transformer: `editingFontCompiled` (the canvas listens here).
- After canvas modes: `glyphCanvasRendered`.

Subtitle is any second event at that same moment.

## Change bridge

Draw **ChangeBridge once**, between story JS events and overview
filters:

- Local canvas commits **fan out** into it (Yjs /
  `_syncCurrentGlyphToYDoc` / `onCommittedChange` origin local).
- Linked or remote windows **fan in** from a separate origin chip
  (`applyRemoteUpdate`) into the same bridge, with no local gesture and
  no live overlay.
- Live lanes skip the bridge and hop north into the live funnels.

## Unification marks

If the graph still has a cleanup ahead, mark chips that should
**delete**, **combine**, or **remove** (alias/leak). Use a small DEL /
CMB / RM badge on the chip. The interactive HTML (and canvas) explain
the mark on hover. Do not mark the chips you intend to keep.

## Start and stop marks

Compute from the **currently highlighted lanes** (the lanes through the
hovered chip). With no hover, or when several paths overlap on a chip,
hide the marks.

- **Start:** green triangle on the **left** edge. Visible only when
  every highlighted lane begins on that chip. Local canvas origins get
  it on the gesture chip. Remote/linked paths get it on the remote
  window chip, never on a local canvas gesture.
- **Stop:** red octagon on the **right** edge. Visible only when every
  highlighted lane that **touches** that chip ends there. If some of
  those lanes continue, hide it (typical: a shared funnel that drops
  guide but compiles everything else).

These marks need hover, so they belong on the standalone HTML page and
the Cursor canvas, not on a frozen image.

## Legend

Keep a **tiny** legend **above** the details card (not a large grid
under the graph). Hovering a legend item lights matching chips;
hovering a chip lights matching legend items.

## Connections

- On the story block, connect filled cells that belong to the same
  identity (gesture → live stamp, or gesture → commit stamp → extra
  classifier). Hop Manhattan-style over blanks.
- From the last story chip of an identity, merge on a **rail** into the
  change bridge (commit) or the shared live funnel (live). Live rails
  travel north of later chips so they do not cut through commit stamps,
  the bridge, or filter chips.
- After the sink, fan to consumer chips. Downward drops to the footer
  are allowed; do not cross consumer chips to reach the footer.
- **No backward edges.** If a later function disagrees with an earlier
  stamp, show that as its own chip in an “extra classifier” column, then
  merge that chip into the chokepoint (or a dashed leak around it).
- Solid stroke = authoritative flow. **Dashed + accent** = alias, lie,
  unused kind, or a hop that skips the funnel.
- Stroke weight about **2.25px**, with a small filled arrowhead. Direct
  edges of a hovered chip may go to **3px**. Do not use thin unlabeled
  bezier fans.

## Chips

- One chip = one function, type, or mode that a reader can search for.
- **Material Symbols Outlined**, weight 400, 16px, `viewBox="0 -960 960 960"`.
  Paths come from the Material Symbols set (Apache 2.0). Do not use emoji.
- Two icons on one chip only when two real owners share the cell.
- Subtitle is the symbol or string the code uses (`editType outline`,
  `startsWith mouse-drag`).
- The transformer chip may be taller than a story chip so the merge is
  obvious. Do not duplicate it per row to “fill the column.”

Suggested icons: `polyline` outline, `anchor` anchors, `align_horizontal_left`
sidebearing, `square_foot` guides, `space_bar` kerning, `alt_route` bypass,
`block` unused, `swipe` live pointer, `keyboard` key, `swap_horiz` alias,
`commit` commit stamp / commit funnel, `account_tree` extra classifier,
`memory` compile, `brush` canvas, `manufacturing` Rust, `bolt` JS event,
`filter_list` overview filter, `sync_alt` change bridge, `laptop` remote window.

## Hover

The standalone HTML page (and the Cursor canvas) must:

1. On chip hover, highlight every inbound and outbound edge, and every
   full lane through that chip.
2. Show start/stop marks only for the highlighted path, as above.
3. On unification-badge chips, explain delete / combine / remove.
4. Keep a **tiny legend above the details card** that lights when a
   chip is hovered, and lights matching chips when a legend item is
   hovered.

Rebuild HTML with `node strategy/graphs/engine/render.mjs`. See
`strategy/graphs/README.md`.

## Color

- HTML snapshots: light print palette by default, dark via
  `prefers-color-scheme`. Accent stroke for aliases, extra-classifier
  chips, and hovered edges. Story-row bands only under the story block,
  so the merge region stays visually separate.
- Canvas: `useHostTheme()` tokens only. Same geometry as the HTML.

## Snapshot discipline

- Keep node **ids** stable (`g-outline`, `funnel-commit`, `compile`,
  `cv-outline`, …) so git diffs stay readable when chips disappear.
- Caption how to read blanks, dashes, and the single sink.
- Update the same JSON and regenerate the same HTML. Do not keep
  parallel `*-before` / `*-after` files; commit reviews are the
  comparison.

## What “better” looks like

A later graph for the same product should keep the chokepoint shape
(stories → fewer funnels → one transformer → consumers) with **fewer
story columns**, fewer dashed alias hops, and no leak around the funnel.
If a new graph needs more bezier nets to stay truthful, the code — not
the drawing — is still scattered.
