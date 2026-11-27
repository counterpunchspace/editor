import tippy, { type Instance } from 'tippy.js';
import type { QaLabel } from './auto-qa-matcher';
import { formatQaLabel, isCorpusQaLabel } from './auto-qa-matcher';
import { getTheme } from '../tippy-utils';
import { escapeHtml } from '../ui/escape-html';

let autoQaTippy: Instance | null = null;

const AUTO_QA_EXPLAINER =
    'Compared with similar glyphs in open-source fonts. Suggestions only.';

/**
 * Property-panel Auto QA control: a bordered warning icon, hidden when
 * there are no labels. Hover shows a tippy with the hints and a short
 * explainer. Does not offer auto-fix.
 */
export function renderAutoQaWidget(labels: QaLabel[]): HTMLElement | null {
    destroyAutoQaTippy();
    if (labels.length === 0) {
        return null;
    }

    const widget = document.createElement('div');
    widget.className = 'glyph-property-control glyph-auto-qa-widget';
    widget.dataset.propertyField = 'auto-qa';

    const label = document.createElement('span');
    label.className = 'glyph-property-control-label';
    label.textContent = 'QA';
    label.title = 'Auto QA';
    widget.appendChild(label);

    const icon = document.createElement('span');
    icon.className = 'material-symbols-outlined glyph-auto-qa-icon';
    icon.textContent = 'warning';
    icon.setAttribute('role', 'img');
    icon.setAttribute('aria-label', 'Auto QA warnings');
    widget.appendChild(icon);

    autoQaTippy = tippy(widget, {
        content: buildAutoQaPopup(labels),
        allowHTML: true,
        interactive: true,
        trigger: 'mouseenter focus',
        appendTo: () => document.body,
        placement: 'top',
        theme: getTheme(),
        maxWidth: 360
    });

    return widget;
}

export function destroyAutoQaTippy(): void {
    autoQaTippy?.destroy();
    autoQaTippy = null;
}

export function buildAutoQaPopup(labels: QaLabel[]): HTMLElement {
    const root = document.createElement('div');
    root.className = 'info-popup-content glyph-auto-qa-popup';

    const list = document.createElement('ul');
    list.className = 'glyph-auto-qa-item-list';
    for (const item of labels) {
        const row = document.createElement('li');
        row.className = 'glyph-auto-qa-item';
        row.dataset.kind = item.kind;
        row.dataset.missing = item.missing;
        row.innerHTML = renderQaMarkdown(formatQaLabel(item));
        list.appendChild(row);
    }
    root.appendChild(list);

    if (!labels.some(isCorpusQaLabel)) {
        return root;
    }
    const explainer = document.createElement('div');
    explainer.className = 'glyph-auto-qa-explainer';
    explainer.innerHTML = renderQaMarkdown(AUTO_QA_EXPLAINER);
    root.appendChild(explainer);
    return root;
}

function renderInlineCodeAsPre(text: string): string {
    return `<pre>${escapeHtml(text)}</pre>`;
}

function renderQaMarkdown(markdown: string): string {
    if (typeof marked !== 'undefined') {
        const renderer = new marked.Renderer();
        renderer.codespan = (token: string | { text: string }) =>
            renderInlineCodeAsPre(
                typeof token === 'string' ? token : token.text
            );
        return marked.parse(markdown, {
            renderer,
            gfm: true,
            breaks: true
        }) as string;
    }
    return `<p>${markdown.replace(/`([^`]+)`/g, (_match, name: string) =>
        renderInlineCodeAsPre(name)
    )}</p>`;
}
