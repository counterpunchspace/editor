# Font Destination Plugins

Registration is the Counterpunch GitHub App and manifest `counterpunch-plugin-manifest:v2`. The Plugin Manager downloads the wheel from the website registry. See `PLUGIN_CONTRACTS.md`.



Font Destination plugins let a third-party website receive the binary font that
Counterpunch just exported. The plugin is a small Python package for discovery
and menu metadata; the actual receiver is a normal web page owned by the third
party.

The receiver does not compile fonts, alter the editing worker, or receive data
until the user explicitly opens it from **Tools > Font Destinations** and later
performs **File > Export binary font**.

## Why There Is A Bridge

Counterpunch runs cross-origin isolated so browser WASM features such as
`SharedArrayBuffer` stay available. In that mode, directly opening an arbitrary
cross-origin site and talking to it through `window.opener` is unreliable: the
browser can sever or proxy the relationship to preserve isolation.

Counterpunch therefore opens a small same-origin bridge page and places the
third-party receiver inside a `credentialless` iframe. The bridge keeps the
editor isolated, keeps the destination user-opened, and forwards only the
binary-export message after the receiver says it is ready.

For receiver authors this means: implement one `postMessage` listener and one
ready signal. You do not need to know about the editor internals.

Reference implementation:
https://github.com/counterpunchspace/fontdestination-example-plugin

## Discovery

The Plugin Manager uses Counterpunch's reusable editor-origin-gated GitHub code
search API to find global marker matches, then loads each matched manifest
directly from GitHub. A plugin is included only when its manifest carries this
exact marker:

```text
counterpunch-plugin:font-destination:v1
```

A matching manifest uses schema `counterpunch-plugin-manifest:v1` and supplies
the display metadata, Python entry point, receiver URL and exact origin,
repository, and the release wheel asset naming rules. Counterpunch validates
the manifest before downloading any release assets and never executes code as
part of GitHub discovery.

The important manifest fields are:

- `fontDestination.entryPoint`: Python entry point name from the wheel.
- `fontDestination.destinationUrl`: browser receiver page to embed.
- `fontDestination.targetOrigin`: exact origin of that receiver page.
- `fontDestination.imageUrl`: optional HTTPS image shown below the plugin
  description in the Plugin Manager. Use a GitHub Pages URL or raw image URL,
  not a GitHub `blob` page. The image host must allow anonymous CORS requests;
  GitHub Pages does this with `Access-Control-Allow-Origin: *`.
- `release.repository`: GitHub repository that publishes the wheel release.
- `release.wheelAssetPrefix` and `release.checksumAssetSuffix`: asset matching
  rules for the downloadable wheel and SHA-256 checksum.

The example repository's manifest currently looks like this:

```json
{
  "schema": "counterpunch-plugin-manifest:v1",
  "package": "fontdestination-example-plugin",
  "provides": ["counterpunch-plugin:font-destination:v1"],
  "fontDestination": {
    "entryPoint": "example_fontdestination",
    "pluginId": "example-font-destination",
    "name": "Example Font Destination",
    "description": "Opens a small browser receiver that displays basic information about each exported binary font.",
    "destinationUrl": "https://counterpunchspace.github.io/fontdestination-example-plugin/",
    "targetOrigin": "https://counterpunchspace.github.io",
    "repositoryUrl": "https://github.com/counterpunchspace/fontdestination-example-plugin",
    "imageUrl": "https://counterpunchspace.github.io/fontdestination-example-plugin/plugin-preview.png"
  },
  "release": {
    "repository": "counterpunchspace/fontdestination-example-plugin",
    "wheelAssetPrefix": "fontdestination_example_plugin-",
    "checksumAssetSuffix": ".sha256"
  }
}
```

## Installation

Plugin installation requires a user-selected Disk workspace with granted
read/write File System Access permission. The selected folder is Counterpunch's
root for all app-owned directories; its name and location remain the user's
choice. The installer verifies the SHA-256 release checksum and writes the
wheel to:

```text
<selected Disk folder>/Plugins/<distribution>-<version>-py3-none-any.whl
```

The wheel's presence defines the installed state. During startup, Counterpunch
reinstalls every wheel from this directory into Pyodide when the retained Disk
folder still grants permission. Removing a wheel affects a newly initialized
Pyodide runtime; Python modules already imported in the current runtime remain
loaded until that runtime is recreated.

## Python Contract

Distributions register an entry point in:

```text
counterpunch_font_destination_plugins
```

The entry point constructs a `FontDestinationPlugin` and returns serializable
metadata through `metadata()`. The metadata contains `pluginId`, `name`,
`description`, `destinationUrl`, `targetOrigin`, `repositoryUrl`, and optional
`imageUrl`. The destination URL's origin must exactly equal `targetOrigin`.

The example package exposes this metadata class:

```py
"""Metadata exposed to Counterpunch through Python entry-point discovery."""


class FontDestinationPlugin:
    """Describe the example browser receiver without handling font bytes itself."""

    # Keep these values in sync with counterpunch-plugin.json. Counterpunch uses
    # this metadata after installing the wheel to populate Tools > Font Destinations.
    plugin_id = "example-font-destination"
    name = "Example Font Destination"
    description = (
        "Opens a small browser receiver that displays basic information about "
        "each exported binary font."
    )
    destination_url = "https://counterpunchspace.github.io/fontdestination-example-plugin/"
    target_origin = "https://counterpunchspace.github.io"
    repository_url = "https://github.com/counterpunchspace/fontdestination-example-plugin"
    image_url = "https://counterpunchspace.github.io/fontdestination-example-plugin/plugin-preview.png"

    def metadata(self) -> dict[str, str | None]:
        """Return serializable metadata used by Counterpunch's Tools menu."""
        return {
            "pluginId": self.plugin_id,
            "name": self.name,
            "description": self.description,
            "destinationUrl": self.destination_url,
            "targetOrigin": self.target_origin,
            "repositoryUrl": self.repository_url,
            "imageUrl": self.image_url,
        }
```

## Receiver Contract

When the user opens an item from **Tools > Font Destinations**, Counterpunch
opens a same-origin bridge window that embeds the declared URL in a
`credentialless` frame. This keeps the editor cross-origin isolated while
allowing the bridge to forward a later successful **File > Export binary font**
action. No binary data is created when the destination is opened.

After installing its message listener, a receiver must notify its parent frame:

```js
window.parent.postMessage(
    { type: "counterpunch:font-destination-ready", version: 1 },
    "https://editor.counterpunch.space",
);
```

The bridge keeps only the newest export until it receives that ready message.
It then transfers a fresh `ArrayBuffer` with the existing
`counterpunch:binary-font-exported` message. Receivers must accept messages
only from a documented Counterpunch editor origin. Cross-origin isolation can
proxy the sender window, so receivers must not compare `event.source` with
`window.parent`. They should also inspect the message type, protocol version,
and transferred `ArrayBuffer` before reading the binary font.

Export message shape:

```ts
type BinaryFontExportMessage = {
    type: "counterpunch:binary-font-exported";
    version: 1;
    bytes: ArrayBuffer;
    metadata?: {
        filename?: string;
        byteLength?: number;
        format?: "ttf";
        mimeType?: string;
        changeVersion?: number;
        timeTakenMs?: number;
    };
};
```

The example site keeps the protocol in
`site/counterpunch-font-destination.js` and the app-specific rendering in
`site/app.js`. The reusable helper is the code below:

```js
(function () {
  // Keep this list narrow. These are the only editor origins allowed to send
  // binary font exports to this receiver.
  const DEFAULT_EDITOR_ORIGINS = [
    "https://editor.counterpunch.space",
    "https://preview.editor.counterpunch.space",
    "https://localhost:8000",
    "https://localhost:8789",
  ];

  function isBinaryFontExport(message) {
    return (
      message &&
      message.type === "counterpunch:binary-font-exported" &&
      message.version === 1 &&
      message.bytes instanceof ArrayBuffer
    );
  }

  function register(options) {
    const editorOrigins = new Set(
      options.editorOrigins || DEFAULT_EDITOR_ORIGINS,
    );
    const onFont = options.onFont;

    window.addEventListener("message", (event) => {
      // Validate by origin and payload shape. Do not compare
      // event.source with window.parent; COOP/COEP can proxy it.
      if (!editorOrigins.has(event.origin)) {
        return;
      }

      const message = event.data;
      if (!isBinaryFontExport(message)) {
        return;
      }

      onFont({
        bytes: message.bytes,
        metadata: message.metadata || {},
        origin: event.origin,
        rawMessage: message,
      });
    });

    if (window.parent !== window) {
      // Tell Counterpunch's bridge it can deliver queued exports.
      for (const editorOrigin of editorOrigins) {
        window.parent.postMessage(
          {
            type: "counterpunch:font-destination-ready",
            version: 1,
          },
          editorOrigin,
        );
      }
    }
  }

  window.CounterpunchFontDestination = {
    defaultEditorOrigins: DEFAULT_EDITOR_ORIGINS,
    register,
  };
})();
```

Third-party receivers may copy this file unchanged and replace only their app
code. In the example app, `site/app.js` consumes it like this:

```js
window.CounterpunchFontDestination.register({
  onFont({ bytes, metadata }) {
    receiptCount += 1;
    const receiptDetails = {
      "Receipt number": receiptCount,
      "Received at": new Date().toLocaleTimeString(),
      "Counterpunch change version": metadata.changeVersion ?? "Unavailable",
      "File name": metadata.filename || "Unavailable",
      "Byte size": metadata.byteLength || bytes.byteLength,
    };
    statusDot.classList.add("received");

    try {
      const inspection = inspectFont(bytes);
      statusElement.textContent = metadata.filename || "Font received";
      renderDetails({
        ...receiptDetails,
        "sfnt version": inspection.sfntVersion,
        "Family name": inspection.familyName,
        "Full name": inspection.fullName,
        "Units per em": inspection.unitsPerEm,
        "Glyph count": inspection.glyphCount,
        Tables: inspection.tables,
      });
    } catch (error) {
      statusElement.textContent = "Unable to inspect font";
      renderDetails({
        ...receiptDetails,
        Error: error instanceof Error ? error.message : String(error),
      });
    }
  },
});
```

## Efficient Receiver Design

- Register the message listener before doing expensive UI work, then send the
  ready message immediately.
- Treat every accepted message as a new receipt, even when the font name and
  table data are unchanged. Show a receipt timestamp, counter, byte hash, or
  exported `changeVersion` so users can see that a new export arrived.
- Keep only the current font unless your product explicitly needs history.
  Counterpunch already transfers a fresh `ArrayBuffer` for each open
  destination.
- Validate by origin, message type, protocol version, and `ArrayBuffer`. Do not
  validate by `event.source`; browser isolation can proxy it.
