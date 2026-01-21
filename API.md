# Font Object Model API Documentation

*Auto-generated from JavaScript object model introspection*


## Table of Contents


- [Overview](#overview)
- [Class Reference](#class-reference)
  - [Font](#font) - 
  - [Glyph](#glyph) - 
  - [Layer](#layer) - 
  - [Path](#path) - 
  - [Node](#node) - 
  - [Component](#component) - 
  - [Anchor](#anchor) - 
  - [Guide](#guide) - 
  - [Axis](#axis) - 
  - [Master](#master) - 
  - [Instance](#instance) - 
- [Complete Examples](#complete-examples)
- [Tips and Best Practices](#tips-and-best-practices)

---

## Overview

The Font Object Model provides an object-oriented interface for manipulating font data.
All objects are lightweight facades over the underlying JSON data - changes are immediately
reflected in the font structure.

### Accessing the Font Model

```python
# Get the current font (fonteditor module is pre-loaded)
font = CurrentFont()
```

### Parent Navigation

All objects in the hierarchy have a `parent()` method that returns their parent object,
allowing navigation up the object tree to the root Font object.

**Example:**
```python
# Navigate from node up to font
node = font.glyphs[0].layers[0].shapes[0].asPath().nodes[0]
path = node.parent()      # Path object
shape = path.parent()     # Shape object
layer = shape.parent()    # Layer object
glyph = layer.parent()    # Glyph object
font = glyph.parent()     # Font object
```

---


## Class Reference


## Font

**Access:**
```python
# fonteditor module is pre-loaded
font = CurrentFont()
```

### Methods

#### `findGlyph(name: str) -> [Glyph](#glyph) | None`
Find a glyph by name

**Example:**
```python
glyph = font.findGlyph("A")
if glyph:
    print(glyph.width)
```

#### `findGlyphByUnicode(unicode: float | int) -> [Glyph](#glyph) | None`
Find a glyph by Unicode codepoint

**Example:**
```python
glyph = font.findGlyphByUnicode(0x0041)  # 'A'
if glyph:
    print(glyph.name)
```

#### `getAxis(tag: str) -> [Axis](#axis) | None`
Get an axis by tag

**Example:**
```python
axis = font.getAxis("wght")
if axis:
    print(axis.min, axis.max)
```

#### `getAxisByName(name: str) -> [Axis](#axis) | None`
Get an axis by name

**Example:**
```python
axis = font.getAxisByName("Weight")
if axis:
    print(axis.tag)
```

#### `getMaster(id: str) -> [Master](#master) | None`
Get a master by ID

**Example:**
```python
master = font.getMaster("m01")
if master:
    print(master.name)
```

#### `toJSONString() -> str`
Serialize font to JSON string

**Example:**
```python
json_str = font.toJSONString()
with open("font.json", "w") as f:
    f.write(json_str)
```

#### `fromData(data: IFont) -> [Font](#font)`
Create a Font instance from parsed JSON data

**Example:**
```python
font = Font.fromData(data_dict)
```

---


## Glyph

**Access:**
```python
glyph = font.glyphs[0]
# or
glyph = font.findGlyph("A")
```

### Methods

#### `getLayerById(id: str) -> [Layer](#layer) | None`
Get a layer by ID

**Example:**
```python
layer = glyph.getLayerById("m01")
if layer:
    print(layer.width)
```

#### `getLayerByMasterId(masterId: str) -> [Layer](#layer) | None`
Get a layer by master ID

**Example:**
```python
layer = glyph.getLayerByMasterId("m01")
if layer:
    print(layer.width)
```

---


## Layer

**Access:**
```python
layer = glyph.layers[0]
```

### Properties

All properties are read/write:

- **`cachedComponentLayerData`** (Any)
- **`lsb`** (float | int): Get left sidebearing
- **`rsb`** (float | int): Get right sidebearing

### Methods

#### `bounds() -> { x: number; y: number; width: number; height: number } | None`
Get bounding box of layer (WASM-backed)

**Example:**
```python
bounds = layer.bounds()
print(f"x={bounds['x']}, y={bounds['y']}")
```

#### `addPath(closed: bool) -> [Path](#path)`
Add a new path to the layer

**Example:**
```python
path = layer.addPath(closed=True)
path.addNode({"x": 0, "y": 0, "type": "line"})
```

#### `deletePath(index: float | int) -> None`
Delete a path by index

**Example:**
```python
layer.deletePath(0)
```

#### `addComponent(reference: str, transform: Any | None = None) -> [Component](#component)`
Add a new component to the layer

**Example:**
```python
comp = layer.addComponent("A")
comp.transform.x = 100
```

#### `deleteComponent(index: float | int) -> None`
Delete a component by index

**Example:**
```python
layer.deleteComponent(0)
```

#### `createAnchor(name: str, x: float | int, y: float | int) -> [Anchor](#anchor)`
Create and add an anchor

**Example:**
```python
anchor = layer.createAnchor("top", 250, 700)
```

#### `processPathSegments(pathData: { nodes: any[]; closed?: boolean; }) -> Array<{ points: Array<{ x: number; y: number }>; type: 'line' | 'quadratic' | 'cubic'; }>`
Process a path into Bezier curve segments
Handles the babelfont node format where:
- Nodes can have 'type' (lowercase: o, c, l, q, etc.) or 'nodetype' (capitalized: OffCurve, Curve, Line, etc.)
- Segments are sequences: [oncurve] [offcurve*] [oncurve]
- For closed paths, the path can start with offcurve nodes

#### `flattenComponents(layer: [Layer](#layer), font: [Font](#font) | None = None) -> list[PathData]`
Flatten all components in the layer to paths with their transforms applied
This recursively processes nested components to any depth

#### `getDirectPaths() -> list[PathData]`
Get only direct paths in this layer (no components)

#### `getAllPaths() -> list[PathData]`
Get all paths in this layer including transformed paths from components (recursively flattened)

#### `calculateBoundingBox(layer: [Layer](#layer), includeAnchors: bool, font: [Font](#font) | None = None) -> { minX: number; minY: number; maxX: number; maxY: number; width: number; height: number; } | None`
Calculate bounding box for layer

#### `getBoundingBox(includeAnchors: bool) -> { minX: number; minY: number; maxX: number; maxY: number; width: number; height: number; } | None`
Calculate bounding box for this layer

#### `getIntersectionsOnLine(p1: { x: number; y: number }, p2: { x: number; y: number }, includeComponents: bool) -> Array<{ x: number; y: number; t: number }>`
Calculate intersections between a line segment and all paths in this layer

---


## Path

**Access:**
```python
shape = layer.shapes[0]
if shape.isPath():
    path = shape.asPath()
```

### Methods

#### `nodesToString(nodes: list[Any]) -> str`
Convert nodes array to compact string format

**Example:**
```python
nodes_str = Path.nodesToString(path.nodes)
```

#### `insertNode(index: float | int, node: INode) -> None`
Insert a node at a specific index

**Example:**
```python
path.insertNode(1, {"x": 100, "y": 200, "type": "line"})
```

#### `addNode(node: INode) -> None`
Add a node to the end of the path

**Example:**
```python
path.addNode({"x": 100, "y": 200, "type": "line"})
```

#### `deleteNode(index: float | int) -> None`
Delete a node by index

**Example:**
```python
path.deleteNode(0)
```

---


## Node

**Access:**
```python
node = path.nodes[0]
```

---


## Component

**Access:**
```python
shape = layer.shapes[0]
if shape.isComponent():
    component = shape.asComponent()
```

### Properties

All properties are read/write:

- **`cachedComponentLayerData`** (Any)

---


## Anchor

**Access:**
```python
anchor = layer.anchors[0]
```

---


## Guide

**Access:**
```python
guide = layer.guides[0]
# or
guide = master.guides[0]
```

---


## Axis

**Access:**
```python
axis = font.axes[0]
# or
axis = font.findAxisByTag("wght")
```

---


## Master

**Access:**
```python
master = font.masters[0]
# or
master = font.findMaster("master-id")
```

---


## Instance

**Access:**
```python
instance = font.instances[0]
```

---


## Complete Examples

### Example 1: Creating a Simple Glyph

```python
# Get the font
font = CurrentFont()

# Create a new glyph
glyph = font.addGlyph("myGlyph", "Base")

# Add a layer
layer = glyph.addLayer(500)  # 500 units wide

# Create a rectangle path
path = layer.addPath(closed=True)
path.appendNode(100, 0, "Line")
path.appendNode(400, 0, "Line")
path.appendNode(400, 700, "Line")
path.appendNode(100, 700, "Line")

print(f"Created glyph: {glyph.name}")
```

### Example 2: Modifying Existing Glyphs

```python
font = CurrentFont()

# Find glyph A
glyph_a = font.findGlyph("A")
if glyph_a:
    layer = glyph_a.layers[0]
    
    # Modify all nodes
    if layer.shapes:
        for shape in layer.shapes:
            if shape.isPath():
                path = shape.asPath()
                for node in path.nodes:
                    node.x += 10  # Shift 10 units right
                    node.y += 5   # Shift 5 units up
    
    # Add an anchor
    layer.addAnchor(250, 700, "top")
    
    print(f"Modified {glyph_a.name}")
```

### Example 3: Working with Components

```python
font = CurrentFont()

# Create a glyph with a component
glyph = font.addGlyph("Aacute", "Base")
layer = glyph.addLayer(600)

# Add base letter component
base = layer.addComponent("A")

# Add accent component with transformation
# Transform: [scaleX, skewX, skewY, scaleY, translateX, translateY]
accent = layer.addComponent("acutecomb", [1, 0, 0, 1, 250, 500])

print(f"Created {glyph.name} with components")
```

### Example 4: Iterating Through Font

```python
font = CurrentFont()

# Count nodes across all glyphs
total_nodes = 0
for glyph in font.glyphs:
    if glyph.layers:
        for layer in glyph.layers:
            if layer.shapes:
                for shape in layer.shapes:
                    if shape.isPath():
                        path = shape.asPath()
                        total_nodes += len(path.nodes)

print(f"Total nodes in font: {total_nodes}")
```

### Example 5: Working with Variable Fonts

```python
font = CurrentFont()

# Check if font has axes
if font.axes:
    print("Variable font axes:")
    for axis in font.axes:
        print(f"  {axis.tag}: {axis.min} - {axis.max} (default: {axis.default})")
    
    # Check masters
    if font.masters:
        print(f"\nFont has {len(font.masters)} masters:")
        for master in font.masters:
            location_str = ", ".join(f"{k}={v}" for k, v in (master.location or {}).items())
            print(f"  Master: {location_str}")
```

### Example 6: Batch Processing Glyphs

```python
font = CurrentFont()

# Scale all glyphs by 1.5x
scale_factor = 1.5

for glyph in font.glyphs:
    if glyph.layers:
        for layer in glyph.layers:
            # Scale width
            layer.width *= scale_factor
            
            # Scale all shapes
            if layer.shapes:
                for shape in layer.shapes:
                    if shape.isPath():
                        path = shape.asPath()
                        for node in path.nodes:
                            node.x *= scale_factor
                            node.y *= scale_factor
            
            # Scale anchors
            if layer.anchors:
                for anchor in layer.anchors:
                    anchor.x *= scale_factor
                    anchor.y *= scale_factor

print(f"Scaled {len(font.glyphs)} glyphs by {scale_factor}x")
```

---

## Tips and Best Practices

### Performance

- Changes to properties are immediately reflected in the underlying JSON data
- No need to "save" or "commit" changes - they are live
- For batch operations, group changes together to minimize redraws

### Type Checking

```python
# Always check shape type before accessing
for shape in layer.shapes:
    if shape.isPath():
        path = shape.asPath()
        # Work with path
    elif shape.isComponent():
        component = shape.asComponent()
        # Work with component
```

### Safe Property Access

```python
# Check for optional properties
if glyph.layers:
    for layer in glyph.layers:
        if layer.shapes:
            for shape in layer.shapes:
                if shape.isPath():
                    path = shape.asPath()
                    # Now you can access nodes
                    for node in path.nodes:
                        print(f"Node at ({node.x}, {node.y})")
```

### Accessing Nodes Example

```python
# Direct access (may fail if properties are None)
# glyph.layers[0].shapes[0].asPath().nodes  # DON'T DO THIS

# Safe access with checks:
layer = glyph.layers[0] if glyph.layers else None
if layer and layer.shapes:
    shape = layer.shapes[0]
    if shape.isPath():
        path = shape.asPath()
        nodes = path.nodes
        print(f"Path has {len(nodes)} nodes")
```

### Coordinate System

- Origin (0, 0) is at the baseline on the left
- Y-axis points upward
- All coordinates are in font units (1/upm of the em square)

### Common Issues

**Q: Why does `glyph.layers[0].shapes[0].asPath().nodes` fail?**

A: Optional properties may be `None`. Use safe access:
```python
# Check each step
if glyph.layers and len(glyph.layers) > 0:
    layer = glyph.layers[0]
    if layer.shapes and len(layer.shapes) > 0:
        shape = layer.shapes[0]
        if shape.isPath():
            path = shape.asPath()
            nodes = path.nodes  # Now safe to access
```

**Q: How do I know if a shape is a path or component?**

A: Always check with `isPath()` or `isComponent()` before calling `asPath()` or `asComponent()`:
```python
for shape in layer.shapes:
    if shape.isPath():
        path = shape.asPath()
    elif shape.isComponent():
        component = shape.asComponent()
```

---

*Generated by `generate-api-docs.mjs`*
