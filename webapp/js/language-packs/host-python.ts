/**
 * Python calls made by the editor itself.
 *
 * `pyodide.runPython` is wrapped as a user script: it opens a transaction,
 * snapshots the font, and logs the source. Calling that wrapper from a commit
 * finalizer starts another transaction and re-enters the commit.
 */

type HostPyodide = {
    runPython(code: string, options?: unknown): unknown;
    runPythonAsync(code: string, options?: unknown): Promise<unknown>;
    _originalRunPython?(code: string, options?: unknown): unknown;
    _originalRunPythonAsync?(code: string, options?: unknown): Promise<unknown>;
};

function hostPyodide(): HostPyodide {
    return window.pyodide as HostPyodide;
}

export function runHostPython(code: string): unknown {
    const pyodide = hostPyodide();
    const run = pyodide._originalRunPython ?? pyodide.runPython;
    return run.call(pyodide, code);
}

export function runHostPythonAsync(code: string): Promise<unknown> {
    const pyodide = hostPyodide();
    const run = pyodide._originalRunPythonAsync ?? pyodide.runPythonAsync;
    return run.call(pyodide, code);
}
