jest.mock('../js/logger', () => ({
    Logger: class {
        log() {}
        warn() {}
        error() {}
    }
}));

const {
    DrawingDataNormalizer: DrawingDataNormalizer
} = require('../js/drawing-data-normalizer');

describe('DrawingDataNormalizer', () => {
    test('preserves missing layer width instead of synthesizing zero', () => {
        const normalized = DrawingDataNormalizer.normalize({ shapes: [] });

        expect(normalized).not.toHaveProperty('width');
    });

    test('preserves explicit zero layer width', () => {
        const normalized = DrawingDataNormalizer.normalize({
            width: 0,
            shapes: []
        });

        expect(normalized.width).toBe(0);
    });
});
