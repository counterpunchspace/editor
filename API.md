# Font Object Model API Documentation

_Auto-generated from JavaScript object model via Pyodide_

## Table of Contents

- [Overview](#overview)
- [Class Reference](#class-reference)
  - [Font](#font) - Main font class
  - [Glyph](#glyph) - Glyph in the font
  - [Layer](#layer) - Layer in a glyph
  - [Shape](#shape) - Shape wrapper (Component or Path)
  - [Path](#path) - Path (contour) in a layer
  - [Node](#node) - Point in a path
  - [Component](#component) - Component reference
  - [Anchor](#anchor) - Anchor point
  - [Guide](#guide) - Guideline
  - [Axis](#axis) - Variation axis
  - [Master](#master) - Master/source
  - [Instance](#instance) - Named instance
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

The main font class representing a complete font.

**Access:**

```python
# fonteditor module is pre-loaded
font = CurrentFont()
```

### Properties

#### Read/Write Properties

- **`upm`** (int): Units per em
- **`version`** (tuple[int, int]): Font version as (major, minor)
- **`note`** (str | None): Optional note about the font
- **`date`** (str): Font creation date
- **`names`** (dict): Font naming information (family_name, designer, etc.)
- **`custom_ot_values`** (list | None): Custom OpenType table values
- **`variation_sequences`** (dict | None): Unicode Variation Sequences mapping
- **`features`** (dict): OpenType features, classes, and prefixes
- **`first_kern_groups`** (dict | None): First-position kerning groups
- **`second_kern_groups`** (dict | None): Second-position kerning groups
- **`format_specific`** (dict | None): Format-specific data
- **`source`** (str | None): Source file path

#### Read-Only Properties

- **`glyphs`** (list[[Glyph](#glyph)]): List of all glyphs in the font
- **`axes`** (list[[Axis](#axis)] | None): List of variation axes (for variable fonts)
- **`masters`** (list[[Master](#master)] | None): List of masters/sources
- **`instances`** (list[[Instance](#instance)] | None): List of named instances

### Methods

#### `findGlyph(name: str) -> `[`Glyph`](#glyph)` | None`

Find a glyph by name.

**Example:**

```python
glyph = font.findGlyph("A")
if glyph:
    print(glyph.name)
```

#### `findGlyphByCodepoint(codepoint: int) -> `[`Glyph`](#glyph)` | None`

Find a glyph by Unicode codepoint.

**Example:**

```python
glyph = font.findGlyphByCodepoint(0x0041)  # Find 'A'
```

#### `findAxis(id: str) -> `[`Axis`](#axis)` | None`

Find an axis by ID.

#### `findAxisByTag(tag: str) -> `[`Axis`](#axis)` | None`

Find an axis by 4-character tag.

**Example:**

```python
weight_axis = font.findAxisByTag("wght")
```

#### `findMaster(id: str) -> `[`Master`](#master)` | None`

Find a master by ID.

#### `addGlyph(name: str, category: str = "Base") -> `[`Glyph`](#glyph)

Add a new glyph to the font.

**Example:**

```python
new_glyph = font.addGlyph("myGlyph", "Base")
```

#### `removeGlyph(name: str) -> bool`

Remove a glyph by name. Returns True if successful.

#### `toJSONString() -> str`

Serialize the font to JSON string.

#### `toJSON() -> dict`

Get the underlying JSON data structure.

---

## Glyph

Represents a glyph in the font.

**Access:**

```python
glyph = font.glyphs[0]
# or
glyph = font.findGlyph("A")
```

### Properties

#### Read/Write Properties

- **`name`** (str): Glyph name
- **`production_name`** (str | None): Production name for export
- **`category`** (str): Glyph category ("Base", "Mark", "Ligature", "Unknown")
- **`codepoints`** (list[int] | None): Unicode codepoints assigned to this glyph
- **`exported`** (bool | None): Whether the glyph is exported
- **`direction`** (str | None): Writing direction ("LeftToRight", "RightToLeft", "TopToBottom")
- **`formatspecific`** (dict | None): Format-specific data

#### Read-Only Properties

- **`layers`** (list[[Layer](#layer)] | None): Foreground layers that are
  default for their master (excludes background layers and copies), sorted
  by master order

### Methods

#### `addLayer(width: float, master: dict | None = None) -> `[`Layer`](#layer)

Add a new layer to the glyph.

**Example:**

```python
layer = glyph.addLayer(600)
```

#### `removeLayer(index: int) -> None`

Remove a layer at the specified index.

#### `findLayerById(id: str) -> `[`Layer`](#layer)` | None`

Find a layer by its ID.

**Example:**

```python
layer = glyph.findLayerById("layer-uuid")
```

#### `findLayerByMasterId(master_id: str) -> `[`Layer`](#layer)` | None`

Find a layer associated with a specific master.

---

## Layer

Represents a layer in a glyph (one drawing per master/location).

**Access:**

```python
layer = glyph.layers[0]
# or
layer = glyph.findLayerById("layer-id")
```

### Properties

#### Read/Write Properties

- **`width`** (float): Advance width of the layer
- **`lsb`** (float): Left sidebearing - distance from x=0 to left edge of bounding box. Setting this translates all geometry (paths, components, anchors) and adjusts width
- **`rsb`** (float): Right sidebearing - distance from right edge of bounding box to advance width. Setting this adjusts width only
- **`name`** (str | None): Layer name
- **`id`** (str | None): Layer ID
- **`master`** (dict | None): Relationship to master (DefaultForMaster/AssociatedWithMaster)
- **`color`** (dict | None): Layer color {r, g, b, a}
- **`layer_index`** (int | None): Index in a color font
- **`is_background`** (bool | None): Whether this is a background layer
- **`background_layer_id`** (str | None): ID of background layer for this layer
- **`location`** (dict | None): Location in design space
- **`format_specific`** (dict | None): Format-specific data

#### Read-Only Properties

- **`shapes`** (list[[Shape](#shape)] | None): Shapes (paths and components) in the layer
- **`anchors`** (list[[Anchor](#anchor)] | None): Anchor points in the layer
- **`guides`** (list[[Guide](#guide)] | None): Guidelines in the layer

### Methods

#### `addAnchor(x: float, y: float, name: str | None = None) -> [`Anchor`](#anchor)`

Add a new anchor point.

**Example:**

```python
anchor = layer.addAnchor(250, 700, "top")
```

#### `addComponent(reference: str, transform: list[float] | None = None) -> [`Component`](#component)`

Add a new component reference to the layer.

**Example:**

```python
component = layer.addComponent("A")
# With transformation: [xx, xy, yx, yy, x, y]
component = layer.addComponent("A", [1, 0, 0, 1, 100, 0])
```

#### `addPath(closed: bool = True) -> [`Path`](#path)`

Add a new path to the layer.

**Example:**

```python
path = layer.addPath(closed=True)
```

#### `addShape(shape_data: dict) -> [`Shape`](#shape)`

Add a new shape (component or path) to the layer.

#### `getBoundingBox(includeAnchors: bool = False) -> dict | None`

Calculate the bounding box for this layer, respecting nested components and their transformation matrices.

**Parameters:**

- `includeAnchors` (bool): If True, include anchors in the bounding box calculation (default: False)

**Returns:**
Dictionary with keys: `minX`, `minY`, `maxX`, `maxY`, `width`, `height`, or `None` if no geometry.

**Example:**

```python
bbox = layer.getBoundingBox()
if bbox:
    print(f"Bounds: {bbox[\'width\']} x {bbox[\'height\']}")
    print(f"Position: ({bbox[\'minX\']}, {bbox[\'minY\']}")

# Include anchors in bounds calculation
bbox_with_anchors = layer.getBoundingBox(includeAnchors=True)
```

#### `getMatchingLayerOnGlyph(glyphName: str) -> [`Layer`](#layer) | None`

Find the matching layer on another glyph that represents the same master.

**Parameters:**

- `glyphName` (str): The name of the glyph to search

**Returns:**
The matching layer on the specified glyph, or `None` if not found.

**Example:**

```python
# Get the layer for "A" that matches the current layer's master
a_layer = layer.getMatchingLayerOnGlyph("A")
if a_layer:
    print(f"Found matching layer on A: {a_layer.width}")
```

#### `removeAnchor(index: int) -> None`

Remove an anchor at the specified index.

#### `removeShape(index: int) -> None`

Remove a shape at the specified index.

---

## Shape

Wrapper for a shape union type (either a Component or a Path).

**Access:**

```python
shape = layer.shapes[0]
```

### Methods

#### `isComponent() -> bool`

Check if this shape is a component.

#### `isPath() -> bool`

Check if this shape is a path.

#### `asComponent() -> `[`Component`](#component)

Get as Component. Raises error if not a component.

**Example:**

```python
if shape.isComponent():
    component = shape.asComponent()
    print(component.reference)
```

#### `asPath() -> `[`Path`](#path)

Get as Path. Raises error if not a path.

**Example:**

```python
if shape.isPath():
    path = shape.asPath()
    print(len(path.nodes))
```

---

## Path

Represents a path (contour) in a layer.

**Access:**

```python
shape = layer.shapes[0]
if shape.isPath():
    path = shape.asPath()
```

### Properties

#### Read/Write Properties

- **`closed`** (bool): Whether the path is closed
- **`format_specific`** (dict | None): Format-specific data

#### Read-Only Properties

- **`nodes`** (list[[Node](#node)]): List of nodes in the path

### Methods

#### `insertNode(index: int, x: float, y: float, nodetype: str = "Line", smooth: bool | None = None) -> `[`Node`](#node)

Insert a node at the specified index.

**Node Types:** "Move", "Line", "Curve", "QCurve", "OffCurve"

**Example:**

```python
node = path.insertNode(0, 100, 200, "Line")
node = path.insertNode(1, 150, 250, "Curve", smooth=True)
```

#### `removeNode(index: int) -> None`

Remove a node at the specified index.

#### `appendNode(x: float, y: float, nodetype: str = "Line", smooth: bool | None = None) -> `[`Node`](#node)

Append a node to the end of the path.

**Example:**

```python
path.appendNode(300, 400, "Line")
```

---

## Node

Represents a point in a path.

**Access:**

```python
node = path.nodes[0]
```

### Properties

All properties are read/write:

- **`x`** (float): X coordinate
- **`y`** (float): Y coordinate
- **`nodetype`** (str): Node type ("Move", "Line", "Curve", "QCurve", "OffCurve")
- **`smooth`** (bool | None): Whether the node is smooth

**Example:**

```python
node.x = 100
node.y = 200
node.nodetype = "Curve"
node.smooth = True
```

---

## Component

Represents a component reference in a layer.

**Access:**

```python
shape = layer.shapes[0]
if shape.isComponent():
    component = shape.asComponent()
```

### Properties

All properties are read/write:

- **`reference`** (str): Name of the referenced glyph
- **`transform`** (list[float] | None): Transformation matrix [xx, xy, yx, yy, x, y]
- **`format_specific`** (dict | None): Format-specific data

**Example:**

```python
component.reference = "B"
component.transform = [1, 0, 0, 1, 50, 0]  # Translate by (50, 0)
```

---

## Anchor

Represents an anchor point in a layer.

**Access:**

```python
anchor = layer.anchors[0]
```

### Properties

All properties are read/write:

- **`x`** (float): X coordinate
- **`y`** (float): Y coordinate
- **`name`** (str | None): Anchor name (e.g., "top", "bottom")
- **`format_specific`** (dict | None): Format-specific data

**Example:**

```python
anchor.x = 250
anchor.y = 700
anchor.name = "top"
```

---

## Guide

Represents a guideline in a layer or master.

**Access:**

```python
guide = layer.guides[0]
# or
guide = master.guides[0]
```

### Properties

All properties are read/write:

- **`pos`** (dict): Position {x, y, angle}
- **`name`** (str | None): Guide name
- **`color`** (dict | None): Guide color {r, g, b, a}
- **`format_specific`** (dict | None): Format-specific data

**Example:**

```python
guide.pos = {"x": 100, "y": 0, "angle": 0}
guide.name = "baseline"
```

---

## Axis

Represents a variation axis in a variable font.

**Access:**

```python
axis = font.axes[0]
# or
axis = font.findAxisByTag("wght")
```

### Properties

All properties are read/write:

- **`name`** (dict): Internationalized name dictionary
- **`tag`** (str): 4-character axis tag
- **`id`** (str): Unique identifier
- **`min`** (float | None): Minimum value (user space)
- **`max`** (float | None): Maximum value (user space)
- **`default`** (float | None): Default value (user space)
- **`map`** (list[tuple[float, float]] | None): User-to-design space mapping
- **`hidden`** (bool | None): Whether hidden in UI
- **`values`** (list[float] | None): Predefined values
- **`formatspecific`** (dict | None): Format-specific data

**Example:**

```python
axis.tag = "wght"
axis.min = 400
axis.max = 700
axis.default = 400
```

---

## Master

Represents a master/source in a design space.

**Access:**

```python
master = font.masters[0]
# or
master = font.findMaster("master-id")
```

### Properties

#### Read/Write Properties

- **`name`** (dict): Internationalized name dictionary
- **`id`** (str): Unique identifier
- **`location`** (dict | None): Location in design space {axis_id: value}
- **`metrics`** (dict): Metrics dictionary {metric_name: value}
- **`kerning`** (dict): Kerning pairs {left: {right: value}}
- **`custom_ot_values`** (list | None): Custom OpenType values
- **`format_specific`** (dict | None): Format-specific data

#### Read-Only Properties

- **`guides`** (list[[Guide](#guide)] | None): Global guidelines for this master

**Example:**

```python
master.location = {"wght": 700}
master.metrics["ascender"] = 800
master.kerning["A"] = {"V": -50}
```

---

## Instance

Represents a named instance in a variable font.

**Access:**

```python
instance = font.instances[0]
```

### Properties

All properties are read/write:

- **`id`** (str): Unique identifier
- **`name`** (dict): Internationalized name dictionary
- **`location`** (dict | None): Location in design space {axis_id: value}
- **`custom_names`** (dict): Custom names for static export
- **`variable`** (bool | None): Whether this exports as a variable font
- **`linked_style`** (str | None): Linked style name for style linking
- **`format_specific`** (dict | None): Format-specific data

**Example:**

```python
instance.name = {"en": "Bold"}
instance.location = {"wght": 700}
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
- No need to "save" or "commit" changes - they're live
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

_Generated by `generate_api_docs.py`_
