# Undo/Redo and Collaboration Architecture

## Executive Summary

This document outlines the architecture for implementing undo/redo functionality and live collaboration in the Context Font Editor. The design uses **Yjs (CRDT)** as the source of truth for collaboration and undo, while maintaining a **babelfont-ts class instance** as the rich domain model for the Python API and application logic.

## Core Requirements

1. **Clean Python API**: Users write normal Python code to manipulate font data
2. **Live Collaboration**: Multiple users can edit the same font simultaneously
3. **Local Undo/Redo**: Per-user undo stack that respects collaborative changes
4. **Rich Domain Model**: TypeScript class-based model (babelfont-ts) with methods and validation
5. **Performance**: No significant overhead during normal editing operations

## Architecture Overview

```
┌─────────────────────────────────────────────────────┐
│              Yjs Document (Y.Map)                   │
│         SOURCE OF TRUTH FOR STATE                   │
│  - Handles conflict resolution (CRDT)               │
│  - Manages undo/redo stacks                         │
│  - Broadcasts changes to collaborators              │
│  - Persists to IndexedDB                            │
└──────────────┬──────────────────────────────────────┘
               │
               │ observeDeep() → materializes view
               ↓
┌─────────────────────────────────────────────────────┐
│         BabelfontFont Class Instance                │
│         RICH DOMAIN MODEL (CACHED)                  │
│  - Convenience methods (scale, normalize, etc.)     │
│  - Validation logic                                 │
│  - Python-friendly toString(), getters              │
│  - Computed properties                              │
└──────────────┬──────────────────────────────────────┘
               │
               ↓
      window.currentFont
               │
        ┌──────┴─────────┬──────────┬─────────┐
        │                │          │         │
     Python            UI       Canvas     File I/O
  (snapshot)      (direct Yjs)  (reads)  (toJSON/fromJSON)
```

## Data Flow Patterns

### 1. UI Interactions (Point Dragging, Component Edits)

**Path: UI → Yjs → BabelfontFont**

```javascript
// User drags a point in the canvas
stateManager.movePoint('A', 0, 0, 5, 250, 300);

// Implementation:
movePoint(glyphId, layerId, pathIdx, pointIdx, x, y) {
  // 1. Update Yjs (source of truth)
  this.ydoc.transact(() => {
    const node = this.yfont
      .get('glyphs').get(glyphId)
      .get('layers').get(layerId)
      .get('paths').get(pathIdx)
      .get('nodes').get(pointIdx);
    node.set('x', x);
    node.set('y', y);
  });

  // 2. Yjs observer automatically:
  //    - Adds to undo stack
  //    - Broadcasts to collaborators
  //    - Triggers view update

  // 3. View update re-instantiates BabelfontFont:
  this.cachedFont = null;  // Invalidate cache
  window.currentFont = this.currentFont;  // Getter creates new instance
}
```

**Benefits:**

- ✓ Automatic undo/redo tracking
- ✓ Automatic collaboration sync
- ✓ Single source of truth

### 2. Python Script Execution

**Path: Python → BabelfontFont → Snapshot Diff → Yjs**

```javascript
// Before Python execution
stateManager.beginPythonTransaction('Scale all glyphs');

// Python executes (fast, no overhead)
await pyodide.runPythonAsync(`
font = currentFont
for glyph in font.glyphs.values():
    glyph.width *= 1.1
    for layer in glyph.layers:
        for path in layer.paths:
            for node in path.nodes:
                node.x *= 1.1
`);

// After Python execution
stateManager.endPythonTransaction();

// Implementation:
beginPythonTransaction(description = 'Python script') {
  // Take snapshot of Yjs state
  this.pythonSnapshot = {
    description,
    before: this.font.toJSON(),  // BabelfontFont serializes current state
    timestamp: Date.now()
  };

  // Python manipulates window.currentFont directly (BabelfontFont instance)
  // No proxies, no interception - full speed
}

endPythonTransaction() {
  // Get state after Python modifications
  const after = this.font.toJSON();
  const before = this.pythonSnapshot.before;

  // Calculate delta and apply to Yjs as single transaction
  this.ydoc.transact(() => {
    this.syncDeltaToYjs(before, after, this.yfont);
  }, 'python-script');  // Origin tag for undo tracking

  // Result:
  // - Single undo entry (entire script is one action)
  // - All changes broadcast to collaborators atomically
  // - BabelfontFont instance already updated (Python modified it)

  this.pythonSnapshot = null;
}
```

**Benefits:**

- ✓ Clean Python API (normal object manipulation)
- ✓ Fast execution (no per-property overhead)
- ✓ Single undo entry for entire script
- ✓ Atomic broadcast to collaborators

### 3. Reads (Canvas, UI, Inspection)

**Path: Direct read from BabelfontFont**

```javascript
// Canvas drawing
const glyph = window.currentFont.glyphs.get("A");
glyph.layers[0].paths.forEach((path) => {
  path.nodes.forEach((node) => {
    ctx.lineTo(node.x, node.y); // Direct read - no overhead
  });
});

// Python inspection
print(currentFont.glyphs.get("A").width); // Direct read
```

**Benefits:**

- ✓ Zero overhead
- ✓ Rich API available
- ✓ Type safety

### 4. File Loading/Saving

**Path: File → BabelfontFont → Yjs**

```javascript
async loadFont(fontData) {
  // 1. Create BabelfontFont instance (validates, normalizes)
  this.font = BabelfontFont.fromJSON(fontData);

  // 2. Sync to Yjs
  this.yfont.clear();
  const serialized = this.font.toJSON();
  this.plainToYjs(serialized, this.yfont);

  // 3. Expose to Python
  pyodide.globals.set('currentFont', this.font);

  // 4. Clear undo history (new document)
  this.undoManager.clear();
}

async saveFont() {
  // BabelfontFont handles serialization (may normalize/validate)
  const json = this.font.toJSON();
  await writeFile(json);
}
```

## State Manager API

### Core Interface

```typescript
class StateManager {
  private ydoc: Y.Doc;
  private yfont: Y.Map<any>;
  private undoManager: Y.UndoManager;
  private font: BabelfontFont;
  private wsProvider?: WebsocketProvider; // For collaboration

  // ============ FONT LIFECYCLE ============

  loadFont(fontData: any): void;
  saveFont(): Promise<any>;
  get currentFont(): BabelfontFont;

  // ============ UI OPERATIONS ============

  // Glyph editing
  movePoint(
    glyphId: string,
    layerId: number,
    pathIdx: number,
    pointIdx: number,
    x: number,
    y: number
  ): void;
  addPoint(
    glyphId: string,
    layerId: number,
    pathIdx: number,
    insertIdx: number,
    point: Point
  ): void;
  deletePoint(
    glyphId: string,
    layerId: number,
    pathIdx: number,
    pointIdx: number
  ): void;

  // Path operations
  addPath(glyphId: string, layerId: number, path: Path): void;
  deletePath(glyphId: string, layerId: number, pathIdx: number): void;
  reversePath(glyphId: string, layerId: number, pathIdx: number): void;

  // Component operations
  addComponent(glyphId: string, layerId: number, component: Component): void;
  transformComponent(
    glyphId: string,
    layerId: number,
    componentIdx: number,
    transform: Transform
  ): void;

  // Glyph-level operations
  setGlyphWidth(glyphId: string, width: number): void;
  setGlyphMetrics(glyphId: string, metrics: Metrics): void;
  renameGlyph(oldName: string, newName: string): void;

  // Kerning (future)
  setKerning(left: string, right: string, value: number): void;

  // ============ PYTHON INTEGRATION ============

  beginPythonTransaction(description?: string): void;
  endPythonTransaction(): void;
  cancelPythonTransaction(): void; // On error

  // ============ UNDO/REDO ============

  undo(): void;
  redo(): void;
  canUndo(): boolean;
  canRedo(): boolean;
  getUndoStack(): UndoEntry[];

  // ============ COLLABORATION ============

  enableCollaboration(config: CollaborationConfig): void;
  disableCollaboration(): void;
  getConnectedUsers(): User[];
}
```

### Internal Methods

```typescript
private materializeFont(): BabelfontFont {
  // Convert Yjs data to BabelfontFont instance
  const plainData = this.yjsToPlain(this.yfont);
  return BabelfontFont.fromJSON(plainData);
}

private syncDeltaToYjs(before: any, after: any, ymap: Y.Map<any>): void {
  // Deep diff and sync changes from 'after' to Yjs
  for (const key in after) {
    const beforeVal = before?.[key];
    const afterVal = after[key];

    if (JSON.stringify(beforeVal) !== JSON.stringify(afterVal)) {
      if (Array.isArray(afterVal)) {
        ymap.set(key, this.plainToYjsArray(afterVal));
      } else if (typeof afterVal === 'object' && afterVal !== null) {
        const childMap = ymap.get(key) || new Y.Map();
        ymap.set(key, childMap);
        this.syncDeltaToYjs(beforeVal || {}, afterVal, childMap);
      } else {
        ymap.set(key, afterVal);
      }
    }
  }
}

private yjsToPlain(ytype: any): any {
  // Convert Yjs types to plain JS objects
  if (ytype instanceof Y.Map) {
    const obj: any = {};
    ytype.forEach((value: any, key: string) => {
      obj[key] = this.yjsToPlain(value);
    });
    return obj;
  }
  if (ytype instanceof Y.Array) {
    return ytype.toArray().map(item => this.yjsToPlain(item));
  }
  return ytype;
}

private plainToYjs(value: any): any {
  // Convert plain JS to Yjs types
  if (Array.isArray(value)) {
    const yarray = new Y.Array();
    value.forEach(item => yarray.push([this.plainToYjs(item)]));
    return yarray;
  }
  if (typeof value === 'object' && value !== null) {
    const ymap = new Y.Map();
    for (const [k, v] of Object.entries(value)) {
      ymap.set(k, this.plainToYjs(v));
    }
    return ymap;
  }
  return value;
}
```

## Undo/Redo Strategy

### Yjs Built-in UndoManager

Yjs provides a sophisticated undo manager that:

- ✓ Tracks operations, not snapshots
- ✓ Respects collaborative edits (doesn't undo other users' changes)
- ✓ Can scope to specific Yjs types (per-glyph undo possible)
- ✓ Groups operations by transaction

### Configuration

```typescript
// Global undo (recommended for MVP)
this.undoManager = new Y.UndoManager(this.yfont, {
  trackedOrigins: new Set([this.ydoc.clientID]), // Only undo own changes
  captureTimeout: 500, // Group rapid changes within 500ms
});

// Per-glyph undo (advanced, future)
this.glyphUndoManagers = new Map();
for (const glyphId of glyphIds) {
  const yGlyph = this.yfont.get("glyphs").get(glyphId);
  this.glyphUndoManagers.set(
    glyphId,
    new Y.UndoManager(yGlyph, { trackedOrigins: new Set([this.ydoc.clientID]) })
  );
}
```

### Undo Granularity

**UI Operations:**

- Individual operations (move point, delete path) = individual undo steps
- Can be grouped by transaction if needed (e.g., move multiple points)

**Python Scripts:**

- Entire script = single undo step
- Achieved by wrapping in `ydoc.transact()`

```javascript
// UI: individual undos
stateManager.movePoint("A", 0, 0, 5, 250, 300); // Undo step 1
stateManager.movePoint("A", 0, 0, 6, 260, 310); // Undo step 2

// UI: grouped undo (all points moved together)
stateManager.moveMultiplePoints([
  { glyphId: "A", layerId: 0, pathIdx: 0, pointIdx: 5, x: 250, y: 300 },
  { glyphId: "A", layerId: 0, pathIdx: 0, pointIdx: 6, x: 260, y: 310 },
]); // Single undo step

// Python: always single undo step
stateManager.beginPythonTransaction();
// ... Python modifies 100 glyphs ...
stateManager.endPythonTransaction(); // Single undo step
```

## Collaboration Setup

### Phase 1: Local-only (MVP)

```typescript
constructor() {
  this.ydoc = new Y.Doc();
  this.yfont = this.ydoc.getMap('font');
  this.undoManager = new Y.UndoManager(this.yfont);

  // Local persistence only
  new IndexeddbPersistence('font-editor', this.ydoc);
}
```

### Phase 2: Add Collaboration

```typescript
enableCollaboration(config: CollaborationConfig) {
  // WebSocket provider (centralized server)
  this.wsProvider = new WebsocketProvider(
    config.serverUrl,  // 'wss://sync.contextfonts.com'
    config.roomId,     // Font-specific room ID
    this.ydoc,
    {
      connect: true,
      awareness: new awarenessProtocol.Awareness(this.ydoc)
    }
  );

  // OR WebRTC provider (P2P, no server needed)
  this.webrtcProvider = new WebrtcProvider(config.roomId, this.ydoc);

  // Listen to connection status
  this.wsProvider.on('status', ({ status }) => {
    console.log('[Collaboration]', status);  // 'connected', 'disconnected'
  });

  // Listen to awareness changes (other users' cursors, selections)
  this.wsProvider.awareness.on('change', () => {
    this.updateCollaboratorUI();
  });
}
```

### Awareness (Cursors, Selections)

```typescript
// Broadcast local user state
this.wsProvider.awareness.setLocalState({
  user: {
    name: "Alice",
    color: "#ff6b6b",
  },
  cursor: {
    glyphId: "A",
    x: 250,
    y: 300,
  },
  selection: {
    glyphId: "A",
    points: [5, 6, 7],
  },
});

// Read other users' states
const states = this.wsProvider.awareness.getStates();
states.forEach((state, clientId) => {
  if (clientId !== this.ydoc.clientID) {
    // Draw other user's cursor
    drawRemoteCursor(state.cursor, state.user.color);
  }
});
```

## BabelfontFont Integration

### Expected API (based on typical patterns)

```typescript
// babelfont-ts (expected structure)
class BabelfontFont {
  glyphs: Map<string, Glyph>; // or object
  masters: Master[];
  axes?: Axis[];
  kerning?: KerningData;

  static fromJSON(data: any): BabelfontFont {
    // Parse and construct instance
  }

  toJSON(): any {
    // Serialize to plain object
  }

  // Convenience methods
  scale(factor: number): void;
  normalize(): void;
  validate(): ValidationResult;
}

class Glyph {
  name: string;
  width: number;
  layers: Layer[];

  getBounds(): Bounds;
  transform(matrix: TransformMatrix): void;
}
```

### Our Extension

```typescript
// webapp/js/extended-babelfont.ts
import { BabelfontFont } from "babelfont-ts";

export class ExtendedBabelfontFont extends BabelfontFont {
  // Python-friendly toString
  toString(): string {
    return `Font(${this.glyphs.size} glyphs, ${this.masters.length} masters)`;
  }

  // Custom methods
  autoKern(options?: KernOptions): void {
    // Your auto-kerning logic
  }

  scaleAllGlyphs(factor: number): void {
    this.glyphs.forEach((glyph) => {
      glyph.width *= factor;
      glyph.layers.forEach((layer) => {
        layer.paths.forEach((path) => {
          path.nodes.forEach((node) => {
            node.x *= factor;
            node.y *= factor;
          });
        });
      });
    });
  }

  // Validation helpers
  findOverlappingPoints(threshold = 1): OverlapResult[] {
    // Your logic
  }
}
```

### Handling Unknown Structure

Since we don't know the exact babelfont-ts structure yet:

```typescript
class StateManager {
  private font: any; // Will be BabelfontFont when available

  // Adapter pattern for flexibility
  private fontAdapter = {
    toJSON: (font: any) => {
      if (typeof font.toJSON === "function") {
        return font.toJSON();
      }
      // Fallback: assume plain object
      return JSON.parse(JSON.stringify(font));
    },

    fromJSON: (data: any) => {
      if (typeof BabelfontFont?.fromJSON === "function") {
        return BabelfontFont.fromJSON(data);
      }
      // Fallback: use plain object
      return data;
    },
  };

  loadFont(fontData: any) {
    this.font = this.fontAdapter.fromJSON(fontData);
    // ... sync to Yjs
  }
}
```

## Python API Examples

### Reading Data

```python
# Get font instance (has methods)
font = currentFont

# Iterate glyphs
for name, glyph in font.glyphs.items():
    print(f"{name}: width={glyph.width}")

# Access nested data
node = font.glyphs['A'].layers[0].paths[0].nodes[5]
print(f"Point at ({node.x}, {node.y})")

# Use convenience methods
bounds = font.glyphs['A'].getBounds()
print(f"Bounds: {bounds}")
```

### Modifying Data

```python
# Direct manipulation (requires transaction wrapper)
stateManager.beginPythonTransaction('Scale font')

font = currentFont
for glyph in font.glyphs.values():
    glyph.width *= 1.1
    for layer in glyph.layers:
        for path in layer.paths:
            for node in path.nodes:
                node.x *= 1.1
                node.y *= 1.1

stateManager.endPythonTransaction()
```

### Using Methods

```python
# Methods that modify data
stateManager.beginPythonTransaction('Auto-kern')

currentFont.autoKern()

stateManager.endPythonTransaction()
```

### JavaScript Wrapper for Convenience

```javascript
// webapp/js/python-helpers.ts

// Automatically wrap Python execution
window.pyExec = async (code: string, description?: string) => {
  stateManager.beginPythonTransaction(description);
  try {
    const result = await pyodide.runPythonAsync(code);
    stateManager.endPythonTransaction();
    return result;
  } catch (error) {
    stateManager.cancelPythonTransaction();
    throw error;
  }
};
```

```python
# Python can use the wrapper
await pyExec("""
currentFont.scaleAllGlyphs(1.1)
""", "Scale all glyphs")
```

## Performance Considerations

### BabelfontFont Instantiation

**Concern:** Creating new BabelfontFont instances on every Yjs change could be expensive.

**Solution:** Lazy caching with invalidation

```typescript
class StateManager {
  private cachedFont: BabelfontFont | null = null;
  private fontDirty = false;

  constructor() {
    this.yfont.observeDeep(() => {
      this.fontDirty = true; // Mark as needing re-instantiation
    });
  }

  get currentFont(): BabelfontFont {
    if (!this.cachedFont || this.fontDirty) {
      const data = this.yjsToPlain(this.yfont);
      this.cachedFont = BabelfontFont.fromJSON(data);
      this.fontDirty = false;
    }
    return this.cachedFont;
  }
}
```

**Alternative:** Incremental updates (if BabelfontFont supports it)

```typescript
// If BabelfontFont has update methods:
this.yfont.observeDeep((events) => {
  events.forEach((event) => {
    if (event.path[0] === "glyphs" && event.path[1] === "A") {
      // Only update glyph 'A', don't rebuild entire font
      this.cachedFont.glyphs.set("A", Glyph.fromJSON(newData));
    }
  });
});
```

### Yjs Transaction Batching

Group related operations:

```typescript
// Instead of:
movePoint('A', 0, 0, 5, 250, 300);  // Transaction 1
movePoint('A', 0, 0, 6, 260, 310);  // Transaction 2

// Do:
moveMultiplePoints([...]);  // Single transaction

// Implementation:
moveMultiplePoints(points: PointUpdate[]) {
  this.ydoc.transact(() => {
    points.forEach(p => {
      const node = this.getNode(p.glyphId, p.layerId, p.pathIdx, p.pointIdx);
      node.set('x', p.x);
      node.set('y', p.y);
    });
  });
}
```

### Delta Calculation Optimization

For Python snapshots, use efficient diffing:

```typescript
import { diff } from 'deep-diff';  // or jsondiffpatch

syncDeltaToYjs(before: any, after: any) {
  const differences = diff(before, after);

  // Only apply actual changes, skip identical branches
  differences?.forEach(change => {
    this.applyChangeToYjs(change);
  });
}
```

## Implementation Phases

### Phase 1: Foundation (Week 1)

**Goal:** State manager with Yjs, no collaboration yet

- [ ] Install Yjs dependencies
- [ ] Create `state-manager.ts` with basic structure
- [ ] Implement Yjs ↔ plain object conversion
- [ ] Set up IndexedDB persistence
- [ ] Implement basic undo/redo
- [ ] Add placeholder for babelfont-ts integration

**Deliverable:** Can load font, modify via state manager, undo/redo works locally

### Phase 2: UI Integration (Week 2)

**Goal:** Migrate existing UI code to use state manager

- [ ] Implement all UI operation methods (movePoint, addPath, etc.)
- [ ] Update glyph canvas to use state manager
- [ ] Update component editing to use state manager
- [ ] Add keyboard shortcuts (Cmd+Z, Cmd+Shift+Z)
- [ ] Update UI to show undo/redo state
- [ ] Verify no direct mutations of font data remain

**Deliverable:** Full UI editing with working undo/redo

### Phase 3: Python Integration (Week 3)

**Goal:** Python scripts can modify font with undo support

- [ ] Implement beginPythonTransaction/endPythonTransaction
- [ ] Wrap Python console execution
- [ ] Wrap Python script execution
- [ ] Test snapshot diffing performance
- [ ] Add error handling (cancelPythonTransaction)
- [ ] Document Python API patterns

**Deliverable:** Python scripts work, create single undo entries

### Phase 4: BabelfontFont Integration (Week 4)

**Goal:** Replace plain object with babelfont-ts class

- [ ] Integrate babelfont-ts package
- [ ] Create ExtendedBabelfontFont class
- [ ] Implement toJSON/fromJSON adapters
- [ ] Add Python toString() and convenience methods
- [ ] Update state manager to use BabelfontFont
- [ ] Performance testing and caching optimization

**Deliverable:** Rich domain model with methods available in Python

### Phase 5: Collaboration (Week 5+)

**Goal:** Enable live multi-user editing

- [ ] Set up WebSocket sync server (or use y-websocket cloud)
- [ ] Implement collaboration enable/disable
- [ ] Add awareness (user cursors, selections)
- [ ] Add connection status UI
- [ ] Test conflict resolution scenarios
- [ ] Add user authentication/room management

**Deliverable:** Live collaboration between multiple users

## Technology Stack

### Required Dependencies

```json
{
  "dependencies": {
    "yjs": "^13.6.10",
    "y-indexeddb": "^9.0.12",
    "babelfont-ts": "^1.0.0" // When available
  },
  "devDependencies": {
    "@types/yjs": "^13.0.0"
  },
  "optionalDependencies": {
    "y-websocket": "^1.5.0", // For collaboration
    "y-webrtc": "^10.2.5", // For P2P collaboration
    "lib0": "^0.2.89" // Yjs utilities
  }
}
```

### Collaboration Server Options

**Option 1:** Use hosted service

- y-sweet.dev (Jamsocket) - managed Yjs server
- No server management required
- Pay-per-usage

**Option 2:** Self-hosted

- Deploy y-websocket server (Node.js)
- Simple Express server (example provided by Yjs)
- Can run on Cloudflare Workers

**Option 3:** P2P (y-webrtc)

- No server needed
- Uses WebRTC for direct peer-to-peer
- Bootstrap via public signaling server

## Testing Strategy

### Unit Tests

```typescript
describe("StateManager", () => {
  it("should track undo for single point move", () => {
    const sm = new StateManager();
    sm.loadFont(testFont);

    sm.movePoint("A", 0, 0, 5, 250, 300);
    expect(sm.canUndo()).toBe(true);

    sm.undo();
    const point = sm.currentFont.glyphs.get("A").layers[0].paths[0].nodes[5];
    expect(point.x).not.toBe(250);
  });

  it("should handle Python transaction as single undo", () => {
    const sm = new StateManager();
    sm.loadFont(testFont);

    sm.beginPythonTransaction();
    sm.currentFont.glyphs.forEach((g) => (g.width *= 2));
    sm.endPythonTransaction();

    sm.undo();
    sm.currentFont.glyphs.forEach((g) => {
      expect(g.width).not.toBeCloseTo(g.width * 2);
    });
  });
});
```

### Integration Tests

```typescript
describe("Collaboration", () => {
  it("should sync changes between two clients", async () => {
    const client1 = new StateManager();
    const client2 = new StateManager();

    client1.enableCollaboration({ roomId: "test-room" });
    client2.enableCollaboration({ roomId: "test-room" });

    await waitForSync();

    client1.movePoint("A", 0, 0, 5, 250, 300);
    await waitForSync();

    const point =
      client2.currentFont.glyphs.get("A").layers[0].paths[0].nodes[5];
    expect(point.x).toBe(250);
  });
});
```

## Security Considerations

### Collaboration

- **Authentication:** Verify user identity before allowing room access
- **Authorization:** Room-level permissions (read-only, edit, admin)
- **Validation:** Validate all Yjs operations server-side
- **Rate limiting:** Prevent DoS via excessive updates

### Python Execution

- **Sandboxing:** Pyodide runs in browser sandbox (safe by default)
- **Transaction rollback:** On error, cancel transaction to prevent partial updates
- **Resource limits:** Timeout long-running scripts

## Open Questions

### BabelfontFont Integration

1. **Does BabelfontFont use getters/setters?**

   - If yes: Can potentially intercept changes automatically
   - If no: Must use snapshot-based detection

2. **How expensive is fromJSON/toJSON?**

   - Affects caching strategy
   - May need incremental update support

3. **Does it support incremental updates?**

   - updateGlyph(id, data) vs full reconstruction
   - Would improve performance

4. **What's the data structure?**
   - Map vs plain object for glyphs
   - Affects iteration in Python

### Performance Targets

- **UI responsiveness:** < 16ms per operation (60fps)
- **Python snapshot diff:** < 100ms for typical script
- **Font instantiation:** < 50ms for average font
- **Collaboration latency:** < 200ms for remote change to appear

## Future Enhancements

### Per-Glyph Undo

Allow undo scoped to individual glyphs:

```typescript
// When editing glyph 'A'
stateManager.setUndoScope("glyph", "A");
// Cmd+Z only undoes changes to glyph 'A'

// When in font view
stateManager.setUndoScope("global");
// Cmd+Z undoes any change
```

### Undo History UI

Visual undo stack browser:

- List of recent operations
- Click to jump to specific state
- Branch visualization for collaborative conflicts

### Operational Transforms

For fine-grained Python tracking without snapshots:

- Parse Python AST to detect operations
- Generate Yjs transactions from AST
- More complex but more efficient

### Offline Collaboration

Yjs already supports offline editing, but need UI for:

- Conflict resolution UI
- Sync status indicator
- Merge conflict handling

## Conclusion

This architecture provides:

- ✓ **Clean Python API:** Normal object manipulation, no wrappers
- ✓ **Live Collaboration:** CRDT-based, automatic conflict resolution
- ✓ **Robust Undo/Redo:** Multi-user aware, operation-based
- ✓ **Rich Domain Model:** TypeScript classes with methods and validation
- ✓ **Performance:** Efficient updates, lazy instantiation
- ✓ **Future-Proof:** Easy to add features incrementally

The key insight is using **Yjs as source of truth** for collaboration/undo, while maintaining a **BabelfontFont instance as the materialized view** for the rich API. This separation of concerns provides the best of both worlds.
