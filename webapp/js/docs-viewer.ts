import { Logger } from './logger';
import { buildDocsHref } from './link-navigation';
import {
    keyboardShortcutHtml,
    platformUsesCommandKey,
    shortcutSpecFromHandbook
} from './keyboard-shortcut-display';
import {
    getDocsPageId,
    getDocsWidthPx,
    getFocusViewId,
    isDocsOpen,
    saveWindowUiFromDom,
    setDocsPageId
} from './window-ui-state';

const console = new Logger('DocsViewer');

const HANDBOOK_ROOT = '/handbook';
const DEFAULT_WIDTH = 340;
const MIN_WIDTH = 200;

export type DocsManifestNode = {
    id: string;
    title: string;
    kind: 'section' | 'page';
    path?: string;
    children?: DocsManifestNode[];
};

export type DocsManifest = {
    version: number;
    defaultId: string;
    nodes: DocsManifestNode[];
};

type PageRecord = {
    id: string;
    title: string;
    path: string;
};

function slugify(text: string): string {
    return text
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
}

function docsHeadingId(raw: string): string {
    const slug = raw.replace(/^docs-/, '');
    return slug ? `docs-${slug}` : '';
}

function isLightAppTheme(): boolean {
    return document.documentElement.getAttribute('data-theme') === 'light';
}

function canonicalHandbookImageSrc(src: string): string {
    return src.replace(/-dark(\.[a-z0-9]+)$/i, '$1');
}

function darkHandbookImageSrc(src: string): string {
    const canonical = canonicalHandbookImageSrc(src);
    return canonical.replace(/(\.[a-z0-9]+)$/i, '-dark$1');
}

function themedHandbookImageSrc(src: string): string {
    const canonical = canonicalHandbookImageSrc(src);
    if (/^(https?:|data:)/i.test(canonical)) {
        return canonical;
    }
    if (!/\.(png|jpe?g|webp|gif)$/i.test(canonical)) {
        return canonical;
    }
    return isLightAppTheme() ? canonical : darkHandbookImageSrc(canonical);
}

function localizeModifierNotation(markdown: string): string {
    const command = platformUsesCommandKey() ? 'Cmd' : 'Ctrl';
    const option = platformUsesCommandKey() ? 'Option' : 'Alt';
    return markdown
        .replaceAll('Cmd/Ctrl', command)
        .replaceAll('Alt/Option', option);
}

function flattenPages(
    nodes: DocsManifestNode[],
    into: Map<string, PageRecord>
) {
    for (const node of nodes) {
        if (node.kind === 'page' && node.path) {
            into.set(node.id, {
                id: node.id,
                title: node.title,
                path: node.path
            });
        }
        if (node.children) {
            flattenPages(node.children, into);
        }
    }
}

function handbookUrl(relativePath: string): string {
    return `${HANDBOOK_ROOT}/${relativePath.replace(/^\/+/, '')}`;
}

export class DocsViewer {
    private readonly shell: HTMLElement;
    private readonly view: HTMLElement;
    private readonly tocEl: HTMLElement;
    private readonly articleEl: HTMLElement;
    private readonly closeBtn: HTMLButtonElement;
    private manifest: DocsManifest | null = null;
    private pages = new Map<string, PageRecord>();
    private currentId: string | null = null;
    private loadPromise: Promise<void> | null = null;
    private animationTimer: number | null = null;

    constructor() {
        const shell = document.getElementById('app-shell');
        const view = document.getElementById('view-docs');
        const divider = document.getElementById('docs-divider');
        const tocEl = document.getElementById('docs-toc');
        const articleEl = document.getElementById('docs-article');
        const closeBtn = document.getElementById(
            'docs-close-btn'
        ) as HTMLButtonElement | null;

        if (!shell || !view || !divider || !tocEl || !articleEl || !closeBtn) {
            throw new Error('Documentation viewer markup is missing');
        }

        this.shell = shell;
        this.view = view;
        this.tocEl = tocEl;
        this.articleEl = articleEl;
        this.closeBtn = closeBtn;

        this.view.style.flex = '0 0 0px';
        this.closeBtn.addEventListener('click', () => this.close());
        this.articleEl.addEventListener('click', (event) =>
            this.onArticleClick(event)
        );
        void this.restorePersistedOpen();
    }

    isOpen(): boolean {
        return this.shell.classList.contains('docs-open');
    }

    restorePersistedOpen(): void {
        if (!this.readSavedOpen()) {
            return;
        }
        if (!this.isOpen()) {
            this.setColumnOpen(true, { animate: false, persist: false });
        }
        void this.loadPersistedPage();
    }

    refreshCodeHighlight(): void {
        this.highlightCodeBlocks();
    }

    refreshThemedImages(): void {
        this.applyThemedImages();
    }

    async open(id?: string, heading?: string): Promise<void> {
        await this.ensureManifest();
        const targetId =
            id ||
            this.readLastPageId() ||
            this.manifest?.defaultId ||
            this.pages.keys().next().value;
        if (!targetId) {
            console.error('Documentation manifest has no pages');
            return;
        }
        if (!this.isOpen()) {
            this.setColumnOpen(true);
        }
        window.focusView?.('view-docs');
        await this.showPage(targetId, heading);
        // showPage / layout work can race the focusView lock; ensure Docs ends
        // focused after the page is on screen (Cmd+Escape and chrome depend on it).
        if (
            !this.view.classList.contains('focused') ||
            window.getCurrentFocusedView?.() !== 'view-docs'
        ) {
            window.focusView?.('view-docs');
        }
        this.scrollCurrentTocIntoView();
        requestAnimationFrame(() => this.scrollCurrentTocIntoView());
    }

    close(): void {
        if (!this.isOpen()) {
            return;
        }
        const docsWereFocused =
            this.view.classList.contains('focused') ||
            window.getCurrentFocusedView?.() === 'view-docs';
        this.setColumnOpen(false);
        if (!docsWereFocused) {
            return;
        }
        const lastActiveView = getFocusViewId();
        window.focusView?.(
            lastActiveView && lastActiveView !== 'view-docs'
                ? lastActiveView
                : 'view-editor'
        );
    }

    private animationConfig(): {
        enabled: boolean;
        duration: number;
        easing: string;
    } {
        const animation = window.VIEW_SETTINGS?.animation as
            | { enabled?: boolean; duration?: number; easing?: string }
            | undefined;
        return {
            enabled: animation?.enabled !== false,
            duration:
                typeof animation?.duration === 'number'
                    ? animation.duration
                    : 300,
            easing:
                typeof animation?.easing === 'string'
                    ? animation.easing
                    : 'ease-in-out'
        };
    }

    private setColumnOpen(
        open: boolean,
        options?: { animate?: boolean; persist?: boolean }
    ): void {
        const persist = options?.persist !== false;
        const { enabled, duration, easing } = this.animationConfig();
        const animate = options?.animate !== false && enabled;
        const divider = document.getElementById('docs-divider');
        const container = this.shell.querySelector(
            '.container'
        ) as HTMLElement | null;
        const animated = [this.view, divider, container].filter(
            (element): element is HTMLElement => Boolean(element)
        );

        if (this.animationTimer !== null) {
            window.clearTimeout(this.animationTimer);
            this.animationTimer = null;
        }

        if (animate) {
            const transition = [
                `flex ${duration}ms ${easing}`,
                `margin ${duration}ms ${easing}`,
                `width ${duration}ms ${easing}`,
                `border-width ${duration}ms ${easing}`,
                `padding ${duration}ms ${easing}`,
                `opacity ${duration}ms ${easing}`
            ].join(', ');
            for (const element of animated) {
                element.style.transition = transition;
            }
        }

        if (open) {
            this.shell.classList.add('docs-open');
            this.view.setAttribute('aria-hidden', 'false');
            void this.view.offsetWidth;
            this.view.style.flex = `0 0 ${this.storedWidth()}px`;
        } else {
            this.view.style.flex = '0 0 0px';
            this.shell.classList.remove('docs-open');
            this.view.setAttribute('aria-hidden', 'true');
        }

        const finish = () => {
            this.animationTimer = null;
            for (const element of animated) {
                element.style.transition = '';
            }
        };

        if (animate) {
            this.animationTimer = window.setTimeout(finish, duration);
        } else {
            finish();
        }

        if (persist) {
            this.persistLayout();
        }
    }

    private persistLayout(): void {
        if (window.resizableViews) {
            window.resizableViews.saveLayout();
            return;
        }
        saveWindowUiFromDom();
    }

    private readSavedOpen(): boolean {
        return isDocsOpen();
    }

    private async loadPersistedPage(): Promise<void> {
        await this.ensureManifest();
        const targetId =
            this.readLastPageId() ||
            this.manifest?.defaultId ||
            this.pages.keys().next().value;
        if (!targetId) {
            return;
        }
        await this.showPage(targetId);
        this.scrollCurrentTocIntoView();
    }

    private storedWidth(): number {
        return Math.max(MIN_WIDTH, getDocsWidthPx() || DEFAULT_WIDTH);
    }

    private readLastPageId(): string | null {
        const stored = getDocsPageId();
        if (stored && this.pages.has(stored)) {
            return stored;
        }
        return null;
    }

    private async ensureManifest(): Promise<void> {
        if (this.manifest) {
            return;
        }
        if (!this.loadPromise) {
            this.loadPromise = this.loadManifest();
        }
        await this.loadPromise;
    }

    private async loadManifest(): Promise<void> {
        const response = await fetch(handbookUrl('manifest.json'));
        if (!response.ok) {
            throw new Error('Failed to load documentation manifest');
        }
        this.manifest = (await response.json()) as DocsManifest;
        this.pages = new Map();
        flattenPages(this.manifest.nodes, this.pages);
        this.renderToc();
    }

    private renderToc(): void {
        if (!this.manifest) {
            return;
        }
        this.tocEl.replaceChildren(this.renderTocList(this.manifest.nodes));
    }

    private renderTocList(nodes: DocsManifestNode[]): HTMLUListElement {
        const list = document.createElement('ul');
        list.className = 'docs-toc-list';
        for (const node of nodes) {
            const item = document.createElement('li');
            if (node.kind === 'section') {
                const details = document.createElement('details');
                details.open = true;
                const summary = document.createElement('summary');
                summary.textContent = node.title;
                details.appendChild(summary);
                if (node.path) {
                    summary.classList.add('docs-toc-link');
                    summary.dataset.docsId = node.id;
                    summary.addEventListener('click', (event) => {
                        event.preventDefault();
                        details.open = !details.open;
                        void this.open(node.id);
                    });
                }
                if (node.children && node.children.length > 0) {
                    details.appendChild(this.renderTocList(node.children));
                }
                item.appendChild(details);
            } else {
                const button = document.createElement('button');
                button.type = 'button';
                button.className = 'docs-toc-link';
                button.dataset.docsId = node.id;
                button.textContent = node.title;
                button.addEventListener('click', () => {
                    void this.open(node.id);
                });
                item.appendChild(button);
            }
            list.appendChild(item);
        }
        return list;
    }

    private highlightToc(): void {
        this.tocEl.querySelectorAll('.docs-toc-link').forEach((el) => {
            el.classList.toggle(
                'is-current',
                el.getAttribute('data-docs-id') === this.currentId
            );
        });
        const current = this.tocEl.querySelector('.docs-toc-link.is-current');
        let ancestor: Element | null = current;
        while (ancestor && ancestor !== this.tocEl) {
            if (ancestor instanceof HTMLDetailsElement) {
                ancestor.open = true;
            }
            ancestor = ancestor.parentElement;
        }
        this.scrollCurrentTocIntoView();
    }

    private scrollCurrentTocIntoView(): void {
        const current = this.tocEl.querySelector('.docs-toc-link.is-current');
        if (!(current instanceof HTMLElement)) {
            return;
        }
        current.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }

    private async showPage(id: string, heading?: string): Promise<void> {
        const page = this.pages.get(id);
        if (!page) {
            this.articleEl.textContent = `Unknown documentation page: ${id}`;
            return;
        }
        this.currentId = id;
        setDocsPageId(id);
        this.highlightToc();

        const markdown = await this.fetchText(handbookUrl(page.path));
        this.articleEl.innerHTML = this.renderMarkdown(markdown, page.path);

        this.rewriteMedia(page.path);
        this.highlightCodeBlocks();
        if (heading) {
            const prefixed = docsHeadingId(heading);
            const target =
                this.articleEl.querySelector(`#${CSS.escape(prefixed)}`) ||
                this.articleEl.querySelector(`#${CSS.escape(heading)}`);
            target?.scrollIntoView({ block: 'start' });
        } else {
            this.articleEl.scrollTop = 0;
        }
    }

    private renderMarkdown(markdown: string, relativePath: string): string {
        const localized = localizeModifierNotation(markdown);
        if (typeof marked === 'undefined') {
            return localized;
        }
        const html = marked.parse(localized, { gfm: true, breaks: false });
        const htmlText = typeof html === 'string' ? html : String(html);
        const wrap = document.createElement('div');
        wrap.innerHTML = htmlText;
        wrap.querySelectorAll('h1, h2, h3, h4').forEach((heading) => {
            heading.id = docsHeadingId(
                heading.id || slugify(heading.textContent || '')
            );
        });
        wrap.querySelectorAll('img').forEach((img) => {
            const src = img.getAttribute('src');
            if (src) {
                img.setAttribute(
                    'src',
                    this.resolveAssetSrc(src, relativePath)
                );
            }
        });
        wrap.querySelectorAll('a').forEach((anchor) => {
            const href = anchor.getAttribute('href');
            if (!href) {
                return;
            }
            const resolved = this.resolveLink(href, relativePath);
            if (resolved.kind === 'external') {
                anchor.setAttribute('target', '_blank');
                anchor.setAttribute('rel', 'noopener noreferrer');
                return;
            }
            if (resolved.kind === 'page') {
                anchor.setAttribute(
                    'href',
                    buildDocsHref(resolved.id, resolved.heading)
                );
                anchor.dataset.docsId = resolved.id;
                if (resolved.heading) {
                    anchor.dataset.docsHeading = resolved.heading;
                }
            }
        });
        wrap.querySelectorAll('code').forEach((code) => {
            if (code.parentElement?.tagName === 'PRE') {
                return;
            }
            const spec = shortcutSpecFromHandbook(code.textContent || '');
            if (spec === null) {
                return;
            }
            code.classList.add('docs-shortcut-chip');
            code.innerHTML = keyboardShortcutHtml(spec);
        });
        wrap.querySelectorAll('pre > code').forEach((code) => {
            const hasLanguage = [...code.classList].some(
                (cls) => cls.startsWith('language-') || cls.startsWith('lang-')
            );
            if (!hasLanguage) {
                code.classList.add('language-python');
            }
        });
        return wrap.innerHTML;
    }

    private highlightCodeBlocks(): void {
        const blocks = this.articleEl.querySelectorAll('pre');
        const ace = window.ace;
        if (!ace?.require || blocks.length === 0) {
            return;
        }

        type AceHighlightMode = { $id?: string };
        type AceHighlightTheme = { cssClass?: string; cssText?: string };
        type AceStaticHighlight = {
            renderSync: (
                input: string,
                mode: AceHighlightMode,
                theme: AceHighlightTheme,
                lineStart: number,
                disableGutter: boolean
            ) => { html: string; css: string };
        };

        let highlighter: AceStaticHighlight;
        let theme: AceHighlightTheme;
        let PythonMode: new () => AceHighlightMode;
        try {
            highlighter = ace.require(
                'ace/ext/static_highlight'
            ) as AceStaticHighlight;
            const themePath =
                document.documentElement.getAttribute('data-theme') === 'light'
                    ? 'ace/theme/tomorrow'
                    : 'ace/theme/tomorrow_night';
            theme = ace.require(themePath) as AceHighlightTheme;
            PythonMode = (
                ace.require('ace/mode/python') as {
                    Mode: new () => AceHighlightMode;
                }
            ).Mode;
        } catch (error) {
            console.warn('Ace static highlight is unavailable', error);
            return;
        }

        if (!highlighter?.renderSync || !PythonMode) {
            return;
        }

        blocks.forEach((pre) => {
            if (!(pre instanceof HTMLElement)) {
                return;
            }
            const code = pre.querySelector('code');
            const source =
                pre.dataset.docsSource ??
                code?.textContent ??
                pre.textContent ??
                '';
            pre.dataset.docsSource = source;
            const result = highlighter.renderSync(
                source.replace(/\n$/, ''),
                new PythonMode(),
                theme,
                1,
                true
            );
            this.applyAceHighlightCss(result.css);
            pre.classList.add('docs-code-block');
            pre.innerHTML = result.html;
        });
    }

    private applyAceHighlightCss(css: string): void {
        let style = document.getElementById('docs-ace-highlight-css');
        if (!style) {
            style = document.createElement('style');
            style.id = 'docs-ace-highlight-css';
            document.head.appendChild(style);
        }
        style.textContent = css;
    }

    private rewriteMedia(relativePath: string): void {
        this.articleEl.querySelectorAll('img').forEach((img) => {
            const resolved = img.getAttribute('src');
            if (resolved) {
                img.dataset.docsSrc = canonicalHandbookImageSrc(resolved);
            }
            img.addEventListener('error', () => {
                const canonical = img.dataset.docsSrc;
                const current = img.getAttribute('src');
                if (canonical && current && current !== canonical) {
                    img.setAttribute('src', canonical);
                    return;
                }
                img.classList.add('docs-image-missing');
            });
            void relativePath;
        });
        this.applyThemedImages();
    }

    private applyThemedImages(): void {
        this.articleEl.querySelectorAll('img').forEach((img) => {
            const canonical =
                img.dataset.docsSrc ||
                canonicalHandbookImageSrc(img.getAttribute('src') || '');
            if (!canonical) {
                return;
            }
            img.dataset.docsSrc = canonical;
            const next = themedHandbookImageSrc(canonical);
            if (img.getAttribute('src') !== next) {
                img.classList.remove('docs-image-missing');
                img.setAttribute('src', next);
            }
        });
    }

    private resolveAssetSrc(href: string, currentPath: string): string {
        if (/^(https?:|data:|\/)/i.test(href)) {
            return href;
        }
        const currentDir = currentPath.includes('/')
            ? currentPath.slice(0, currentPath.lastIndexOf('/'))
            : '';
        const joined = currentDir ? `${currentDir}/${href}` : href;
        const normalized = joined.split('/').reduce<string[]>((parts, part) => {
            if (part === '.' || part === '') {
                return parts;
            }
            if (part === '..') {
                parts.pop();
                return parts;
            }
            parts.push(part);
            return parts;
        }, []);
        return handbookUrl(normalized.join('/'));
    }

    private resolveLink(
        href: string,
        currentPath: string
    ):
        | { kind: 'external' }
        | { kind: 'page'; id: string; heading?: string }
        | { kind: 'other' } {
        if (
            href.startsWith('http://') ||
            href.startsWith('https://') ||
            href.startsWith('mailto:')
        ) {
            return { kind: 'external' };
        }
        if (href.startsWith('#')) {
            return {
                kind: 'page',
                id: this.currentId || '',
                heading: href.slice(1)
            };
        }
        const [rawPath, hash] = href.split('#');
        if (!rawPath.toLowerCase().endsWith('.md')) {
            return { kind: 'other' };
        }
        const resolvedSrc = this.resolveAssetSrc(rawPath, currentPath).replace(
            `${HANDBOOK_ROOT}/`,
            ''
        );
        for (const page of this.pages.values()) {
            if (
                page.path === resolvedSrc ||
                page.path.replace(/\.md$/i, '') ===
                    resolvedSrc.replace(/\.md$/i, '')
            ) {
                return { kind: 'page', id: page.id, heading: hash };
            }
        }
        return { kind: 'other' };
    }

    private onArticleClick(event: MouseEvent): void {
        const target = (event.target as HTMLElement | null)?.closest('a');
        if (!target || !this.articleEl.contains(target)) {
            return;
        }
        const id = target.dataset.docsId;
        if (!id) {
            return;
        }
        event.preventDefault();
        void this.open(id, target.dataset.docsHeading);
    }

    private async fetchText(url: string): Promise<string> {
        const response = await fetch(url);
        if (!response.ok) {
            throw new Error(`Failed to load ${url}`);
        }
        return await response.text();
    }
}

export function initDocsViewer(): void {
    try {
        const viewer = new DocsViewer();
        window.docsViewer = viewer;
        window.openDocs = (id?: string, heading?: string) => {
            return viewer.open(id, heading);
        };
        window.closeDocs = () => viewer.close();
    } catch (error) {
        console.error('Documentation viewer failed to initialize', error);
    }
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initDocsViewer);
} else {
    initDocsViewer();
}
