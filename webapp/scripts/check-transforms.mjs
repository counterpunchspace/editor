import {
    initFixtureHelper,
    loadGlyphsAsBabelfont,
    cleanupFixtures
} from '../tests/fixture-helper.js';
import { Font } from '../js/babelfont-extended.ts';

async function main() {
    await initFixtureHelper();
    const fontData = loadGlyphsAsBabelfont('NestedComponents.glyphs');
    const font = Font.fromData(fontData);
    const adieresis = font.findGlyph('adieresis');
    console.log('adieresis layers:', adieresis.layers.length);
    for (let i = 0; i < adieresis.layers.length; i++) {
        const layer = adieresis.layers[i];
        console.log('Layer', i, 'masterId:', layer.getMasterId());
        console.log('  shapes:', layer.shapes?.length);
        if (layer.shapes) {
            for (let j = 0; j < layer.shapes.length; j++) {
                const shape = layer.shapes[j];
                if (shape.reference) {
                    console.log(
                        '    Component:',
                        shape.reference,
                        'transform:',
                        shape.transform?.translation
                    );
                }
            }
        }
    }
    cleanupFixtures();
}
main().catch(console.error);
