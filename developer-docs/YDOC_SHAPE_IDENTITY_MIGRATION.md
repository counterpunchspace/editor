# Y.Doc outline identity

**Status:** Active. Normalized geometry is the Y.Doc authority for outlines.

Nested numeric writes such as `shapes/0/nodes` converged in browser Yjs but
could append duplicate parent shapes in Rust/Yrs. Do not restore that path.

## Storage

Each layer stores:

```text
geometryTopology       versioned JSON string (generation + atomic path grammar)
nodePositionsById     Y.Map<nodeUUID, "x y">
shapeDataById          Y.Map<shapeUUID, non-topology fields>
```

Browser and Rust reconstruct ordered Babelfont `shapes` after a complete
Yjs transaction. `shapes` Y.Array is not stored alongside this schema.

- Coordinate drag: `nodePositionsById.set(nodeId, packedXY)`
- Structural path ops: atomically replace `geometryTopology`, increment its
  generation, and add/remove shape data or positions as needed after
  convergence.
- External source files still use ordinary `shapes` arrays; runtime IDs are
  stripped at that boundary.

## Reconstruction rules

1. Reject duplicate/missing shape IDs and node references.
2. Reject unknown topology versions and malformed path grammar.
3. Do not skip stale order entries for the normalized schema.
4. On reconstruction failure, do not replace the last known-good compiler cache.
5. Browser and Rust shape/node counts must match.

Legacy documents that still have a flat `shapes` Y.Array are migrated atomically
on write. Flat and normalized representations are never simultaneous authorities.
