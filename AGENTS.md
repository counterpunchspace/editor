# Context Font Editor - Coding Instructions

## Project Overview
This is a WebAssembly-based font editor using Rust (fontc/babelfont) compiled to WASM and a JavaScript/HTML/CSS frontend. It uses a Python object model as the primary font source data storage which is exposed to the users via the Pyodide console and Python scripting environment.

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
- **Always verify TypeScript/JavaScript changes** by running `cd webapp && npm run build` after making edits and checking it for errors
- The `get_errors` tool only checks VS Code's TypeScript language server, which may miss errors that webpack's stricter compilation catches
- Look for "compiled successfully" or "ERROR" in the build output
- Check exit code to ensure compilation succeeded

## Important Notes
- CORS headers are required for SharedArrayBuffer (see _headers and coi-serviceworker.js)
- Keep instructions/ directory updated with architectural decisions

## Github Repository
- Add major changes since last push to CHANGELOG.md. Be as concise as possible. Don't keep adding new items for fixes to the same topic, instead do a rewrite.
