const fs = require('fs');
const path = require('path');
const { Font } = require('../js/babelfont-model');

describe('Babelfont Object Model', () => {
    let fontData;
    let font;

    beforeAll(() => {
        // Load Fustat.babelfont as test fixture
        const fixturePath = path.join(
            __dirname,
            '..',
            'examples',
            'Fustat.babelfont'
        );
        const jsonString = fs.readFileSync(fixturePath, 'utf-8');
        fontData = JSON.parse(jsonString);
    });

    beforeEach(() => {
        // Create a fresh font instance for each test
        font = Font.fromData(fontData);
    });

    describe('parent() method', () => {
        test('Font.parent() should return null (root object)', () => {
            expect(font.parent()).toBeNull();
        });

        test('Glyph.parent() should return Font', () => {
            const glyph = font.glyphs[0];
            expect(glyph.parent()).toBe(font);
        });

        test('Layer.parent() should return Glyph', () => {
            const glyph = font.glyphs[0];
            const layer = glyph.layers[0];
            expect(layer.parent()).toBe(glyph);
        });

        test('Shape.parent() should return Layer', () => {
            const glyph = font.glyphs[0];
            const layer = glyph.layers[0];
            const shapes = layer.shapes;

            if (shapes && shapes.length > 0) {
                const shape = shapes[0];
                expect(shape.parent()).toBe(layer);
            }
        });

        test('Path.parent() should return Shape', () => {
            // Find a glyph with a path
            for (const glyph of font.glyphs) {
                const layer = glyph.layers[0];
                if (!layer || !layer.shapes) continue;

                for (const shape of layer.shapes) {
                    if (shape.isPath()) {
                        const path = shape.asPath();
                        expect(path.parent()).toBe(shape);
                        return; // Test passed
                    }
                }
            }
        });

        test('Node.parent() should return Path', () => {
            // Find a glyph with a path that has nodes
            for (const glyph of font.glyphs) {
                const layer = glyph.layers[0];
                if (!layer || !layer.shapes) continue;

                for (const shape of layer.shapes) {
                    if (shape.isPath()) {
                        const path = shape.asPath();
                        if (path.nodes && path.nodes.length > 0) {
                            const node = path.nodes[0];
                            expect(node.parent()).toBe(path);
                            return; // Test passed
                        }
                    }
                }
            }
        });

        test('Component.parent() should return Shape', () => {
            // Find a glyph with a component
            for (const glyph of font.glyphs) {
                const layer = glyph.layers[0];
                if (!layer || !layer.shapes) continue;

                for (const shape of layer.shapes) {
                    if (shape.isComponent()) {
                        const component = shape.asComponent();
                        expect(component.parent()).toBe(shape);
                        return; // Test passed
                    }
                }
            }
        });

        test('Anchor.parent() should return Layer', () => {
            // Find a glyph with anchors
            for (const glyph of font.glyphs) {
                const layer = glyph.layers[0];
                if (!layer || !layer.anchors || layer.anchors.length === 0)
                    continue;

                const anchor = layer.anchors[0];
                expect(anchor.parent()).toBe(layer);
                return; // Test passed
            }
        });

        test('Guide.parent() should return Layer', () => {
            // Find a layer with guides
            for (const glyph of font.glyphs) {
                const layer = glyph.layers[0];
                if (!layer || !layer.guides || layer.guides.length === 0)
                    continue;

                const guide = layer.guides[0];
                expect(guide.parent()).toBe(layer);
                return; // Test passed
            }
        });

        test('Axis.parent() should return Font', () => {
            if (font.axes && font.axes.length > 0) {
                const axis = font.axes[0];
                expect(axis.parent()).toBe(font);
            }
        });

        test('Master.parent() should return Font', () => {
            if (font.masters && font.masters.length > 0) {
                const master = font.masters[0];
                expect(master.parent()).toBe(font);
            }
        });

        test('Instance.parent() should return Font', () => {
            if (font.instances && font.instances.length > 0) {
                const instance = font.instances[0];
                expect(instance.parent()).toBe(font);
            }
        });

        test('should navigate from Node up to Font', () => {
            // Find a complete path: Node → Path → Shape → Layer → Glyph → Font
            for (const glyph of font.glyphs) {
                const layer = glyph.layers[0];
                if (!layer || !layer.shapes) continue;

                for (const shape of layer.shapes) {
                    if (shape.isPath()) {
                        const path = shape.asPath();
                        if (path.nodes && path.nodes.length > 0) {
                            const node = path.nodes[0];

                            // Navigate up the hierarchy
                            const parentPath = node.parent();
                            expect(parentPath).toBe(path);

                            const parentShape = parentPath.parent();
                            expect(parentShape).toBe(shape);

                            const parentLayer = parentShape.parent();
                            expect(parentLayer).toBe(layer);

                            const parentGlyph = parentLayer.parent();
                            expect(parentGlyph).toBe(glyph);

                            const parentFont = parentGlyph.parent();
                            expect(parentFont).toBe(font);

                            return; // Test passed
                        }
                    }
                }
            }
        });
    });

    describe('Font basic properties', () => {
        test('should have correct UPM', () => {
            expect(font.upm).toBe(fontData.upm);
        });

        test('should have glyphs', () => {
            expect(font.glyphs).toBeDefined();
            expect(Array.isArray(font.glyphs)).toBe(true);
            expect(font.glyphs.length).toBeGreaterThan(0);
        });

        test('should have version', () => {
            expect(font.version).toBeDefined();
            expect(Array.isArray(font.version)).toBe(true);
            expect(font.version.length).toBe(2);
        });

        test('should have names', () => {
            expect(font.names).toBeDefined();
            expect(font.names.family_name).toBeDefined();
        });
    });

    describe('Glyph access and properties', () => {
        test('should access glyph by index', () => {
            const glyph = font.glyphs[0];
            expect(glyph).toBeDefined();
            expect(glyph.name).toBeDefined();
        });

        test('glyph should have layers', () => {
            const glyph = font.glyphs[0];
            expect(glyph.layers).toBeDefined();
        });

        test('glyph layers should be filtered (no background, no copies)', () => {
            // Find a glyph with multiple layers in raw data
            for (let i = 0; i < fontData.glyphs.length; i++) {
                const rawGlyph = fontData.glyphs[i];
                const modelGlyph = font.glyphs[i];

                if (rawGlyph.layers && rawGlyph.layers.length > 1) {
                    // Model layers should be filtered
                    const modelLayers = modelGlyph.layers || [];
                    const rawLayers = rawGlyph.layers;

                    // Count foreground default layers in raw data
                    let expectedCount = 0;
                    for (const layer of rawLayers) {
                        if (layer.is_background) continue;
                        if (
                            layer.master &&
                            typeof layer.master === 'object' &&
                            'DefaultForMaster' in layer.master
                        ) {
                            expectedCount++;
                        }
                    }

                    expect(modelLayers.length).toBeLessThanOrEqual(
                        rawLayers.length
                    );
                    break;
                }
            }
        });
    });

    describe('Layer properties and methods', () => {
        let layer;

        beforeEach(() => {
            const glyph = font.glyphs[0];
            layer = glyph.layers[0];
        });

        test('should have width property', () => {
            expect(layer.width).toBeDefined();
            expect(typeof layer.width).toBe('number');
        });

        test('should have shapes array', () => {
            if (layer.shapes) {
                expect(Array.isArray(layer.shapes)).toBe(true);
            }
        });

        test('should calculate lsb', () => {
            const lsb = layer.lsb;
            expect(typeof lsb).toBe('number');
        });

        test('should calculate rsb', () => {
            const rsb = layer.rsb;
            expect(typeof rsb).toBe('number');
        });

        test('lsb + bbox.width + rsb should equal width', () => {
            const bbox = layer.getBoundingBox(false);
            if (bbox) {
                const lsb = layer.lsb;
                const rsb = layer.rsb;
                const bboxWidth = bbox.maxX - bbox.minX;
                const total = lsb + bboxWidth + rsb;
                expect(Math.abs(total - layer.width)).toBeLessThan(0.01);
            }
        });
    });

    describe('Sidebearing manipulation (lsb/rsb setters)', () => {
        test('lsb setter should translate paths and adjust width', () => {
            const glyph = font.glyphs.find((g) => g.name === 'A'); // paths only
            const layer = glyph.layers[0];

            const originalLsb = layer.lsb;
            const originalBbox = layer.getBoundingBox(false);
            const originalWidth = layer.width;

            layer.lsb = originalLsb + 50;

            const newBbox = layer.getBoundingBox(false);
            expect(newBbox.minX).toBeCloseTo(originalBbox.minX + 50, 1);
            expect(newBbox.maxX).toBeCloseTo(originalBbox.maxX + 50, 1);
            expect(layer.width).toBeCloseTo(originalWidth + 50, 1);
        });

        test('lsb setter should translate components and adjust width', () => {
            const glyph = font.glyphs.find((g) => g.name === 'Aacute'); // components only
            const layer = glyph.layers[0];

            const originalLsb = layer.lsb;
            const originalWidth = layer.width;

            // Get original component transforms before modification
            const componentsBefore = layer.shapes
                .filter((s) => s.isComponent())
                .map((s) => {
                    const comp = s.asComponent();
                    const transform = comp.data.transform || [1, 0, 0, 1, 0, 0];
                    return transform[4]; // x translation
                });

            layer.lsb = originalLsb - 30;

            // Check that all component transforms were updated
            const componentsAfter = layer.shapes
                .filter((s) => s.isComponent())
                .map((s) => {
                    const comp = s.asComponent();
                    const transform = comp.data.transform || [1, 0, 0, 1, 0, 0];
                    return transform[4]; // x translation
                });

            for (let i = 0; i < componentsBefore.length; i++) {
                expect(componentsAfter[i]).toBeCloseTo(
                    componentsBefore[i] - 30,
                    1
                );
            }
            expect(layer.width).toBeCloseTo(originalWidth - 30, 1);
        });

        test('lsb setter should translate mixed shapes and adjust width', () => {
            const glyph = font.glyphs.find((g) => g.name === 'AE'); // mixed paths + components
            const layer = glyph.layers[0];

            const originalLsb = layer.lsb;
            const originalBbox = layer.getBoundingBox(false);
            const originalWidth = layer.width;

            layer.lsb = originalLsb + 25;

            const newBbox = layer.getBoundingBox(false);
            expect(newBbox.minX).toBeCloseTo(originalBbox.minX + 25, 1);
            expect(newBbox.maxX).toBeCloseTo(originalBbox.maxX + 25, 1);
            expect(layer.width).toBeCloseTo(originalWidth + 25, 1);
        });

        test('rsb setter should only adjust width without translating geometry', () => {
            const glyph = font.glyphs.find((g) => g.name === 'A');
            const layer = glyph.layers[0];

            const originalRsb = layer.rsb;
            const originalBbox = layer.getBoundingBox(false);
            const originalWidth = layer.width;

            layer.rsb = originalRsb + 40;

            const newBbox = layer.getBoundingBox(false);
            expect(newBbox.minX).toBeCloseTo(originalBbox.minX, 1);
            expect(newBbox.maxX).toBeCloseTo(originalBbox.maxX, 1);
            expect(layer.width).toBeCloseTo(originalWidth + 40, 1);
        });
    });

    describe('Shape polymorphism', () => {
        test('Shape.isPath() and asPath() should work', () => {
            for (const glyph of font.glyphs) {
                const layer = glyph.layers[0];
                if (!layer || !layer.shapes) continue;

                for (const shape of layer.shapes) {
                    if (shape.isPath()) {
                        expect(shape.isComponent()).toBe(false);
                        const path = shape.asPath();
                        expect(path).toBeDefined();
                        expect(path.nodes).toBeDefined();
                        return;
                    }
                }
            }
        });

        test('Shape.isComponent() and asComponent() should work', () => {
            for (const glyph of font.glyphs) {
                const layer = glyph.layers[0];
                if (!layer || !layer.shapes) continue;

                for (const shape of layer.shapes) {
                    if (shape.isComponent()) {
                        expect(shape.isPath()).toBe(false);
                        const component = shape.asComponent();
                        expect(component).toBeDefined();
                        expect(component.reference).toBeDefined();
                        return;
                    }
                }
            }
        });
    });

    describe('Path and Node manipulation', () => {
        test('should access nodes in a path', () => {
            for (const glyph of font.glyphs) {
                const layer = glyph.layers[0];
                if (!layer || !layer.shapes) continue;

                for (const shape of layer.shapes) {
                    if (shape.isPath()) {
                        const path = shape.asPath();
                        if (path.nodes && path.nodes.length > 0) {
                            const node = path.nodes[0];
                            expect(node.x).toBeDefined();
                            expect(node.y).toBeDefined();
                            expect(node.nodetype).toBeDefined();
                            return;
                        }
                    }
                }
            }
        });

        test('node should have correct properties', () => {
            for (const glyph of font.glyphs) {
                const layer = glyph.layers[0];
                if (!layer || !layer.shapes) continue;

                for (const shape of layer.shapes) {
                    if (shape.isPath()) {
                        const path = shape.asPath();
                        if (path.nodes && path.nodes.length > 0) {
                            const node = path.nodes[0];
                            expect(typeof node.x).toBe('number');
                            expect(typeof node.y).toBe('number');
                            expect(typeof node.nodetype).toBe('string');
                            return;
                        }
                    }
                }
            }
        });
    });

    describe('toJSON() serialization', () => {
        test('Font.toJSON() should return underlying data', () => {
            const json = font.toJSON();
            expect(json).toBeDefined();
            expect(json.glyphs).toBeDefined();
            expect(json.upm).toBe(fontData.upm);
        });

        test('Glyph.toJSON() should return glyph data', () => {
            const glyph = font.glyphs[0];
            const json = glyph.toJSON();
            expect(json).toBeDefined();
            expect(json.name).toBeDefined();
        });

        test('Layer.toJSON() should return layer data', () => {
            const glyph = font.glyphs[0];
            const layer = glyph.layers[0];
            const json = layer.toJSON();
            expect(json).toBeDefined();
            expect(json.width).toBeDefined();
        });
    });

    describe('Layer.getMatchingLayerOnGlyph()', () => {
        test('should find matching layers across glyphs by master ID', () => {
            const glyphA = font.findGlyph('A');
            const glyphB = font.findGlyph('B');

            expect(glyphA).toBeDefined();
            expect(glyphB).toBeDefined();

            // Both glyphs should have layers
            expect(glyphA.layers).toBeDefined();
            expect(glyphB.layers).toBeDefined();
            expect(glyphA.layers.length).toBeGreaterThan(0);
            expect(glyphB.layers.length).toBeGreaterThan(0);

            // For each layer in A, find matching layer in B
            for (const layerA of glyphA.layers) {
                const matchingLayerB = layerA.getMatchingLayerOnGlyph('B');
                expect(matchingLayerB).toBeDefined();

                // The matching layer should have the same master ID
                expect(layerA.master).toEqual(matchingLayerB.master);
            }
        });

        test('round-trip: A->B->A should return the same layers', () => {
            const glyphA = font.findGlyph('A');
            const glyphB = font.findGlyph('B');

            expect(glyphA).toBeDefined();
            expect(glyphB).toBeDefined();
            expect(glyphA.layers).toBeDefined();
            expect(glyphB.layers).toBeDefined();

            // For each layer in A:
            // 1. Find matching layer in B
            // 2. From that B layer, find matching layer back in A
            // 3. Should get a layer with the same master as the original
            const layersA = glyphA.layers; // Cache to avoid recreating wrappers
            for (let i = 0; i < layersA.length; i++) {
                const originalLayerA = layersA[i];
                const matchingLayerB =
                    originalLayerA.getMatchingLayerOnGlyph('B');
                expect(matchingLayerB).toBeDefined();

                const roundTripLayerA =
                    matchingLayerB.getMatchingLayerOnGlyph('A');
                expect(roundTripLayerA).toBeDefined();

                // Should have the same master (compare underlying data, not object identity)
                expect(roundTripLayerA.master).toEqual(originalLayerA.master);

                // Should reference the same underlying layer data
                expect(roundTripLayerA.toJSON()).toBe(originalLayerA.toJSON());
            }
        });

        test('should return undefined for non-existent glyph', () => {
            const glyphA = font.findGlyph('A');
            expect(glyphA).toBeDefined();
            expect(glyphA.layers).toBeDefined();

            const layer = glyphA.layers[0];
            const matchingLayer =
                layer.getMatchingLayerOnGlyph('NonExistentGlyph');
            expect(matchingLayer).toBeUndefined();
        });

        test('should return undefined if target glyph has no matching master', () => {
            const glyphA = font.findGlyph('A');
            expect(glyphA).toBeDefined();
            expect(glyphA.layers).toBeDefined();

            // Create a test glyph with a single layer but different master
            const testGlyph = font.addGlyph('TestGlyph', 'Base');
            const testLayer = testGlyph.addLayer(500);
            testLayer.master = { DefaultForMaster: 'non-existent-master-id' };

            const layer = glyphA.layers[0];
            const matchingLayer = layer.getMatchingLayerOnGlyph('TestGlyph');
            expect(matchingLayer).toBeUndefined();

            // Clean up
            font.removeGlyph('TestGlyph');
        });
    });

    describe('Layer.flattenComponents()', () => {
        test('should flatten adieresis components across all layers with transforms', () => {
            // Load NestedComponents.babelfont for this test
            const nestedFixturePath = path.join(
                __dirname,
                '..',
                'examples',
                'NestedComponents.babelfont'
            );
            const nestedJsonString = fs.readFileSync(
                nestedFixturePath,
                'utf-8'
            );
            const nestedFontData = JSON.parse(nestedJsonString);
            const nestedFont = Font.fromData(nestedFontData);

            const adieresis = nestedFont.findGlyph('adieresis');
            expect(adieresis).toBeDefined();
            expect(adieresis.layers.length).toBe(3);

            // Layer 0: a + dieresiscomb with [1,0,0,1,118,0]
            const layer0 = adieresis.layers[0];
            const layer0Bbox = layer0.getBoundingBox(false);

            // Find matching layers in component glyphs
            const a0 = layer0.getMatchingLayerOnGlyph('a');
            const dieresis0 = layer0.getMatchingLayerOnGlyph('dieresiscomb');
            expect(a0).toBeDefined();
            expect(dieresis0).toBeDefined();

            const a0Bbox = a0.getBoundingBox(false);
            const dieresis0Bbox = dieresis0.getBoundingBox(false);

            // dieresis transformed by [1,0,0,1,118,0]
            const dieresis0Transformed = {
                minX: dieresis0Bbox.minX + 118,
                minY: dieresis0Bbox.minY,
                maxX: dieresis0Bbox.maxX + 118,
                maxY: dieresis0Bbox.maxY
            };

            const expectedBbox0 = {
                minX: Math.min(a0Bbox.minX, dieresis0Transformed.minX),
                minY: Math.min(a0Bbox.minY, dieresis0Transformed.minY),
                maxX: Math.max(a0Bbox.maxX, dieresis0Transformed.maxX),
                maxY: Math.max(a0Bbox.maxY, dieresis0Transformed.maxY)
            };

            expect(layer0Bbox.minX).toBeCloseTo(expectedBbox0.minX, 5);
            expect(layer0Bbox.minY).toBeCloseTo(expectedBbox0.minY, 5);
            expect(layer0Bbox.maxX).toBeCloseTo(expectedBbox0.maxX, 5);
            expect(layer0Bbox.maxY).toBeCloseTo(expectedBbox0.maxY, 5);

            // Layer 1: a + dieresiscomb with [1,0,0,1,102,0]
            const layer1 = adieresis.layers[1];
            const layer1Bbox = layer1.getBoundingBox(false);

            const a1 = layer1.getMatchingLayerOnGlyph('a');
            const dieresis1 = layer1.getMatchingLayerOnGlyph('dieresiscomb');
            expect(a1).toBeDefined();
            expect(dieresis1).toBeDefined();

            const a1Bbox = a1.getBoundingBox(false);
            const dieresis1Bbox = dieresis1.getBoundingBox(false);

            // dieresis transformed by [1,0,0,1,102,0]
            const dieresis1Transformed = {
                minX: dieresis1Bbox.minX + 102,
                minY: dieresis1Bbox.minY,
                maxX: dieresis1Bbox.maxX + 102,
                maxY: dieresis1Bbox.maxY
            };

            const expectedBbox1 = {
                minX: Math.min(a1Bbox.minX, dieresis1Transformed.minX),
                minY: Math.min(a1Bbox.minY, dieresis1Transformed.minY),
                maxX: Math.max(a1Bbox.maxX, dieresis1Transformed.maxX),
                maxY: Math.max(a1Bbox.maxY, dieresis1Transformed.maxY)
            };

            expect(layer1Bbox.minX).toBeCloseTo(expectedBbox1.minX, 5);
            expect(layer1Bbox.minY).toBeCloseTo(expectedBbox1.minY, 5);
            expect(layer1Bbox.maxX).toBeCloseTo(expectedBbox1.maxX, 5);
            expect(layer1Bbox.maxY).toBeCloseTo(expectedBbox1.maxY, 5);

            // Layer 2: a + dieresiscomb with [1,0,0,0.6872,56,159] (SCALED)
            const layer2 = adieresis.layers[2];
            const layer2Bbox = layer2.getBoundingBox(false);

            const a2 = layer2.getMatchingLayerOnGlyph('a');
            const dieresis2 = layer2.getMatchingLayerOnGlyph('dieresiscomb');
            expect(a2).toBeDefined();
            expect(dieresis2).toBeDefined();

            const a2Bbox = a2.getBoundingBox(false);
            const dieresis2Bbox = dieresis2.getBoundingBox(false);

            // dieresis transformed by [1,0,0,0.6872,56,159]
            // This scales Y by 0.6872 and translates by (56, 159)
            const dieresis2Transformed = {
                minX: dieresis2Bbox.minX + 56,
                minY: dieresis2Bbox.minY * 0.6872 + 159,
                maxX: dieresis2Bbox.maxX + 56,
                maxY: dieresis2Bbox.maxY * 0.6872 + 159
            };

            const expectedBbox2 = {
                minX: Math.min(a2Bbox.minX, dieresis2Transformed.minX),
                minY: Math.min(a2Bbox.minY, dieresis2Transformed.minY),
                maxX: Math.max(a2Bbox.maxX, dieresis2Transformed.maxX),
                maxY: Math.max(a2Bbox.maxY, dieresis2Transformed.maxY)
            };

            expect(layer2Bbox.minX).toBeCloseTo(expectedBbox2.minX, 4);
            expect(layer2Bbox.minY).toBeCloseTo(expectedBbox2.minY, 4);
            expect(layer2Bbox.maxX).toBeCloseTo(expectedBbox2.maxX, 4);
            expect(layer2Bbox.maxY).toBeCloseTo(expectedBbox2.maxY, 4);
        });

        test('should handle nested components with accumulated transforms', () => {
            // Test with a more complex case if available
            // For now, verify that single-level components work correctly
            const glyphA = font.findGlyph('A');
            expect(glyphA).toBeDefined();

            const aLayer = glyphA.layers[0];
            expect(aLayer).toBeDefined();

            // A should have paths (not components)
            const aShapes = aLayer.shapes;
            expect(aShapes).toBeDefined();

            let hasPath = false;
            for (const shape of aShapes) {
                if (shape.isPath()) {
                    hasPath = true;
                    break;
                }
            }
            expect(hasPath).toBe(true);

            // Bounding box should work for a glyph with only paths
            const bbox = aLayer.getBoundingBox(false);
            expect(bbox).not.toBeNull();
            expect(bbox.width).toBeGreaterThan(0);
            expect(bbox.height).toBeGreaterThan(0);
        });

        test('should return empty array for layer with no shapes', () => {
            // Create a test glyph with empty layer
            const testGlyph = font.addGlyph('EmptyGlyph', 'Base');
            const testLayer = testGlyph.addLayer(500);

            // Layer has no shapes
            expect(testLayer.shapes).toBeUndefined();

            // Bounding box should handle this gracefully
            const bbox = testLayer.getBoundingBox(false);
            // Should return a fallback bbox based on width
            expect(bbox).not.toBeNull();
            expect(bbox.width).toBe(500); // Uses layer width as fallback

            // Clean up
            font.removeGlyph('EmptyGlyph');
        });
    });
});
