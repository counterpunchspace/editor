#!/usr/bin/env node

/**
 * API Documentation Generator - JavaScript Introspection
 *
 * Generates API documentation for the Font Object Model by introspecting
 * the TypeScript babelfont-model.ts file directly. Produces Python-oriented
 * documentation since Python is the primary scripting interface.
 *
 * Usage:
 *   node scripts/generate-api-docs.mjs
 *
 * Writes API.md at the repo root and a handbook mirror at
 * documentation/python/06-python-api.md.
 */

import { readFileSync, writeFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import ts from "typescript";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = join(__dirname, "..");

const HIDDEN_PROPERTIES_BY_CLASS = {
    Drawing: new Set(["shapes"]),
};

/**
 * Parse TypeScript file and extract class information
 */
function parseTypeScriptFile(filePath) {
    const sourceCode = readFileSync(filePath, "utf-8");
    const sourceFile = ts.createSourceFile(
        filePath,
        sourceCode,
        ts.ScriptTarget.Latest,
        true,
    );

    const classes = [];

    function visit(node) {
        if (ts.isClassDeclaration(node) && node.name) {
            const className = node.name.text;

            // Only process exported classes
            const isExported = node.modifiers?.some(
                (m) => m.kind === ts.SyntaxKind.ExportKeyword,
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
                if (
                    ts.isPropertyDeclaration(member) ||
                    ts.isGetAccessor(member)
                ) {
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
    // Computed names such as [Symbol.toStringTag] are not Python attributes.
    if (node.name && ts.isComputedPropertyName(node.name)) return null;
    const name = node.name?.getText(sourceFile);
    if (!name || name.startsWith("_")) return null; // Skip private properties

    const isReadOnly = node.modifiers?.some(
        (m) => m.kind === ts.SyntaxKind.ReadonlyKeyword,
    );

    // Check if there's a corresponding setter
    const hasGetter = ts.isGetAccessor(node);
    const parent = node.parent;
    let hasSetter = false;
    if (hasGetter && parent && ts.isClassDeclaration(parent)) {
        hasSetter = parent.members.some(
            (m) => ts.isSetAccessor(m) && m.name?.getText(sourceFile) === name,
        );
    }

    const type = node.type ? node.type.getText(sourceFile) : "any";
    const jsDoc = extractJsDoc(node);

    const className =
        node.parent && ts.isClassDeclaration(node.parent) && node.parent.name
            ? node.parent.name.text
            : null;

    if (className && HIDDEN_PROPERTIES_BY_CLASS[className]?.has(name)) {
        return null;
    }

    return {
        name,
        type,
        readOnly: isReadOnly || (hasGetter && !hasSetter),
        jsDoc: jsDoc?.description || null,
        example: jsDoc?.example || null,
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
    const isPrivateModifier = node.modifiers?.some(
        (m) => m.kind === ts.SyntaxKind.PrivateKeyword,
    );
    const isPrivateIdentifier = node.name && ts.isPrivateIdentifier(node.name);

    if (
        !name ||
        name.startsWith("_") ||
        isPrivateModifier ||
        isPrivateIdentifier
    ) {
        return null; // Skip private methods
    }

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
        "Babelfont.I18NDictionary": "I18NDictionary",
        "Babelfont.Names": "Names",
        "Babelfont.Features": "dict",
        "Babelfont.CustomOTValues": "dict[str, Any]",
        "Babelfont.DecomposedAffine": "dict",
        "Babelfont.Position": "dict",
        "Babelfont.Color": "dict",
        "Babelfont.LayerType": "dict",
        FeatureVariationAxisRule: "dict",
        GlyphDataSearchResult: "dict",
        DesignspaceLocation: "dict[str, float | int]",
        UserspaceLocation: "dict[str, float | int]",
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
        "Drawing",
        "Glyph",
        "Axis",
        "Station",
        "Instance",
        "Font",
    ];
    if (knownClasses.includes(tsType)) {
        return `[${tsType}](#${tsType.toLowerCase()})`;
    }

    return tsType;
}

function appendPropertyDocs(lines, prop) {
    const pyType = tsToPythonType(prop.type);
    const desc = prop.jsDoc ? `: ${prop.jsDoc}` : "";
    lines.push(`- **\`${prop.name}\`** (${pyType})${desc}`);
    if (prop.example) {
        lines.push(``);
        lines.push(`**Example:**`);
        lines.push(`\`\`\`python`);
        lines.push(prop.example);
        lines.push(`\`\`\``);
    }
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
        Font: "```python\n# fonteditor module is pre-loaded\nfont = Font()\n```",
        Glyph: '```python\nglyph = font.glyphs[0]\n# or\nglyph = font.findGlyph("A")\n```',
        Drawing: "```python\ndrawing = glyph.drawings[0]\n```",
        Path: "```python\npath = drawing.paths[0]\n```",
        Component: "```python\ncomponent = drawing.components[0]\n```",
        Node: "```python\nnode = path.nodes[0]\n```",
        Anchor: "```python\nanchor = drawing.anchors[0]\n```",
        Guide: "```python\nguide = drawing.guides[0]\n# or\nguide = station.guides[0]\n```",
        Shape: "```python\npath = drawing.paths[0]\nshape = path.parent()\n```",
        Axis: '```python\naxis = font.axes[0]\n# or\naxis = font.findAxisByTag("wght")\n```',
        Station:
            '```python\nstation = font.stations[0]\n# or\nstation = font.findStation("station-id")\n```',
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
            appendPropertyDocs(lines, prop);
        });

        if (readWriteProps.length > 0 && readOnlyProps.length > 0) {
            lines.push(``);
            lines.push(`#### Read-Only Properties\n`);
        }

        // Document read-only properties
        readOnlyProps.forEach((prop) => {
            appendPropertyDocs(lines, prop);
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

            lines.push(
                `#### \`${method.name}(${pyParams}) -> ${pyReturnType}\``,
            );

            if (method.jsDoc) {
                lines.push(`${method.jsDoc}\n`);
            }

            // Add example from JSDoc @example tag
            if (method.example) {
                lines.push(
                    `**Example:**\n\`\`\`python\n${method.example}\n\`\`\`\n`,
                );
            }
        });
    }

    lines.push(`---\n`);

    return lines.join("\n");
}

function ensurePythonFences(markdown) {
    let inFence = false;
    return markdown
        .split("\n")
        .map((line) => {
            const match = line.match(/^```([\w+-]*)\s*$/);
            if (!match) {
                return line;
            }
            if (inFence) {
                inFence = false;
                return line;
            }
            inFence = true;
            if (!match[1]) {
                return "```python";
            }
            return line;
        })
        .join("\n");
}

/**
 * Generate the complete API documentation
 */
function generateAPIDocs(version = null) {
    console.log("📄 Parsing babelfont-model.ts...");

    const modelPath = join(REPO_ROOT, "webapp", "js", "babelfont-model.ts");
    const classes = parseTypeScriptFile(modelPath);

    console.log(`✅ Found ${classes.length} exported classes`);

    // Order classes for documentation
    const classOrder = [
        "Font",
        "Glyph",
        "FeatureVariationGlyph",
        "Drawing",
        "Shape",
        "Path",
        "Node",
        "Component",
        "Anchor",
        "Guide",
        "Axis",
        "Station",
        "Instance",
    ];

    const orderedClasses = classOrder
        .map((name) => classes.find((c) => c.name === name))
        .filter((c) => c);

    console.log("📝 Generating documentation...");

    const lines = [];

    // Header
    lines.push("# Font Object Model API Documentation\n");
    if (version) {
        lines.push(`**Version:** ${version}\n`);
    }
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

    const docs = ensurePythonFences(lines.join("\n"));

    console.log(`✅ Generated ${docs.length} characters of documentation`);

    const outputPath = join(REPO_ROOT, "API.md");
    writeFileSync(outputPath, docs, "utf-8");
    console.log(`📝 Documentation saved to: ${outputPath}`);

    const handbookPath = join(
        REPO_ROOT,
        "documentation",
        "python",
        "06-python-api.md",
    );
    const handbookDocs = docs.replace(
        /^# Font Object Model API Documentation/m,
        "# Python API",
    );
    writeFileSync(handbookPath, handbookDocs, "utf-8");
    console.log(`📝 Handbook copy saved to: ${handbookPath}`);
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
font = Font()
\`\`\`

### Dictionary Access (Python wrappers)

Dictionary-like object model fields are wrapped as live Python mappings.
Use attribute access when the name is a Python identifier, including I18N
language tags (\`name.dflt\`) and designspace locations (\`location.wght\`).
Do not use \`.get()\`. Index kerning by pair key
(\`kerning["A:V"]\`).

\`\`\`python
font = Font()
station = font.stations[0]

# Pair-key kerning dictionary
station.kerning["A:V"] = -80

# Per-station vertical metrics
xh = station.metrics.XHeight
station.metrics.Ascender = 800

# I18N: language tags are attributes
print(font.names.family_name.dflt)
font.names.family_name.dflt = "My Family"
font.names.family_name.de = "Meine Familie"
font.names.family_name.fr = "Ma Famille"
print(station.name.dflt)
station.name.dflt = "Standard"

# Designspace location
print(station.location)
print(station.location.wght)

# Optional snapshot copy when needed
kerning_snapshot = station.kerning.as_dict()
\`\`\`

### System Notifications

\`Notification(title, body="")\` posts an OS notification. The first call may ask the browser for permission. The open font family name is included when a font is open. Repeating the same title and body shows the banner again without stacking a new Notification Center item.

\`\`\`python
Notification("Export complete", "MyFont.otf written")
\`\`\`

Use this for a requested action finishing, not as automatic confirmation of routine edits.

### Shared Plugin Context

\`\`\`python
ctx = Context()
ctx.runCount = getattr(ctx, "runCount", 0) + 1
SetContextPatch({"lastRun": {"count": ctx.runCount}})
\`\`\`

### Parent Navigation

All objects in the hierarchy have a \`parent()\` method that returns their parent object,
allowing navigation up the object tree to the root Font object.

**Example:**
\`\`\`python
# Navigate from node up to font
node = font.glyphs[0].drawings[0].paths[0].nodes[0]
path = node.parent()      # Path object
shape = path.parent()     # Shape object
drawing = shape.parent()    # Drawing object
glyph = drawing.parent()    # Glyph object
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
font = Font()

# Create a new glyph
glyph = font.addGlyph("myGlyph", "Base")

# Add a drawing
drawing = glyph.addDrawing(500)  # 500 units wide

# Create a rectangle path
path = drawing.addPath(closed=True)
path.appendNode(100, 0, "Line")
path.appendNode(400, 0, "Line")
path.appendNode(400, 700, "Line")
path.appendNode(100, 700, "Line")

print(f"Created glyph: {glyph.name}")
\`\`\`

### Example 2: Modifying Existing Glyphs

\`\`\`python
font = Font()

# Find glyph A
glyph_a = font.findGlyph("A")
if glyph_a:
    drawing = glyph_a.drawings[0]
    
    # Modify all nodes
    for path in drawing.paths:
        for node in path.nodes:
            node.x += 10  # Shift 10 units right
            node.y += 5   # Shift 5 units up
    
    # Add an anchor
    drawing.addAnchor(250, 700, "top")
    
    print(f"Modified {glyph_a.name}")
\`\`\`

### Example 3: Working with Components

\`\`\`python
font = Font()

# Create a glyph with a component
glyph = font.addGlyph("Aacute", "Base")
drawing = glyph.addDrawing(600)

# Add base letter component
base = drawing.addComponent("A")

# Add accent component with transformation
# Transform: [scaleX, skewX, skewY, scaleY, translateX, translateY]
accent = drawing.addComponent("acutecomb", [1, 0, 0, 1, 250, 500])

print(f"Created {glyph.name} with components")
\`\`\`

### Example 4: Iterating Through Font

\`\`\`python
font = Font()

# Count nodes across all glyphs
total_nodes = 0
for glyph in font.glyphs:
    if glyph.drawings:
        for drawing in glyph.drawings:
            for path in drawing.paths:
                total_nodes += len(path.nodes)

print(f"Total nodes in font: {total_nodes}")
\`\`\`

### Example 5: Working with Variable Fonts

\`\`\`python
font = Font()

# Check if font has axes
if font.axes:
    print("Variable font axes:")
    for axis in font.axes:
        print(f"  {axis.tag}: {axis.min} - {axis.max} (default: {axis.default})")
    
    # Check stations
    if font.stations:
        print(f"\\nFont has {len(font.stations)} stations:")
        for station in font.stations:
            location_str = ", ".join(f"{k}={v}" for k, v in (station.location or {}).items())
            print(f"  Station: {location_str}")
\`\`\`

### Example 6: Batch Processing Glyphs

\`\`\`python
font = Font()

# Scale all glyphs by 1.5x
scale_factor = 1.5

for glyph in font.glyphs:
    if glyph.drawings:
        for drawing in glyph.drawings:
            # Scale width
            drawing.width *= scale_factor
            
            # Scale all outline paths
            for path in drawing.paths:
                for node in path.nodes:
                    node.x *= scale_factor
                    node.y *= scale_factor
            
            # Scale anchors
            if drawing.anchors:
                for anchor in drawing.anchors:
                    anchor.x *= scale_factor
                    anchor.y *= scale_factor

print(f"Scaled {len(font.glyphs)} glyphs by {scale_factor}x")
\`\`\`

### Example 7: Kerning and i18n Dictionaries

\`\`\`python
font = Font()
station = font.stations[0]

# Pair-key kerning
station.kerning["A:V"] = -90
station.kerning["A:W"] = -70

# Read values
av_value = station.kerning["A:V"]
print(f"A/V kerning: {av_value}")

# Update localized names
font.names.family_name.dflt = "Counterpunch Sans"
font.names.family_name.de = "Counterpunch Sans DE"
font.names.family_name.fr = "Counterpunch Sans FR"
\`\`\`

### Example 8: Editing OpenType Features List

\`\`\`python
font = Font()

# features is a live list-like wrapper
feature_items = font.features.features

# Append a new feature tuple: [tag, code-record]
feature_items.append(["liga", {"code": "sub f i by fi;"}])

# Insert at the top
feature_items.insert(0, ["kern", {"code": "pos A V -80;"}])

# Remove entries with normal list operations
if len(feature_items) > 5:
    feature_items.pop()

del feature_items[0]
\`\`\`

---

## Tips and Best Practices

### Performance

- Changes to properties are immediately reflected in the underlying JSON data
- No need to "save" or "commit" changes - they are live
- Dictionary-like fields are live Python mappings (no routine \`.to_py()\` needed)
- Array fields (for example \`font.features.features\`) are live list-like wrappers
- For batch operations, group changes together to minimize redraws

### Type Checking

\`\`\`python
# Use the filtered convenience collections when you know what you want
for path in drawing.paths:
    # Work with path

for component in drawing.components:
    # Work with component
\`\`\`

### Safe Property Access

\`\`\`python
# Check for optional properties
if glyph.drawings:
    for drawing in glyph.drawings:
        for path in drawing.paths:
            for node in path.nodes:
                print(f"Node at ({node.x}, {node.y})")
\`\`\`

### Guardrails for Dictionary Fields

Dictionary-like fields reject scalar overwrite assignments to prevent broken model state.

\`\`\`python
# ❌ Avoid replacing a language table with a string
# font.names.family_name = "My Font"
# font.names.family_name.get("dflt")

# ✅ Language tags are attributes
font.names.family_name.dflt = "My Font"

# ✅ Or replace with a full mapping
font.names.family_name = {
    "dflt": "My Font",
    "de": "Meine Schrift"
}
\`\`\`

### Accessing Nodes Example

\`\`\`python
# Direct access (may fail if properties are None)
# glyph.drawings[0].paths[0].nodes  # DON'T DO THIS

# Safe access with checks:
drawing = glyph.drawings[0] if glyph.drawings else None
if drawing and drawing.paths:
    path = drawing.paths[0]
    nodes = path.nodes
    print(f"Path has {len(nodes)} nodes")
\`\`\`

### Coordinate System

- Origin (0, 0) is at the baseline on the left
- Y-axis points upward
- All coordinates are in font units (1/upm of the em square)

### Common Issues

**Q: Why does \`glyph.drawings[0].paths[0].nodes\` fail?**

A: Optional properties may be \`None\`. Use safe access:
\`\`\`python
# Check each step
if glyph.drawings and len(glyph.drawings) > 0:
    drawing = glyph.drawings[0]
    if drawing.paths and len(drawing.paths) > 0:
        path = drawing.paths[0]
        nodes = path.nodes  # Now safe to access
\`\`\`

**Q: How do I access only paths or only components in a drawing?**

A: Use \`drawing.paths\` and \`drawing.components\` directly:
\`\`\`python
for path in drawing.paths:
    print(len(path.nodes))

for component in drawing.components:
    print(component.reference)
\`\`\`

---

*Generated by \`scripts/generate-api-docs.mjs\`*
`;
}

// Run the generator
// Accept version from command line: node scripts/generate-api-docs.mjs [version]
const version = process.argv[2] || null;
generateAPIDocs(version);
