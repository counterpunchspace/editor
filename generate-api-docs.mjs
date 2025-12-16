#!/usr/bin/env node

/**
 * API Documentation Generator - JavaScript Introspection
 *
 * Generates API documentation for the Font Object Model by introspecting
 * the TypeScript babelfont-model.ts file directly. Produces Python-oriented
 * documentation since Python is the primary scripting interface.
 *
 * Usage:
 *   node generate-api-docs.mjs
 */

import { readFileSync, writeFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import ts from "typescript";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Parse TypeScript file and extract class information
 */
function parseTypeScriptFile(filePath) {
  const sourceCode = readFileSync(filePath, "utf-8");
  const sourceFile = ts.createSourceFile(
    filePath,
    sourceCode,
    ts.ScriptTarget.Latest,
    true
  );

  const classes = [];

  function visit(node) {
    if (ts.isClassDeclaration(node) && node.name) {
      const className = node.name.text;

      // Only process exported classes
      const isExported = node.modifiers?.some(
        (m) => m.kind === ts.SyntaxKind.ExportKeyword
      );
      if (!isExported) {
        ts.forEachChild(node, visit);
        return;
      }

      const classInfo = {
        name: className,
        properties: [],
        methods: [],
        jsDoc: extractJsDoc(node)?.description || null,
      };

      // Process class members
      node.members.forEach((member) => {
        if (ts.isPropertyDeclaration(member) || ts.isGetAccessor(member)) {
          const prop = extractProperty(member, sourceFile);
          if (prop) classInfo.properties.push(prop);
        } else if (ts.isMethodDeclaration(member)) {
          const method = extractMethod(member, sourceFile);
          if (method) classInfo.methods.push(method);
        }
      });

      classes.push(classInfo);
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return classes;
}

/**
 * Extract JSDoc comments from a node
 */
function extractJsDoc(node) {
  const jsDoc = ts.getJSDocCommentsAndTags(node);
  if (jsDoc.length === 0) return null;

  let description = "";
  let example = "";

  jsDoc.forEach((doc) => {
    if (ts.isJSDoc(doc)) {
      // Extract main comment
      if (doc.comment) {
        description += doc.comment + "\n";
      }

      // Extract @example tags
      if (doc.tags) {
        doc.tags.forEach((tag) => {
          if (tag.tagName.text === "example" && tag.comment) {
            example += tag.comment + "\n";
          }
        });
      }
    }
  });

  return {
    description: description.trim() || null,
    example: example.trim() || null,
  };
}

/**
 * Extract property information
 */
function extractProperty(node, sourceFile) {
  const name = node.name?.getText(sourceFile);
  if (!name || name.startsWith("_")) return null; // Skip private properties

  const isReadOnly = node.modifiers?.some(
    (m) => m.kind === ts.SyntaxKind.ReadonlyKeyword
  );

  // Check if there's a corresponding setter
  const hasGetter = ts.isGetAccessor(node);
  const parent = node.parent;
  let hasSetter = false;
  if (hasGetter && parent && ts.isClassDeclaration(parent)) {
    hasSetter = parent.members.some(
      (m) => ts.isSetAccessor(m) && m.name?.getText(sourceFile) === name
    );
  }

  const type = node.type ? node.type.getText(sourceFile) : "any";
  const jsDoc = extractJsDoc(node);

  return {
    name,
    type,
    readOnly: isReadOnly || (hasGetter && !hasSetter),
    jsDoc: jsDoc?.description || null,
  };
}

/**
 * Simplify a TypeScript type by removing newlines and collapsing whitespace
 */
function simplifyType(tsType) {
  return tsType.replace(/\s+/g, " ").trim();
}

/**
 * Extract method information
 */
function extractMethod(node, sourceFile) {
  const name = node.name?.getText(sourceFile);
  if (!name || name.startsWith("_")) return null; // Skip private methods

  const parameters = node.parameters
    .map((p) => {
      const paramName = p.name.getText(sourceFile);
      const paramType = p.type
        ? simplifyType(p.type.getText(sourceFile))
        : "any";
      const optional = p.questionToken ? "?" : "";
      return `${paramName}${optional}: ${paramType}`;
    })
    .join(", ");

  const returnType = node.type
    ? simplifyType(node.type.getText(sourceFile))
    : "void";
  const jsDoc = extractJsDoc(node);

  return {
    name,
    parameters,
    returnType,
    signature: `${name}(${parameters}): ${returnType}`,
    jsDoc: jsDoc?.description || null,
    example: jsDoc?.example || null,
  };
}

/**
 * Convert TypeScript type to Python-style type hint
 */
function tsToPythonType(tsType) {
  // Simple type mappings
  const typeMap = {
    string: "str",
    number: "float | int",
    boolean: "bool",
    any: "Any",
    void: "None",
    undefined: "None",
    null: "None",
  };

  // Handle array types
  if (tsType.endsWith("[]")) {
    const baseType = tsType.slice(0, -2);
    return `list[${tsToPythonType(baseType)}]`;
  }

  // Handle union types
  if (tsType.includes("|")) {
    const types = tsType.split("|").map((t) => tsToPythonType(t.trim()));
    return types.join(" | ");
  }

  // Handle Record types
  if (tsType.startsWith("Record<")) {
    return "dict";
  }

  // Direct mapping
  if (typeMap[tsType]) {
    return typeMap[tsType];
  }

  // Class types - wrap in markdown link if it's a known class
  const knownClasses = [
    "Node",
    "Path",
    "Component",
    "Anchor",
    "Guide",
    "Shape",
    "Layer",
    "Glyph",
    "Axis",
    "Master",
    "Instance",
    "Font",
  ];
  if (knownClasses.includes(tsType)) {
    return `[${tsType}](#${tsType.toLowerCase()})`;
  }

  return tsType;
}

/**
 * Generate markdown documentation for a class
 */
function generateClassDocs(classInfo) {
  const lines = [];
  const className = classInfo.name;

  lines.push(`## ${className}\n`);

  if (classInfo.jsDoc) {
    lines.push(`${classInfo.jsDoc}\n`);
  }

  // Access example
  const accessExamples = {
    Font: "```python\n# fonteditor module is pre-loaded\nfont = CurrentFont()\n```",
    Glyph:
      '```python\nglyph = font.glyphs[0]\n# or\nglyph = font.findGlyph("A")\n```',
    Layer: "```python\nlayer = glyph.layers[0]\n```",
    Path: "```python\nshape = layer.shapes[0]\nif shape.isPath():\n    path = shape.asPath()\n```",
    Component:
      "```python\nshape = layer.shapes[0]\nif shape.isComponent():\n    component = shape.asComponent()\n```",
    Node: "```python\nnode = path.nodes[0]\n```",
    Anchor: "```python\nanchor = layer.anchors[0]\n```",
    Guide:
      "```python\nguide = layer.guides[0]\n# or\nguide = master.guides[0]\n```",
    Shape: "```python\nshape = layer.shapes[0]\n```",
    Axis: '```python\naxis = font.axes[0]\n# or\naxis = font.findAxisByTag("wght")\n```',
    Master:
      '```python\nmaster = font.masters[0]\n# or\nmaster = font.findMaster("master-id")\n```',
    Instance: "```python\ninstance = font.instances[0]\n```",
  };

  if (accessExamples[className]) {
    lines.push(`**Access:**\n${accessExamples[className]}\n`);
  }

  // Properties section
  if (classInfo.properties.length > 0) {
    lines.push(`### Properties\n`);

    const readWriteProps = classInfo.properties.filter((p) => !p.readOnly);
    const readOnlyProps = classInfo.properties.filter((p) => p.readOnly);

    if (readWriteProps.length > 0 && readOnlyProps.length > 0) {
      lines.push(`#### Read/Write Properties\n`);
    } else if (readWriteProps.length > 0) {
      lines.push(`All properties are read/write:\n`);
    } else {
      lines.push(`All properties are read-only:\n`);
    }

    // Document read/write properties
    readWriteProps.forEach((prop) => {
      const pyType = tsToPythonType(prop.type);
      const desc = prop.jsDoc ? `: ${prop.jsDoc}` : "";
      lines.push(`- **\`${prop.name}\`** (${pyType})${desc}`);
    });

    if (readWriteProps.length > 0 && readOnlyProps.length > 0) {
      lines.push(``);
      lines.push(`#### Read-Only Properties\n`);
    }

    // Document read-only properties
    readOnlyProps.forEach((prop) => {
      const pyType = tsToPythonType(prop.type);
      const desc = prop.jsDoc ? `: ${prop.jsDoc}` : "";
      lines.push(`- **\`${prop.name}\`** (${pyType})${desc}`);
    });

    lines.push(``);
  }

  // Methods section
  if (classInfo.methods.length > 0) {
    lines.push(`### Methods\n`);

    classInfo.methods.forEach((method) => {
      // Convert signature to Python style
      const pyReturnType = tsToPythonType(method.returnType);
      const pyParams = method.parameters
        .split(", ")
        .filter((p) => p)
        .map((param) => {
          const match = param.match(/^(\w+)(\?)?:\s*(.+)$/);
          if (match) {
            const [, name, optional, type] = match;
            const pyType = tsToPythonType(type);
            return `${name}: ${pyType}${optional ? " | None = None" : ""}`;
          }
          return param;
        })
        .join(", ");

      lines.push(`#### \`${method.name}(${pyParams}) -> ${pyReturnType}\``);

      if (method.jsDoc) {
        lines.push(`${method.jsDoc}\n`);
      }

      // Add example from JSDoc @example tag
      if (method.example) {
        lines.push(`**Example:**\n\`\`\`python\n${method.example}\n\`\`\`\n`);
      }
    });
  }

  lines.push(`---\n`);

  return lines.join("\n");
}

/**
 * Generate the complete API documentation
 */
function generateAPIDocs() {
  console.log("📄 Parsing babelfont-model.ts...");

  const modelPath = join(__dirname, "webapp", "js", "babelfont-model.ts");
  const classes = parseTypeScriptFile(modelPath);

  console.log(`✅ Found ${classes.length} exported classes`);

  // Order classes for documentation
  const classOrder = [
    "Font",
    "Glyph",
    "Layer",
    "Shape",
    "Path",
    "Node",
    "Component",
    "Anchor",
    "Guide",
    "Axis",
    "Master",
    "Instance",
  ];

  const orderedClasses = classOrder
    .map((name) => classes.find((c) => c.name === name))
    .filter((c) => c);

  console.log("📝 Generating documentation...");

  const lines = [];

  // Header
  lines.push("# Font Object Model API Documentation\n");
  lines.push("*Auto-generated from JavaScript object model introspection*\n");
  lines.push("");

  // Table of Contents
  lines.push("## Table of Contents\n");
  lines.push("");
  lines.push("- [Overview](#overview)");
  lines.push("- [Class Reference](#class-reference)");
  orderedClasses.forEach((cls) => {
    const anchor = cls.name.toLowerCase();
    const desc = cls.jsDoc || "";
    lines.push(`  - [${cls.name}](#${anchor}) - ${desc}`);
  });
  lines.push("- [Complete Examples](#complete-examples)");
  lines.push("- [Tips and Best Practices](#tips-and-best-practices)");
  lines.push("");
  lines.push("---\n");

  // Overview
  lines.push(getOverviewSection());

  // Class documentation
  lines.push("## Class Reference\n");
  lines.push("");

  orderedClasses.forEach((cls) => {
    lines.push(generateClassDocs(cls));
    lines.push("");
  });

  // Examples and tips
  lines.push(getExamplesSection());

  const docs = lines.join("\n");

  console.log(`✅ Generated ${docs.length} characters of documentation`);

  // Write to API.md
  const outputPath = join(__dirname, "API.md");
  writeFileSync(outputPath, docs, "utf-8");

  console.log(`📝 Documentation saved to: ${outputPath}`);
  console.log("✨ Done!");
}

/**
 * Get the overview section
 */
function getOverviewSection() {
  return `## Overview

The Font Object Model provides an object-oriented interface for manipulating font data.
All objects are lightweight facades over the underlying JSON data - changes are immediately
reflected in the font structure.

### Accessing the Font Model

\`\`\`python
# Get the current font (fonteditor module is pre-loaded)
font = CurrentFont()
\`\`\`

### Parent Navigation

All objects in the hierarchy have a \`parent()\` method that returns their parent object,
allowing navigation up the object tree to the root Font object.

**Example:**
\`\`\`python
# Navigate from node up to font
node = font.glyphs[0].layers[0].shapes[0].asPath().nodes[0]
path = node.parent()      # Path object
shape = path.parent()     # Shape object
layer = shape.parent()    # Layer object
glyph = layer.parent()    # Glyph object
font = glyph.parent()     # Font object
\`\`\`

---

`;
}

/**
 * Get the examples and tips section
 */
function getExamplesSection() {
  return `## Complete Examples

### Example 1: Creating a Simple Glyph

\`\`\`python
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
\`\`\`

### Example 2: Modifying Existing Glyphs

\`\`\`python
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
\`\`\`

### Example 3: Working with Components

\`\`\`python
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
\`\`\`

### Example 4: Iterating Through Font

\`\`\`python
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
\`\`\`

### Example 5: Working with Variable Fonts

\`\`\`python
font = CurrentFont()

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
\`\`\`

### Example 6: Batch Processing Glyphs

\`\`\`python
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
\`\`\`

---

## Tips and Best Practices

### Performance

- Changes to properties are immediately reflected in the underlying JSON data
- No need to "save" or "commit" changes - they are live
- For batch operations, group changes together to minimize redraws

### Type Checking

\`\`\`python
# Always check shape type before accessing
for shape in layer.shapes:
    if shape.isPath():
        path = shape.asPath()
        # Work with path
    elif shape.isComponent():
        component = shape.asComponent()
        # Work with component
\`\`\`

### Safe Property Access

\`\`\`python
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
\`\`\`

### Accessing Nodes Example

\`\`\`python
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
\`\`\`

### Coordinate System

- Origin (0, 0) is at the baseline on the left
- Y-axis points upward
- All coordinates are in font units (1/upm of the em square)

### Common Issues

**Q: Why does \`glyph.layers[0].shapes[0].asPath().nodes\` fail?**

A: Optional properties may be \`None\`. Use safe access:
\`\`\`python
# Check each step
if glyph.layers and len(glyph.layers) > 0:
    layer = glyph.layers[0]
    if layer.shapes and len(layer.shapes) > 0:
        shape = layer.shapes[0]
        if shape.isPath():
            path = shape.asPath()
            nodes = path.nodes  # Now safe to access
\`\`\`

**Q: How do I know if a shape is a path or component?**

A: Always check with \`isPath()\` or \`isComponent()\` before calling \`asPath()\` or \`asComponent()\`:
\`\`\`python
for shape in layer.shapes:
    if shape.isPath():
        path = shape.asPath()
    elif shape.isComponent():
        component = shape.asComponent()
\`\`\`

---

*Generated by \`generate-api-docs.mjs\`*
`;
}

// Run the generator
generateAPIDocs();
