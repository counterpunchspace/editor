# Font Object Model API Documentation

*Auto-generated from JavaScript object model introspection*


## Table of Contents


- [Overview](#overview)
- [Class Reference](#class-reference)
  - [Font](#font)
  - [Glyph](#glyph)
  - [Layer](#layer)
  - [Path](#path)
  - [Node](#node)
  - [Component](#component)
  - [Anchor](#anchor)
  - [Guide](#guide)
  - [Axis](#axis)
  - [Master](#master)
  - [Instance](#instance)
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

**Note:** Font objects are created by loading font files. Use `CurrentFont()` to access the current font.

### Properties

All properties are read/write:

- **`upm`** (float | int): Units per em
- **`version`** (tuple[float | int, float | int]): Font version as (major, minor)
- **`axes`** (list[[Axis](#axis)] | None)
- **`cross_axis_mappings`** (list[CrossAxisMapping] | None): A list of cross-axis mappings (avar2 mappings)
- **`instances`** (list[[Instance](#instance)] | None)
- **`masters`** (list[[Master](#master)] | None)
- **`glyphs`** (list[[Glyph](#glyph)])
- **`note`** (str | None): An optional note about the font
- **`date`** (datetime): The font's creation date
- **`names`** ([Names](#names))
- **`custom_ot_values`** (CustomOTValues | None): Any values to be placed in OpenType tables on export to override defaults  These must be font-wide. Metrics which may vary by master should be placed in the `metrics` field of a Master
- **`variation_sequences`** (dict | None): A map of Unicode Variation Sequences to glyph names
- **`features`** ([Features](#features))
- **`first_kern_groups`** (dict | None): A dictionary of kerning groups  The key is the group name and the value is a list of glyph names in the group Group names are *not* prefixed with "@" here. This is the first item in a kerning pair. and so these are generally organized based on the profile of *right side* of the glyph (for LTR scripts).
- **`second_kern_groups`** (dict | None): The key is the group name and the value is a list of glyph names in the group Group names are *not* prefixed with "@" here. This is the second item in a kerning pair. and so these are generally organized based on the profile of *left side* of the glyph (for LTR scripts).
- **`format_specific`** (dict | None): Format-specific data
- **`source`** (str | None): The source file path, if any, from which this font was loaded

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

#### `addGlyph(name: str, category: str) -> [Glyph](#glyph)`
Create and add a new glyph to the font

**Example:**
```python
glyph = font.addGlyph("A")
print(glyph.name)
```

---


## Glyph

**Access:**
```python
glyph = font.glyphs[0]
# or
glyph = font.findGlyph("A")
```

**Note:** Create new glyphs using `font.addGlyph(name, category)`. Existing glyphs are accessed from `font.glyphs` list or via `font.findGlyph(name)`.

### Properties

All properties are read/write:

- **`name`** (str): The name of the glyph
- **`production_name`** (str | None): The production name of the glyph, if any
- **`category`** (GlyphCategory): The category of the glyph. Options: `"Base"`, `"Mark"`, `"Unknown"`, `"Ligature"`
- **`codepoints`** (list[float | int] | None): Unicode codepoints assigned to the glyph
- **`layers`** (list[[Layer](#layer)])
- **`exported`** (bool): Whether the glyph is exported
- **`direction`** (Direction | None): The writing direction of the glyph, if any. Options: `"LeftToRight"` (Left to right text flow), `"RightToLeft"` (Right to left text flow), `"TopToBottom"` (Top to bottom text flow), `"Bidi"` (Bidirectional,)
- **`component_axes`** (list[[Axis](#axis)] | None): Glyph-specific axes for "smart components" / variable components
- **`format_specific`** (dict | None): Format-specific data

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

#### `addLayer(masterId: str | None = None, width: float | int) -> [Layer](#layer)`
Create and add a new layer to the glyph

**Example:**
```python
layer = glyph.addLayer("m01")
print(layer.width)
```

---


## Layer

**Access:**
```python
layer = glyph.layers[0]
```

**Note:** Create new layers using `glyph.addLayer(masterId, width)`. Existing layers are accessed from `glyph.layers` list.

### Properties

All properties are read/write:

- **`width`** (float | int): The advance width of the layer
- **`name`** (str | None): The name of the layer
- **`id`** (str | None): The ID of the layer
- **`master`** (LayerType | None): The relationship between this layer and a master, if any
- **`guides`** (list[[Guide](#guide)] | None): Guidelines in the layer
- **`shapes`** (list[(Component | Path)])
- **`anchors`** (list[[Anchor](#anchor)] | None): Anchors in the layer
- **`color`** ([Color](#color) | None): The color of the layer
- **`layer_index`** (float | int | None): The index of the layer in a color font
- **`is_background`** (bool | None): Whether this layer is a background layer
- **`background_layer_id`** (str | None): The ID of the background layer for this layer, if any
- **`location`** (dict | None): The location of the layer in design space, if it is not at the default location for a master
- **`smart_component_location`** (dict | None): The location of the layer in smart component (glyph-specific axes) space
- **`format_specific`** (dict | None): Format-specific data for the layer
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
path = layer.addPath()
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

**Note:** Create paths using `layer.addPath(closed=True/False)`.

### Properties

All properties are read/write:

- **`nodes`** (list[[Node](#node)])
- **`closed`** (bool): Whether the path is closed
- **`format_specific`** (dict | None): Format-specific data

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

**Note:** Create nodes using `path.addNode({"x": 100, "y": 200, "type": "line"})`.

### Properties

All properties are read/write:

- **`x`** (float | int): The x-coordinate of the node
- **`y`** (float | int): The y-coordinate of the node
- **`nodetype`** (NodeType): The type of the node. Options: `"Move"` (Move to a new position without drawing (only defined for open contours)), `"Line"` (Draw a straight line to this node), `"OffCurve"` (Cubic Bézier curve control node (off-curve)), `"Curve"` (Draw a cubic Bézier curve to this node), `"QCurve"` (Draw a quadratic Bézier curve to this node)
- **`smooth`** (bool | None): Whether the node is smooth
- **`format_specific`** (dict | None): Format-specific data

---


## Component

**Access:**
```python
shape = layer.shapes[0]
if shape.isComponent():
    component = shape.asComponent()
```

**Note:** Create components using `layer.addComponent("glyphName")`.

### Properties

All properties are read/write:

- **`reference`** (str): The referenced glyph name
- **`transform`** ([DecomposedAffine](#decomposedaffine))
- **`location`** (dict | None): A location for a variable component
- **`format_specific`** (dict | None): Format-specific data
- **`cachedComponentLayerData`** (Any)

---


## Anchor

**Access:**
```python
anchor = layer.anchors[0]
```

**Note:** Create anchors using `layer.createAnchor("name", x, y)`.

### Properties

All properties are read/write:

- **`x`** (float | int): X coordinate
- **`y`** (float | int): Y coordinate
- **`name`** (str | None): Name of the anchor
- **`format_specific`** (dict | None): Format-specific data

---


## Guide

**Access:**
```python
guide = layer.guides[0]
# or
guide = master.guides[0]
```

**Note:** Guides are accessed from `layer.guides` or `master.guides` lists.

### Properties

All properties are read/write:

- **`pos`** ([Position](#position)): Position of the guideline
- **`name`** (str | None): Optional name of the guideline
- **`color`** ([Color](#color) | None): Optional color of the guideline
- **`format_specific`** (dict | None): Format-specific data

---


## Axis

**Access:**
```python
axis = font.axes[0]
# or
axis = font.findAxisByTag("wght")
```

**Note:** Axes are accessed from `font.axes` list.

### Properties

All properties are read/write:

- **`name`** (I18NDictionary): Name of the axis
- **`tag`** (str): 4-character tag of the axis
- **`min`** (float | int | None): Minimum value of the axis in user space coordinates
- **`max`** (float | int | None): Maximum value of the axis in user space coordinates
- **`default`** (float | int | None): Default value of the axis in user space coordinates
- **`map`** (float | int | None | None): Mapping of user space coordinates to design space coordinates
- **`hidden`** (bool | None): Whether the axis is hidden in the font's user interface
- **`values`** (list[float | int] | None): Predefined values for the axis in user space coordinates
- **`format_specific`** (dict | None): Format-specific data

---


## Master

**Access:**
```python
master = font.masters[0]
# or
master = font.findMaster("master-id")
```

**Note:** Masters are accessed from `font.masters` list.

### Properties

All properties are read/write:

- **`name`** (I18NDictionary): Name of the master
- **`id`** (str): Unique identifier for the master (usually a UUID)
- **`location`** (dict | None): Location of the master in design space coordinates
- **`guides`** (list[[Guide](#guide)] | None): Global guidelines associated with the master
- **`metrics`** (dict): Master-specific metrics
- **`kerning`** (Map<[string, string], number>): Kerning for this master.  (Kerning pairs are (left glyph name, right glyph name) -> value) Groups are represented as `@<groupname>`; whether they are first or second groups is determined by position in the tuple.
- **`custom_ot_values`** (CustomOTValues | None): Custom OpenType values for this master
- **`format_specific`** (dict | None): Format-specific data

---


## Instance

**Access:**
```python
instance = font.instances[0]
```

**Note:** Instances are accessed from `font.instances` list.

### Properties

All properties are read/write:

- **`id`** (str): Unique identifier for the instance  Should be unique within the design space; usually a UUID.
- **`name`** (I18NDictionary): Name of the instance
- **`location`** (dict | None): Location of the instance in design space coordinates
- **`custom_names`** ([Names](#names)): Any custom names for the instance if it is exported as a static font
- **`variable`** (bool | None): Whether the instance represents an export of a variable font
- **`linked_style`** (str | None): Name of the linked style for style linking (e.g., "Bold Italic" links to "Bold" and "Italic")
- **`format_specific`** (dict | None): Format-specific data

---


## Complete Examples

### Example 1: Modifying Existing Glyphs

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
    layer.createAnchor("top", 250, 700)
    
    print(f"Modified {glyph_a.name}")
```

### Example 2: Working with Components

```python
font = CurrentFont()

# Access an existing glyph
glyph = font.findGlyph("Aacute")
if glyph and glyph.layers:
    layer = glyph.layers[0]
    
    # Add base letter component
    base = layer.addComponent("A")
    
    # Add accent component with transformation
    accent = layer.addComponent("acutecomb")
    
    print(f"Added components to {glyph.name}")
```

### Example 3: Iterating Through Font

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

### Example 4: Working with Variable Fonts

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

### Example 5: Batch Processing Glyphs

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
