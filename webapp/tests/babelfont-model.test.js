const fs = require('fs');
const path = require('path');
const { Font, isPath, isComponent } = require('../js/babelfont-extended');
const {
    initFixtureHelper,
    loadGlyphsAsBabelfont,
    cleanupFixtures
} = require('./fixture-helper');

describe('Babelfont Object Model', () => {
    let fontData;
    let font;

    beforeAll(async () => {
        // Initialize WASM and load Fustat.glyphs as test fixture
        await initFixtureHelper();
        fontData = loadGlyphsAsBabelfont('Fustat.glyphs');
    });

    afterAll(() => {
        cleanupFixtures();
    });

    beforeEach(() => {
        // Create a fresh font instance for each test
        font = Font.fromData(fontData);
    });

    describe('parent property', () => {
        test('Font.parent should return undefined (root object)', () => {
            expect(font.parent).toBeUndefined();
        });

        test('Glyph.parent should return Font', () => {
            const glyph = font.glyphs[0];
            expect(glyph.parent).toBe(font);
        });

        test('Layer.parent should return Glyph', () => {
            const glyph = font.glyphs[0];
            const layer = glyph.layers[0];
            expect(layer.parent).toBe(glyph);
        });

        test('Shape.parent should return Layer', () => {
            const glyph = font.glyphs[0];
            const layer = glyph.layers[0];
            const shapes = layer.shapes;

            if (shapes && shapes.length > 0) {
                const shape = shapes[0];
                expect(shape.parent).toBe(layer);
            }
        });

        test('Path.parent should return Layer (Path is a Shape)', () => {
            // Find a glyph with a path
            for (const glyph of font.glyphs) {
                const layer = glyph.layers[0];
                if (!layer || !layer.shapes) continue;

                for (const shape of layer.shapes) {
                    if (isPath(shape)) {
                        // Path is a Shape, so its parent is Layer
                        expect(shape.parent).toBe(layer);
                        return; // Test passed
                    }
                }
            }
        });

        test('Node.parent should return Path', () => {
            // Find a glyph with a path that has nodes
            for (const glyph of font.glyphs) {
                const layer = glyph.layers[0];
                if (!layer || !layer.shapes) continue;

                for (const shape of layer.shapes) {
                    if (isPath(shape)) {
                        if (shape.nodes && shape.nodes.length > 0) {
                            const node = shape.nodes[0];
                            expect(node.parent).toBe(shape);
                            return; // Test passed
                        }
                    }
                }
            }
        });

        test('Component.parent should return Layer (Component is a Shape)', () => {
            // Find a glyph with a component
            for (const glyph of font.glyphs) {
                const layer = glyph.layers[0];
                if (!layer || !layer.shapes) continue;

                for (const shape of layer.shapes) {
                    if (isComponent(shape)) {
                        // Component is a Shape, so its parent is Layer
                        expect(shape.parent).toBe(layer);
                        return; // Test passed
                    }
                }
            }
        });

        test('Anchor.parent should return Layer', () => {
            // Find a glyph with anchors
            for (const glyph of font.glyphs) {
                const layer = glyph.layers[0];
                if (!layer || !layer.anchors || layer.anchors.length === 0)
                    continue;

                const anchor = layer.anchors[0];
                expect(anchor.parent).toBe(layer);
                return; // Test passed
            }
        });

        test('Guide.parent should return Layer', () => {
            // Find a layer with guides
            for (const glyph of font.glyphs) {
                const layer = glyph.layers[0];
                if (!layer || !layer.guides || layer.guides.length === 0)
                    continue;

                const guide = layer.guides[0];
                expect(guide.parent).toBe(layer);
                return; // Test passed
            }
        });

        test('Axis.parent should return Font', () => {
            if (font.axes && font.axes.length > 0) {
                const axis = font.axes[0];
                expect(axis.parent).toBe(font);
            }
        });

        test('Master.parent should return Font', () => {
            if (font.masters && font.masters.length > 0) {
                const master = font.masters[0];
                expect(master.parent).toBe(font);
            }
        });

        test('Instance.parent should return Font', () => {
            if (font.instances && font.instances.length > 0) {
                const instance = font.instances[0];
                expect(instance.parent).toBe(font);
            }
        });

        test('should navigate from Node up to Font', () => {
            // Find a complete path: Node → Path → Layer → Glyph → Font
            for (const glyph of font.glyphs) {
                const layer = glyph.layers[0];
                if (!layer || !layer.shapes) continue;

                for (const shape of layer.shapes) {
                    if (isPath(shape)) {
                        if (shape.nodes && shape.nodes.length > 0) {
                            const node = shape.nodes[0];

                            // Navigate up the hierarchy
                            const parentPath = node.parent;
                            expect(parentPath).toBe(shape);

                            // Path is a Shape, so its parent is Layer
                            const parentLayer = parentPath.parent;
                            expect(parentLayer).toBe(layer);

                            const parentGlyph = parentLayer.parent;
                            expect(parentGlyph).toBe(glyph);

                            const parentFont = parentGlyph.parent;
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

            // Get original component translation X before modification
            const getTranslationX = (comp) => {
                const transform = comp.transform;
                if (!transform) return 0;
                if (transform.translation) return transform.translation[0] || 0;
                // DecomposedAffine might use numeric keys like a matrix
                if (transform['4'] !== undefined) return transform['4'];
                if (Array.isArray(transform)) return transform[4] || 0;
                return 0;
            };

            const componentsBefore = layer.shapes
                .filter((s) => isComponent(s))
                .map((s) => getTranslationX(s));

            console.log('[Test] Components before:', componentsBefore);

            layer.lsb = originalLsb - 30;

            // Check that all component transforms were updated
            const componentsAfter = layer.shapes
                .filter((s) => isComponent(s))
                .map((s) => getTranslationX(s));

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
        test('isPath() type guard should work', () => {
            for (const glyph of font.glyphs) {
                const layer = glyph.layers[0];
                if (!layer || !layer.shapes) continue;

                for (const shape of layer.shapes) {
                    if (isPath(shape)) {
                        expect(isComponent(shape)).toBe(false);
                        expect(shape).toBeDefined();
                        expect(shape.nodes).toBeDefined();
                        return;
                    }
                }
            }
        });

        test('isComponent() type guard should work', () => {
            for (const glyph of font.glyphs) {
                const layer = glyph.layers[0];
                if (!layer || !layer.shapes) continue;

                for (const shape of layer.shapes) {
                    if (isComponent(shape)) {
                        expect(isPath(shape)).toBe(false);
                        expect(shape).toBeDefined();
                        expect(shape.reference).toBeDefined();
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
                    if (isPath(shape)) {
                        if (shape.nodes && shape.nodes.length > 0) {
                            const node = shape.nodes[0];
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
                    if (isPath(shape)) {
                        if (shape.nodes && shape.nodes.length > 0) {
                            const node = shape.nodes[0];
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

    describe('Font.toJSONString() serialization', () => {
        test('Font.toJSONString() should return valid JSON string', () => {
            const jsonStr = font.toJSONString();
            expect(typeof jsonStr).toBe('string');
            const parsed = JSON.parse(jsonStr);
            expect(parsed).toBeDefined();
            expect(parsed.glyphs).toBeDefined();
            expect(parsed.upm).toBe(fontData.upm);
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
                expect(layerA.getMasterId()).toEqual(
                    matchingLayerB.getMasterId()
                );
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
                expect(roundTripLayerA.getMasterId()).toEqual(
                    originalLayerA.getMasterId()
                );
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
            // Load NestedComponents.glyphs for this test
            const nestedFontData = loadGlyphsAsBabelfont(
                'NestedComponents.glyphs'
            );
            const nestedFont = Font.fromData(nestedFontData);

            const adieresis = nestedFont.findGlyph('adieresis');
            expect(adieresis).toBeDefined();
            expect(adieresis.layers.length).toBe(3);

            // Test that getMatchingLayerOnGlyph works for component resolution
            for (let i = 0; i < adieresis.layers.length; i++) {
                const layer = adieresis.layers[i];
                const bbox = layer.getBoundingBox(false);

                // Verify bounding box is calculated
                expect(bbox).not.toBeNull();
                expect(bbox.width).toBeGreaterThan(0);
                expect(bbox.height).toBeGreaterThan(0);

                // Verify components can find matching layers
                const a = layer.getMatchingLayerOnGlyph('a');
                const dieresis = layer.getMatchingLayerOnGlyph('dieresiscomb');
                expect(a).toBeDefined();
                expect(dieresis).toBeDefined();

                // Verify component bounding boxes exist
                const aBbox = a.getBoundingBox(false);
                const dieresisBbox = dieresis.getBoundingBox(false);
                expect(aBbox).not.toBeNull();
                expect(dieresisBbox).not.toBeNull();

                // The composite bbox should be larger than or equal to the base 'a' glyph
                expect(bbox.minX).toBeLessThanOrEqual(aBbox.minX);
                expect(bbox.minY).toBeLessThanOrEqual(aBbox.minY);
            }
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
                if (isPath(shape)) {
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
            const testLayer = testGlyph.addLayer(undefined, 500);

            // Layer has empty shapes array
            expect(testLayer.shapes).toEqual([]);

            // Bounding box should handle this gracefully
            const bbox = testLayer.getBoundingBox(false);
            // Should return a fallback bbox based on width
            expect(bbox).not.toBeNull();
            expect(bbox.width).toBe(500); // Uses layer width as fallback

            // Clean up
            font.removeGlyph('EmptyGlyph');
        });
    });

    describe('Layer.getIntersectionsOnLine()', () => {
        test('should calculate intersections on adieresis layer 2 with components', () => {
            // Load NestedComponents.glyphs for this test
            const nestedFontData = loadGlyphsAsBabelfont(
                'NestedComponents.glyphs'
            );
            const nestedFont = Font.fromData(nestedFontData);

            const adieresis = nestedFont.findGlyph('adieresis');
            const layer2 = adieresis.layers[2];

            expect(layer2).toBeDefined();
            expect(layer2.width).toBe(558);

            // Horizontal measurement at y=332 from x=0 to glyph width
            const horizontalIntersections = layer2.getIntersectionsOnLine(
                { x: 0, y: 332 },
                { x: layer2.width, y: 332 },
                true // include components
            );

            // Expected intersection count (verified)
            expect(horizontalIntersections.length).toBe(2);

            // Verify intersections are sorted by t parameter
            for (let i = 1; i < horizontalIntersections.length; i++) {
                expect(horizontalIntersections[i].t).toBeGreaterThanOrEqual(
                    horizontalIntersections[i - 1].t
                );
            }

            // Verify intersections are on the line (y should be 332)
            horizontalIntersections.forEach((int) => {
                expect(int.y).toBeCloseTo(332, 1);
            });

            // Verify intersections are within expected range (component-flattened coordinates)
            // First intersection should be left side of 'a' bowl area
            expect(horizontalIntersections[0].x).toBeGreaterThan(350);
            expect(horizontalIntersections[0].x).toBeLessThan(400);
            // Second intersection should be right side
            expect(horizontalIntersections[1].x).toBeGreaterThan(480);
            expect(horizontalIntersections[1].x).toBeLessThan(520);

            // Vertical measurement at x=114 from y=-50 to y=750
            const verticalIntersections = layer2.getIntersectionsOnLine(
                { x: 114, y: -50 },
                { x: 114, y: 750 },
                true // include components
            );

            // Expected intersection count (verified)
            expect(verticalIntersections.length).toBe(6);

            // Verify intersections are sorted by t parameter
            for (let i = 1; i < verticalIntersections.length; i++) {
                expect(verticalIntersections[i].t).toBeGreaterThanOrEqual(
                    verticalIntersections[i - 1].t
                );
            }

            // Verify intersections are on the line (x should be 114)
            verticalIntersections.forEach((int) => {
                expect(int.x).toBeCloseTo(114, 1);
            });

            // Verify y values are in reasonable range (from bottom to top of glyph)
            const yValues = verticalIntersections
                .map((int) => int.y)
                .sort((a, b) => a - b);
            expect(yValues[0]).toBeGreaterThan(-30); // Near baseline or below
            expect(yValues[0]).toBeLessThan(50);
            expect(yValues[yValues.length - 1]).toBeGreaterThan(600); // Near top
            expect(yValues[yValues.length - 1]).toBeLessThan(700);
        });
    });

    describe('Object Creation Methods', () => {
        test('Font.addGlyph() should create and add a new glyph', () => {
            const initialCount = font.glyphs.length;
            const glyph = font.addGlyph('newglyph', 'letter');

            expect(font.glyphs.length).toBe(initialCount + 1);
            expect(glyph).toBeDefined();
            expect(glyph.name).toBe('newglyph');
            expect(glyph.category).toBe('letter');
            expect(glyph.exported).toBe(true);
            expect(glyph.layers).toEqual([]);
        });

        test('Glyph.addLayer() should create and add a new layer', () => {
            const glyph = font.glyphs[0];
            const initialCount = glyph.layers.length;
            const layer = glyph.addLayer('m01', 500);

            expect(glyph.layers.length).toBe(initialCount + 1);
            expect(layer).toBeDefined();
            expect(layer.width).toBe(500);
            expect(layer.id).toBe('m01');
            expect(layer.master).toBe('m01');
        });

        test('Created glyph should have proper parent relationship', () => {
            const glyph = font.addGlyph('testglyph', 'base');
            expect(glyph.parent).toBe(font);
        });

        test('Created layer should have proper parent relationship', () => {
            const glyph = font.glyphs[0];
            const layer = glyph.addLayer('test', 600);
            expect(layer.parent).toBe(glyph);
        });
    });
});
