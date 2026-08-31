import { OPFSAdapter } from '../../file-system-adapter';
import { FilesystemPlugin } from '../filesystem-plugin';

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
        return 'Memory';
    }

    getIcon(): string {
        return '<span class="material-symbols-outlined">memory</span>';
    }

    getDefaultPath(): string {
        return '/user';
    }
}
