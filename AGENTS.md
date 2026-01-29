# Counterpunch Font Editor - Coding Instructions

## Project Overview

Counterpunch (also known as "Context Font Editor") is a browser-based font editor with live compilation and rendering capabilities. It uses a WebAssembly-based font compilation pipeline (Rust fontc/babelfont compiled to WASM) and a JavaScript/TypeScript/HTML/CSS frontend. The editor provides a Python scripting environment via Pyodide, allowing users to manipulate font data programmatically.

### Key Features

- **Interactive outline editing** with visual feedback
- **Live font compilation** in the browser using fontc WASM
- **Variable font preview** with live interpolation and animation
- **AI assistant** that generates Python code for font manipulation
- **Python scripting** via Pyodide with a transparent JS-to-Python object model
- **Plugin system** for canvas rendering and glyph filtering

## Technology Stack

| Component | Technology |
|-----------|------------|
| **Frontend** | TypeScript, JavaScript (ES6+), HTML5, CSS3 |
| **Font Compilation** | Rust (fontc/babelfont) compiled to WebAssembly via wasm-pack |
| **Python Runtime** | Pyodide (WASM-based Python in browser) |
| **Text Shaping** | HarfBuzz.js |
| **Build System** | Webpack 5, Babel, TypeScript compiler |
| **Testing** | Jest (unit), Playwright (E2E) |
| **Deployment** | Cloudflare Pages, GitHub Actions |
| **AI Proxy** | Cloudflare Workers (Anthropic API relay) |

## Project Structure

```
/
├── webapp/                    # Main web application
│   ├── js/                    # JavaScript/TypeScript source (60+ files)
│   │   ├── glyph-canvas/      # Canvas rendering modules (9 files)
│   │   ├── bootstrap.ts       # Application entry point
│   │   ├── font-manager.ts    # Font loading/saving
│   │   ├── babelfont-model.ts # Font object model
│   │   └── ...
│   ├── css/                   # Stylesheets
│   │   ├── style.css          # Main styles
│   │   ├── tokens.json        # Design tokens
│   │   └── tokens.css         # Generated CSS variables
│   ├── py/                    # Python scripts for Pyodide
│   │   └── fonteditor.py      # Core font editing module
│   ├── wasm-dist/             # WASM binaries
│   ├── tests/                 # Test files
│   ├── examples/              # Sample font files (.babelfont, .glyphs)
│   ├── build/                 # Webpack build output
│   ├── index.html             # Main HTML file
│   ├── webpack.config.js      # Webpack configuration
│   ├── playwright.config.ts   # Playwright test config
│   └── jest.config.js         # Jest test config
├── babelfont-fontc-build/     # Rust/WASM source code
│   ├── src/                   # Rust source files (4 files, ~1700 LOC)
│   └── Cargo.toml             # Rust dependencies
├── mcp-server/                # MCP server for development monitoring
├── plugins/                   # Plugin system
│   ├── canvas/                # Canvas drawing plugins
│   └── glyphfilter/           # Glyph filtering plugins
├── instructions/              # Architecture documentation
│   ├── CSS_COLOR_STYLING.md   # Color system guidelines
│   ├── UI_ELEMENTS.md         # UI component guidelines
│   ├── WEBAPP_OVERVIEW.md     # Webapp architecture
│   └── UNDO_COLLABORATION_ARCHITECTURE.md
└── .github/workflows/         # CI/CD pipelines
    ├── ci.yml                 # CI workflow
    └── release.yml            # Release workflow
```

## Build Commands

### Webapp Development

```bash
cd webapp

# Install dependencies
npm install

# Development server (https://localhost:8000)
npm run dev

# Production build
npm run build

# Generate CSS tokens from tokens.json
npm run tokens
```

### Rust/WASM Development

```bash
# Build WASM from Rust (requires Rust nightly + wasm-pack)
./build-fontc-wasm.sh

# Update Rust dependencies and toolchains
./update-rust-deps.sh
```

### Testing

```bash
cd webapp

# Run Playwright E2E tests
npm test

# Run Playwright with UI
npm run test:ui

# Run Jest unit tests
npm run test:jest

# Update Playwright snapshots
npm run test:update-snapshots
```

### Release Process

```bash
# Create and deploy a new release
./release.sh v1.0.0
```

This script:
1. Updates version in `webapp/coi-serviceworker.js` and `API.md`
2. Extracts release notes from `CHANGELOG.md`
3. Commits version changes
4. Creates and pushes git tag
5. Triggers GitHub Actions to create release and deploy to Cloudflare Pages

## Code Style Guidelines

### General

- Be extremely concise in interactions, plans, and commit messages
- Scan for reusable code across languages; avoid duplicate implementations
- Don't write spaghetti code
- Clean up temporary code, excessive logs, and debug statements
- Prefer command-line commands for search/replace operations
- Run commands such that output is visible (don't route to unreadable pipelines)

### JavaScript/TypeScript

- Use modern ES6+ syntax
- Prefer `const` over `let`, avoid `var`
- Use camelCase for variables and functions
- Use PascalCase for classes
- Add JSDoc comments for complex functions
- When adding properties to the global `window` object, type them in `js/index.d.ts`

**Console Logging Convention:**

All `console.log` statements MUST be prefixed with a [Descriptor] tag:

```javascript
console.log('[FontCompilation]', 'Compiling font...');
console.log('[GlyphCanvas]', 'Rendering glyph:', glyphName);
console.warn('[PythonExec]', 'Script execution failed', error);
```

**DOM Update Pattern (prevent flickering):**

```javascript
// Build off-screen first
const tempContainer = document.createElement('div');
// ... populate tempContainer ...

// Swap in single paint cycle
requestAnimationFrame(() => {
    container.innerHTML = '';
    container.appendChild(tempContainer);
});
```

### CSS

**NEVER use hard-coded color values. ALWAYS use CSS variables.**

```css
/* WRONG */
.button { background-color: #ff00ff; }

/* CORRECT */
.button { background-color: var(--accent-magenta); }
```

Colors are defined in `webapp/css/style.css` in two theme blocks:
- **Dark Theme (Default)**: `:root { ... }`
- **Light Theme**: `:root[data-theme="light"] { ... }`

Variable naming: Use semantic names (purpose, not color):
- ✅ `--text-primary`, `--background-hover`, `--accent-green`
- ❌ `--dark-gray`, `--light-blue`, `--color-1`

Design tokens are defined in `css/tokens.json` and generated to `css/tokens.css` via `npm run tokens`.

### Rust

- Follow standard Rust conventions
- Use rustfmt for formatting
- Write documentation comments with `///`

## Testing Strategy

### Unit Tests (Jest)

- Configuration: `webapp/jest.config.js`
- Test files: `webapp/tests/*.test.js`
- Environment: jsdom with canvas mock
- WASM modules are mocked for Jest

### E2E Tests (Playwright)

- Configuration: `webapp/playwright.config.ts`
- Test files: `webapp/tests/*.spec.ts`
- Browsers: Chromium (WebKit commented out)
- SharedArrayBuffer required for WASM/Pyodide
- 5-minute timeout for complex interactions
- Screenshots/videos captured on failure

### Code Formatting

Prettier configuration in `webapp/.prettierrc`:
- Print width: 80
- Tab width: 4 spaces
- Single quotes
- No trailing commas
- LF line endings

Run formatting: `cd webapp && npx prettier --write .`
Check formatting: `cd webapp && npx prettier -c .`

## Key Architecture Details

### Font Object Model

The font data model is defined in `babelfont-model.ts` with classes:
- `Font` - Main font class
- `Glyph` - Individual glyphs
- `Layer` - Master/intermediate designs
- `Path` / `Node` - Outline contours and points
- `Component` - Component references
- `Axis` / `Master` / `Instance` - Variable font data

The model is accessible via `window.currentFontModel` and exposed to Python through Pyodide.

### File I/O

Supported formats (via `font-manager.ts`):
- `.babelfont` - Native JSON format
- `.glyphs` - Glyphs.app format
- `.vfj` - FontLab format
- `.ufo`/`.designspace` - Planned

### Compilation Pipeline

```
Edit → Serialize to JSON → fontc WASM → OpenType font → HarfBuzz shaping → Render
```

### Plugin System

- **Canvas plugins**: Custom drawing on glyph canvas (above/below outlines)
- **Glyph filters**: Custom filtering in glyph overview

Plugins are discovered dynamically from the `plugins/` directory.

## MCP Server for Development

The MCP (Model Context Protocol) server in `mcp-server/` provides:
- Console log capture and querying
- Runtime data inspection
- JavaScript execution in webapp context

Start the server: `cd mcp-server && npm run dev`

WebSocket port: 9876

## Security Considerations

- CORS headers required for SharedArrayBuffer (see `webapp/_headers`)
- COOP/COEP headers configured for cross-origin isolation
- Cloudflare Worker proxies Anthropic API requests to avoid CORS issues
- Service worker (`coi-serviceworker.js`) handles cache versioning

## Global Window Objects

Key globals exposed on `window` (see `js/index.d.ts` for full list):
- `window.currentFontModel` - Current font object model
- `window.fontManager` - Font loading/management
- `window.glyphCanvas` - Main canvas editor
- `window.pyodide` - Python runtime
- `window.aiAssistant` - AI assistant integration

## Deployment

- **Production**: https://editor.counterpunch.space
- **Preview**: https://preview.editor.counterpunch.space (auto-updated on push)
- Platform: Cloudflare Pages
- CI/CD: GitHub Actions

## Documentation Files

- `API.md` - Font Object Model API documentation (auto-generated)
- `CHANGELOG.md` - Release notes
- `instructions/*.md` - Architecture and style guides
- `mcp-server/README.md` - MCP server documentation

## Useful Resources

- fontc: https://github.com/googlefonts/fontc
- babelfont-rs: https://github.com/simoncozens/babelfont-rs
- Pyodide: https://pyodide.org/
- HarfBuzz.js: https://github.com/harfbuzz/harfbuzzjs
