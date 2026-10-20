import {
    FontDestinationManifest,
    fontDestinationPluginManager
} from './font-destination-plugin-manager';
import {
    downloadPluginWheel,
    fetchPluginCatalog,
    fetchPluginPurchases,
    installedVersionFromFilename,
    pluginAction,
    removeRevokedPlugins,
    reportPlugin,
    type CatalogBilling,
    type CatalogPlugin
} from './installed-plugin-manager';
import { resolveWebsiteURL } from './website-url';
import { Logger } from './logger';
import { bindModalEscape, type ModalEscapeBinding } from './ui/modal-escape';
import { createFolderSetupCallout } from './folder-permissions-dialog';
import { settingsFolder } from './settings-folder';
import {
    discoverCompileFilters,
    rememberPluginIdAliases
} from './compile-filter-host';

const console = new Logger('FontDestinationPluginUI');

let pluginManagerEscapeBinding: ModalEscapeBinding | null = null;
let catalogRefreshBound = false;
let purchaseSheetOpen = false;

function paymentMethodText(billing: CatalogBilling): string {
    const email = billing.email ? ` (${billing.email})` : '';
    if (billing.type === 'paypal') return `PayPal${email}`;
    if (billing.type === 'link') return `Link${email}`;
    if (billing.type === 'revolut_pay') return 'Revolut Pay';
    if (billing.type === 'amazon_pay') return 'Amazon Pay';
    if (billing.type === 'klarna') return 'Klarna';
    if (billing.wallet === 'apple_pay')
        return `Apple Pay ·· ${billing.last4 || ''}`;
    if (billing.wallet === 'google_pay')
        return `Google Pay ·· ${billing.last4 || ''}`;
    if (billing.last4) {
        const brand = billing.brand
            ? billing.brand.charAt(0).toUpperCase() + billing.brand.slice(1)
            : 'Card';
        return `${brand} ·· ${billing.last4}`;
    }
    return 'Saved payment method';
}

function countryLabel(code?: string | null): string {
    if (!code) return '';
    try {
        return (
            new Intl.DisplayNames(['en'], { type: 'region' }).of(code) || code
        );
    } catch {
        return code;
    }
}

function formatEuro(cents: number): string {
    return `€${(cents / 100).toFixed(2)}`;
}

function bindCatalogRefresh(content: HTMLElement): void {
    if (catalogRefreshBound) return;
    catalogRefreshBound = true;
    window.addEventListener('focus', () => {
        if (purchaseSheetOpen) return;
        const overlay = document.getElementById('plugin-manager-modal');
        if (!overlay || overlay.style.display === 'none') return;
        void renderPluginManager(content);
    });
}

function createTextElement<K extends keyof HTMLElementTagNameMap>(
    tagName: K,
    text: string,
    className?: string
): HTMLElementTagNameMap[K] {
    const element = document.createElement(tagName);
    element.textContent = text;
    if (className) {
        element.className = className;
    }
    return element;
}

function getModalElements(): {
    overlay: HTMLElement;
    content: HTMLElement;
    closeButton: HTMLButtonElement;
} | null {
    const overlay = document.getElementById('plugin-manager-modal');
    const content = document.getElementById('plugin-manager-modal-content');
    const closeButton = document.getElementById(
        'plugin-manager-modal-close-btn'
    ) as HTMLButtonElement | null;
    if (!overlay || !content || !closeButton) {
        return null;
    }
    return { overlay, content, closeButton };
}

function closePluginManager(): void {
    pluginManagerEscapeBinding?.release();
    pluginManagerEscapeBinding = null;
    const overlay = document.getElementById('plugin-manager-modal');
    if (overlay) {
        overlay.style.display = 'none';
    }
}

async function renderPluginManager(content: HTMLElement): Promise<void> {
    content.replaceChildren(
        createTextElement('p', 'Searching Font Destinations…')
    );
    try {
        const settingsAccess = await settingsFolder.getAccessState();
        if (settingsAccess !== 'ready') {
            const notice = document.createElement('section');
            notice.className = 'plugin-manager-storage-notice';
            notice.appendChild(createFolderSetupCallout());
            content.replaceChildren(notice);
            return;
        }
        const storageStatus =
            await fontDestinationPluginManager.getPluginStorageStatus();
        if (storageStatus !== 'ready') {
            content.replaceChildren(
                createPluginStorageNotice(storageStatus, content)
            );
            return;
        }
        const installedWheels =
            await fontDestinationPluginManager.getInstalledWheelFiles();
        const installedPaths = installedWheels.map((wheel) => wheel.path);
        try {
            const catalog = await fetchPluginCatalog();
            const purchases = await fetchPluginPurchases();
            rememberPluginIdAliases(catalog.plugins);
            await removeRevokedPlugins(catalog, installedPaths);
            for (const plugin of catalog.plugins) {
                plugin.purchased =
                    plugin.purchased || purchases.packages.has(plugin.package);
            }
            content.replaceChildren(
                renderCatalog(
                    catalog.plugins,
                    installedPaths,
                    purchases.signedIn,
                    catalog.billing || {
                        state: purchases.signedIn ? 'payment_method' : 'sign_in'
                    },
                    content
                )
            );
            bindCatalogRefresh(content);
            return;
        } catch (catalogError: unknown) {
            console.warn('Website plugin catalog unavailable:', catalogError);
        }
        const catalogue =
            await fontDestinationPluginManager.discoverCatalogue();
        const installedNames = new Set(
            installedWheels.map((wheel) => wheel.path)
        );
        const section = document.createElement('section');
        section.className = 'plugin-manager-section';
        section.appendChild(createTextElement('h4', 'Font Destinations'));
        const diagnostics = fontDestinationPluginManager.getDiagnostics();
        if (diagnostics.length) {
            section.appendChild(createPluginDiagnostics(diagnostics));
        }

        if (!catalogue.length) {
            section.appendChild(
                createTextElement(
                    'p',
                    'No Font Destination plugins were found on GitHub.'
                )
            );
        }

        for (const manifest of catalogue) {
            section.appendChild(
                createPluginRow(manifest, installedNames, content)
            );
        }
        content.replaceChildren(section);
    } catch (error: unknown) {
        console.error('Could not load Plugin Manager:', error);
        content.replaceChildren(
            createTextElement(
                'p',
                error instanceof Error
                    ? error.message
                    : 'Could not load Font Destination plugins.'
            )
        );
    }
}

function createPluginStorageNotice(
    storageStatus: 'settings-folder-not-connected' | 'plugins-folder-missing',
    content: HTMLElement
): HTMLElement {
    const notice = document.createElement('section');
    notice.className = 'plugin-manager-storage-notice';
    const isSettingsFolderMissing =
        storageStatus === 'settings-folder-not-connected';
    notice.appendChild(
        createTextElement(
            'h4',
            isSettingsFolderMissing
                ? 'Connect a Settings Folder'
                : 'Create the Plugins Folder'
        )
    );
    notice.appendChild(
        createTextElement(
            'p',
            isSettingsFolderMissing
                ? 'Choose the Settings Folder Counterpunch should use for Font Destination plugins.'
                : 'The connected Settings Folder has no /Plugins directory. Plugin wheels are stored there.'
        )
    );
    const action = document.createElement('button');
    action.className = 'dialog-button plugin-manager-action';
    action.type = 'button';
    action.textContent = isSettingsFolderMissing
        ? 'Connect Folder'
        : 'Create Plugins Folder';
    action.addEventListener('click', async () => {
        action.disabled = true;
        try {
            if (isSettingsFolderMissing) {
                await fontDestinationPluginManager.connectSettingsFolder();
            } else {
                await fontDestinationPluginManager.createPluginsDirectory();
            }
            await renderPluginManager(content);
        } catch (error: unknown) {
            window.alert(
                error instanceof Error
                    ? error.message
                    : 'Could not prepare plugin storage.'
            );
            action.disabled = false;
        }
    });
    notice.appendChild(action);
    return notice;
}

function createPluginDiagnostics(messages: string[]): HTMLElement {
    const notice = document.createElement('section');
    notice.className = 'plugin-manager-diagnostics';
    notice.appendChild(createTextElement('h4', 'Plugin Diagnostics'));
    for (const message of messages) {
        notice.appendChild(createTextElement('p', message));
    }
    return notice;
}

function openPurchaseSheet(
    plugin: CatalogPlugin,
    billing: CatalogBilling,
    content: HTMLElement
): void {
    document.querySelector('.plugin-purchase-sheet')?.remove();
    purchaseSheetOpen = true;
    const sheet = document.createElement('div');
    sheet.className = 'plugin-purchase-sheet';
    const card = document.createElement('div');
    card.className = 'plugin-purchase-card';
    sheet.appendChild(card);
    let escapeBinding: { release: () => void } | null = null;
    const close = () => {
        escapeBinding?.release();
        purchaseSheetOpen = false;
        sheet.remove();
    };
    const renderQuote = (current: CatalogPlugin) => {
        card.replaceChildren();
        card.appendChild(createTextElement('h4', current.name));
        if (current.creatorName) {
            card.appendChild(
                createTextElement('p', `By ${current.creatorName}`)
            );
        }
        card.appendChild(
            createTextElement(
                'p',
                `${current.package}${current.version ? ` · v${current.version}` : ''}`
            )
        );
        card.appendChild(
            createTextElement('p', `Price ${formatEuro(current.netCents || 0)}`)
        );
        card.appendChild(
            createTextElement(
                'p',
                `VAT ${formatEuro(current.taxCents || 0)} (${countryLabel(current.country) || current.countryName || ''})`
            )
        );
        card.appendChild(
            createTextElement(
                'p',
                `Total ${formatEuro(current.grossCents || 0)}`
            )
        );
        const cardLine = document.createElement('p');
        cardLine.append(`${paymentMethodText(billing)} `);
        const change = document.createElement('button');
        change.type = 'button';
        change.className = 'plugin-purchase-link';
        change.textContent = 'Change';
        change.addEventListener('click', () => {
            window.open(
                `${resolveWebsiteURL()}/account/payment?return=editor`,
                '_blank'
            );
        });
        cardLine.append(change);
        card.appendChild(cardLine);
        card.appendChild(
            createTextElement('p', 'You will receive an invoice by email.')
        );
        const refunds = document.createElement('a');
        refunds.href = `${resolveWebsiteURL()}/account#purchases`;
        refunds.target = '_blank';
        refunds.rel = 'noopener';
        refunds.textContent = 'Refunds within 14 days';
        card.appendChild(refunds);
        const error = createTextElement('p', '');
        error.className = 'plugin-purchase-error';
        error.hidden = true;
        card.appendChild(error);
        const pay = document.createElement('button');
        pay.type = 'button';
        pay.className = 'dialog-button';
        pay.textContent = `Pay ${formatEuro(current.grossCents || 0)}`;
        const cancel = document.createElement('button');
        cancel.type = 'button';
        cancel.className = 'dialog-button';
        cancel.textContent = 'Cancel';
        cancel.addEventListener('click', close);
        pay.addEventListener('click', () => {
            void payForPlugin(current, pay, error, card, content, close);
        });
        const actions = document.createElement('div');
        actions.className = 'plugin-purchase-actions';
        actions.append(pay, cancel);
        card.appendChild(actions);
    };
    renderQuote(plugin);
    sheet.addEventListener('click', (event) => {
        if (event.target === sheet) close();
    });
    document.body.appendChild(sheet);
    escapeBinding = bindModalEscape(close);

    async function payForPlugin(
        current: CatalogPlugin,
        pay: HTMLButtonElement,
        error: HTMLElement,
        card: HTMLElement,
        host: HTMLElement,
        closeSheet: () => void
    ) {
        pay.disabled = true;
        pay.textContent = 'Paying…';
        error.hidden = true;
        const response = await fetch(
            `${resolveWebsiteURL()}/api/plugins/${encodeURIComponent(current.package)}/purchase`,
            {
                method: 'POST',
                credentials: 'include',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ expectedGrossCents: current.grossCents })
            }
        );
        const body = (await response.json().catch(() => ({}))) as {
            status?: string;
            error?: string;
            invoicePdf?: string | null;
            hostedInvoiceUrl?: string | null;
            quote?: CatalogPlugin;
        };
        if (body.status === 'processing') {
            error.hidden = false;
            error.textContent = 'Payment processing';
            pay.textContent = 'Waiting…';
            const paid = await pollPluginPurchase(current.package);
            if (!paid) {
                error.textContent =
                    'The payment is still processing. It will finish in the background.';
                pay.disabled = false;
                return;
            }
            await showPurchased(current, paid, card, host, closeSheet);
            return;
        }
        if (response.status === 409 && body.quote?.grossCents != null) {
            renderQuote({ ...current, ...body.quote, priceState: 'ready' });
            return;
        }
        if (body.status === 'requires_action' && body.hostedInvoiceUrl) {
            window.open(body.hostedInvoiceUrl, '_blank');
            pay.textContent = 'Waiting for confirmation…';
            const paid = await pollPluginPurchase(current.package);
            if (!paid) {
                error.hidden = false;
                error.textContent =
                    'The payment is still waiting. Finish it in the other tab, then try again.';
                pay.disabled = false;
                pay.textContent = `Pay ${formatEuro(current.grossCents || 0)}`;
                return;
            }
            await showPurchased(current, paid, card, host, closeSheet);
            return;
        }
        if (!response.ok || body.status !== 'paid') {
            error.hidden = false;
            error.textContent =
                body.error || 'The payment method was declined.';
            const change = document.createElement('button');
            change.type = 'button';
            change.className = 'plugin-purchase-link';
            change.textContent = 'Change payment method';
            change.addEventListener('click', () => {
                window.open(
                    `${resolveWebsiteURL()}/account/payment?return=editor`,
                    '_blank'
                );
            });
            error.append(document.createElement('br'), change);
            pay.disabled = false;
            pay.textContent = `Pay ${formatEuro(current.grossCents || 0)}`;
            return;
        }
        await showPurchased(current, body, card, host, closeSheet);
    }
}

async function pollPluginPurchase(packageName: string): Promise<{
    invoicePdf?: string | null;
    hostedInvoiceUrl?: string | null;
} | null> {
    for (let attempt = 0; attempt < 30; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 2000));
        const response = await fetch(
            `${resolveWebsiteURL()}/api/plugins/${encodeURIComponent(packageName)}/purchase`,
            { credentials: 'include' }
        );
        if (!response.ok) continue;
        const body = (await response.json()) as {
            status?: string;
            invoicePdf?: string | null;
            hostedInvoiceUrl?: string | null;
        };
        if (body.status === 'paid') return body;
    }
    return null;
}

async function showPurchased(
    plugin: CatalogPlugin,
    purchase: { invoicePdf?: string | null; hostedInvoiceUrl?: string | null },
    card: HTMLElement,
    content: HTMLElement,
    close: () => void
): Promise<void> {
    try {
        await downloadPluginWheel(plugin);
        await discoverCompileFilters();
    } catch (error: unknown) {
        console.warn('Plugin installed after purchase failed:', error);
    }
    card.replaceChildren();
    card.appendChild(createTextElement('h4', 'Purchased'));
    card.appendChild(createTextElement('p', `${plugin.name} is ready to use.`));
    const invoiceUrl = purchase.invoicePdf || purchase.hostedInvoiceUrl;
    if (invoiceUrl) {
        const link = document.createElement('a');
        link.href = invoiceUrl;
        link.target = '_blank';
        link.rel = 'noopener';
        link.textContent = 'View invoice';
        card.appendChild(link);
    }
    const done = document.createElement('button');
    done.type = 'button';
    done.className = 'dialog-button';
    done.textContent = 'Done';
    done.addEventListener('click', () => {
        close();
        void renderPluginManager(content);
    });
    card.appendChild(done);
}

function renderCatalog(
    plugins: CatalogPlugin[],
    installedPaths: string[],
    signedIn: boolean,
    billing: CatalogBilling,
    content: HTMLElement
): HTMLElement {
    const section = document.createElement('section');
    section.className = 'plugin-manager-section';
    section.appendChild(createTextElement('h4', 'Plugins'));
    if (billing.state === 'payment_method') {
        const banner = document.createElement('div');
        banner.className = 'plugin-manager-banner';
        banner.appendChild(
            createTextElement(
                'p',
                'Add a payment method to see prices and buy plugins in one click.'
            )
        );
        const add = document.createElement('button');
        add.type = 'button';
        add.className = 'dialog-button plugin-manager-action';
        add.textContent = 'Add payment method';
        add.addEventListener('click', () => {
            window.open(
                `${resolveWebsiteURL()}/account/payment?return=editor`,
                '_blank'
            );
        });
        banner.appendChild(add);
        section.appendChild(banner);
    }
    const search = document.createElement('input');
    search.type = 'search';
    search.className = 'plugin-manager-search';
    search.placeholder = 'Search by name, package, or description';
    search.setAttribute('aria-label', 'Search plugins');
    section.appendChild(search);
    if (!plugins.length) {
        section.appendChild(
            createTextElement('p', 'No plugins are published yet.')
        );
        return section;
    }
    const empty = createTextElement('p', 'No plugins match that search.');
    empty.hidden = true;
    section.appendChild(empty);
    const rows: HTMLElement[] = [];
    for (const plugin of plugins) {
        const installed = installedVersionFromFilename(
            plugin.package,
            installedPaths
        );
        const actionName = pluginAction({
            plugin,
            installedVersion: installed,
            signedIn
        });
        const row = document.createElement('article');
        row.className = 'plugin-manager-row';
        row.dataset.search =
            `${plugin.name} ${plugin.package} ${plugin.description}`.toLowerCase();
        const details = document.createElement('div');
        details.className = 'plugin-manager-details';
        const title = document.createElement('h5');
        title.className = 'plugin-manager-title';
        title.appendChild(document.createTextNode(plugin.name));
        title.appendChild(screenedMark());
        details.appendChild(title);
        details.appendChild(createTextElement('p', plugin.description));
        if (plugin.kind === 'commercial' && !plugin.purchased) {
            const priceLine =
                plugin.priceState === 'ready' && plugin.grossCents != null
                    ? `${formatEuro(plugin.grossCents)} incl. ${formatEuro(plugin.taxCents || 0)} VAT (${countryLabel(plugin.country) || plugin.countryName || ''})`
                    : actionName === 'sign-in'
                      ? 'Paid plugin · Sign in to see your price'
                      : 'Paid plugin · Price appears after you add a payment method';
            details.appendChild(createTextElement('p', priceLine));
        }
        row.appendChild(details);
        const action = document.createElement('button');
        action.className = 'dialog-button plugin-manager-action';
        action.type = 'button';
        const labels: Record<string, string> = {
            'buy': 'Buy',
            'sign-in': 'Sign in',
            'payment-method': 'Add payment method',
            'install': 'Install',
            'update': `Update to ${plugin.version}`,
            'uninstall': 'Uninstall',
            'incompatible': 'Incompatible'
        };
        action.textContent = labels[actionName];
        action.disabled = actionName === 'incompatible';
        action.addEventListener('click', async () => {
            action.disabled = true;
            try {
                if (actionName === 'sign-in') {
                    void window.authManager?.login();
                    return;
                } else if (actionName === 'payment-method') {
                    window.open(
                        `${resolveWebsiteURL()}/account/payment?return=editor`,
                        '_blank'
                    );
                } else if (actionName === 'buy') {
                    openPurchaseSheet(plugin, billing, content);
                    action.disabled = false;
                    return;
                } else if (actionName === 'uninstall' && installed) {
                    const path = installedPaths.find((item) =>
                        (item.split('/').pop() || '').startsWith(
                            plugin.package.replaceAll('-', '_') + '-'
                        )
                    );
                    if (path)
                        await fontDestinationPluginManager.uninstall(path);
                } else {
                    await downloadPluginWheel(plugin);
                    await discoverCompileFilters();
                }
                if (actionName === 'payment-method') {
                    action.disabled = false;
                    return;
                }
                await renderPluginManager(content);
            } catch (error: unknown) {
                window.alert(
                    error instanceof Error
                        ? error.message
                        : 'Plugin installation failed.'
                );
                action.disabled = false;
            }
        });
        const report = document.createElement('button');
        report.type = 'button';
        report.className = 'dialog-button plugin-manager-action';
        report.textContent = 'Report';
        report.addEventListener('click', async () => {
            const reason = window.prompt(
                'What should we know about this plugin?'
            );
            if (reason) await reportPlugin(plugin.package, reason);
        });
        row.appendChild(action);
        row.appendChild(report);
        section.appendChild(row);
        rows.push(row);
    }
    search.addEventListener('input', () => {
        const query = search.value.trim().toLowerCase();
        let visible = 0;
        for (const row of rows) {
            const matches =
                !query || (row.dataset.search || '').includes(query);
            row.hidden = !matches;
            if (matches) visible += 1;
        }
        empty.hidden = visible > 0;
    });
    return section;
}

const SCREENED_TOOLTIP =
    'From the Counterpunch catalog. Before publication, the release is run in a sandbox and screened for sending data off your computer, changing the font outside that plugin type contract, and crashing or hanging the editor.';

function screenedMark(): HTMLElement {
    const mark = document.createElement('span');
    mark.className = 'plugin-screened';
    mark.title = SCREENED_TOOLTIP;
    mark.setAttribute('aria-label', SCREENED_TOOLTIP);
    mark.innerHTML =
        '<svg viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M8 1.2 2.5 3.4v4.2c0 3.3 2.3 5.6 5.5 6.8 3.2-1.2 5.5-3.5 5.5-6.8V3.4L8 1.2Zm0 1.7 3.8 1.5v3.1c0 2.4-1.6 4.2-3.8 5.2-2.2-1-3.8-2.8-3.8-5.2V4.4L8 2.9Z"/></svg>';
    return mark;
}

function createPluginRow(
    manifest: FontDestinationManifest,
    installedNames: Set<string>,
    content: HTMLElement
): HTMLElement {
    const isInstalled = Array.from(installedNames).some((path) =>
        path.split('/').pop()?.startsWith(manifest.wheelAssetPrefix)
    );
    const row = document.createElement('article');
    row.className = 'plugin-manager-row';

    const details = document.createElement('div');
    details.className = 'plugin-manager-details';
    details.appendChild(createTextElement('h5', manifest.name));
    details.appendChild(createTextElement('p', manifest.description));
    if (manifest.imageUrl) {
        const image = document.createElement('img');
        image.className = 'plugin-manager-image';
        image.alt = `${manifest.name} preview`;
        image.crossOrigin = 'anonymous';
        image.loading = 'lazy';
        image.decoding = 'async';
        image.src = manifest.imageUrl;
        details.appendChild(image);
    }
    const repository = document.createElement('a');
    repository.href = manifest.repositoryUrl;
    repository.target = '_blank';
    repository.rel = 'noreferrer';
    repository.textContent = 'View on GitHub';
    details.appendChild(repository);
    row.appendChild(details);

    const action = document.createElement('button');
    action.className = 'dialog-button plugin-manager-action';
    action.type = 'button';
    action.textContent = isInstalled ? 'Uninstall' : 'Install';
    action.addEventListener('click', async () => {
        action.disabled = true;
        try {
            if (isInstalled) {
                const wheel = Array.from(installedNames).find((path) =>
                    path.split('/').pop()?.startsWith(manifest.wheelAssetPrefix)
                );
                if (wheel) {
                    await fontDestinationPluginManager.uninstall(wheel);
                }
            } else {
                await fontDestinationPluginManager.install(manifest);
            }
            await renderPluginManager(content);
        } catch (error: unknown) {
            window.alert(
                error instanceof Error
                    ? error.message
                    : 'Plugin installation failed.'
            );
            action.disabled = false;
        }
    });
    row.appendChild(action);
    return row;
}

/** Open the shared modal with catalogue entries and install controls. */
export async function showFontDestinationPluginManager(): Promise<void> {
    const elements = getModalElements();
    if (!elements) {
        return;
    }
    elements.overlay.style.display = 'flex';
    if (!pluginManagerEscapeBinding) {
        pluginManagerEscapeBinding = bindModalEscape(closePluginManager, {
            isOpen: () =>
                document.getElementById('plugin-manager-modal')?.style
                    .display === 'flex'
        });
    }
    elements.closeButton.onclick = closePluginManager;
    elements.overlay.onclick = (event) => {
        if (event.target === elements.overlay) {
            closePluginManager();
        }
    };
    await renderPluginManager(elements.content);
}
