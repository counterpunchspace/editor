# Context Font Editor - Coding Instructions

## Project Overview

This is a WebAssembly-based font editor using Rust (fontc/babelfont) compiled to WASM and a JavaScript/HTML/CSS frontend. It uses a Javascript object model as the primary font source data storage which is exposed to the users via the Pyodide console and Python scripting environment transparently translated from Javascript.

## Code Style

### General

- Scan for reusable code in any of the languages, avoid duplicate implementations where possible
- Don't write spaghetti code
- Clean up code that isn't needed any more, like excessive log statements or temporary documents

### JavaScript

- Use modern ES6+ syntax
- Prefer const over let, avoid var
- Use camelCase for variables and functions
- Use PascalCase for classes
- Add JSDoc comments for complex functions
- Use prettier for code formatting
- When adding properties to the global `window` object, ensure they are properly typed in `js/index.d.ts`
- To prevent DOM flickering when updating content: build new content in a temporary off-screen container first, then use `requestAnimationFrame` to clear and swap in the new content in a single paint cycle
- All console.log statements MUST be prefixed with a [Descriptor] tag that identifies the code section (e.g., `console.log('[FontCompilation]', ...)`). Use descriptive prefixes like [GlyphCanvas], [PythonExec], [FileManager], etc. to enable efficient filtering and debugging
- Decide intelligently in which JavaScript file to place new code. Infer target files from each file name or comments at the file header and only create new files if a topic is entirely new.
- The font object is available under `window.currentFontModel`

### Rust

- Follow standard Rust conventions
- Use rustfmt for formatting
- Write documentation comments with ///

### CSS

- Refer to instructions/CSS_COLOR_STYLING.md for color standards
- Use CSS custom properties for theming
- Keep selectors specific but not overly nested

## Architecture Principles

- Keep WASM boundary clean - minimize data passing between JS and Rust
- Refer to instructions/WEBAPP_OVERVIEW.md for webapp structure
- Refer to instructions/UI_ELEMENTS.md for UI component guidelines

## File Organization

- webapp/js/ - JavaScript modules
- webapp/css/ - Stylesheets
- webapp/py/ - Python (Pyodide) scripts
- webapp/wasm-dist/ - WASM binaries

## Build Process

- Update Rust dependencies with `update-rust-deps.sh`
- Build WASM with `build-fontc-wasm.sh`

## Testing & Verification

- **Always verify TypeScript/JavaScript changes** by running `cd webapp && npm run build` after making edits and checking it for errors. Use only `npm run build` without ever changing ` 2>&1 | tail -40` suffixes.
- The `get_errors` tool only checks VS Code's TypeScript language server, which may miss errors that webpack's stricter compilation catches
- Look for "compiled successfully" or "ERROR" in the build output
- Check exit code to ensure compilation succeeded
- Run the command only once
- After changes to Javascript/Typescript files, see if there are relevant unit tests in `tests/` that need to be run selectively.

## MCP Server for Development Monitoring

An MCP (Model Context Protocol) server is available for AI-assisted debugging and development monitoring:

**Automatic during development:**

- The webapp automatically connects to the MCP server at `ws://localhost:9876` when running in development mode
- All console logs are intercepted and forwarded to the MCP server with timestamps, prefixes, and stack traces
- Only active when `window.isDevelopment()` returns true

**Starting the MCP server:**

```bash
./start-mcp-server.sh
# or manually:
cd mcp-server && npm run dev
```

**Accessing the data:**
As an AI assistant with MCP access, you can query the data using:

- `query_logs` tool - Filter logs by level, prefix, search text, or time range
  - Example: `query_logs({ level: "error", prefix: "FontCompilation", limit: 100 })`
- `get_runtime_value` tool - Retrieve specific runtime data using dot notation
  - Example: `get_runtime_value({ key: "fontManager.currentFont.name" })`
- `clear_logs` tool - Clear all captured logs
- `reload_webapp` tool - Reload the webapp page in the browser
- `execute_javascript` tool - Execute JavaScript code in the webapp context
  - Example: `execute_javascript({ code: "window.fontManager.currentFont.name" })`

**Remote control of the webapp:**

The MCP server enables full remote control of the webapp via the `execute_javascript` tool:

- **Opening a font:**

  ```javascript
  window.openFont("/user/NestedComponents.babelfont");
  ```

- **Accessing the current font:**

  ```javascript
  window.currentFontModel; // The currently loaded font object
  ```

- **Switching layers/masters:**

  ```javascript
  // Check available masters
  window.currentFontModel.masters.map((m) => m.name);

  // Switch to a specific master (e.g., Bold)
  // Implementation depends on the UI controls
  ```

- **Inspecting DOM and UI state:**

  ```javascript
  // Find UI elements
  document.querySelectorAll(".some-selector");

  // Trigger UI actions
  document.querySelector("#some-button")?.click();
  ```

**MCP Resources:**

- `context://logs/all` - All captured console logs (up to 1000)
- `context://logs/recent` - Last 50 console logs
- `context://runtime/data` - Current runtime state

**Sending runtime data from webapp:**

```javascript
window.mcpTransport.sendRuntimeData({
  currentFont: window.fontManager?.currentFont?.name,
  customData: { ... }
});
```

See `mcp-server/README.md` for complete documentation.

## Important Notes

- CORS headers are required for SharedArrayBuffer (see \_headers and coi-serviceworker.js)
- Keep instructions/ directory updated with architectural decisions

## Github Repository

- Add major changes since last push to CHANGELOG.md. Be as concise as possible. Don't keep adding new items for fixes to the same topic, instead do a rewrite.
