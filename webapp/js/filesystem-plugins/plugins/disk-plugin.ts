import {
    NativeAdapter,
    FONTS_FOLDER_HANDLE_KEY
} from '../../file-system-adapter';
import { Logger } from '../../logger';
import { dispatchManagedFileChanged } from '../../managed-file-events';
import { FilesystemPlugin, type TitleBarMenuItem } from '../filesystem-plugin';

const console = new Logger('FilesystemPlugins');

/**
 * Disk Plugin - uses File System Access API for direct disk access
 */
export class DiskPlugin extends FilesystemPlugin {
    private nativeAdapter: NativeAdapter;
    private fileSystemObserver: any = null;
    private observerSupported: boolean = 'FileSystemObserver' in window;

    constructor() {
        const adapter = new NativeAdapter(FONTS_FOLDER_HANDLE_KEY);
        super(adapter);
        this.nativeAdapter = adapter;
    }

    getId(): string {
        return 'disk';
    }

    getName(): string {
        return 'Disk';
    }

    getIcon(): string {
        return '<span class="material-symbols-outlined">hard_drive</span>';
    }

    requiresPermission(): boolean {
        return true;
    }

    showsManualRefreshButton(): boolean {
        return !this.observerSupported;
    }

    async onActivate(): Promise<boolean> {
        const isReady = await this.isReady();
        if (!isReady) {
            return false;
        }

        const hasPermission = await this.nativeAdapter.checkPermission();
        if (!hasPermission) {
            return false;
        }

        await this.setupFileSystemObserver();

        return true;
    }

    async onDeactivate(): Promise<void> {
        this.disconnectObserver();
    }

    private async setupFileSystemObserver(): Promise<void> {
        this.disconnectObserver();

        if (!this.observerSupported) {
            console.log(
                '[DiskPlugin] FileSystemObserver not supported, changes require manual refresh'
            );
            return;
        }

        try {
            const rootHandle = await this.nativeAdapter.getHandleAtPath('/');
            if (!rootHandle || rootHandle.kind !== 'directory') {
                console.log(
                    '[DiskPlugin] Cannot get root directory handle for observer'
                );
                return;
            }

            const FileSystemObserver = (window as any).FileSystemObserver;
            this.fileSystemObserver = new FileSystemObserver(
                async (records: any[]) => {
                    console.log(
                        '[DiskPlugin] FileSystemObserver detected changes:',
                        records.length
                    );
                    window.dispatchEvent(
                        new CustomEvent('diskFilesChanged', {
                            detail: { records }
                        })
                    );
                    dispatchManagedFileChanged({
                        pluginId: this.getId(),
                        source: 'file-system-observer',
                        records,
                        internalWrite: false
                    });
                }
            );

            await this.fileSystemObserver.observe(rootHandle, {
                recursive: true
            });
            console.log(
                '[DiskPlugin] FileSystemObserver watching root directory'
            );
        } catch (error) {
            console.error(
                '[DiskPlugin] Failed to set up FileSystemObserver:',
                error
            );
        }
    }

    private disconnectObserver(): void {
        if (this.fileSystemObserver) {
            try {
                this.fileSystemObserver.disconnect();
            } catch (e) {
                // Ignore disconnect errors
            }
            this.fileSystemObserver = null;
        }
    }

    async showSetupUI(options?: {
        startIn?: FileSystemHandle;
    }): Promise<boolean> {
        try {
            const selected = await this.nativeAdapter.selectDirectory(options);
            if (!selected) {
                return false;
            }
            this.redrawTitleBarButtons();
            await this.setupFileSystemObserver();
            return true;
        } catch (error) {
            console.error('[DiskPlugin] Setup cancelled or failed:', error);
            return false;
        }
    }

    async isReady(): Promise<boolean> {
        return await this.nativeAdapter.hasDirectory();
    }

    getDefaultPath(): string {
        return '/';
    }

    supportsUpload(): boolean {
        return false;
    }

    getDirectoryName(): string | null {
        return this.nativeAdapter.getDirectoryName();
    }

    async requestPermission(): Promise<boolean> {
        const permission = await this.nativeAdapter.requestPermission();
        return permission === 'granted';
    }

    canClose(): boolean {
        return true;
    }

    async close(): Promise<void> {
        this.disconnectObserver();
        await this.nativeAdapter.clearDirectory();
        console.log('[DiskPlugin]', 'Folder access closed');
    }

    getTitleBarMenuItems(): TitleBarMenuItem[] {
        return [
            {
                label: 'Close Folder Access',
                icon: 'close',
                action: async () => {
                    await this.close();
                    window.dispatchEvent(new CustomEvent('pluginFolderClosed'));
                }
            }
        ];
    }

    async updateUI(uiCallbacks: {
        showOpenFolderUI: () => void;
        hideOpenFolderUI: () => void;
        showPermissionBanner: (show: boolean) => void;
        showUnsupportedBrowserUI: () => void;
        hideUnsupportedBrowserUI: () => void;
    }): Promise<void> {
        if ((this as any)._unsupported) {
            uiCallbacks.showUnsupportedBrowserUI();
            uiCallbacks.showPermissionBanner(false);
            return;
        }

        uiCallbacks.hideUnsupportedBrowserUI();

        const isReady = await this.isReady();

        if (!isReady) {
            uiCallbacks.showOpenFolderUI();
            uiCallbacks.showPermissionBanner(false);
        } else {
            uiCallbacks.hideOpenFolderUI();

            const permission = await this.nativeAdapter.checkPermission();
            if (permission !== 'granted') {
                uiCallbacks.showPermissionBanner(true);
            } else {
                uiCallbacks.showPermissionBanner(false);
            }
        }
    }

    async clearDirectory(): Promise<void> {
        await this.nativeAdapter.clearDirectory();
    }

    supportsOpenFilePicker(): boolean {
        return this.nativeAdapter.hasDirectory();
    }

    supportsSaveAsFilePicker(): boolean {
        return this.nativeAdapter.hasDirectory();
    }

    async showOpenFilePicker(options?: {
        types?: { description: string; accept: Record<string, string[]> }[];
        startIn?: string;
    }): Promise<string | null> {
        if (!this.nativeAdapter.hasDirectory()) {
            return null;
        }

        try {
            const pickerOptions: any = {
                multiple: false
            };

            if (options?.types) {
                pickerOptions.types = options.types;
            }

            const startPath = options?.startIn || '/';
            const startHandle =
                await this.nativeAdapter.getHandleAtPath(startPath);
            if (startHandle) {
                pickerOptions.startIn = startHandle;
            }

            const [fileHandle] = await (window as any).showOpenFilePicker(
                pickerOptions
            );

            const relativePath = await this.getRelativePath(fileHandle);
            return relativePath;
        } catch (error: any) {
            if (error.name === 'AbortError') {
                console.log('[DiskPlugin] Open file picker cancelled');
                return null;
            }
            console.error('[DiskPlugin] Error opening file picker:', error);
            return null;
        }
    }

    async showSaveFilePicker(options?: {
        suggestedName?: string;
        types?: { description: string; accept: Record<string, string[]> }[];
        startIn?: string;
    }): Promise<string | null> {
        if (!this.nativeAdapter.hasDirectory()) {
            return null;
        }

        try {
            const pickerOptions: any = {};

            if (options?.suggestedName) {
                pickerOptions.suggestedName = options.suggestedName;
            }

            if (options?.types) {
                pickerOptions.types = options.types;
            }

            const startPath = options?.startIn || '/';
            const startHandle =
                await this.nativeAdapter.getHandleAtPath(startPath);
            if (startHandle) {
                pickerOptions.startIn = startHandle;
            }

            const fileHandle = await (window as any).showSaveFilePicker(
                pickerOptions
            );

            const relativePath = await this.getRelativePath(fileHandle);
            return relativePath;
        } catch (error: any) {
            if (error.name === 'AbortError') {
                console.log('[DiskPlugin] Save file picker cancelled');
                return null;
            }
            console.error('[DiskPlugin] Error saving file picker:', error);
            return null;
        }
    }

    private async getRelativePath(
        fileHandle: FileSystemFileHandle
    ): Promise<string | null> {
        try {
            const rootHandle = await this.nativeAdapter.getHandleAtPath('/');
            if (!rootHandle || rootHandle.kind !== 'directory') {
                return null;
            }

            const pathParts = await (rootHandle as any).resolve(fileHandle);
            if (pathParts === null) {
                console.warn(
                    '[DiskPlugin] Selected file is outside the root directory'
                );
                return null;
            }

            return '/' + pathParts.join('/');
        } catch (error) {
            console.error('[DiskPlugin] Error resolving path:', error);
            return null;
        }
    }
}
