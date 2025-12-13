"""
Generate API documentation for the Font Object Model

This script introspects the JavaScript font model classes exposed via Pyodide
and generates comprehensive Python-oriented API documentation.

Usage from Python console:
    from generate_api_docs import generate_docs
    docs = generate_docs()
    print(docs)  # Or save to file
"""

from js import window


def get_layer_methods():
    """Introspect Layer class methods programmatically"""
    try:
        font = window.currentFontModel
        if not font or not font.glyphs or len(font.glyphs) == 0:
            return []
        
        # Get a layer instance
        glyph = font.glyphs[0]
        if not glyph.layers or len(glyph.layers) == 0:
            return []
        
        layer = glyph.layers[0]
        
        # Get all methods (callable attributes)
        methods = []
        for attr_name in dir(layer):
            if attr_name.startswith('_'):
                continue
            try:
                attr = getattr(layer, attr_name)
                if callable(attr):
                    methods.append(attr_name)
            except Exception:
                pass
        
        return sorted(methods)
    except Exception as e:
        print(f"Error introspecting Layer methods: {e}")
        return []


def generate_docs():
    """Generate complete API documentation as Markdown"""
    
    docs = []
    docs.append("# Font Object Model API Documentation\n")
    docs.append("*Auto-generated from JavaScript object model via Pyodide*\n")
    docs.append("\n")
    
    # Define classes to document with descriptions
    classes_to_document = [
        ('Font', 'Main font class', get_font_class_docs),
        ('Glyph', 'Glyph in the font', get_glyph_class_docs),
        ('Layer', 'Layer in a glyph', get_layer_class_docs),
        ('Shape', 'Shape wrapper (Component or Path)', get_shape_class_docs),
        ('Path', 'Path (contour) in a layer', get_path_class_docs),
        ('Node', 'Point in a path', get_node_class_docs),
        ('Component', 'Component reference', get_component_class_docs),
        ('Anchor', 'Anchor point', get_anchor_class_docs),
        ('Guide', 'Guideline', get_guide_class_docs),
        ('Axis', 'Variation axis', get_axis_class_docs),
        ('Master', 'Master/source', get_master_class_docs),
        ('Instance', 'Named instance', get_instance_class_docs),
    ]
    
    # Generate Table of Contents
    docs.append("## Table of Contents\n")
    docs.append("\n")
    docs.append("- [Overview](#overview)\n")
    docs.append("- [Class Reference](#class-reference)\n")
    for class_name, description, _ in classes_to_document:
        anchor = class_name.lower()
        docs.append(f"  - [{class_name}](#{anchor}) - {description}\n")
    docs.append("- [Complete Examples](#complete-examples)\n")
    docs.append("- [Tips and Best Practices](#tips-and-best-practices)\n")
    docs.append("\n")
    docs.append("---\n")
    docs.append("\n")
    
    docs.append("## Overview\n")
    docs.append("\n")
    docs.append("The Font Object Model provides an object-oriented ")
    docs.append("interface for manipulating font data.\n")
    docs.append("All objects are lightweight facades over the underlying ")
    docs.append("JSON data - changes are immediately\n")
    docs.append("reflected in the font structure.\n")
    docs.append("\n")
    docs.append("### Accessing the Font Model\n")
    docs.append("\n")
    docs.append("```python\n")
    docs.append("from js import window\n")
    docs.append("\n")
    docs.append("# Get the current font\n")
    docs.append("font = window.currentFontModel\n")
    docs.append("```\n")
    docs.append("\n")
    docs.append("### Parent Navigation\n")
    docs.append("\n")
    docs.append("All objects in the hierarchy have a `parent()` method that ")
    docs.append("returns their parent object,\n")
    docs.append("allowing navigation up the object tree to the root Font object.\n")
    docs.append("\n")
    docs.append("**Example:**\n")
    docs.append("```python\n")
    docs.append("# Navigate from node up to font\n")
    docs.append("node = font.glyphs[0].layers[0].shapes[0].asPath().nodes[0]\n")
    docs.append("path = node.parent()      # Path object\n")
    docs.append("shape = path.parent()     # Shape object\n")
    docs.append("layer = shape.parent()    # Layer object\n")
    docs.append("glyph = layer.parent()    # Glyph object\n")
    docs.append("font = glyph.parent()     # Font object\n")
    docs.append("```\n")
    docs.append("\n")
    docs.append("---\n")
    docs.append("\n")
    docs.append("## Class Reference\n")
    docs.append("\n")
    
    # Document each class
    for class_name, description, doc_func in classes_to_document:
        docs.append(doc_func())
        docs.append("\n")
    
    # Add examples section
    docs.append(get_examples_section())
    
    return "".join(docs)


def get_font_class_docs():
    """Generate documentation for the Font class"""
    return """## Font

The main font class representing a complete font.

**Access:**
```python
font = window.currentFontModel
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
"""


def get_glyph_class_docs():
    """Generate documentation for the Glyph class"""
    return """## Glyph

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
"""


def get_layer_class_docs():
    """Generate documentation for the Layer class"""
    # Manual method documentation (with descriptions and examples)
    manual_methods = {
        'addPath': {
            'signature': 'addPath(closed: bool = True) -> [`Path`](#path)',
            'description': 'Add a new path to the layer.',
            'example': 'path = layer.addPath(closed=True)'
        },
        'addComponent': {
            'signature': (
                'addComponent(reference: str, '
                'transform: list[float] | None = None) -> '
                '[`Component`](#component)'
            ),
            'description': 'Add a new component reference to the layer.',
            'example': (
                'component = layer.addComponent("A")\n'
                '# With transformation: [xx, xy, yx, yy, x, y]\n'
                'component = layer.addComponent("A", [1, 0, 0, 1, 100, 0])'
            )
        },
        'addShape': {
            'signature': 'addShape(shape_data: dict) -> [`Shape`](#shape)',
            'description': 'Add a new shape (component or path) to the layer.',
            'example': None
        },
        'removeShape': {
            'signature': 'removeShape(index: int) -> None',
            'description': 'Remove a shape at the specified index.',
            'example': None
        },
        'addAnchor': {
            'signature': (
                'addAnchor(x: float, y: float, '
                'name: str | None = None) -> [`Anchor`](#anchor)'
            ),
            'description': 'Add a new anchor point.',
            'example': 'anchor = layer.addAnchor(250, 700, "top")'
        },
        'removeAnchor': {
            'signature': 'removeAnchor(index: int) -> None',
            'description': 'Remove an anchor at the specified index.',
            'example': None
        },
        'getBoundingBox': {
            'signature': (
                'getBoundingBox(includeAnchors: bool = False) '
                '-> dict | None'
            ),
            'description': (
                'Calculate the bounding box for this layer, respecting '
                'nested components and their transformation matrices.'
            ),
            'params': [
                (
                    '- `includeAnchors` (bool): If True, include anchors '
                    'in the bounding box calculation (default: False)'
                )
            ],
            'returns': (
                'Dictionary with keys: `minX`, `minY`, `maxX`, `maxY`, '
                '`width`, `height`, or `None` if no geometry.'
            ),
            'example': (
                'bbox = layer.getBoundingBox()\n'
                'if bbox:\n'
                '    print(f"Bounds: {bbox[\\\'width\\\']} x '
                '{bbox[\\\'height\\\']}")\n'
                '    print(f"Position: ({bbox[\\\'minX\\\']}, '
                '{bbox[\\\'minY\\\']}")\n'
                '\n'
                '# Include anchors in bounds calculation\n'
                'bbox_with_anchors = layer.getBoundingBox('
                'includeAnchors=True)'
            )
        }
    }
    
    # Get methods programmatically
    detected_methods = get_layer_methods()
    
    # Build methods section
    methods_section = []
    
    # First add documented methods
    for method_name in sorted(manual_methods.keys()):
        method_info = manual_methods[method_name]
        methods_section.append(
            f"#### `{method_info['signature']}`\n"
        )
        methods_section.append(f"{method_info['description']}\n")
        
        if 'params' in method_info:
            methods_section.append("\n**Parameters:**\n")
            for param in method_info['params']:
                methods_section.append(f"{param}\n")
        
        if 'returns' in method_info:
            methods_section.append("\n**Returns:**\n")
            methods_section.append(f"{method_info['returns']}\n")
        
        if method_info.get('example'):
            methods_section.append("\n**Example:**\n")
            methods_section.append("```python\n")
            methods_section.append(f"{method_info['example']}\n")
            methods_section.append("```\n")
        
        methods_section.append("\n")
    
    # Add any additional detected methods not in manual list
    undocumented_methods = [
        m for m in detected_methods if m not in manual_methods
    ]
    if undocumented_methods:
        methods_section.append(
            "#### Additional Methods\n\n"
        )
        for method_name in undocumented_methods:
            methods_section.append(f"- `{method_name}()`\n")
        methods_section.append("\n")
    
    methods_text = "".join(methods_section)
    
    return f"""## Layer

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
- **`lsb`** (float): Left sidebearing - distance from x=0 to left \
edge of bounding box. Setting this translates all geometry \
(paths, components, anchors) and adjusts width
- **`rsb`** (float): Right sidebearing - distance from right edge \
of bounding box to advance width. Setting this adjusts width only
- **`name`** (str | None): Layer name
- **`id`** (str | None): Layer ID
- **`master`** (dict | None): Relationship to master \
(DefaultForMaster/AssociatedWithMaster)
- **`color`** (dict | None): Layer color {{r, g, b, a}}
- **`layer_index`** (int | None): Index in a color font
- **`is_background`** (bool | None): Whether this is a background layer
- **`background_layer_id`** (str | None): ID of background layer \
for this layer
- **`location`** (dict | None): Location in design space
- **`format_specific`** (dict | None): Format-specific data

#### Read-Only Properties

- **`shapes`** (list[[Shape](#shape)] | None): Shapes (paths and \
components) in the layer
- **`anchors`** (list[[Anchor](#anchor)] | None): Anchor points \
in the layer
- **`guides`** (list[[Guide](#guide)] | None): Guidelines in the layer

### Methods

{methods_text}---
"""


def get_shape_class_docs():
    """Generate documentation for the Shape class"""
    return """## Shape

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
"""


def get_path_class_docs():
    """Generate documentation for the Path class"""
    return """## Path

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
"""


def get_node_class_docs():
    """Generate documentation for the Node class"""
    return """## Node

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
"""


def get_component_class_docs():
    """Generate documentation for the Component class"""
    return """## Component

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
"""


def get_anchor_class_docs():
    """Generate documentation for the Anchor class"""
    return """## Anchor

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
"""


def get_guide_class_docs():
    """Generate documentation for the Guide class"""
    return """## Guide

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
"""


def get_axis_class_docs():
    """Generate documentation for the Axis class"""
    return """## Axis

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
"""


def get_master_class_docs():
    """Generate documentation for the Master class"""
    return """## Master

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
"""


def get_instance_class_docs():
    """Generate documentation for the Instance class"""
    return """## Instance

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
"""


def get_examples_section():
    """Generate the examples section"""
    return """## Complete Examples

### Example 1: Creating a Simple Glyph

```python
from js import window

# Get the font
font = window.currentFontModel

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
from js import window

font = window.currentFontModel

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
from js import window

font = window.currentFontModel

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
from js import window

font = window.currentFontModel

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
from js import window

font = window.currentFontModel

# Check if font has axes
if font.axes:
    print("Variable font axes:")
    for axis in font.axes:
        print(f"  {axis.tag}: {axis.min} - {axis.max} (default: {axis.default})")
    
    # Check masters
    if font.masters:
        print(f"\\nFont has {len(font.masters)} masters:")
        for master in font.masters:
            location_str = ", ".join(f"{k}={v}" for k, v in (master.location or {}).items())
            print(f"  Master: {location_str}")
```

### Example 6: Batch Processing Glyphs

```python
from js import window

font = window.currentFontModel

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

*Generated by `generate_api_docs.py`*
"""


# Allow running as a script in the Python console
if __name__ == "__main__":
    docs = generate_docs()
    print(docs)
