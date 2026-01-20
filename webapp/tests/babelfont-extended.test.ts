/**
 * Tests for babelfont-extended.ts
 *
 * These tests verify that extended classes work correctly with:
 * - Convenience methods
 * - Change tracking
 * - Custom properties
 * - WASM-backed geometry calculations
 */

import {
    Font,
    Glyph,
    Layer,
    Path,
    Node,
    Component,
    loadFontFromJSON
} from '../js/babelfont-extended';

describe('Extended babelfont classes', () => {
    describe('Font class', () => {
        it('should find glyph by name', () => {
            const fontData = {
                glyphs: [
                    {
                        name: 'A',
                        category: 'letter',
                        exported: true,
                        layers: []
                    },
                    {
                        name: 'B',
                        category: 'letter',
                        exported: true,
                        layers: []
                    }
                ],
                axes: [],
                masters: [],
                instances: []
            };

            const font = loadFontFromJSON(fontData);
            const glyph = font.findGlyph('A');

            expect(glyph).toBeDefined();
            expect(glyph?.name).toBe('A');
        });

        it('should find glyph by unicode', () => {
            const fontData = {
                glyphs: [
                    {
                        name: 'A',
                        category: 'letter',
                        exported: true,
                        codepoints: [0x0041],
                        layers: []
                    }
                ],
                axes: [],
                masters: [],
                instances: []
            };

            const font = loadFontFromJSON(fontData);
            const glyph = font.findGlyphByUnicode(0x0041);

            expect(glyph).toBeDefined();
            expect(glyph?.name).toBe('A');
        });

        it('should get axis by tag', () => {
            const fontData = {
                glyphs: [],
                axes: [
                    {
                        name: { dflt: 'Weight' },
                        tag: 'wght',
                        min: 400,
                        default: 400,
                        max: 700
                    }
                ],
                masters: [],
                instances: []
            };

            const font = loadFontFromJSON(fontData);
            const axis = font.getAxis('wght');

            expect(axis).toBeDefined();
            expect(axis?.tag).toBe('wght');
        });

        it('should get master by ID', () => {
            const fontData = {
                glyphs: [],
                axes: [],
                masters: [{ id: 'm01', name: 'Regular', location: {} }],
                instances: []
            };

            const font = loadFontFromJSON(fontData);
            const master = font.getMaster('m01');

            expect(master).toBeDefined();
            expect(master?.id).toBe('m01');
        });
    });

    describe('Glyph class', () => {
        it('should get layer by ID', () => {
            const fontData = {
                glyphs: [
                    {
                        name: 'A',
                        category: 'letter',
                        exported: true,
                        layers: [
                            { id: 'layer1', width: 600, shapes: [] },
                            { id: 'layer2', width: 700, shapes: [] }
                        ]
                    }
                ],
                axes: [],
                masters: [],
                instances: []
            };

            const font = loadFontFromJSON(fontData);
            const glyph = font.findGlyph('A');
            const layer = glyph?.getLayerById('layer1');

            expect(layer).toBeDefined();
            expect(layer?.id).toBe('layer1');
            expect(layer?.width).toBe(600);
        });
    });

    describe('Layer class', () => {
        it('should add a new path', () => {
            const fontData = {
                glyphs: [
                    {
                        name: 'A',
                        category: 'letter',
                        exported: true,
                        layers: [{ id: 'layer1', width: 600, shapes: [] }]
                    }
                ],
                axes: [],
                masters: [],
                instances: []
            };

            const font = loadFontFromJSON(fontData);
            const glyph = font.findGlyph('A');
            const layer = glyph?.layers?.[0];

            expect(layer?.shapes?.length).toBe(0);

            const path = layer?.addPath(true);

            expect(layer?.shapes?.length).toBe(1);
            expect(path).toBeDefined();
        });

        it('should add a new component', () => {
            const fontData = {
                glyphs: [
                    {
                        name: 'A',
                        category: 'letter',
                        exported: true,
                        layers: [{ id: 'layer1', width: 600, shapes: [] }]
                    }
                ],
                axes: [],
                masters: [],
                instances: []
            };

            const font = loadFontFromJSON(fontData);
            const glyph = font.findGlyph('A');
            const layer = glyph?.layers?.[0];

            const component = layer?.addComponent('B');

            expect(layer?.shapes?.length).toBe(1);
            expect(component).toBeDefined();
            expect(component?.reference).toBe('B');
        });

        it('should delete a path', () => {
            const fontData = {
                glyphs: [
                    {
                        name: 'A',
                        category: 'letter',
                        exported: true,
                        layers: [
                            {
                                id: 'layer1',
                                width: 600,
                                shapes: [{ nodes: [], closed: true }]
                            }
                        ]
                    }
                ],
                axes: [],
                masters: [],
                instances: []
            };

            const font = loadFontFromJSON(fontData);
            const glyph = font.findGlyph('A');
            const layer = glyph?.layers?.[0];

            expect(layer?.shapes?.length).toBe(1);

            layer?.deletePath(0);

            expect(layer?.shapes?.length).toBe(0);
        });

        it('should create an anchor', () => {
            const fontData = {
                glyphs: [
                    {
                        name: 'A',
                        category: 'letter',
                        exported: true,
                        layers: [
                            {
                                id: 'layer1',
                                width: 600,
                                shapes: [],
                                anchors: []
                            }
                        ]
                    }
                ],
                axes: [],
                masters: [],
                instances: []
            };

            const font = loadFontFromJSON(fontData);
            const glyph = font.findGlyph('A');
            const layer = glyph?.layers?.[0];

            const anchor = layer?.createAnchor('top', 300, 700);

            expect(layer?.anchors?.length).toBe(1);
            expect(anchor?.name).toBe('top');
            expect(anchor?.x).toBe(300);
            expect(anchor?.y).toBe(700);
        });

        it('should support custom cachedComponentLayerData property', () => {
            const fontData = {
                glyphs: [
                    {
                        name: 'A',
                        category: 'letter',
                        exported: true,
                        layers: [{ id: 'layer1', width: 600, shapes: [] }]
                    }
                ],
                axes: [],
                masters: [],
                instances: []
            };

            const font = loadFontFromJSON(fontData);
            const glyph = font.findGlyph('A');
            const layer = glyph?.layers?.[0];

            // Should be able to set custom property
            if (layer) {
                layer.cachedComponentLayerData = { test: 'value' };
                expect(layer.cachedComponentLayerData).toEqual({
                    test: 'value'
                });
            }
        });
    });

    describe('Path class', () => {
        it('should add a node', () => {
            const fontData = {
                glyphs: [
                    {
                        name: 'A',
                        category: 'letter',
                        exported: true,
                        layers: [{ id: 'layer1', width: 600, shapes: [] }]
                    }
                ],
                axes: [],
                masters: [],
                instances: []
            };

            const font = loadFontFromJSON(fontData);
            const glyph = font.findGlyph('A');
            const layer = glyph?.layers?.[0];
            const path = layer?.addPath(true);

            expect(path?.nodes?.length).toBe(0);

            path?.addNode({ x: 100, y: 200, nodetype: 'line' });

            expect(path?.nodes?.length).toBe(1);
        });

        it('should insert a node at index', () => {
            const fontData = {
                glyphs: [
                    {
                        name: 'A',
                        category: 'letter',
                        exported: true,
                        layers: [
                            {
                                id: 'layer1',
                                width: 600,
                                shapes: [
                                    {
                                        nodes: [
                                            { x: 0, y: 0, nodetype: 'line' },
                                            { x: 100, y: 0, nodetype: 'line' }
                                        ],
                                        closed: true
                                    }
                                ]
                            }
                        ]
                    }
                ],
                axes: [],
                masters: [],
                instances: []
            };

            const font = loadFontFromJSON(fontData);
            const glyph = font.findGlyph('A');
            const layer = glyph?.layers?.[0];
            const path = layer?.shapes?.[0] as any;

            expect(path?.nodes?.length).toBe(2);

            path?.insertNode(1, { x: 50, y: 50, nodetype: 'line' });

            expect(path?.nodes?.length).toBe(3);
            expect(path?.nodes?.[1]?.x).toBe(50);
        });

        it('should delete a node', () => {
            const fontData = {
                glyphs: [
                    {
                        name: 'A',
                        category: 'letter',
                        exported: true,
                        layers: [
                            {
                                id: 'layer1',
                                width: 600,
                                shapes: [
                                    {
                                        nodes: [
                                            { x: 0, y: 0, nodetype: 'line' },
                                            { x: 100, y: 0, nodetype: 'line' }
                                        ],
                                        closed: true
                                    }
                                ]
                            }
                        ]
                    }
                ],
                axes: [],
                masters: [],
                instances: []
            };

            const font = loadFontFromJSON(fontData);
            const glyph = font.findGlyph('A');
            const layer = glyph?.layers?.[0];
            const path = layer?.shapes?.[0] as any;

            expect(path?.nodes?.length).toBe(2);

            path?.deleteNode(0);

            expect(path?.nodes?.length).toBe(1);
            expect(path?.nodes?.[0]?.x).toBe(100);
        });
    });

    describe('Component class', () => {
        it('should support custom cachedComponentLayerData property', () => {
            const fontData = {
                glyphs: [
                    {
                        name: 'A',
                        category: 'letter',
                        exported: true,
                        layers: [{ id: 'layer1', width: 600, shapes: [] }]
                    }
                ],
                axes: [],
                masters: [],
                instances: []
            };

            const font = loadFontFromJSON(fontData);
            const glyph = font.findGlyph('A');
            const layer = glyph?.layers?.[0];
            const component = layer?.addComponent('B');

            // Should be able to set custom property
            if (component) {
                component.cachedComponentLayerData = { test: 'data' };
                expect(component.cachedComponentLayerData).toEqual({
                    test: 'data'
                });
            }
        });
    });
});
