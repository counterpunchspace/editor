/**
 * Show an element's full text as its tooltip only while CSS cuts it off
 * (`text-overflow: ellipsis`), and drop the tooltip otherwise.
 */
export function syncTruncatedTitle(element: HTMLElement): void {
    const text = element.textContent || '';
    if (text && element.scrollWidth > element.clientWidth + 1) {
        element.title = text;
    } else {
        element.removeAttribute('title');
    }
}
