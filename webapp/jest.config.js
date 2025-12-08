module.exports = {
    testEnvironment: 'jest-environment-jsdom',
    setupFilesAfterEnv: ['jest-canvas-mock', '<rootDir>/tests/setup.js'],
    transform: {
        '^.+\.(ts|tsx|js|jsx)': 'babel-jest'
    }
};
