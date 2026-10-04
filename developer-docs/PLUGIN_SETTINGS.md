# Plugin settings

Any bundled Python plugin may declare `SETTINGS`. Counterpunch renders them, stores them, and passes the resolved values back as `context.settings`. Plugins do not persist settings themselves.

```python
SETTINGS = [
    {
        "id": "composition_output",
        "type": "radio",
        "label": "Composition output for new glyphs",
        "help": "Materialized writes component glyphs. ccmp writes empty shells.",
        "target": "font-info.features",
        "options": [
            {"value": "materialized", "label": "Materialized components"},
            {"value": "ccmp", "label": "Shaper-composed (ccmp)"},
        ],
        "default": "materialized",
        "regenerates": False,
        "actions": [
            {"id": "host:rebuild-composition", "label": "Rebuild Composition…"}
        ],
    }
]
```

Required fields are `id`, `type`, and `default`. `target` selects where the control appears. Unknown targets fall back to `font-info.language-packs`.

Allowed types: `checkbox`, `radio`, `select`, `number`, `slider`, `textfield`, `color`. `radio` and `select` need `options`. `number` and `slider` should set `min`, `max`, and `step`.

`regenerates` defaults to true for feature generators. When it is true, changing the setting re-runs that generator in the same commit. `host:` actions are buttons resolved by the editor. `plugin:` actions are reserved.

Font-scoped values live at `format_specific["com.counterpunch.plugin-settings"][pluginId].values`. Window-scoped canvas plugin values stay in the existing window UI parameter store.

Targets shipped now:

| Target | Scope | Where |
| --- | --- | --- |
| `font-info.features` | font | Features sidebar, Settings section |
| `canvas.plugins` | window | Canvas plugin dropdown |
| `font-info.language-packs` | font | Fallback section in that same sidebar |

Reserved: `font-info.general`, `glyph-overview.filters`, `add-glyphs`.
