describe('auto-compile-manager failure latch', () => {
    let originalRequestAnimationFrame;
    let originalCancelAnimationFrame;
    let originalConsoleError;

    beforeEach(() => {
        jest.resetModules();
        jest.useFakeTimers();
        originalRequestAnimationFrame = global.requestAnimationFrame;
        originalCancelAnimationFrame = global.cancelAnimationFrame;
        originalConsoleError = console.error;
        global.requestAnimationFrame = jest.fn(() => 1);
        global.cancelAnimationFrame = jest.fn();
        console.error = jest.fn();
        delete window.autoCompileManager;
    });

    afterEach(() => {
        jest.useRealTimers();
        global.requestAnimationFrame = originalRequestAnimationFrame;
        global.cancelAnimationFrame = originalCancelAnimationFrame;
        console.error = originalConsoleError;
        delete window.autoCompileManager;
        jest.dontMock('../js/font-manager');
    });

    test('stops retrying an unchanged compile request after a compile error', async () => {
        const currentFont = {
            needsRecompile: false,
            compileRequestVersion: 7
        };
        const recompileEditingFont = jest
            .fn()
            .mockRejectedValue(new Error('compile failed'));

        jest.doMock('../js/font-manager', () => ({
            __esModule: true,
            default: {
                currentFont,
                isReady: jest.fn(() => true),
                recompileEditingFont
            }
        }));

        require('../js/auto-compile-manager');

        currentFont.needsRecompile = true;

        await window.autoCompileManager.forceTrigger();
        await window.autoCompileManager.forceTrigger();

        expect(recompileEditingFont).toHaveBeenCalledTimes(1);
        expect(console.error).toHaveBeenCalledTimes(1);
        expect(currentFont.needsRecompile).toBe(false);

        currentFont.compileRequestVersion = 8;
        currentFont.needsRecompile = true;

        await window.autoCompileManager.forceTrigger();

        expect(recompileEditingFont).toHaveBeenCalledTimes(2);
    });

    test('compiles the first loaded font without an existing editing font', async () => {
        const currentFont = {
            needsRecompile: true,
            compileRequestVersion: 1
        };
        const recompileEditingFont = jest.fn().mockResolvedValue(false);

        jest.doMock('../js/font-manager', () => ({
            __esModule: true,
            default: {
                currentFont,
                isReady: jest.fn(() => false),
                recompileEditingFont
            }
        }));

        require('../js/auto-compile-manager');

        await window.autoCompileManager.forceTrigger();

        expect(recompileEditingFont).toHaveBeenCalledTimes(1);
        expect(currentFont.needsRecompile).toBe(true);
    });
});
