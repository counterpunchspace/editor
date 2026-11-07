# Installing plugins and packages

Python in Counterpunch can grow in two ways. **Plugin Manager** installs Font Destination plugins and keeps their wheels on disk (mor eplugin types coming soon). **`micropip.install()`** adds a plugin wheel or any Pyodide-compatible package for the current session only.

The runtime is still the browser’s Pyodide, not the Python on your computer. A package must be installable there: pure Python, or a wheel published for Pyodide.

## Plugin Manager

Open **Tools → Plugin Manager**. The first time, connect a **Settings Folder** if none is selected. You can also choose the Settings Folder in Settings (`Cmd/Ctrl+,`).

The manager lists Font Destination plugins discovered on GitHub. **Install** downloads the latest release wheel, checks its checksum, and writes it into `Plugins` inside the Settings Folder. **Uninstall** removes that wheel. After a successful install, the destination appears under **Tools → Font Destinations**.

## Saved locally

Installed plugins are `.whl` files in the Settings Folder’s `Plugins` directory. That is the durable copy. After a reload, Counterpunch reinstalls every wheel in that folder into Pyodide so plugins return without using Plugin Manager again.

The Settings Folder is separate from your font sources. How it is chosen is in [Settings Folder and fonts on disk](../getting-started/04-project-and-settings-folders.md). The same Settings Folder also holds `Scripts` and `Filters`.

## Temporary installs with micropip

In [Konsole](03-konsole-quick-tasks.md) or a script, install a package or a plugin wheel for this session:

```python
import micropip
await micropip.install("fonttools")
```

`await` is required. Use a PyPI name when Pyodide can resolve it, or a URL to a compatible `.whl`. The install lasts until you reload the editor. It is not written to `Plugins` and will not return on the next launch.

Use this to try a plugin without keeping it, or to pull in a complete package for one task. For something you want every session, install it with Plugin Manager (plugins) or copy a compatible wheel into `Plugins`.

`numpy`, `matplotlib`, and `pandas` install themselves the first time a script or Konsole command imports them. You do not need `micropip` for those three.

Python setup is in [Python in Counterpunch](01-python-in-counterpunch.md). Reusable scripts are in [Writing general scripts](04-writing-general-scripts.md).
