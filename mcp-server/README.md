# Context Font Editor MCP Server

Model Context Protocol (MCP) server for monitoring and debugging the Context Font Editor webapp during development.

## Features

- **Console Log Capture**: Intercepts and stores all console logs with timestamps, prefixes, and stack traces
- **Runtime Data Monitoring**: Exposes webapp runtime state for inspection
- **Query Tools**: Filter and search logs by level, prefix, search text, or time range
- **WebSocket Transport**: Real-time log streaming from webapp to MCP server
- **MCP Resources**: Access logs and runtime data through standard MCP resource URIs

## Installation

From the `mcp-server` directory:

```bash
npm install
npm run build
```

## Usage

### 1. Start the MCP Server

The MCP server communicates via stdio (for MCP clients) and WebSocket (for the webapp):

```bash
cd mcp-server
npm run dev
```

The server will:

- Listen on `ws://localhost:9876` for webapp connections
- Expose MCP resources and tools via stdio

### 2. Configure Your MCP Client

Add to your MCP client configuration (e.g., Claude Desktop `config.json`):

```json
{
  "mcpServers": {
    "context-font-editor": {
      "command": "node",
      "args": ["/path/to/context-font-editor/mcp-server/build/index.js"]
    }
  }
}
```

### 3. Run the Webapp

Start the webapp in development mode (it auto-connects to the MCP server):

```bash
cd webapp
npm run dev
```

The webapp will automatically connect to the MCP server at `ws://localhost:9876` and start forwarding console logs.

## MCP Resources

### `context://logs/all`

All captured console logs (up to 1000 most recent)

### `context://logs/recent`

Last 50 console logs

### `context://runtime/data`

Current runtime data from the webapp

## MCP Tools

### `query_logs`

Filter and search console logs:

```json
{
  "level": "error", // Filter by log level (log, warn, error, etc.)
  "prefix": "FontCompilation", // Filter by prefix tag
  "search": "compile", // Search in log arguments
  "limit": 50, // Max results (default: 50)
  "since": 1234567890 // Unix timestamp in ms
}
```

### `get_runtime_value`

Retrieve specific runtime data:

```json
{
  "key": "fontManager.currentFont.name" // Supports dot notation
}
```

### `clear_logs`

Clear all captured logs

### `reload_webapp`

Reload the webapp page in the browser:

```json
{}
```

### `execute_javascript`

Execute JavaScript code in the webapp context:

```json
{
  "code": "window.fontManager.currentFont.name"
}
```

**Examples:**

```javascript
// Inspect global state
execute_javascript({ code: "window.fontManager.currentFont.name" });

// Call functions
execute_javascript({ code: "window.fontCompiler.compile()" });

// Modify state
execute_javascript({ code: "window.debugMode = true" });
```

## Webapp Integration

The webapp automatically intercepts console logs in development mode. All console methods (`log`, `warn`, `error`, `info`, `debug`) are forwarded to the MCP server.

### Sending Runtime Data

From the webapp console or code:

```javascript
// Send any runtime data to the MCP server
window.mcpTransport.sendRuntimeData({
  currentFont: window.fontManager?.currentFont?.name,
  glyphCount: window.fontManager?.currentFont?.glyphs?.length,
  customData: { ... }
});
```

### Manual Control

```javascript
// Connect/disconnect manually
window.mcpTransport.connect();
window.mcpTransport.disconnect();
```

## Log Prefix Convention

All console logs in the webapp should use descriptive prefixes:

```javascript
console.log("[FontCompilation]", "Compiling font...");
console.warn("[GlyphCanvas]", "Invalid glyph data");
console.error("[PythonExec]", "Script execution failed", error);
```

This enables efficient filtering via the `query_logs` tool.

## Development

### Build

```bash
npm run build
```

### Watch Mode

```bash
npm run watch
```

### WebSocket Port

Default port is `9876`. To change, modify `wsPort` in `src/index.ts`.

## Architecture

```
┌─────────────────┐         WebSocket          ┌─────────────────┐
│                 │      (ws://localhost:9876)  │                 │
│  Webapp         │◄───────────────────────────►│  MCP Server     │
│  (Browser)      │                             │  (Node.js)      │
│                 │                             │                 │
└─────────────────┘                             └────────┬────────┘
                                                         │
                                                    stdio (MCP)
                                                         │
                                                         ▼
                                                ┌─────────────────┐
                                                │  MCP Client     │
                                                │  (Claude, etc.) │
                                                └─────────────────┘
```

## Troubleshooting

**Webapp not connecting?**

- Ensure MCP server is running (`npm run dev` in `mcp-server/`)
- Check browser console for `[MCPTransport]` messages
- Verify WebSocket port (default: 9876) is not blocked

**No logs appearing?**

- Verify webapp is in development mode (`NODE_ENV=development`)
- Check that logs use proper prefix format: `console.log('[Prefix]', ...)`
- Use `query_logs` tool to search for specific logs

**MCP client can't connect?**

- Ensure the path in your MCP config points to the built `index.js` file
- Run `npm run build` in `mcp-server/` directory
- Check that Node.js is in your PATH
