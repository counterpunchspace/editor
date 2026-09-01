import { Logger } from '../logger';
import { pluginRegistry } from './registry';
import { DiskPlugin } from './plugins/disk-plugin';
import { MemoryPlugin } from './plugins/memory-plugin';

export {
    FilesystemPlugin,
    type TitleBarMenuItem,
    type FileContextAction,
    type FileContextTarget,
    type PluginMessageOptions,
    type FilesystemPluginUICallbacks,
    type CanAddGlyphsResult
} from './filesystem-plugin';
export { pluginRegistry } from './registry';
export { MemoryPlugin } from './plugins/memory-plugin';
export { DiskPlugin } from './plugins/disk-plugin';

const console = new Logger('FilesystemPlugins');

pluginRegistry.register(new MemoryPlugin());
pluginRegistry.register(new DiskPlugin());
pluginRegistry.setDefault('memory');

console.log(
    '[FilesystemPlugins] ✅ Plugin system initialized with',
    pluginRegistry.getIds().join(', ')
);
