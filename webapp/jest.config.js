module.exports = {
    testEnvironment: 'jest-environment-jsdom',
    setupFilesAfterEnv: ['jest-canvas-mock', '<rootDir>/tests/setup.js'],
    transform: {
        '^.+\\.(ts|tsx|js|jsx)': 'babel-jest'
    },
    testMatch: ['**/*.test.js'], // Only run .test.js files, exclude Playwright .spec.ts files
    moduleNameMapper: {
        // Mock WASM modules since they can't be loaded in Jest environment
        '^.+\\.wasm$': '<rootDir>/tests/__mocks__/wasmMock.js',
        '^../wasm-dist/babelfont_fontc_web$':
            '<rootDir>/tests/__mocks__/babelfontWasmMock.js',
        '^\\.\\.\/wasm-dist\/babelfont_fontc_web$':
            '<rootDir>/tests/__mocks__/babelfontWasmMock.js',
        '^\\.\\.\/\\.\\.\\/wasm-dist\/babelfont_fontc_web$':
            '<rootDir>/tests/__mocks__/babelfontWasmMock.js'
    }
};
