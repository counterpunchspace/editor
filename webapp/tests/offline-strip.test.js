// The strip under the bottom panels that says a cloud font is offline.

const {
    OFFLINE_STRIP_ID,
    OFFLINE_STRIP_OPEN_CLASS,
    initOfflineStrip,
    renderOfflineStrip
} = require('../js/offline-strip');

beforeAll(() => initOfflineStrip());

beforeEach(() => {
    document.body.className = '';
    document.body.innerHTML =
        '<div class="toolbar"></div><div id="app-shell" class="app-shell"></div>';
});

const strip = () => document.getElementById(OFFLINE_STRIP_ID);
const level = (value) =>
    window.dispatchEvent(
        new CustomEvent('cloudOfflineLevelChanged', {
            detail: { assetId: 'asset-1', level: value }
        })
    );

test('offline shows the amber message under the panels', () => {
    level('offline');
    expect(strip().previousElementSibling.id).toBe('app-shell');
    expect(strip().dataset.level).toBe('offline');
    expect(strip().textContent).toContain(
        'You’re offline.You can keep editing for 5 minutes. Your edits are sent when you reconnect.'
    );
    expect(document.body.classList.contains(OFFLINE_STRIP_OPEN_CLASS)).toBe(
        true
    );
});

test('paused shows the red message', () => {
    level('offline');
    level('paused');
    expect(strip().dataset.level).toBe('paused');
    expect(strip().textContent).toContain(
        'Editing is paused.You’ve been offline for over 5 minutes. Your edits are sent when you reconnect.'
    );
});

test('back online slides the strip away', () => {
    level('offline');
    level('none');
    expect(document.body.classList.contains(OFFLINE_STRIP_OPEN_CLASS)).toBe(
        false
    );
    expect(strip().dataset.level).toBe('none');
});

test('the link explains whose edits are kept, and leads to the docs', () => {
    window.openDocs = jest.fn();
    renderOfflineStrip('offline');
    strip().querySelector('.offline-strip-link').click();
    const dialog = document.querySelector('.offline-merge-dialog');
    expect(dialog.textContent).toContain(
        'If you both changed the same thing, only one change is kept.'
    );
    expect(dialog.textContent).toContain(
        'Which change is kept is decided at random'
    );
    dialog.querySelector('[data-action="docs"]').click();
    expect(document.querySelector('.offline-merge-dialog')).toBeNull();
    expect(window.openDocs).toHaveBeenCalledWith(
        'files/cloud-fonts',
        'working-offline'
    );
});

test('the dialog closes with OK', () => {
    renderOfflineStrip('paused');
    strip().querySelector('.offline-strip-link').click();
    document.querySelector('[data-action="close"]').click();
    expect(document.querySelector('.offline-merge-dialog')).toBeNull();
});
