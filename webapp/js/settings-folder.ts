/**
 * Settings Folder — app-owned local directory for Plugins, Filters, and Scripts.
 *
 * The only folder Counterpunch asks for; fonts on disk are opened with the
 * system pickers instead. Persisted under its own IndexedDB key and
 * configured from the startup prompt, Preferences and Plugin Manager.
 */

import {
    NativeAdapter,
    SETTINGS_FOLDER_HANDLE_KEY
} from './file-system-adapter';
import {
    ensureSettingsFolderSubdirectories,
    SETTINGS_FOLDER_PATHS
} from './settings-folder-paths';
import { Logger } from './logger';

const console = new Logger('SettingsFolder');

/** Source id used in script-editor URIs for Settings Folder backed files. */
export const SETTINGS_FOLDER_SOURCE_ID = 'settings';

export type SettingsFolderAccessState = 'missing' | 'needsRenewal' | 'ready';

export type SettingsFolderAccessChangedDetail = {
    hasSettingsFolderAccess: boolean;
    source: 'attach' | 'detach' | 'init' | 'renew';
};

class SettingsFolderService {
    private readonly adapter: NativeAdapter;
    private initializePromise: Promise<boolean> | null = null;
    /** Cached directory handles for picker startIn (must be sync at gesture time). */
    private readonly startInHandles = new Map<
        string,
        FileSystemDirectoryHandle
    >();
    private openPickerInFlight = false;
    private savePickerInFlight = false;

    constructor() {
        this.adapter = new NativeAdapter(SETTINGS_FOLDER_HANDLE_KEY);
    }

    getAdapter(): NativeAdapter {
        return this.adapter;
    }

    getFolderName(): string | null {
        if (!this.adapter.hasDirectory()) {
            return null;
        }
        return this.adapter.getDirectoryName() || null;
    }

    hasFolder(): boolean {
        return this.adapter.hasDirectory();
    }

    async getAccessState(): Promise<SettingsFolderAccessState> {
        await this.initialize();
        if (!this.adapter.hasDirectory()) {
            return 'missing';
        }
        const permission = await this.adapter.checkPermission();
        return permission === 'granted' ? 'ready' : 'needsRenewal';
    }

    async renewPermission(): Promise<boolean> {
        if (!this.adapter.hasDirectory()) {
            return false;
        }
        const permission = await this.adapter.requestPermission();
        if (permission !== 'granted') {
            return false;
        }
        await ensureSettingsFolderSubdirectories(this.adapter);
        await this.refreshStartInCache();
        this.dispatchAccessChanged({
            hasSettingsFolderAccess: true,
            source: 'renew'
        });
        return true;
    }

    async isReady(): Promise<boolean> {
        await this.initialize();
        return this.adapter.hasDirectory();
    }

    async initialize(): Promise<boolean> {
        if (this.adapter.hasDirectory()) {
            if (this.startInHandles.size === 0) {
                await this.refreshStartInCache();
            }
            return true;
        }
        if (!this.initializePromise) {
            this.initializePromise = this.adapter
                .initialize()
                .then(async (restored) => {
                    if (restored || this.adapter.hasDirectory()) {
                        await this.refreshStartInCache();
                    }
                    return this.adapter.hasDirectory();
                })
                .finally(() => {
                    this.initializePromise = null;
                });
        }
        return this.initializePromise;
    }

    /**
     * Prompt the user to choose a Settings Folder, create managed subfolders,
     * and notify dependents.
     */
    async selectFolder(options?: {
        startIn?: FileSystemHandle;
    }): Promise<boolean> {
        const selected = await this.adapter.selectDirectory(options);
        if (!selected) {
            return false;
        }

        await ensureSettingsFolderSubdirectories(this.adapter);
        await this.refreshStartInCache();
        this.dispatchAccessChanged({
            hasSettingsFolderAccess: true,
            source: 'attach'
        });
        console.log(
            'Settings Folder selected:',
            this.adapter.getDirectoryName()
        );
        return true;
    }

    async clearFolder(): Promise<void> {
        await this.adapter.clearDirectory();
        this.startInHandles.clear();
        this.dispatchAccessChanged({
            hasSettingsFolderAccess: false,
            source: 'detach'
        });
        console.log('Settings Folder cleared');
    }

    async ensureSubdirectories(): Promise<void> {
        if (!this.adapter.hasDirectory()) {
            throw new Error('Choose a Settings Folder first.');
        }
        await ensureSettingsFolderSubdirectories(this.adapter);
        await this.refreshStartInCache();
    }

    /**
     * Resolve a cached startIn handle without awaiting filesystem I/O.
     * Awaits before show*FilePicker consume user activation and cause
     * NotAllowedError even when a picker still appears from a concurrent call.
     */
    private getCachedStartInHandle(
        path?: string
    ): FileSystemDirectoryHandle | undefined {
        if (path && this.startInHandles.has(path)) {
            return this.startInHandles.get(path);
        }
        if (path === '/' || !path) {
            return this.startInHandles.get('/');
        }
        return this.startInHandles.get('/') ?? undefined;
    }

    private async refreshStartInCache(): Promise<void> {
        this.startInHandles.clear();
        const root = this.adapter.getDirectoryHandle();
        if (!root) {
            return;
        }
        this.startInHandles.set('/', root);

        for (const path of Object.values(SETTINGS_FOLDER_PATHS)) {
            try {
                const handle = await this.adapter.getHandleAtPath(path);
                if (handle && handle.kind === 'directory') {
                    this.startInHandles.set(
                        path,
                        handle as FileSystemDirectoryHandle
                    );
                }
            } catch {
                // Subfolder may not exist yet.
            }
        }
    }

    showOpenFilePicker(options?: {
        types?: { description: string; accept: Record<string, string[]> }[];
        startIn?: string;
    }): Promise<string | null> {
        if (!this.adapter.hasDirectory()) {
            return Promise.resolve(null);
        }
        if (this.openPickerInFlight) {
            return Promise.resolve(null);
        }

        const pickerOptions: Record<string, unknown> = {
            multiple: false
        };

        if (options?.types) {
            pickerOptions.types = options.types;
        }

        const startHandle = this.getCachedStartInHandle(
            options?.startIn || '/'
        );
        if (startHandle) {
            pickerOptions.startIn = startHandle;
        }

        this.openPickerInFlight = true;

        let nativePromise: Promise<FileSystemFileHandle[]>;
        try {
            // Invoke synchronously so the call stays inside the user gesture.
            nativePromise = (
                window as unknown as {
                    showOpenFilePicker: (
                        options?: Record<string, unknown>
                    ) => Promise<FileSystemFileHandle[]>;
                }
            ).showOpenFilePicker(pickerOptions);
        } catch (error: unknown) {
            this.openPickerInFlight = false;
            if (error instanceof DOMException && error.name === 'AbortError') {
                return Promise.resolve(null);
            }
            console.error('Error opening Settings Folder file picker:', error);
            return Promise.reject(error);
        }

        return nativePromise
            .then(async ([fileHandle]) => this.getRelativePath(fileHandle))
            .catch((error: unknown) => {
                if (
                    error instanceof DOMException &&
                    error.name === 'AbortError'
                ) {
                    console.log('Open file picker cancelled');
                    return null;
                }
                console.error(
                    'Error opening Settings Folder file picker:',
                    error
                );
                throw error;
            })
            .finally(() => {
                this.openPickerInFlight = false;
            });
    }

    showSaveFilePicker(options?: {
        suggestedName?: string;
        types?: { description: string; accept: Record<string, string[]> }[];
        startIn?: string;
    }): Promise<string | null> {
        if (!this.adapter.hasDirectory()) {
            return Promise.resolve(null);
        }
        if (this.savePickerInFlight) {
            return Promise.resolve(null);
        }

        const pickerOptions: Record<string, unknown> = {};

        if (options?.suggestedName) {
            pickerOptions.suggestedName = options.suggestedName;
        }

        if (options?.types) {
            pickerOptions.types = options.types;
        }

        const startHandle = this.getCachedStartInHandle(
            options?.startIn || '/'
        );
        if (startHandle) {
            pickerOptions.startIn = startHandle;
        }

        this.savePickerInFlight = true;

        let nativePromise: Promise<FileSystemFileHandle>;
        try {
            // Invoke synchronously so the call stays inside the user gesture.
            nativePromise = (
                window as unknown as {
                    showSaveFilePicker: (
                        options?: Record<string, unknown>
                    ) => Promise<FileSystemFileHandle>;
                }
            ).showSaveFilePicker(pickerOptions);
        } catch (error: unknown) {
            this.savePickerInFlight = false;
            if (error instanceof DOMException && error.name === 'AbortError') {
                return Promise.resolve(null);
            }
            console.error('Error saving Settings Folder file picker:', error);
            return Promise.reject(error);
        }

        return nativePromise
            .then(async (fileHandle) => this.getRelativePath(fileHandle))
            .catch((error: unknown) => {
                if (
                    error instanceof DOMException &&
                    error.name === 'AbortError'
                ) {
                    console.log('Save file picker cancelled');
                    return null;
                }
                console.error(
                    'Error saving Settings Folder file picker:',
                    error
                );
                throw error;
            })
            .finally(() => {
                this.savePickerInFlight = false;
            });
    }

    private async getRelativePath(
        fileHandle: FileSystemFileHandle
    ): Promise<string | null> {
        try {
            const rootHandle = this.adapter.getDirectoryHandle();
            if (!rootHandle) {
                return null;
            }

            const pathParts = await (
                rootHandle as FileSystemDirectoryHandle & {
                    resolve: (
                        handle: FileSystemHandle
                    ) => Promise<string[] | null>;
                }
            ).resolve(fileHandle);
            if (pathParts === null) {
                console.warn(
                    'Selected file is outside the Settings Folder root'
                );
                return null;
            }

            return '/' + pathParts.join('/');
        } catch (error) {
            console.error('Error resolving Settings Folder path:', error);
            return null;
        }
    }

    private dispatchAccessChanged(
        detail: SettingsFolderAccessChangedDetail
    ): void {
        window.dispatchEvent(
            new CustomEvent('settingsFolderAccessChanged', { detail })
        );
    }
}

export const settingsFolder = new SettingsFolderService();

export { SETTINGS_FOLDER_PATHS };
