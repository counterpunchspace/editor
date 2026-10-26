// Drives the real Python console interpreter (pyodide-official-console.ts,
// alongside python-execution-wrapper.ts) with a stubbed jQuery Terminal and
// Pyodide, and checks that every command opens and closes the before/after
// Python execution hooks.

jest.mock('../js/perf-timeline', () => ({
    timelineMark: jest.fn(),
    timelineSpanStart: jest.fn(() => 0),
    timelineSpanEnd: jest.fn()
}));

class PythonError extends Error {}

function settle(ms = 0) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('Python console execution hooks', () => {
    let interpreter;
    let term;
    let nextResult;

    beforeAll(async () => {
        // jsdom has no User Timing API.
        performance.mark ??= jest.fn();
        performance.getEntriesByName ??= jest.fn(() => []);
        document.body.innerHTML = '<div id="console-container"></div>';

        term = {
            echo: jest.fn(),
            error: jest.fn(),
            pause: jest.fn(),
            resume: jest.fn(),
            set_prompt: jest.fn(),
            focus: jest.fn(),
            clear: jest.fn(),
            // jQuery Terminal returns the typed text here, not the interpreter.
            get_command: () => '',
            set_interpreter: (fn) => {
                interpreter = fn;
            }
        };
        window.$ = jest.fn(() => ({
            terminal: (fn) => {
                interpreter = fn;
                return term;
            }
        }));

        const pyconsole = {
            push: jest.fn(() => ({
                syntax_check: nextResult.syntax ?? 'complete',
                formatted_error: 'Traceback: boom',
                destroy: jest.fn()
            })),
            complete: jest.fn()
        };
        const awaitFut = () => {
            const promise = nextResult.error
                ? Promise.reject(nextResult.error)
                : Promise.resolve([nextResult.value]);
            promise.destroy = jest.fn();
            return promise;
        };
        window.pyodide = {
            version: 'test',
            pyimport: () => ({
                repr_shorten: { callKwargs: (value) => String(value) },
                BANNER: '',
                PyodideConsole: () => pyconsole
            }),
            globals: { get: () => () => ({ destroy: jest.fn() }) },
            runPythonAsync: jest.fn(async () => awaitFut),
            runPython: jest.fn(),
            ffi: { PyProxy: class {} },
            setStdout: jest.fn(),
            setStderr: jest.fn(),
            _api: {}
        };
        window.cleanPythonTraceback = (message) => message;

        // Load the wrapper too: it must not replace the console interpreter.
        jest.isolateModules(() => {
            require('../js/python-execution-wrapper.ts');
            require('../js/pyodide-official-console.ts');
        });
        document.dispatchEvent(new Event('DOMContentLoaded'));
        for (let i = 0; i < 50 && !interpreter; i += 1) {
            await settle(20);
        }
    });

    beforeEach(() => {
        nextResult = { value: 2 };
        term.error.mockClear();
        term.resume.mockClear();
        window.beforePythonExecution = jest.fn(async (code) => ({
            beforeFontDataJson: '{}',
            code
        }));
        window.afterPythonExecution = jest.fn(async () => {});
    });

    afterAll(() => {
        delete window.$;
        delete window.pyodide;
        delete window.term;
        delete window.cleanPythonTraceback;
        delete window.beforePythonExecution;
        delete window.afterPythonExecution;
    });

    test('a successful command calls both hooks once with succeeded true', async () => {
        expect(typeof interpreter).toBe('function');

        await interpreter('1+1');

        expect(window.beforePythonExecution).toHaveBeenCalledTimes(1);
        expect(window.beforePythonExecution).toHaveBeenCalledWith('1+1');
        expect(window.afterPythonExecution).toHaveBeenCalledTimes(1);
        expect(window.afterPythonExecution).toHaveBeenCalledWith(
            { succeeded: true },
            { beforeFontDataJson: '{}', code: '1+1' }
        );
        expect(term.echo).toHaveBeenCalledWith('2');
    });

    test('a Python exception reports succeeded false', async () => {
        nextResult = { error: new PythonError('boom') };

        await interpreter('raise ValueError("boom")');

        expect(term.error).toHaveBeenCalledWith('Traceback: boom');
        expect(window.afterPythonExecution).toHaveBeenCalledTimes(1);
        expect(window.afterPythonExecution.mock.calls[0][0]).toEqual({
            succeeded: false
        });
    });

    test('a syntax error reports succeeded false', async () => {
        nextResult = { syntax: 'syntax-error' };

        await interpreter('1 +');

        expect(window.afterPythonExecution).toHaveBeenCalledTimes(1);
        expect(window.afterPythonExecution.mock.calls[0][0]).toEqual({
            succeeded: false
        });
    });

    test('a non-Python error still closes the hooks and resumes the terminal', async () => {
        nextResult = { error: new TypeError('host failure') };

        await expect(interpreter('Font()')).rejects.toThrow('host failure');

        expect(window.afterPythonExecution).toHaveBeenCalledTimes(1);
        expect(window.afterPythonExecution.mock.calls[0][0]).toEqual({
            succeeded: false
        });
        expect(term.resume).toHaveBeenCalled();
    });
});
