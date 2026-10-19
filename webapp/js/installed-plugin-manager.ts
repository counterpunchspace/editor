import { editorSupportsContract } from './plugin-contracts.generated';
import { resolveWebsiteURL } from './website-url';

export type CatalogPriceState =
    'free' | 'sign_in' | 'payment_method' | 'ready' | 'tax_unavailable';

export type CatalogPlugin = {
    package: string;
    kind: 'free' | 'commercial';
    name: string;
    description: string;
    currency: 'eur';
    version: string | null;
    filename: string | null;
    sha256: string | null;
    releaseNotes: string | null;
    purchased: boolean;
    priceState?: CatalogPriceState;
    netCents?: number;
    taxCents?: number;
    grossCents?: number;
    country?: string;
    countryName?: string;
    types: { type: string; contract: string; pluginId: string }[];
    previousIds?: string[];
    creatorName?: string | null;
};

export type CatalogBilling = {
    state: 'sign_in' | 'payment_method' | 'ready';
    country?: string;
    countryName?: string;
    type?: string | null;
    brand?: string | null;
    last4?: string | null;
    wallet?: string | null;
    email?: string | null;
};

export type BlockedPlugin = { package: string; versions: string[] };

export type CatalogResponse = {
    plugins: CatalogPlugin[];
    blocked: BlockedPlugin[];
    revoked?: string[];
    billing?: CatalogBilling;
};

const DISMISSED_KEY = 'counterpunch.plugin-updates.dismissed';

export function comparePluginVersions(left: string, right: string): number {
    const a = left.split('.').map(Number);
    const b = right.split('.').map(Number);
    for (let i = 0; i < 3; i += 1) {
        if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) - (b[i] || 0);
    }
    return 0;
}

export function installedVersionFromFilename(
    packageName: string,
    paths: string[]
): string | null {
    const prefix = packageName.replaceAll('-', '_') + '-';
    const match = paths
        .map((path) => path.split('/').pop() || '')
        .find((name) => name.startsWith(prefix) && name.endsWith('.whl'));
    if (!match) return null;
    const version = match.slice(prefix.length).split('-')[0];
    return /^[0-9]+\.[0-9]+\.[0-9]+$/.test(version) ? version : null;
}

export function pluginAction(input: {
    plugin: CatalogPlugin;
    installedVersion: string | null;
    signedIn: boolean;
}):
    | 'buy'
    | 'sign-in'
    | 'payment-method'
    | 'install'
    | 'update'
    | 'uninstall'
    | 'incompatible' {
    const supported = input.plugin.types.every((type) =>
        editorSupportsContract(type.type, type.contract)
    );
    if (!supported) return 'incompatible';
    if (input.plugin.kind === 'commercial' && !input.plugin.purchased) {
        if (!input.signedIn || input.plugin.priceState === 'sign_in') {
            return 'sign-in';
        }
        if (input.plugin.priceState !== 'ready') return 'payment-method';
        return 'buy';
    }
    if (!input.installedVersion) return 'install';
    if (
        input.plugin.version &&
        comparePluginVersions(input.plugin.version, input.installedVersion) > 0
    ) {
        return 'update';
    }
    return 'uninstall';
}

export function contractHeader(): string {
    return [
        'canvas:v1',
        'glyphfilter:v1',
        'character_set:v1',
        'compilefilter:v1',
        'composition:v1',
        'feature:v1',
        'font_destination:v1'
    ].join(',');
}

export async function fetchPluginCatalog(): Promise<CatalogResponse> {
    const response = await fetch(`${resolveWebsiteURL()}/api/plugins/catalog`, {
        credentials: 'include',
        headers: { 'X-Plugin-Contracts': contractHeader() }
    });
    if (!response.ok) {
        throw new Error(`Plugin catalog responded ${response.status}.`);
    }
    const body = (await response.json()) as CatalogResponse;
    return {
        plugins: body.plugins || [],
        blocked: body.blocked || [],
        billing: body.billing
    };
}

export async function fetchPluginPurchases(): Promise<{
    signedIn: boolean;
    packages: Set<string>;
}> {
    const response = await fetch(
        `${resolveWebsiteURL()}/api/plugins/purchases`,
        { credentials: 'include' }
    );
    if (response.status === 401 || !response.ok) {
        return {
            signedIn: response.status !== 401 && response.ok,
            packages: new Set()
        };
    }
    const body = (await response.json()) as { packages?: string[] };
    return { signedIn: true, packages: new Set(body.packages || []) };
}

export async function downloadPluginWheel(
    plugin: CatalogPlugin
): Promise<Uint8Array> {
    if (!plugin.version || !plugin.sha256) {
        throw new Error(`${plugin.name} has no published version.`);
    }
    const response = await fetch(
        `${resolveWebsiteURL()}/api/plugins/${encodeURIComponent(plugin.package)}/versions/${encodeURIComponent(plugin.version)}/wheel`,
        { credentials: 'include' }
    );
    if (!response.ok) {
        throw new Error(
            `Could not download ${plugin.name} (${response.status}).`
        );
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    const header = response.headers.get('X-Wheel-Sha256');
    if (header && header.toLowerCase() !== plugin.sha256.toLowerCase()) {
        throw new Error(`Checksum header mismatch for ${plugin.name}.`);
    }
    const { fontDestinationPluginManager } =
        await import('./font-destination-plugin-manager');
    await fontDestinationPluginManager.installVerifiedWheel(
        plugin.filename || `${plugin.package}-${plugin.version}.whl`,
        bytes,
        plugin.sha256
    );
    return bytes;
}

export function revokedWheelPaths(
    catalog: Pick<CatalogResponse, 'blocked' | 'revoked'>,
    installedPaths: string[]
): string[] {
    const revoked = new Set(catalog.revoked || []);
    return installedPaths.filter((file) => {
        const name = file.split('/').pop() || '';
        for (const entry of catalog.blocked || []) {
            const prefix = entry.package.replaceAll('-', '_') + '-';
            if (!name.startsWith(prefix)) continue;
            const version = name.slice(prefix.length).split('-')[0];
            if (
                entry.versions.includes(version) ||
                entry.versions.includes('*')
            ) {
                return true;
            }
        }
        for (const packageName of revoked) {
            if (name.startsWith(packageName.replaceAll('-', '_') + '-'))
                return true;
        }
        return false;
    });
}

export async function removeRevokedPlugins(
    catalog: Pick<CatalogResponse, 'blocked' | 'revoked' | 'plugins'>,
    installedPaths: string[]
): Promise<string[]> {
    const removed: string[] = [];
    const names = new Map(
        (catalog.plugins || []).map((plugin) => [plugin.package, plugin.name])
    );
    for (const file of revokedWheelPaths(catalog, installedPaths)) {
        const name = file.split('/').pop() || '';
        const packageName = [...names.keys()].find((item) =>
            name.startsWith(item.replaceAll('-', '_') + '-')
        );
        const { fontDestinationPluginManager } =
            await import('./font-destination-plugin-manager');
        await fontDestinationPluginManager.uninstall(file);
        removed.push((packageName && names.get(packageName)) || name);
    }
    if (removed.length) {
        const { discoverCompileFilters } =
            await import('./compile-filter-host');
        await discoverCompileFilters().catch(() => undefined);
        showPluginRemovedToast(removed);
    }
    return removed;
}

export async function applyBlockedPlugins(
    blocked: BlockedPlugin[],
    installedPaths: string[]
): Promise<string[]> {
    return removeRevokedPlugins({ blocked, plugins: [] }, installedPaths);
}

function showPluginRemovedToast(names: string[]): void {
    const text = names
        .map((name) => `${name} was removed after your refund.`)
        .join(' ');
    let toast = document.querySelector('.plugin-removed-toast');
    if (!toast) {
        toast = document.createElement('div');
        toast.className = 'plugin-removed-toast';
        document.body.appendChild(toast);
    }
    toast.textContent = text;
}

let lastRevocationCheck = 0;

export async function enforcePluginRevocation(force = false): Promise<void> {
    if (!force && Date.now() - lastRevocationCheck < 60000) return;
    lastRevocationCheck = Date.now();
    const catalog = await fetchPluginCatalog();
    const { rememberPluginIdAliases } = await import('./compile-filter-host');
    rememberPluginIdAliases(catalog.plugins);
    const { fontDestinationPluginManager } =
        await import('./font-destination-plugin-manager');
    const installed =
        await fontDestinationPluginManager.getInstalledWheelFiles();
    await removeRevokedPlugins(
        catalog,
        installed.map((file) => file.path)
    );
}

export function startPluginRevocationWatch(): void {
    window.addEventListener('focus', () => {
        void enforcePluginRevocation(false).catch(() => undefined);
    });
    window.setInterval(
        () => {
            void enforcePluginRevocation(true).catch(() => undefined);
        },
        30 * 60 * 1000
    );
}

export async function revokeBeforeReinstall(): Promise<void> {
    const catalog = await Promise.race([
        fetchPluginCatalog(),
        new Promise<CatalogResponse>((_, reject) => {
            window.setTimeout(() => reject(new Error('catalog timeout')), 4000);
        })
    ]);
    const { rememberPluginIdAliases } = await import('./compile-filter-host');
    rememberPluginIdAliases(catalog.plugins);
    const { fontDestinationPluginManager } =
        await import('./font-destination-plugin-manager');
    const installed =
        await fontDestinationPluginManager.getInstalledWheelFiles();
    await removeRevokedPlugins(
        catalog,
        installed.map((file) => file.path)
    );
}

export function dismissedUpdates(): Record<string, string> {
    try {
        return JSON.parse(
            localStorage.getItem(DISMISSED_KEY) || '{}'
        ) as Record<string, string>;
    } catch {
        return {};
    }
}

export function dismissUpdate(packageName: string, version: string): void {
    const current = dismissedUpdates();
    current[packageName] = version;
    localStorage.setItem(DISMISSED_KEY, JSON.stringify(current));
}

export function countUpdates(
    plugins: CatalogPlugin[],
    installedPaths: string[]
): number {
    const dismissed = dismissedUpdates();
    return plugins.filter((plugin) => {
        const installed = installedVersionFromFilename(
            plugin.package,
            installedPaths
        );
        if (!installed || !plugin.version) return false;
        if (dismissed[plugin.package] === plugin.version) return false;
        return comparePluginVersions(plugin.version, installed) > 0;
    }).length;
}

let updateCount = 0;

export function pluginUpdateCount(): number {
    return updateCount;
}

export async function refreshPluginUpdateCount(): Promise<number> {
    try {
        const catalog = await fetchPluginCatalog();
        const { fontDestinationPluginManager } =
            await import('./font-destination-plugin-manager');
        const installed =
            await fontDestinationPluginManager.getInstalledWheelFiles();
        const paths = installed.map((file) => file.path);
        await applyBlockedPlugins(catalog.blocked, paths);
        updateCount = countUpdates(catalog.plugins, paths);
    } catch {
        updateCount = 0;
    }
    return updateCount;
}

export async function reportPlugin(
    packageName: string,
    reason: string
): Promise<void> {
    await fetch(`${resolveWebsiteURL()}/api/plugins/report`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ package: packageName, reason })
    });
}
