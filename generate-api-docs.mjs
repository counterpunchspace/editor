#!/usr/bin/env node

/**
 * API Documentation Generator - JavaScript Introspection
 *
 * Generates API documentation for the Font Object Model by introspecting
 * the TypeScript babelfont-extended.ts file directly. Produces Python-oriented
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

// Methods to skip in API documentation
const SKIP_METHODS = [
  "toString",
  "markDirty",
  "toJSON",
  "toJSONString",
  "fromData",
];

// Source files to parse
const SOURCE_FILE = join(__dirname, "webapp/js/babelfont-extended.ts");
const BABELFONT_TS_DIR = join(
  __dirname,
  "webapp/vendor/babelfont-rs/babelfont-ts/src",
);

/**
 * Parse TypeScript file and extract class/interface information
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
  const interfaces = new Map(); // className -> properties[]

  function visit(node) {
    // Collect interface declarations
    if (ts.isInterfaceDeclaration(node) && node.name) {
      const interfaceName = node.name.text;
      const props = [];

      node.members.forEach((member) => {
        if (ts.isPropertySignature(member)) {
          const prop = extractInterfaceProperty(member, sourceFile);
          if (prop) props.push(prop);
        }
      });

      interfaces.set(interfaceName, props);
    }

    // Process class declarations
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
        constructor: null,
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
        } else if (ts.isConstructorDeclaration(member)) {
          classInfo.constructor = extractConstructor(member, sourceFile);
        }
      });

      classes.push(classInfo);
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);

  // Merge interface properties into classes
  classes.forEach((cls) => {
    if (interfaces.has(cls.name)) {
      const interfaceProps = interfaces.get(cls.name);
      cls.properties = [...interfaceProps, ...cls.properties];
    }
  });

  return classes;
}

/**
 * Extract property from interface signature
 */
function extractInterfaceProperty(member, sourceFile) {
  const name = member.name?.getText(sourceFile);
  if (!name || name.startsWith("_")) return null;

  const type = member.type ? member.type.getText(sourceFile) : "any";
  const isReadOnly = member.modifiers?.some(
    (m) => m.kind === ts.SyntaxKind.ReadonlyKeyword,
  );
  const isOptional = !!member.questionToken;
  const jsDoc = extractJsDoc(member);

  return {
    name,
    type:
      isOptional && !type.includes("undefined") ? `${type} | undefined` : type,
    readOnly: isReadOnly,
    jsDoc: jsDoc?.description || null,
  };
}

/**
 * Parse underlying.ts to extract base interface properties and type definitions
 */
function parseUnderlyingFile(filePath) {
  const sourceCode = readFileSync(filePath, "utf-8");
  const sourceFile = ts.createSourceFile(
    filePath,
    sourceCode,
    ts.ScriptTarget.Latest,
    true,
  );

  const interfaces = new Map(); // interfaceName -> properties[]
  const typeDefinitions = new Map(); // typeName -> options[]

  function visit(node) {
    if (ts.isInterfaceDeclaration(node) && node.name) {
      const interfaceName = node.name.text;
      const props = [];

      node.members.forEach((member) => {
        if (ts.isPropertySignature(member)) {
          const prop = extractInterfaceProperty(member, sourceFile);
          if (prop) props.push(prop);
        }
      });

      interfaces.set(interfaceName, props);
    }

    // Extract enum definitions
    if (ts.isEnumDeclaration(node) && node.name) {
      const enumName = node.name.text;
      const options = [];

      node.members.forEach((member) => {
        if (member.name) {
          const memberName = member.name.getText(sourceFile);
          const jsDoc = extractJsDoc(member);
          const description = jsDoc?.description || null;

          // Get the value if it's a string literal
          let value = memberName;
          if (member.initializer && ts.isStringLiteral(member.initializer)) {
            value = member.initializer.text;
          }

          options.push({ value, description });
        }
      });

      typeDefinitions.set(enumName, options);
    }

    // Extract type alias with union of string literals
    if (ts.isTypeAliasDeclaration(node) && node.name) {
      const typeName = node.name.text;
      const typeNode = node.type;

      if (ts.isUnionTypeNode(typeNode)) {
        const options = [];

        typeNode.types.forEach((type) => {
          if (ts.isLiteralTypeNode(type) && ts.isStringLiteral(type.literal)) {
            const value = type.literal.text;
            // Try to get JSDoc for this specific literal (usually on the line)
            options.push({ value, description: null });
          }
        });

        if (options.length > 0) {
          // Get JSDoc description from the type alias itself
          const jsDoc = extractJsDoc(node);
          const typeDescription = jsDoc?.description || null;

          // Parse JSDoc to extract per-value descriptions if available
          if (jsDoc?.description) {
            const lines = jsDoc.description.split("\n");
            lines.forEach((line) => {
              const match = line.match(/^(?:A |An |The )?(.+?)(?: glyph)?$/);
              if (match) {
                // Try to match descriptions to values
                const desc = line.trim();
                options.forEach((opt) => {
                  if (
                    desc.toLowerCase().includes(opt.value.toLowerCase()) &&
                    !opt.description
                  ) {
                    opt.description = desc;
                  }
                });
              }
            });
          }

          typeDefinitions.set(typeName, options);
        }
      }
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return { interfaces, typeDefinitions };
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
  if (SKIP_METHODS.includes(name)) return null; // Skip methods in skip list

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
 * Extract constructor information
 */
function extractConstructor(node, sourceFile) {
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

  const jsDoc = extractJsDoc(node);

  return {
    parameters,
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
    Date: "datetime",
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

  // Handle tuple types
  if (tsType.match(/^\[.*\]$/)) {
    // Convert [number, number] to tuple[float | int, float | int]
    const inner = tsType.slice(1, -1);
    const types = inner.split(",").map((t) => tsToPythonType(t.trim()));
    return `tuple[${types.join(", ")}]`;
  }

  // Handle import() types - extract the last part
  if (tsType.includes("import(")) {
    // Extract types like DesignspaceLocation from import("@simoncozens/fonttypes").DesignspaceLocation
    const match = tsType.match(/\.(\w+)/);
    if (match) {
      const typeName = match[1];
      // Map some known types
      const importTypeMap = {
        DesignspaceLocation: "dict",
        UserspaceCoordinate: "float | int",
        DesignspaceCoordinate: "float | int",
      };
      return importTypeMap[typeName] || typeName;
    }
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
    "Names",
    "Features",
    "DecomposedAffine",
    "Color",
    "Position",
  ];
  if (knownClasses.includes(tsType)) {
    return `[${tsType}](#${tsType.toLowerCase()})`;
  }

  return tsType;
}

/**
 * Get formatted type options for a property if available
 * @param {string} tsType - TypeScript type string
 * @param {Map} typeDefinitions - Map of type names to their options
 * @returns {string} Formatted options string or empty string
 */
function getTypeOptions(tsType, typeDefinitions) {
  // Extract the base type name (remove optional/undefined, array brackets, etc.)
  let baseType = tsType
    .replace(/\s*\|\s*undefined$/, "")
    .replace(/\[\]$/, "")
    .trim();

  // Check if we have options for this type
  if (typeDefinitions.has(baseType)) {
    const options = typeDefinitions.get(baseType);
    if (options.length > 0) {
      const optionsList = options
        .map((opt) => {
          if (opt.description) {
            return `\`"${opt.value}"\` (${opt.description})`;
          }
          return `\`"${opt.value}"\``;
        })
        .join(", ");
      return `. Options: ${optionsList}`;
    }
  }

  return "";
}

/**
 * Generate markdown documentation for a class
 */
function generateClassDocs(classInfo, typeDefinitions = new Map()) {
  const lines = [];
  const className = classInfo.name;

  lines.push(`## ${className}\n`);

  if (classInfo.jsDoc) {
    lines.push(`${classInfo.jsDoc}\n`);
  }

  // Access example
  const accessExamples = {
    Font: "```python\n# fonteditor module is pre-loaded\nfont = CurrentFont()\n```",
    Names:
      '```python\n# Access all name entries\nfont.names.copyright = {"en": "Copyright 2026"}\nfont.names.family_name = {"en": "My Font"}\n```',
    Features:
      '```python\n# Define OpenType feature code\nfont.features.classes["@lowercase"] = "a b c d e"\nfont.features.prefixes["languagesystems"] = "languagesystem DFLT dflt;"\nfont.features.features.append(("liga", "sub f i by fi;"))\n```',
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

  // Note about object creation (constructors are not directly accessible in Python)
  const creationNotes = {
    Font: "**Note:** Font objects are created by loading font files. Use `CurrentFont()` to access the current font.",
    Glyph:
      "**Note:** Create new glyphs using `font.addGlyph(name, category)`. Existing glyphs are accessed from `font.glyphs` list or via `font.findGlyph(name)`.",
    Layer:
      "**Note:** Create new layers using `glyph.addLayer(masterId, width)`. Existing layers are accessed from `glyph.layers` list.",
    Path: "**Note:** Create paths using `layer.addPath(closed=True/False)`.",
    Node: '**Note:** Create nodes using `path.addNode({"x": 100, "y": 200, "type": "line"})`.',
    Component:
      '**Note:** Create components using `layer.addComponent("glyphName")`.',
    Anchor:
      '**Note:** Create anchors using `layer.createAnchor("name", x, y)`.',
    Guide:
      "**Note:** Guides are accessed from `layer.guides` or `master.guides` lists.",
    Axis: "**Note:** Axes are accessed from `font.axes` list.",
    Master: "**Note:** Masters are accessed from `font.masters` list.",
    Instance: "**Note:** Instances are accessed from `font.instances` list.",
  };

  if (creationNotes[className]) {
    lines.push(`${creationNotes[className]}\n`);
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
      // Replace newlines in descriptions with spaces to keep everything on one line
      let desc = prop.jsDoc ? `: ${prop.jsDoc.replace(/\n/g, " ")}` : "";

      // Check if this property's type has defined options
      const typeOptions = getTypeOptions(prop.type, typeDefinitions);
      if (typeOptions) {
        desc += typeOptions;
      }

      lines.push(`- **\`${prop.name}\`** (${pyType})${desc}`);
    });

    if (readWriteProps.length > 0 && readOnlyProps.length > 0) {
      lines.push(``);
      lines.push(`#### Read-Only Properties\n`);
    }

    // Document read-only properties
    readOnlyProps.forEach((prop) => {
      const pyType = tsToPythonType(prop.type);
      // Replace newlines in descriptions with spaces to keep everything on one line
      let desc = prop.jsDoc ? `: ${prop.jsDoc.replace(/\n/g, " ")}` : "";

      // Check if this property's type has defined options
      const typeOptions = getTypeOptions(prop.type, typeDefinitions);
      if (typeOptions) {
        desc += typeOptions;
      }

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
function generateAPIDocs(version = null) {
  console.log("📄 Parsing TypeScript sources...");

  // Parse babelfont-extended.ts for methods
  const extendedClasses = parseTypeScriptFile(SOURCE_FILE);
  console.log(`✅ Found ${extendedClasses.length} extended classes`);

  // Parse underlying.ts for base interfaces and type definitions
  const underlyingPath = join(BABELFONT_TS_DIR, "underlying.ts");
  const { interfaces: underlyingInterfaces, typeDefinitions } =
    parseUnderlyingFile(underlyingPath);
  console.log(
    `✅ Parsed underlying.ts: ${underlyingInterfaces.size} interfaces, ${typeDefinitions.size} type definitions`,
  );

  // Parse babelfont-ts source files for wrapper class interfaces
  const classFiles = [
    "font.ts",
    "names.ts",
    "features.ts",
    "glyph.ts",
    "layer.ts",
    "shape.ts",
    "anchor.ts",
    "guide.ts",
    "axis.ts",
    "master.ts",
    "instance.ts",
  ];

  const baseClasses = new Map();
  classFiles.forEach((file) => {
    const filePath = join(BABELFONT_TS_DIR, file);
    try {
      const classes = parseTypeScriptFile(filePath);
      classes.forEach((cls) => {
        // Also merge in underlying interface properties
        const underlyingProps = underlyingInterfaces.get(cls.name) || [];
        const allProps = [...underlyingProps, ...cls.properties];
        // Deduplicate by name
        const propMap = new Map();
        allProps.forEach((prop) => propMap.set(prop.name, prop));
        cls.properties = Array.from(propMap.values());

        baseClasses.set(cls.name, cls);
      });
      console.log(`✅ Parsed ${file}: ${classes.length} classes`);
    } catch (err) {
      console.warn(`⚠️ Could not parse ${file}: ${err.message}`);
    }
  });

  // Merge base properties into extended classes
  const mergedClasses = extendedClasses.map((extCls) => {
    const baseCls = baseClasses.get(extCls.name);
    if (baseCls) {
      // Merge properties (base first, then extended)
      const allProps = [...baseCls.properties, ...extCls.properties];
      // Deduplicate by name (extended overrides base)
      const propMap = new Map();
      allProps.forEach((prop) => propMap.set(prop.name, prop));

      return {
        ...extCls,
        properties: Array.from(propMap.values()),
        jsDoc: extCls.jsDoc || baseCls.jsDoc,
      };
    }
    return extCls;
  });

  console.log(`✅ Merged ${mergedClasses.length} classes with base properties`);

  console.log(`✅ Merged ${mergedClasses.length} classes with base properties`);

  // Order classes for documentation
  const classOrder = [
    "Font",
    "Names",
    "Features",
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
    .map((name) => mergedClasses.find((c) => c.name === name))
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
    const desc = cls.jsDoc ? ` - ${cls.jsDoc}` : "";
    lines.push(`  - [${cls.name}](#${anchor})${desc}`);
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
    lines.push(generateClassDocs(cls, typeDefinitions));
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

### Example 1: Modifying Existing Glyphs

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
    layer.createAnchor("top", 250, 700)
    
    print(f"Modified {glyph_a.name}")
\`\`\`

### Example 2: Working with Components

\`\`\`python
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
\`\`\`

### Example 3: Iterating Through Font

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

### Example 4: Working with Variable Fonts

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

### Example 5: Batch Processing Glyphs

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
// Accept version from command line: node generate-api-docs.mjs [version]
const version = process.argv[2] || null;
generateAPIDocs(version);
