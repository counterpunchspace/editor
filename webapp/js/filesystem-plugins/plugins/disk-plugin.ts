import { Logger } from '../../logger';
import { dispatchManagedFileChanged } from '../../managed-file-events';
import { FilesystemPlugin } from '../filesystem-plugin';
import { DocumentRootAdapter } from '../../font-windows/document-root-adapter';
import type { DiskDocument } from '../../font-windows/document-store';

const console = new Logger('FilesystemPlugins');

type ObserverRecord = {
    relativePathComponents?: string[];
    [key: string]: unknown;
};

type FileSystemObserverLike = {
    observe(
        handle: FileSystemHandle,
        options?: { recursive?: boolean }
    ): Promise<void>;
    disconnect(): void;
};

type FileSystemObserverConstructor = new (
    callback: (records: ObserverRecord[]) => void
) => FileSystemObserverLike;

/**
 * Disk: fonts on this computer, opened through the system file pickers.
 *
 * Each window shows one font, so the plugin holds that window's document.
 * Its adapter is rooted at the document (see DocumentRootAdapter) and the
 * font's path is `/<name>`. Fonts are opened from the launcher, not browsed
 * in the file dialog.
 */
export class DiskPlugin extends FilesystemPlugin {
    private documentAdapter: DocumentRootAdapter;
    private fileSystemObserver: FileSystemObserverLike | null = null;

    constructor() {
        const adapter = new DocumentRootAdapter();
        super(adapter);
        this.documentAdapter = adapter;
    }

    getId(): string {
        return 'disk';
    }

    getName(): string {
        return 'This computer';
    }

    getIcon(): string {
        return '<span class="material-symbols-outlined">computer</span>';
    }

    /** The document this window shows, if it came from this computer. */
    get document(): DiskDocument | null {
        return this.documentAdapter.attachedDocument;
    }

    /** Point this window's Disk plugin at `doc` and follow its changes. */
    attachDocument(doc: DiskDocument): void {
        this.documentAdapter.attach(doc);
        void this.watch();
    }

    detachDocument(): void {
        this.disconnectObserver();
        this.documentAdapter.detach();
    }

    isVisibleInUI(): boolean {
        return false;
    }

    supportsUpload(): boolean {
        return false;
    }

    supportsNewFolder(): boolean {
        return false;
    }

    supportsNewFile(): boolean {
        return false;
    }

    requiresPermission(): boolean {
        return true;
    }

    showsManualRefreshButton(): boolean {
        return false;
    }

    async isReady(): Promise<boolean> {
        return this.document !== null;
    }

    async onDeactivate(): Promise<void> {
        // The window's font stays watched whichever plugin the dialog shows.
    }

    /** Report outside changes to the font's files, as paths below `/`. */
    private async watch(): Promise<void> {
        this.disconnectObserver();
        const Observer = (
            window as unknown as {
                FileSystemObserver?: FileSystemObserverConstructor;
            }
        ).FileSystemObserver;
        const doc = this.document;
        const handle = this.documentAdapter.watchHandle();
        if (!Observer || !doc || !handle) {
            return;
        }
        // Without a parent folder the observed handle is the font itself, so
        // its changes are reported relative to the font: put its name back.
        const prefix = doc.parent ? [] : [doc.name];
        try {
            const observer = new Observer((records) => {
                const rooted = records.map((record) => ({
                    ...record,
                    relativePathComponents: [
                        ...prefix,
                        ...(record.relativePathComponents ?? [])
                    ]
                }));
                window.dispatchEvent(
                    new CustomEvent('diskFilesChanged', {
                        detail: { records: rooted }
                    })
                );
                dispatchManagedFileChanged({
                    pluginId: this.getId(),
                    source: 'file-system-observer',
                    records: rooted,
                    internalWrite: false
                });
            });
            await observer.observe(handle, { recursive: true });
            this.fileSystemObserver = observer;
        } catch (error) {
            console.warn('[DiskPlugin] Could not watch', doc.name, error);
        }
    }

    private disconnectObserver(): void {
        try {
            this.fileSystemObserver?.disconnect();
        } catch {
            // Already gone.
        }
        this.fileSystemObserver = null;
    }
}
