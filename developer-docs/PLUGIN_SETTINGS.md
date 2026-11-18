# Plugin settings

Contract checks for `SETTINGS` live in `plugin-contracts/`. See `PLUGIN_CONTRACTS.md`.



Any bundled Python plugin may declare `SETTINGS`. Counterpunch renders them, stores them, and passes the resolved values back as `context.settings`. Plugins do not persist settings themselves.

```python
SETTINGS = [
    {
        "id": "composition_output",
        "type": "radio",
        "label": "Composition output for new glyphs",
        "help": "For letters that Counterpunch can build from other glyphs, such as Ä from A and ¨.",
        "target": "add-glyphs",
        "options": [
            {"value": "ccmp", "label": "On-the-fly Composition (ccmp)", "help": "You draw and maintain only the base shapes. …"},
            {"value": "materialized", "label": "Components", "help": "Each letter, and each of its joining forms, is its own glyph in the font. …"},
            {"value": "none", "label": "Empty", "help": "The new glyph has nothing in it, and no parts are added. …"},
        ],
        "default": "ccmp",
        "regenerates": False,
    }
]
```

Required fields are `id`, `type`, and `default`. `target` selects where the control appears. Unknown targets fall back to `font-info.skills`.

Allowed types: `checkbox`, `radio`, `select`, `number`, `slider`, `textfield`, `color`. `radio` and `select` need `options`. A `radio` option may add `help`, a sentence shown with that choice. `number` and `slider` should set `min`, `max`, and `step`.

`regenerates` defaults to true for feature generators. When it is true, changing the setting re-runs that generator in the same commit. `host:` actions are buttons resolved by the editor. `plugin:` actions are reserved.

Font-scoped values live at `format_specific["com.counterpunch.plugin-settings"][pluginId].values`. Window-scoped canvas plugin values stay in the existing window UI parameter store.

Targets shipped now:

| Target | Scope | Where |
| --- | --- | --- |
| `font-info.features` | font | Features sidebar, Settings section |
| `add-glyphs` | font | Add Glyphs dialog |
| `canvas.plugins` | window | Canvas plugin dropdown |
| `font-info.skills` | font | Fallback section in that same sidebar |

Reserved: `font-info.general`, `glyph-overview.filters`.
