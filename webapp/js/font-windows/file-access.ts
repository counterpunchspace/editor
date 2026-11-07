// Typed access to the File System Access API parts that TypeScript's DOM
// library does not declare: pickers, permissions and resolve().

export type PickerAcceptType = {
    description?: string;
    accept: Record<string, string[]>;
};

type PickerStart = FileSystemHandle | 'documents' | 'desktop' | 'downloads';

type FileAccessWindow = {
    showOpenFilePicker?: (options?: {
        id?: string;
        multiple?: boolean;
        startIn?: PickerStart;
        types?: PickerAcceptType[];
        excludeAcceptAllOption?: boolean;
    }) => Promise<FileSystemFileHandle[]>;
    showSaveFilePicker?: (options?: {
        id?: string;
        suggestedName?: string;
        startIn?: PickerStart;
        types?: PickerAcceptType[];
    }) => Promise<FileSystemFileHandle>;
    showDirectoryPicker?: (options?: {
        id?: string;
        mode?: 'read' | 'readwrite';
        startIn?: PickerStart;
    }) => Promise<FileSystemDirectoryHandle>;
};

type PermissionHandle = {
    queryPermission(options: {
        mode: 'read' | 'readwrite';
    }): Promise<PermissionState>;
    requestPermission(options: {
        mode: 'read' | 'readwrite';
    }): Promise<PermissionState>;
};

const fileAccessWindow = window as unknown as FileAccessWindow;

export const supportsFileAccess =
    typeof fileAccessWindow.showOpenFilePicker === 'function' &&
    typeof fileAccessWindow.showDirectoryPicker === 'function';

function requirePicker<K extends keyof FileAccessWindow>(
    name: K
): NonNullable<FileAccessWindow[K]> {
    const picker = fileAccessWindow[name];
    if (typeof picker !== 'function') {
        throw new Error('This browser can’t open files from your computer.');
    }
    return picker.bind(window) as NonNullable<FileAccessWindow[K]>;
}

// Each picker must start in the same turn as the click that asked for it.
export const showOpenFilePicker = (
    ...args: Parameters<NonNullable<FileAccessWindow['showOpenFilePicker']>>
) => requirePicker('showOpenFilePicker')(...args);

export const showSaveFilePicker = (
    ...args: Parameters<NonNullable<FileAccessWindow['showSaveFilePicker']>>
) => requirePicker('showSaveFilePicker')(...args);

export const showDirectoryPicker = (
    ...args: Parameters<NonNullable<FileAccessWindow['showDirectoryPicker']>>
) => requirePicker('showDirectoryPicker')(...args);

export async function queryPermission(
    handle: FileSystemHandle,
    mode: 'read' | 'readwrite' = 'read'
): Promise<PermissionState> {
    try {
        return await (handle as unknown as PermissionHandle).queryPermission({
            mode
        });
    } catch {
        return 'denied';
    }
}

/** Ask for access if needed. Needs a click when the answer is 'prompt'. */
export async function ensurePermission(
    handle: FileSystemHandle,
    mode: 'read' | 'readwrite' = 'read'
): Promise<boolean> {
    if ((await queryPermission(handle, mode)) === 'granted') return true;
    return (
        (await (handle as unknown as PermissionHandle).requestPermission({
            mode
        })) === 'granted'
    );
}

/** The path from `folder` down to `handle`, or null if it isn't inside. */
export async function resolveInside(
    folder: FileSystemDirectoryHandle,
    handle: FileSystemHandle
): Promise<string[] | null> {
    try {
        return await folder.resolve(handle);
    } catch {
        return null;
    }
}

export async function isSameEntry(
    a: FileSystemHandle | undefined,
    b: FileSystemHandle | undefined
): Promise<boolean> {
    if (!a || !b || a.kind !== b.kind) return false;
    try {
        return await a.isSameEntry(b);
    } catch {
        return false;
    }
}

export const isAbortError = (error: unknown) =>
    error instanceof DOMException && error.name === 'AbortError';
