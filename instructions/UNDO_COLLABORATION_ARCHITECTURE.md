# Undo/Redo and Collaboration Architecture

## Executive Summary

This document outlines the architecture for implementing undo/redo functionality and live collaboration in the Context Font Editor. The design uses **Yjs (CRDT)** as the source of truth for collaboration and undo, while maintaining the existing **babelfont-model.ts classes** (Font, Glyph, Layer, Path, Node, etc.) as the rich domain model for the Python API and application logic.

> **Current State:** The existing codebase already has a working object model (`babelfont-model.ts`) with getters/setters that mark fonts dirty, Python execution hooks (`beforePythonExecution`/`afterPythonExecution`), and a font manager. This architecture builds upon these foundations.

## Core Requirements

1. **Clean Python API**: Users write normal Python code to manipulate font data
2. **Live Collaboration**: Multiple users can edit the same font simultaneously
3. **Local Undo/Redo**: Per-user undo stack that respects collaborative changes
4. **Rich Domain Model**: TypeScript class-based model with methods and validation
5. **Performance**: No significant overhead during normal editing operations

## Existing Infrastructure to Leverage

The codebase already provides several building blocks:

| Component                                        | Location                      | Current Function                  | Undo/Collab Role                  |
| ------------------------------------------------ | ----------------------------- | --------------------------------- | --------------------------------- |
| `Font`, `Glyph`, `Layer`, `Path`, `Node` classes | `babelfont-model.ts`          | Object model with getters/setters | Will become the materialized view |
| `markFontDirty()`                                | `babelfont-model.ts`          | Marks font as modified            | Hook point for change tracking    |
| `beforePythonExecution` / `afterPythonExecution` | `python-execution-wrapper.js` | Hooks around Python execution     | Transaction boundaries            |
| `OpenedFont.dirty`                               | `font-manager.ts`             | Tracks unsaved changes            | Can be derived from Yjs state     |
| `OpenedFont.syncJsonFromModel()`                 | `font-manager.ts`             | Syncs object model to JSON        | Integrate with Yjs sync           |

## Architecture Overview

```
┌─────────────────────────────────────────────────────┐
│              Yjs Document (Y.Map)                   │
│         SOURCE OF TRUTH FOR STATE (NEW)             │
│  - Handles conflict resolution (CRDT)               │
│  - Manages undo/redo stacks                         │
│  - Broadcasts changes to collaborators              │
│  - Persists to IndexedDB                            │
└──────────────┬──────────────────────────────────────┘
               │
               │ observeDeep() → updates underlying JSON
               ↓
┌─────────────────────────────────────────────────────┐
│    babelfont-model.ts Classes (EXISTING)            │
│    Font, Glyph, Layer, Path, Node, Component        │
│  - Getters/setters wrapping babelfontData JSON      │
│  - markFontDirty() → hook for change tracking       │
│  - Python-friendly toString() on all classes        │
│  - Path.nodesToString() for serialization           │
└──────────────┬──────────────────────────────────────┘
               │
               ↓
    window.currentFontModel (via fontManager.currentFont.fontModel)
               │
        ┌──────┴─────────┬──────────┬─────────┐
        │                │          │         │
     Python            UI       Canvas     File I/O
  (snapshot)     (modify model) (reads)  (syncJsonFromModel)
```

> **Key Insight:** The existing `babelfont-model.ts` classes are thin wrappers around `babelfontData` JSON. We can intercept `markFontDirty()` calls to sync changes to Yjs, rather than replacing the entire model.

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

### Integration with Existing markFontDirty()

The existing `markFontDirty()` function in `babelfont-model.ts` is called by every setter. We can hook into this for Yjs sync:

```typescript
// In babelfont-model.ts, modify markFontDirty():
function markFontDirty(): void {
  if (window.fontManager?.currentFont) {
    window.fontManager.currentFont.dirty = true;

    // NEW: Notify state manager of change
    if (window.stateManager && !window.stateManager.inPythonTransaction) {
      // Queue a microtask to batch rapid changes
      window.stateManager.scheduleYjsSync();
    }
  }
}
```

**Alternative: Debounced Sync Strategy**

For better performance, especially during drag operations:

```typescript
class StateManager {
  private syncDebounceTimer: number | null = null;
  private pendingChanges: Set<string> = new Set(); // Track changed paths

  scheduleYjsSync(changedPath?: string) {
    if (changedPath) this.pendingChanges.add(changedPath);

    if (this.syncDebounceTimer) clearTimeout(this.syncDebounceTimer);
    this.syncDebounceTimer = window.setTimeout(() => {
      this.flushChangesToYjs();
    }, 16); // ~1 frame
  }

  flushChangesToYjs() {
    this.ydoc.transact(() => {
      // Sync only changed portions
      for (const path of this.pendingChanges) {
        this.syncPathToYjs(path);
      }
    });
    this.pendingChanges.clear();
  }
}
```

### 2. Python Script Execution

**Path: Python → Font Model → Snapshot Diff → Yjs**

The existing `python-execution-wrapper.js` already provides `beforePythonExecution` and `afterPythonExecution` hooks. We leverage these:

```javascript
// In python-execution-wrapper.js, hooks are already called:
window.beforePythonExecution = () => {
  stateManager.beginPythonTransaction();
};

window.afterPythonExecution = () => {
  stateManager.endPythonTransaction();
};

// Python executes normally (fast, no overhead)
await pyodide.runPythonAsync(`
font = currentFont
for glyph in font.glyphs.values():
    glyph.width *= 1.1
    for layer in glyph.layers:
        for path in layer.paths:
            for node in path.nodes:
                node.x *= 1.1
`);

// Implementation in StateManager:
beginPythonTransaction(description = 'Python script') {
  // Temporarily disable per-property Yjs sync
  this.inPythonTransaction = true;

  // Take snapshot of current state
  this.pythonSnapshot = {
    description,
    before: JSON.parse(JSON.stringify(this.fontManager.currentFont.babelfontData)),
    timestamp: Date.now()
  };
}

endPythonTransaction() {
  // Re-enable per-property sync
  this.inPythonTransaction = false;

  // Get state after Python modifications
  const after = this.fontManager.currentFont.babelfontData;
  const before = this.pythonSnapshot.before;

  // Calculate delta and apply to Yjs as single transaction
  this.ydoc.transact(() => {
    this.syncDeltaToYjs(before, after, this.yfont);
  }, 'python-script');  // Origin tag for undo tracking

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

Given the existing infrastructure (`babelfont-model.ts`, Python execution hooks, `font-manager.ts`), phases are reorganized to leverage what's already built:

### Phase 1: Simple Undo/Redo (3-4 days)

**Goal:** Basic undo/redo without Yjs, using JSON patches

- [ ] Install `fast-json-patch` or `jsondiffpatch`
- [ ] Create `undo-manager.ts` with simple stack-based undo
- [ ] Hook into existing `beforePythonExecution`/`afterPythonExecution`
- [ ] Add transaction wrappers for UI operations (point drag, etc.)
- [ ] Add keyboard shortcuts (Cmd+Z, Cmd+Shift+Z)
- [ ] Add undo/redo buttons with stack depth indicator

**Files to modify:**

- `python-execution-wrapper.js` - Connect to undo manager
- `glyph-canvas.ts` - Wrap edit operations in transactions
- `keyboard-navigation.js` - Add undo/redo shortcuts

**Deliverable:** Working undo/redo for all editing operations

### Phase 2: Transaction Granularity (2-3 days)

**Goal:** Proper grouping of related operations

- [ ] Batch rapid changes (e.g., 60fps point dragging → 1 undo entry)
- [ ] Handle "begin drag" / "end drag" semantics in canvas
- [ ] Python scripts as single undo entries (already have hooks!)
- [ ] Add transaction descriptions for undo UI

**Key insight:** The existing `afterPythonExecution` hook is perfect for ending Python transactions. Just need to capture the "before" state.

**Deliverable:** Intuitive undo behavior matching user expectations

### Phase 3: Add Yjs Infrastructure (3-4 days)

**Goal:** Introduce Yjs as shadow state (non-blocking)

- [ ] Install Yjs dependencies
- [ ] Create `state-manager.ts` that wraps the undo manager
- [ ] Mirror `babelfontData` to Yjs on changes (async, debounced)
- [ ] Set up IndexedDB persistence via `y-indexeddb`
- [ ] Migrate undo from JSON patches to Yjs UndoManager

**Deliverable:** Yjs running in parallel, no user-visible changes

### Phase 4: Collaboration Foundation (1 week)

**Goal:** Enable multi-user editing

- [ ] Set up PartyKit or y-websocket server
- [ ] Implement "Share" button that enables collaboration
- [ ] Add connection status UI (connected/disconnected/syncing)
- [ ] Handle offline → online transitions
- [ ] Add basic awareness (who else is viewing)

**Deliverable:** Two users can edit the same font

### Phase 5: Collaboration Polish (1 week+)

**Goal:** Production-quality collaboration

- [ ] Show remote user cursors/selections on canvas
- [ ] Add user presence list
- [ ] Handle conflict visualization (optional)
- [ ] Room management and sharing links
- [ ] Rate limiting and security
- [ ] Authentication integration

**Deliverable:** Full collaborative editing experience

## Technology Stack

### Required Dependencies

```json
{
  "dependencies": {
    "yjs": "^13.6.15",
    "y-indexeddb": "^9.0.12",
    "immer": "^10.0.3",
    "fast-json-patch": "^3.1.1"
  },
  "optionalDependencies": {
    "y-websocket": "^2.0.0",
    "y-webrtc": "^10.3.0",
    "lib0": "^0.2.94",
    "y-partykit": "^0.0.25"
  }
}
```

> **Note:** The existing codebase already uses `idb-keyval` for IndexedDB. Consider whether to migrate to `y-indexeddb` or use both.

### Alternative to Yjs: Simpler Undo-Only Approach

If collaboration is not an immediate priority, a simpler command-pattern approach could be faster to implement:

```typescript
// Simple undo stack without Yjs
interface UndoEntry {
  description: string;
  patches: JsonPatch[]; // From fast-json-patch
  timestamp: number;
}

class SimpleUndoManager {
  private undoStack: UndoEntry[] = [];
  private redoStack: UndoEntry[] = [];
  private snapshotBefore: any = null;

  beginTransaction(description: string) {
    this.snapshotBefore = JSON.parse(JSON.stringify(currentData));
  }

  endTransaction(description: string) {
    const patches = jsonpatch.compare(this.snapshotBefore, currentData);
    if (patches.length > 0) {
      this.undoStack.push({ description, patches, timestamp: Date.now() });
      this.redoStack = []; // Clear redo on new action
    }
  }

  undo() {
    const entry = this.undoStack.pop();
    if (entry) {
      const reversePatches = jsonpatch.compare(
        currentData,
        this.applyPatches(entry.patches, true)
      );
      this.redoStack.push({ ...entry, patches: reversePatches });
    }
  }
}
```

This can later be upgraded to Yjs for collaboration.

````

### Collaboration Server Options

**Option 1: PartyKit (Recommended for MVP)**

- `y-partykit` - Serverless Yjs on Cloudflare's edge
- Free tier available, scales automatically
- Integrates with existing Cloudflare setup (see `cloudflare-worker.js`)
- Example: `partykit.io/party/context-font-editor`

**Option 2: Hosted Services**

- **Liveblocks** - Full-featured, React-focused but works with vanilla JS
- **y-sweet (Jamsocket)** - Managed Yjs, pay-per-usage
- **Hocuspocus** - Self-hostable with good defaults

**Option 3: Self-hosted on Existing Infrastructure**

- Deploy `y-websocket` server alongside existing backend
- Can run on Cloudflare Workers (already have `cloudflare-worker.js`)
- ~50 lines of code for basic sync

**Option 4: P2P (y-webrtc)**

- No server for data sync (only signaling)
- Good for local/offline-first scenarios
- May have NAT traversal issues in some networks

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
````

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

### Integration Decisions (Answered from Codebase Analysis)

1. **Does the object model use getters/setters?**

   - ✅ **YES**: `babelfont-model.ts` uses getters/setters on all classes
   - Every setter calls `markFontDirty()` - perfect hook point!

2. **How expensive is serialization?**

   - The model wraps `babelfontData` directly (no copying)
   - `syncJsonFromModel()` in `font-manager.ts` handles Path nodes → string conversion
   - Need to profile: JSON.stringify on 1000-glyph font

3. **Does it support incremental updates?**

   - Currently: No - full JSON is regenerated
   - Recommendation: Track changed glyph IDs, only sync those to Yjs

4. **What's the data structure?**
   - Glyphs: Array with name lookup via `Font.glyphs.get(name)`
   - Python iteration via `font.glyphs.values()` works

### Remaining Questions

1. **Python execution granularity**

   - Should individual console commands (REPL) also be undoable?
   - Or only full script executions?

2. **Undo scope during glyph editing**

   - Should switching glyphs commit the current undo group?
   - What about switching masters/layers?

3. **Conflict resolution UI**
   - What happens when collaborative edits conflict?
   - Yjs handles merging, but should we show users what changed?

### Performance Targets

- **UI responsiveness:** < 16ms per operation (60fps during drag)
- **Python snapshot diff:** < 50ms for typical script (use `fast-json-patch` or `jsondiffpatch`)
- **Yjs sync:** < 5ms for single glyph change
- **Full font serialization:** < 200ms for 1000-glyph font (profile `syncJsonFromModel()`)
- **Collaboration latency:** < 300ms for remote change to appear (includes network)
- **Undo/Redo:** < 10ms (operation-based, not snapshot restore)

### Profiling Recommendations

Add performance marks to critical paths:

```javascript
performance.mark("sync-start");
syncJsonFromModel();
performance.mark("sync-end");
performance.measure("syncJsonFromModel", "sync-start", "sync-end");
console.log(
  "[Performance]",
  performance.getEntriesByName("syncJsonFromModel")[0].duration
);
```

## Incremental Migration Strategy

Rather than a big-bang rewrite, integrate Yjs incrementally:

### Step 1: Undo-Only (No Yjs Yet)

```typescript
// Extend existing hooks in python-execution-wrapper.js
window.beforePythonExecution = () => {
  undoManager.beginTransaction("Python script");
};

window.afterPythonExecution = () => {
  undoManager.endTransaction();
};
```

### Step 2: Add Yjs as Shadow State

```typescript
// Yjs runs in parallel, doesn't block UI
class StateManager {
  private ydoc = new Y.Doc();
  private yfont = this.ydoc.getMap("font");

  // Mirror changes to Yjs without blocking
  scheduleYjsSync = debounce(() => {
    requestIdleCallback(() => {
      this.syncToYjs();
    });
  }, 100);
}
```

### Step 3: Enable Collaboration

```typescript
// Only when user clicks "Share"
enableCollaboration() {
  this.wsProvider = new WebsocketProvider(...);
  // Now Yjs is the authority, not just a mirror
  this.yfont.observeDeep(() => this.syncFromYjs());
}
```

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
