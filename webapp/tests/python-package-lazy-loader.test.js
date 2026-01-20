/**
 * @jest-environment jsdom
 */

// Mock script for lazy loader
const lazyLoaderScript = `
(function () {
    'use strict';

    const installedPackages = new Set();
    const lazyPackages = {
        matplotlib: 'matplotlib',
        numpy: 'numpy',
        pandas: 'pandas'
    };
    const installingPackages = new Set();

    function detectRequiredPackages(code) {
        const required = [];

        for (const [packageName, pipName] of Object.entries(lazyPackages)) {
            if (installedPackages.has(packageName) || installingPackages.has(packageName)) {
                continue;
            }

            const importPatterns = [
                new RegExp(\`^\\\\s*import\\\\s+\${packageName}(?:\\\\s|$|\\\\.)\`, 'm'),
                new RegExp(\`^\\\\s*from\\\\s+\${packageName}(?:\\\\s|\\\\.)\`,'m')
            ];

            if (importPatterns.some(pattern => pattern.test(code))) {
                required.push(pipName);
            }
        }

        return required;
    }

    window._testLazyLoader = {
        detectRequiredPackages,
        installedPackages,
        installingPackages
    };
})();
`;

describe('Python Package Lazy Loader', () => {
    beforeEach(() => {
        // Inject the lazy loader script
        eval(lazyLoaderScript);
    });

    test('detects matplotlib import', () => {
        const code = 'import matplotlib.pyplot as plt';
        const required = window._testLazyLoader.detectRequiredPackages(code);
        expect(required).toContain('matplotlib');
    });

    test('detects numpy from import', () => {
        const code = 'from numpy import array';
        const required = window._testLazyLoader.detectRequiredPackages(code);
        expect(required).toContain('numpy');
    });

    test('detects pandas import', () => {
        const code = 'import pandas as pd';
        const required = window._testLazyLoader.detectRequiredPackages(code);
        expect(required).toContain('pandas');
    });

    test('detects multiple packages', () => {
        const code = `
import numpy as np
import pandas as pd
        `;
        const required = window._testLazyLoader.detectRequiredPackages(code);
        expect(required).toContain('numpy');
        expect(required).toContain('pandas');
        expect(required).toHaveLength(2);
    });

    test('skips already installed packages', () => {
        window._testLazyLoader.installedPackages.add('numpy');
        const code = 'import numpy as np';
        const required = window._testLazyLoader.detectRequiredPackages(code);
        expect(required).not.toContain('numpy');
        expect(required).toHaveLength(0);
    });

    test('skips currently installing packages', () => {
        window._testLazyLoader.installingPackages.add('matplotlib');
        const code = 'import matplotlib.pyplot as plt';
        const required = window._testLazyLoader.detectRequiredPackages(code);
        expect(required).not.toContain('matplotlib');
        expect(required).toHaveLength(0);
    });

    test('ignores non-lazy packages', () => {
        const code = 'import os\\nimport sys';
        const required = window._testLazyLoader.detectRequiredPackages(code);
        expect(required).toHaveLength(0);
    });

    test('detects matplotlib submodule imports', () => {
        const code = 'import matplotlib.pyplot';
        const required = window._testLazyLoader.detectRequiredPackages(code);
        expect(required).toContain('matplotlib');
    });

    test('detects from matplotlib.pyplot import', () => {
        const code = 'from matplotlib.pyplot import plot';
        const required = window._testLazyLoader.detectRequiredPackages(code);
        expect(required).toContain('matplotlib');
    });

    test('handles indented imports', () => {
        const code = `
def test():
    import numpy as np
        `;
        const required = window._testLazyLoader.detectRequiredPackages(code);
        expect(required).toContain('numpy');
    });

    test('ignores comments with package names', () => {
        const code = '# import matplotlib\\nprint("hello")';
        const required = window._testLazyLoader.detectRequiredPackages(code);
        expect(required).toHaveLength(0);
    });
});
