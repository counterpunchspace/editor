module.exports = {
    testEnvironment: 'jest-environment-jsdom',
    setupFilesAfterEnv: ['jest-canvas-mock', '<rootDir>/tests/setup.js']
};
