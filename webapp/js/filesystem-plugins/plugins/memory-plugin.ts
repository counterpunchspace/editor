import { OPFSAdapter } from '../../file-system-adapter';
import { isExampleFontPath } from '../../example-fonts';
import {
    FilesystemPlugin,
    type FileContextAction,
    type FileContextTarget
} from '../filesystem-plugin';

/**
 * Memory Plugin - uses OPFS (Origin Private File System) for browser storage
 */
export class MemoryPlugin extends FilesystemPlugin {
    constructor() {
        super(new OPFSAdapter());
    }

    getId(): string {
        return 'memory';
    }

    getName(): string {
        return 'Browser storage';
    }

    getIcon(): string {
        return '<span class="material-symbols-outlined">memory</span>';
    }

    getDefaultPath(): string {
        return '/user';
    }

    // The sample font and other example fonts must stay for the demo.
    supportsFileContextAction(
        action: FileContextAction,
        target: FileContextTarget
    ): boolean {
        if (
            (action === 'delete' || action === 'rename') &&
            isExampleFontPath(target.path)
        ) {
            return false;
        }
        return super.supportsFileContextAction(action, target);
    }
}
