import type { FileSystemAdapter, FileInfo } from './file-system-adapter';
import { settingsFolder, SETTINGS_FOLDER_PATHS } from './settings-folder';
import { Logger } from './logger';
import { resolveWebsiteURL } from './website-url';

const console = new Logger('FontDestinationPlugins');

export const FONT_DESTINATION_PLUGIN_MARKER =
    'counterpunch-plugin:font-destination:v1';
const MANIFEST_FILENAME = 'counterpunch-plugin.json';
const PLUGINS_DIRECTORY = SETTINGS_FOLDER_PATHS.plugins;
const ENTRY_POINT_GROUP = 'counterpunch_font_destination_plugins';

type JsonRecord = Record<string, unknown>;

type GitHubManifestLocation = {
    branch: string;
    path: string;
    repository: string;
};

type GitHubReleaseAsset = {
    name: string;
    browser_download_url: string;
};

type EntryPointDiscoveryResult = {
    destinations: unknown[];
    errors: string[];
};

export type FontDestinationManifest = {
    packageName: string;
    entryPoint: string;
    pluginId: string;
    name: string;
    description: string;
    destinationUrl: string;
    targetOrigin: string;
    repositoryUrl: string;
    imageUrl: string | null;
    releaseRepository: string;
    wheelAssetPrefix: string;
    checksumAssetSuffix: string;
};

export type InstalledFontDestination = {
    pluginId: string;
    name: string;
    description: string;
    destinationUrl: string;
    targetOrigin: string;
    repositoryUrl: string;
    imageUrl: string | null;
};

export type PluginStorageStatus =
    'settings-folder-not-connected' | 'plugins-folder-missing' | 'ready';

type OpenFontDestination = InstalledFontDestination & {
    window: Window;
};

type ExportedBinaryFontMetadata = {
    byteLength: number;
    changeVersion: number;
    filename: string;
    format: 'ttf';
    mimeType: 'font/ttf';
    timeTakenMs: number;
};

type PyodideFileSystem = {
    mkdirTree: (path: string) => void;
    writeFile: (path: string, contents: Uint8Array) => void;
};

type PyodideProxy = {
    toJs?: (options?: { dict_converter: typeof Object.fromEntries }) => unknown;
    destroy?: () => void;
};

type PyodideRuntime = {
    FS?: PyodideFileSystem;
    runPythonAsync: (code: string) => Promise<unknown>;
};

function isRecord(value: unknown): value is JsonRecord {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function getRequiredString(record: JsonRecord, key: string): string {
    const value = record[key];
    if (typeof value !== 'string' || !value) {
        throw new Error(`Plugin manifest is missing ${key}.`);
    }
    return value;
}

function getOptionalString(record: JsonRecord, key: string): string | null {
    const value = record[key];
    return typeof value === 'string' && value ? value : null;
}

function getOptionalHttpsUrl(record: JsonRecord, key: string): string | null {
    const value = getOptionalString(record, key);
    if (!value) {
        return null;
    }
    if (new URL(value).protocol !== 'https:') {
        throw new Error(`Plugin manifest ${key} must be an HTTPS URL.`);
    }
    return value;
}

/** Return the normalized distribution name encoded in a wheel filename. */
function getWheelDistributionName(wheelPath: string): string | null {
    const filename = wheelPath.split('/').pop() || '';
    const separator = filename.indexOf('-');
    if (separator <= 0) {
        return null;
    }
    return filename
        .slice(0, separator)
        .replace(/[-_.]+/g, '-')
        .toLowerCase();
}

function getErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

/** Parse and validate a Font Destination manifest without executing package code. */
function parseFontDestinationManifestV2(
    value: JsonRecord
): FontDestinationManifest {
    const plugins = Array.isArray(value.plugins) ? value.plugins : [];
    const destination = plugins.find(
        (plugin) => isRecord(plugin) && plugin.type === 'font_destination'
    );
    if (!isRecord(destination)) {
        throw new Error('Manifest does not provide a Font Destination plugin.');
    }
    const destinationUrl = getRequiredString(destination, 'destinationUrl');
    const targetOrigin = getRequiredString(destination, 'targetOrigin');
    if (new URL(destinationUrl).origin !== targetOrigin) {
        throw new Error(
            'Font Destination targetOrigin must match destinationUrl.'
        );
    }
    const packageName = getRequiredString(value, 'package');
    return {
        packageName,
        entryPoint: getRequiredString(destination, 'entryPoint'),
        pluginId: getRequiredString(destination, 'pluginId'),
        name: getRequiredString(destination, 'name'),
        description: getRequiredString(destination, 'description'),
        destinationUrl,
        targetOrigin,
        repositoryUrl: getRequiredString(destination, 'repositoryUrl'),
        imageUrl:
            typeof destination.imageUrl === 'string'
                ? destination.imageUrl
                : null,
        releaseRepository: getRequiredString(destination, 'repositoryUrl')
            .replace(/^https:\/\/github.com\//, '')
            .replace(/\/$/, ''),
        wheelAssetPrefix: `${packageName.replaceAll('-', '_')}-`,
        checksumAssetSuffix: '.sha256'
    };
}

export function parseFontDestinationManifest(
    value: unknown
): FontDestinationManifest {
    if (!isRecord(value)) {
        throw new Error('Plugin manifest must be an object.');
    }
    if (value.schema === 'counterpunch-plugin-manifest:v2') {
        return parseFontDestinationManifestV2(value);
    }
    if (value.schema !== 'counterpunch-plugin-manifest:v1') {
        throw new Error('Unsupported Counterpunch plugin manifest schema.');
    }
    if (
        !Array.isArray(value.provides) ||
        !value.provides.includes(FONT_DESTINATION_PLUGIN_MARKER)
    ) {
        throw new Error('Manifest does not provide a Font Destination plugin.');
    }
    if (!isRecord(value.fontDestination) || !isRecord(value.release)) {
        throw new Error(
            'Manifest is missing Font Destination release metadata.'
        );
    }

    const destination = value.fontDestination;
    const release = value.release;
    const destinationUrl = getRequiredString(destination, 'destinationUrl');
    const targetOrigin = getRequiredString(destination, 'targetOrigin');
    if (new URL(destinationUrl).origin !== targetOrigin) {
        throw new Error(
            'Font Destination targetOrigin must match destinationUrl.'
        );
    }
    return {
        packageName: getRequiredString(value, 'package'),
        entryPoint: getRequiredString(destination, 'entryPoint'),
        pluginId: getRequiredString(destination, 'pluginId'),
        name: getRequiredString(destination, 'name'),
        description: getRequiredString(destination, 'description'),
        destinationUrl,
        targetOrigin,
        repositoryUrl: getRequiredString(destination, 'repositoryUrl'),
        imageUrl: getOptionalHttpsUrl(destination, 'imageUrl'),
        releaseRepository: getRequiredString(release, 'repository'),
        wheelAssetPrefix: getRequiredString(release, 'wheelAssetPrefix'),
        checksumAssetSuffix: getRequiredString(release, 'checksumAssetSuffix')
    };
}

function getPyodide(): PyodideRuntime | null {
    const runtime = window.pyodide as PyodideRuntime | undefined;
    return runtime || null;
}

function getSettingsFolderAdapter(): FileSystemAdapter {
    return settingsFolder.getAdapter();
}

function toUint8Array(content: string | Uint8Array): Uint8Array {
    return typeof content === 'string'
        ? new TextEncoder().encode(content)
        : content;
}

async function sha256(bytes: Uint8Array): Promise<string> {
    const buffer = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(buffer).set(bytes);
    const digest = await crypto.subtle.digest('SHA-256', buffer);
    return Array.from(new Uint8Array(digest), (value) =>
        value.toString(16).padStart(2, '0')
    ).join('');
}

async function fetchJson(
    url: string,
    allowNotFound = false,
    cache: RequestCache = 'default'
): Promise<unknown | null> {
    const response = await fetch(url, {
        cache,
        headers: { Accept: 'application/vnd.github+json' }
    });
    if (allowNotFound && response.status === 404) {
        return null;
    }
    if (!response.ok) {
        throw new Error(`GitHub request failed (${response.status}).`);
    }
    return response.json();
}

function extractGitHubManifestLocations(
    value: unknown
): GitHubManifestLocation[] {
    if (!isRecord(value) || !Array.isArray(value.items)) {
        return [];
    }
    return value.items.flatMap((item): GitHubManifestLocation[] => {
        if (
            !isRecord(item) ||
            typeof item.path !== 'string' ||
            !isRecord(item.repository) ||
            typeof item.repository.defaultBranch !== 'string' ||
            typeof item.repository.fullName !== 'string'
        ) {
            return [];
        }
        return [
            {
                branch: item.repository.defaultBranch,
                path: item.path,
                repository: item.repository.fullName
            }
        ];
    });
}

function extractReleaseAssets(value: unknown): GitHubReleaseAsset[] {
    if (!isRecord(value) || !Array.isArray(value.assets)) {
        throw new Error('GitHub release has no assets.');
    }
    return value.assets.filter(
        (asset): asset is GitHubReleaseAsset =>
            isRecord(asset) &&
            typeof asset.name === 'string' &&
            typeof asset.browser_download_url === 'string'
    );
}

async function fetchReleaseAsset(
    repository: string,
    asset: string
): Promise<Response> {
    const parameters = new URLSearchParams({ asset, repository });
    const response = await fetch(
        `${resolveWebsiteURL()}/api/github/release-asset?${parameters}`,
        { cache: 'no-store' }
    );
    if (!response.ok) {
        throw new Error(
            `Could not download release asset ${asset} from ${repository} (${response.status}).`
        );
    }
    return response;
}

/** Manage discoverable Font Destination wheels stored in the Settings Folder. */
export class FontDestinationPluginManager {
    private installedDestinations: InstalledFontDestination[] = [];
    private diagnostics: string[] = [];
    private openDestinations = new Map<string, OpenFontDestination>();

    /** Return the destinations discovered in the current Pyodide runtime. */
    getInstalledDestinations(): InstalledFontDestination[] {
        return [...this.installedDestinations];
    }

    /** Return non-fatal plugin install or metadata diagnostics for the UI. */
    getDiagnostics(): string[] {
        return [...this.diagnostics];
    }

    /** Check the connected Settings Folder and its Plugins subfolder. */
    async getPluginStorageStatus(): Promise<PluginStorageStatus> {
        if (!(await settingsFolder.isReady())) {
            return 'settings-folder-not-connected';
        }
        const adapter = getSettingsFolderAdapter();
        return (await adapter.fileExists(PLUGINS_DIRECTORY))
            ? 'ready'
            : 'plugins-folder-missing';
    }

    /** Prompt for a writable Settings Folder. */
    async connectSettingsFolder(): Promise<boolean> {
        return settingsFolder.selectFolder();
    }

    /** Create the dedicated wheel directory inside the Settings Folder. */
    async createPluginsDirectory(): Promise<void> {
        if (!(await settingsFolder.isReady())) {
            throw new Error(
                'Choose a Settings Folder before creating Plugins.'
            );
        }
        const adapter = getSettingsFolderAdapter();
        if ((await adapter.requestPermission?.()) !== 'granted') {
            throw new Error('Write permission is required to create Plugins.');
        }
        await adapter.createFolder(PLUGINS_DIRECTORY);
    }

    /** List wheels physically present in the Settings Folder. */
    async getInstalledWheelFiles(): Promise<FileInfo[]> {
        const adapter = getSettingsFolderAdapter();
        if (!(await settingsFolder.isReady())) {
            return [];
        }
        const files = await adapter.scanDirectory(PLUGINS_DIRECTORY);
        return Object.values(files).filter(
            (file) => !file.is_dir && file.path.toLowerCase().endsWith('.whl')
        );
    }

    /** Discover GitHub-wide marker matches through the editor-origin-gated code-search API. */
    async discoverCatalogue(): Promise<FontDestinationManifest[]> {
        const parameters = new URLSearchParams({
            q: `"${FONT_DESTINATION_PLUGIN_MARKER}" filename:${MANIFEST_FILENAME}`,
            per_page: '100'
        });
        const catalogue = await fetchJson(
            `${resolveWebsiteURL()}/api/github/code-search?${parameters}`,
            false,
            'no-store'
        );
        const manifests = await Promise.all(
            extractGitHubManifestLocations(catalogue).map(async (location) => {
                const url = `https://raw.githubusercontent.com/${location.repository}/${location.branch}/${location.path}`;
                try {
                    const manifest = await fetchJson(url, true);
                    return manifest === null
                        ? null
                        : parseFontDestinationManifest(manifest);
                } catch (error: unknown) {
                    console.warn(
                        'Skipping invalid Font Destination manifest:',
                        error instanceof Error ? error.message : String(error)
                    );
                    return null;
                }
            })
        );
        return manifests.filter(
            (manifest): manifest is FontDestinationManifest => manifest !== null
        );
    }

    /** Download, checksum, and write a release wheel into the Settings Folder Plugins directory. */
    async install(manifest: FontDestinationManifest): Promise<void> {
        if (!(await settingsFolder.isReady())) {
            throw new Error(
                'Choose a Settings Folder before installing plugins.'
            );
        }
        const adapter = getSettingsFolderAdapter();
        if ((await adapter.requestPermission?.()) !== 'granted') {
            throw new Error('Write permission is required to install plugins.');
        }
        if ((await this.getPluginStorageStatus()) !== 'ready') {
            throw new Error(
                'Create the Plugins folder before installing plugins.'
            );
        }

        this.diagnostics = [];
        let release: unknown;
        try {
            release = await fetchJson(
                `https://api.github.com/repos/${manifest.releaseRepository}/releases/latest`
            );
        } catch (error: unknown) {
            throw new Error(
                `Could not read the latest GitHub release for ${manifest.releaseRepository}. Publish a release containing a wheel named ${manifest.wheelAssetPrefix}*.whl and its checksum, or check that the repository is public. ${getErrorMessage(error)}`
            );
        }
        const assets = extractReleaseAssets(release);
        const wheel = assets.find(
            (asset) =>
                asset.name.startsWith(manifest.wheelAssetPrefix) &&
                asset.name.endsWith('.whl')
        );
        if (!wheel) {
            throw new Error(
                `The latest release for ${manifest.releaseRepository} does not contain a wheel whose filename starts with ${manifest.wheelAssetPrefix} and ends with .whl.`
            );
        }
        const checksum = assets.find(
            (asset) =>
                asset.name === `${wheel.name}${manifest.checksumAssetSuffix}`
        );
        if (!checksum) {
            throw new Error(
                `The latest release for ${manifest.releaseRepository} contains ${wheel.name}, but not the required checksum asset ${wheel.name}${manifest.checksumAssetSuffix}.`
            );
        }

        const [wheelResponse, checksumResponse] = await Promise.all([
            fetchReleaseAsset(manifest.releaseRepository, wheel.name),
            fetchReleaseAsset(manifest.releaseRepository, checksum.name)
        ]);
        const bytes = new Uint8Array(await wheelResponse.arrayBuffer());
        const expectedChecksum = (await checksumResponse.text())
            .trim()
            .split(/\s+/)[0]
            .toLowerCase();
        if ((await sha256(bytes)) !== expectedChecksum) {
            throw new Error(
                `Checksum mismatch for ${wheel.name}. The downloaded wheel does not match ${checksum.name}.`
            );
        }

        const wheelPath = `${PLUGINS_DIRECTORY}/${wheel.name}`;
        await adapter.writeFile(wheelPath, bytes);
        try {
            await this.installWheelIntoPyodide(wheel.name, bytes);
            await this.discoverInstalledDestinations(false);
            if (
                !this.installedDestinations.some(
                    (destination) => destination.pluginId === manifest.pluginId
                )
            ) {
                throw new Error(
                    `Installed wheel ${wheel.name} did not expose Font Destination metadata for pluginId ${manifest.pluginId}. Check entry point ${manifest.entryPoint}.`
                );
            }
        } catch (error: unknown) {
            try {
                await this.uninstallWheelFromPyodide(wheelPath);
            } catch (cleanupError: unknown) {
                console.warn(
                    'Could not clean up failed Font Destination runtime install:',
                    getErrorMessage(cleanupError)
                );
            }
            try {
                await adapter.deleteItem(wheelPath, false);
            } catch (cleanupError: unknown) {
                console.warn(
                    'Could not delete failed Font Destination wheel:',
                    getErrorMessage(cleanupError)
                );
            }
            throw new Error(
                `Could not install ${manifest.name}: ${getErrorMessage(error)}`
            );
        }
    }

    /** Remove a wheel; the next Pyodide initialization makes removal effective. */
    /** Write a website wheel after checking its hash. Restore the previous file if loading fails. */
    async installVerifiedWheel(
        filename: string,
        bytes: Uint8Array,
        expectedSha256: string
    ): Promise<void> {
        if ((await sha256(bytes)) !== expectedSha256.toLowerCase()) {
            throw new Error(`Checksum mismatch for ${filename}.`);
        }
        const adapter = getSettingsFolderAdapter();
        const wheelPath = `${PLUGINS_DIRECTORY}/${filename}`;
        let existing: string | Uint8Array | null = null;
        try {
            existing = await adapter.readFile(wheelPath);
        } catch {
            existing = null;
        }
        await adapter.writeFile(wheelPath, bytes);
        try {
            await this.installWheelIntoPyodide(filename, bytes);
        } catch (error: unknown) {
            if (existing) {
                await adapter.writeFile(wheelPath, existing);
            } else {
                await adapter.deleteItem(wheelPath, false);
            }
            throw error;
        }
    }

    async uninstall(wheelPath: string): Promise<void> {
        if (!(await settingsFolder.isReady())) {
            throw new Error('Settings Folder is not available.');
        }
        const adapter = getSettingsFolderAdapter();
        await this.uninstallWheelFromPyodide(wheelPath);
        await adapter.deleteItem(wheelPath, false);
        await this.discoverInstalledDestinations();
        this.openDestinations.clear();
    }

    /** Reinstall every stored wheel after Pyodide starts, without prompting for permission. */
    async reinstallStoredPlugins(): Promise<void> {
        const adapter = getSettingsFolderAdapter();
        if (
            !(await settingsFolder.isReady()) ||
            (await adapter.checkPermission?.()) !== 'granted'
        ) {
            return;
        }
        this.diagnostics = [];
        for (const file of await this.getInstalledWheelFiles()) {
            try {
                const contents = await adapter.readFile(file.path);
                await this.installWheelIntoPyodide(
                    file.path.split('/').pop() || 'plugin.whl',
                    toUint8Array(contents)
                );
            } catch (error: unknown) {
                const message = `Could not restore ${file.path}: ${getErrorMessage(error)}`;
                this.diagnostics.push(message);
                console.warn(message);
            }
        }
        await this.discoverInstalledDestinations(false);
    }

    /** Re-read Python entry points when the Tools menu opens. */
    async discoverInstalledDestinations(
        resetDiagnostics = true
    ): Promise<void> {
        if (resetDiagnostics) {
            this.diagnostics = [];
        }
        const pyodide = getPyodide();
        if (!pyodide) {
            this.installedDestinations = [];
            return;
        }

        const installedDistributions = (await this.getInstalledWheelFiles())
            .map((file) => getWheelDistributionName(file.path))
            .filter((name): name is string => name !== null);
        if (!installedDistributions.length) {
            this.installedDestinations = [];
            return;
        }

        const result = (await pyodide.runPythonAsync(`
import importlib
import re
from importlib.metadata import entry_points

importlib.invalidate_caches()
installed_distributions = ${JSON.stringify(installedDistributions)}

def normalize_distribution_name(name):
    return re.sub(r"[-_.]+", "-", name).lower()

entries = entry_points(group=${JSON.stringify(ENTRY_POINT_GROUP)})
destinations = []
errors = []
for entry in entries:
    try:
        distribution = entry.dist.metadata["Name"]
        if normalize_distribution_name(distribution) not in installed_distributions:
            continue
        plugin = entry.load()()
        metadata = plugin.metadata()
        destinations.append(metadata)
    except Exception as error:
        message = f"Could not load {entry.name}: {error}"
        print(f"[FontDestinationPlugins] {message}")
        errors.append(message)
{"destinations": destinations, "errors": errors}
`)) as PyodideProxy;
        try {
            const values = result?.toJs
                ? result.toJs({ dict_converter: Object.fromEntries })
                : result;
            const discovery = this.parseEntryPointDiscoveryResult(values);
            this.diagnostics.push(...discovery.errors);
            this.installedDestinations = discovery.destinations.length
                ? discovery.destinations.flatMap((value, index) =>
                      this.parseInstalledDestination(
                          value,
                          `Installed Font Destination metadata ${index + 1}`
                      )
                  )
                : [];
        } finally {
            result?.destroy?.();
        }
    }

    /** Open a same-origin bridge that forwards later exports to the destination frame. */
    openDestination(destination: InstalledFontDestination): void {
        const url = new URL(destination.destinationUrl);
        if (url.origin !== destination.targetOrigin) {
            throw new Error(
                'Font Destination URL does not match its declared origin.'
            );
        }

        const bridgeUrl = new URL(
            '/font-destination-bridge.html',
            window.location.origin
        );
        bridgeUrl.searchParams.set('destinationUrl', url.href);
        const opened = window.open(
            bridgeUrl.href,
            `counterpunch-font-destination-${destination.pluginId}`
        );
        if (!opened) {
            throw new Error('The browser blocked the Font Destination window.');
        }
        this.openDestinations.set(destination.pluginId, {
            ...destination,
            window: opened
        });
    }

    /** Send one transferable byte-buffer copy to each destination opened this session. */
    deliverExportedFont(
        bytes: Uint8Array,
        metadata: ExportedBinaryFontMetadata
    ): void {
        for (const [pluginId, destination] of this.openDestinations) {
            if (destination.window.closed) {
                this.openDestinations.delete(pluginId);
                continue;
            }
            const messageBytes = bytes.slice();
            destination.window.postMessage(
                {
                    type: 'counterpunch:binary-font-exported',
                    version: 1,
                    bytes: messageBytes.buffer,
                    metadata
                },
                window.location.origin,
                [messageBytes.buffer]
            );
        }
    }

    private parseEntryPointDiscoveryResult(
        value: unknown
    ): EntryPointDiscoveryResult {
        if (Array.isArray(value)) {
            return { destinations: value, errors: [] };
        }
        if (!isRecord(value)) {
            return { destinations: [], errors: [] };
        }
        const destinations = Array.isArray(value.destinations)
            ? value.destinations
            : [];
        const errors = Array.isArray(value.errors)
            ? value.errors.filter(
                  (error): error is string => typeof error === 'string'
              )
            : [];
        return { destinations, errors };
    }

    private parseInstalledDestination(
        value: unknown,
        source = 'Installed Font Destination metadata'
    ): InstalledFontDestination[] {
        try {
            if (!isRecord(value)) {
                this.diagnostics.push(`${source} is not an object.`);
                return [];
            }
            const destinationUrl = getRequiredString(value, 'destinationUrl');
            const targetOrigin = getRequiredString(value, 'targetOrigin');
            if (new URL(destinationUrl).origin !== targetOrigin) {
                return [];
            }
            return [
                {
                    pluginId: getRequiredString(value, 'pluginId'),
                    name: getRequiredString(value, 'name'),
                    description: getRequiredString(value, 'description'),
                    destinationUrl,
                    targetOrigin,
                    repositoryUrl: getRequiredString(value, 'repositoryUrl'),
                    imageUrl: getOptionalHttpsUrl(value, 'imageUrl')
                }
            ];
        } catch (error: unknown) {
            this.diagnostics.push(`${source}: ${getErrorMessage(error)}`);
            return [];
        }
    }

    private async installWheelIntoPyodide(
        filename: string,
        bytes: Uint8Array
    ): Promise<void> {
        const pyodide = getPyodide();
        if (!pyodide?.FS) {
            throw new Error('Python is not ready to install plugins.');
        }
        const path = `/tmp/counterpunch-plugins/${filename}`;
        pyodide.FS.mkdirTree('/tmp/counterpunch-plugins');
        pyodide.FS.writeFile(path, bytes);
        await pyodide.runPythonAsync(`
import importlib
import micropip

importlib.invalidate_caches()
await micropip.install(${JSON.stringify(`emfs:${path}`)}, reinstall=True)
importlib.invalidate_caches()
`);
    }

    /** Remove a wheel-installed distribution and its cached entry-point modules. */
    private async uninstallWheelFromPyodide(wheelPath: string): Promise<void> {
        const pyodide = getPyodide();
        const distribution = getWheelDistributionName(wheelPath);
        if (!pyodide || !distribution) {
            return;
        }
        await pyodide.runPythonAsync(`
import importlib
import re
import sys
from importlib.metadata import entry_points
import micropip

target_distribution = ${JSON.stringify(distribution)}

def normalize_distribution_name(name):
    return re.sub(r"[-_.]+", "-", name).lower()

for entry in entry_points(group=${JSON.stringify(ENTRY_POINT_GROUP)}):
    if normalize_distribution_name(entry.dist.metadata["Name"]) != target_distribution:
        continue
    module_name = entry.value.partition(":")[0]
    for loaded_name in tuple(sys.modules):
        if loaded_name == module_name or loaded_name.startswith(f"{module_name}."):
            sys.modules.pop(loaded_name, None)

installed_name = next(
    (
        name
        for name in micropip.list()
        if normalize_distribution_name(name) == target_distribution
    ),
    None,
)
if installed_name:
    micropip.uninstall(installed_name)
importlib.invalidate_caches()
`);
    }
}

export const fontDestinationPluginManager = new FontDestinationPluginManager();
