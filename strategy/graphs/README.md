# Graphical code graphs

Standalone HTML snapshots for architecture drawings that follow
`instructions/GRAPHICAL_CODE_GRAPHS.md`. Each page is one graph: styles,
runtime, icons, and data are inlined. Open the HTML in a browser; there
are no CDN, font, or Cursor runtime dependencies.

The Cursor canvas beside chat can stay as a scratchpad. This folder is
the current, shareable view. Git history of these files is the
before/after.

## Layout

```
strategy/graphs/
  README.md
  engine/
    render.mjs    # JSON → self-contained HTML
    runtime.js    # hover, start/stop, legend, view filters
    styles.css    # light default, dark via prefers-color-scheme
  data/
    *.json        # one graph each
  *.html          # generated; do not edit by hand
```

## Add or update a graph

1. Put a graph object in `data/<id>.json`. `id` becomes `<id>.html`.
2. From the repo root:

   ```bash
   node strategy/graphs/engine/render.mjs
   ```

   Pass a JSON path to rebuild one file. Rebuild after changing
   `engine/runtime.js` or `engine/styles.css` as well.

3. Open `strategy/graphs/<id>.html`. Hover chips and the legend; use the
   view pills. Start (green triangle) and stop (red octagon) appear only
   when the highlighted lanes uniquely begin or end on a chip.

Keep node ids stable so git diffs stay readable. Update the same JSON
and regenerate the same HTML; do not add `*-before` / `*-after` copies.

## Graph JSON

Required: `id`, `title`, `layout`, `nodes`, `edges`, `lanes`.

Typical extras: `lede`, `stats`,
`callout`, `headers`, `columnTitles`, `footerTitle`, `views`, `legend`,
`notes`, `later`.

Layout keys match the canvas geometry (`chipW`, `chipH`, `colGap`,
`rowGap`, `originX`, `originY`, `storyCols`, `storyRows`, `filterCol`,
`sink`, `compiledId`, `renderedId`).

Legend and view filters use declarative matchers, not functions:

```json
{ "node": { "stage": "live" } }
{ "node": { "unify": "delete" } }
{ "node": { "mark": "start" } }
{ "edge": { "route": "leak" } }
```

`stats` may use `"value": "unifyCount"` to count nodes with a `unify`
badge.
