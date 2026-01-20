# babelfont-ts Migration Plan

## Overview

Migrate from custom babelfont.d.ts interfaces and babelfontobjectmodel.js to using babelfont-ts from the babelfont-rs repository as the foundation, while preserving all existing convenience functions and adding change tracking hooks for future undo/redo and collaboration features.

## Goals

1. Use babelfont-ts as the source of truth for TypeScript definitions
2. Replace bounding box calculations with Rust/WASM implementations
3. Maintain all existing convenience methods (findGlyph, addPath, lsb/rsb, etc.)
4. Add change callback hooks for future Yjs integration
5. Preserve comprehensive API documentation for Python scripting
6. Ensure type safety and refactor where needed

## Architecture Decisions

### 1. Proxy Modification: Wrap, Don't Fork

Add a second Proxy layer in extended classes rather than forking babelfont-ts's createCaseConvertingProxy.

**Rationale:** Stays in sync with upstream updates, clean separation of concerns.

### 2. Custom Properties: Use Class Registry

Add custom properties (cachedComponentLayerData, legacyMasterRef) directly to extended classes.

**Rationale:** Single source of truth, TypeScript autocomplete, no separate augmentation files.

### 3. Testing Strategy: New Tests First, Then Verify Existing

Write tests for extended classes, then run existing test suite to catch regressions.

**Rationale:** New tests document expected behavior, existing tests verify compatibility.

## Implementation Steps

### Step 1: Add babelfont-ts Dependency

**Files to modify:**

- Create `webapp/vendor/` directory structure
- Update `webapp/package.json`
- Update `webapp/webpack.config.js`
- Update `webapp/tsconfig.json`

**Actions:**

1. Add babelfont-ts as git submodule pointing to `https://github.com/simoncozens/babelfont-rs` subdirectory `babelfont-ts`
2. Install babelfont-ts dependencies in webapp
3. Configure webpack alias: `'babelfont-ts': path.resolve(__dirname, 'vendor/babelfont-ts/src')`
4. Add TypeScript path mapping for babelfont-ts imports
5. Pin to specific babelfont-rs commit matching Rust dependency in `babelfont-fontc-build/Cargo.toml`

**Verification:**

```bash
cd webapp
npm install
npm run build  # Should resolve babelfont-ts imports
```

### Step 2: Create Extended Classes with Rust-Backed Methods

**Files to create:**

- `webapp/js/babelfont-extended.ts`

**Files to reference:**

- `webapp/js/babelfontobjectmodel.js` (source of convenience methods)
- `babelfont-fontc-build/pkg/babelfont_fontc_web.d.ts` (WASM interface)

**Actions:**

1. Create extended classes for each babelfont-ts class:
   - `Font extends BabelfontFont`
   - `Glyph extends BabelfontGlyph`
   - `Layer extends BabelfontLayer`
   - `Path extends BabelfontPath`
   - `Node extends BabelfontNode`
   - `Component extends BabelfontComponent`
   - etc.

2. Migrate convenience methods from babelfontobjectmodel.js:

   **Font class:**
   - `findGlyph(name)` - lookup by name
   - `findGlyphByUnicode(unicode)` - lookup by codepoint
   - `getAxis(tag)`, `getAxisByName(name)` - axis lookups
   - `getMaster(id)` - master lookup
   - `clone()` - deep clone
   - Custom properties: add any needed

   **Glyph class:**
   - `addLayer()`, `deleteLayer(id)` - layer management
   - `getLayer(id)`, `getLayerByMasterId(masterId)` - layer lookups
   - Custom properties: none currently

   **Layer class:**
   - **Replace with WASM:** `bounds()` - call WASM after decomposing components
   - **Keep in JS:** `lsb` getter/setter - calculate from bounds()
   - **Keep in JS:** `rsb` getter/setter - calculate from bounds() and width
   - `addPath(closed)`, `addComponent(ref, transform)` - add shapes
   - `deletePath(idx)`, `deleteComponent(idx)` - delete shapes
   - `createAnchor(name, x, y)` - add anchor
   - `allPaths(includeComponents)` - path extraction with optional component flattening
   - `intersectWithLine(x1, y1, x2, y2)` - line intersection using Bezier.js (keep in JS)
   - `correspondingLayerOnGlyph(otherGlyph)` - find matching layer
   - Custom properties: `cachedComponentLayerData`

   **Path class:**
   - `insertNode(idx, node)` - insert node
   - `addNode(node)` - append node
   - `deleteNode(idx)` - remove node
   - Static: `nodesToString()`, `nodesFromString()` - compact format conversion (may be in babelfont-ts already)

   **Component class:**
   - `flatten(font)` - recursive component decomposition with transforms (may use WASM)
   - Custom properties: `cachedComponentLayerData`

3. Add change tracking wrapper in each extended class constructor:

```typescript
export class Layer extends BabelfontLayer {
  cachedComponentLayerData?: any;

  constructor(data: ILayer) {
    const instance = super(data);

    return new Proxy(instance, {
      set(target, prop, value) {
        const result = Reflect.set(target, prop, value);
        if (result && window.fontManager?.currentFont) {
          window.fontManager.currentFont.dirty = true;
        }
        return result;
      },
    });
  }

  // Convenience methods that mutate also call markFontDirty
  addPath(closed = false): Path {
    const path = new Path({ nodes: [], closed });
    this.shapes.push(path);
    if (window.fontManager?.currentFont) {
      window.fontManager.currentFont.dirty = true;
    }
    return path;
  }
}
```

4. Add comprehensive JSDoc with Python examples for API doc generator:

```typescript
/**
 * Find a glyph by name
 *
 * @param name - The glyph name to search for
 * @returns The glyph if found, undefined otherwise
 * @example
 * glyph = font.findGlyph("A")
 * if glyph:
 *     print(glyph.width)
 */
findGlyph(name: string): Glyph | undefined {
  return this.glyphs?.find(g => g.name === name);
}
```

**Verification:**

```bash
cd webapp
npm run build  # Should compile without errors
```

### Step 3: Register Extended Classes and Integrate

**Files to modify:**

- `webapp/js/babelfont-extended.ts` (add registry setup)
- `webapp/js/fontmanager.js` (update font loading)
- All files importing from `babelfontobjectmodel.js`

**Actions:**

1. Create class registry in babelfont-extended.ts:

```typescript
import { Font as BabelfontFont } from "babelfont-ts";
import type { ClassRegistry } from "babelfont-ts";

// ... extended class definitions ...

// Export registry
export const ExtendedClassRegistry: ClassRegistry = {
  Font,
  Glyph,
  Layer,
  Path,
  Node,
  Component,
  Anchor,
  Guide,
  // ... etc
};

// Export function to load font with extended classes
export function loadFontFromJSON(data: any): Font {
  return new Font(data, ExtendedClassRegistry);
}
```

2. Update fontmanager.js to use loadFontFromJSON:

```typescript
import { loadFontFromJSON } from "./babelfont-extended";

// Replace:
// this.fontModel = new BabelfontFont(babelfontData);
// With:
this.fontModel = loadFontFromJSON(babelfontData);
```

3. Replace all imports throughout codebase:

```bash
# Find all imports
grep -r "from './babelfontobjectmodel'" webapp/js/

# Replace with:
# import { Font, Glyph, Layer, ... } from './babelfont-extended';
```

4. Remove old files:

- Delete `webapp/js/babelfont.d.ts`
- Delete `webapp/js/babelfontobjectmodel.js`

**Verification:**

```bash
cd webapp
npm run build
# Check for import errors
grep -r "babelfontobjectmodel" webapp/js/  # Should return nothing
```

### Step 4: Update API Documentation Generator

**Files to modify:**

- `generate-api-docs.mjs`

**Actions:**

1. Update source file path from babelfontobjectmodel.js to babelfont-extended.ts
2. Verify JSDoc parsing works with TypeScript
3. Test Python type conversions with new TypeScript types
4. Regenerate API documentation

**Verification:**

```bash
node generate-api-docs.mjs
# Check output API.md for completeness
```

### Step 5: Testing

**Files to create:**

- `webapp/tests/babelfont-extended.test.ts`

**Actions:**

1. Write tests for extended functionality:
   - Test convenience methods (findGlyph, addPath, etc.)
   - Test change tracking (dirty flag)
   - Test custom properties
   - Test WASM-backed bounds() method
   - Test lsb/rsb getters/setters

2. Run existing test suite:

```bash
cd webapp
npm test
```

3. Fix any regressions discovered

4. Update existing tests to import from babelfont-extended if needed

## WASM Integration Notes

### Geometry Methods

Since font already exists in WASM and is kept in sync after every edit:

**Layer.bounds():**

```typescript
bounds(): { x: number, y: number, width: number, height: number } {
  // Call WASM method (font is already synced)
  const wasmBounds = window.wasmWorker.getLayerBounds(
    this.parent.name,  // glyph name
    this.id
  );
  return wasmBounds;
}
```

**Layer.lsb getter/setter (kept in JS):**

```typescript
get lsb(): number {
  const bounds = this.bounds();  // WASM call
  return bounds.x;
}

set lsb(value: number) {
  const bounds = this.bounds();  // WASM call
  const delta = value - bounds.x;
  // Shift all shapes
  this.shapes.forEach(shape => {
    if ('nodes' in shape) {
      // Path
      shape.nodes.forEach(node => {
        node.x += delta;
      });
    } else {
      // Component
      shape.transform.x += delta;
    }
  });
  // Mark dirty to trigger WASM sync
  if (window.fontManager?.currentFont) {
    window.fontManager.currentFont.dirty = true;
  }
}
```

**Layer.rsb getter/setter (kept in JS):**

```typescript
get rsb(): number {
  const bounds = this.bounds();  // WASM call
  return this.width - (bounds.x + bounds.width);
}

set rsb(value: number) {
  const bounds = this.bounds();  // WASM call
  const currentRsb = this.width - (bounds.x + bounds.width);
  const delta = value - currentRsb;
  this.width += delta;
  // Mark dirty
  if (window.fontManager?.currentFont) {
    window.fontManager.currentFont.dirty = true;
  }
}
```

## Rollback Plan

If migration encounters critical issues:

1. Revert git commits
2. Restore babelfont.d.ts and babelfontobjectmodel.js from git history
3. Document issues encountered
4. Reassess approach

## Success Criteria

- [ ] All existing tests pass
- [ ] No TypeScript compilation errors
- [ ] API documentation generates correctly
- [ ] Python console works with extended classes
- [ ] Font compilation still works (WASM integration intact)
- [ ] No performance regressions in canvas rendering
- [ ] All convenience methods work as before
- [ ] Change tracking calls markFontDirty appropriately

## Timeline Estimate

- Step 1: 2 hours (dependency setup)
- Step 2: 8-12 hours (migrate all convenience methods)
- Step 3: 4 hours (registry setup and import replacement)
- Step 4: 2 hours (API docs update)
- Step 5: 4-6 hours (testing and fixes)

**Total: 20-26 hours**

## Future Enhancements

Once migration is complete:

1. **Undo/Redo Integration**
   - Enhance change callbacks to track property paths
   - Integrate with Yjs for CRDT-based undo
   - See UNDO_COLLABORATION_ARCHITECTURE.md

2. **Collaboration**
   - Wire change callbacks to Yjs document
   - Add WebSocket provider
   - Implement conflict resolution

3. **Additional Rust Methods**
   - Expose more babelfont-rs methods to JavaScript
   - Add path operations (reverse, simplify, etc.)
   - Add interpolation helpers
