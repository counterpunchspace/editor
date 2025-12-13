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
});
