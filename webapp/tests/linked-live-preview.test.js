const { webcrypto } = require('crypto');
const { TextDecoder, TextEncoder } = require('util');
Object.defineProperty(global, 'crypto', {
    value: webcrypto,
    configurable: true,
    writable: true
});
global.TextDecoder = TextDecoder;
global.TextEncoder = TextEncoder;

const {
    LivePreviewThrottle,
    LinkedLivePreviewReceiver,
    LINKED_PREVIEW_STALE_MS
} = require('../js/linked-live-preview');
const { PatchSyncEngine } = require('../js/patch-sync-engine');
const { WindowSync, parseWindowSyncMessage } = require('../js/window-sync');

function fakeClock() {
    let now = 0;
    const timers = new Map();
    let nextHandle = 1;
    return {
        clock: {
            now: () => now,
            setTimer: (callback, ms) => {
                const handle = nextHandle++;
                timers.set(handle, { callback, at: now + ms });
                return handle;
            },
            clearTimer: (handle) => timers.delete(handle)
        },
        advance(ms) {
            const target = now + ms;
            for (;;) {
                const due = [...timers.entries()]
                    .filter(([, timer]) => timer.at <= target)
                    .sort((left, right) => left[1].at - right[1].at)[0];
                if (!due) break;
                timers.delete(due[0]);
                now = due[1].at;
                due[1].callback();
            }
            now = target;
        }
    };
}

describe('LivePreviewThrottle', () => {
    it('sends the first payload at once and the newest of the rest later', () => {
        const time = fakeClock();
        const sent = [];
        const throttle = new LivePreviewThrottle(
            (payload) => sent.push(payload),
            40,
            time.clock
        );
        throttle.push('a');
        expect(sent).toEqual(['a']);
        time.advance(10);
        throttle.push('b');
        time.advance(10);
        throttle.push('c');
        expect(sent).toEqual(['a']);
        time.advance(30);
        expect(sent).toEqual(['a', 'c']);
        time.advance(100);
        throttle.push('d');
        expect(sent).toEqual(['a', 'c', 'd']);
    });

    it('flushes and cancels what is waiting', () => {
        const time = fakeClock();
        const sent = [];
        const throttle = new LivePreviewThrottle(
            (payload) => sent.push(payload),
            40,
            time.clock
        );
        throttle.push('a');
        throttle.push('b');
        expect(throttle.flush()).toBe(true);
        expect(sent).toEqual(['a', 'b']);
        throttle.push('c');
        throttle.push('d');
        throttle.cancel();
        time.advance(500);
        expect(sent).toEqual(['a', 'b']);
    });
});

describe('LinkedLivePreviewReceiver', () => {
    function makeReceiver(overrides = {}) {
        const time = fakeClock();
        const calls = [];
        const host = {
            isBusyLocally: () => false,
            applyModelLayers: jest.fn((records) =>
                calls.push(['model', records.length])
            ),
            revertModelLayers: jest.fn(() => calls.push(['revert'])),
            stageOverlay: jest.fn(async (records) => {
                calls.push(['overlay', records.length]);
                return true;
            }),
            requestCompile: jest.fn(() => calls.push(['compile'])),
            repaint: jest.fn(async () => calls.push(['repaint'])),
            clearOverlay: jest.fn(() => calls.push(['clear'])),
            recompile: jest.fn(() => calls.push(['recompile'])),
            ...overrides
        };
        return {
            receiver: new LinkedLivePreviewReceiver(host, time.clock),
            host,
            calls,
            time
        };
    }
    const record = (layerId) => ({
        glyphName: 'A',
        layerId,
        layerData: { width: 500 }
    });
    const payload = (layerId = 'l1') => ({
        overlay: [record(layerId)],
        model: [record(layerId)],
        compile: { changeSource: 'keyboard-outline', editType: 'outline' }
    });
    const settle = async () => {
        for (let i = 0; i < 10; i += 1) await Promise.resolve();
    };

    it('shows a preview: model, repaint, worker overlay, compile', async () => {
        const { receiver, calls } = makeReceiver();
        receiver.receive('p1', payload());
        await settle();
        // The layers are drawn at once; the worker and the compile follow.
        expect(calls).toEqual([
            ['model', 1],
            ['repaint'],
            ['overlay', 1],
            ['compile']
        ]);
        expect(receiver.isPreviewing).toBe(true);
    });

    it('repaints an overlay-only preview that asks for no compile', async () => {
        const { receiver, calls } = makeReceiver();
        receiver.receive('p1', { ...payload(), model: [], compile: null });
        await settle();
        expect(calls).toEqual([['overlay', 1], ['repaint']]);
    });

    it('applies only the newest of the previews that arrive while it stages', async () => {
        let release;
        const gate = new Promise((resolve) => (release = resolve));
        const { receiver, host } = makeReceiver({
            stageOverlay: jest.fn(async () => {
                await gate;
                return true;
            })
        });
        receiver.receive('p1', payload('l1'));
        await settle();
        receiver.receive('p1', payload('l2'));
        receiver.receive('p1', payload('l3'));
        release();
        await settle();
        const layerIds = host.applyModelLayers.mock.calls.map(
            (call) => call[0][0].layerId
        );
        expect(layerIds).toEqual(['l1', 'l3']);
    });

    it('puts everything back when the sender ends without a commit', async () => {
        const { receiver, calls } = makeReceiver();
        receiver.receive('p1', payload());
        await settle();
        calls.length = 0;
        receiver.end('p1');
        expect(calls.map((call) => call[0])).toEqual([
            'revert',
            'clear',
            'recompile',
            'repaint'
        ]);
        expect(receiver.isPreviewing).toBe(false);
    });

    it('leaves a preview alone once its commit has landed', async () => {
        const { receiver, calls } = makeReceiver();
        receiver.receive('p1', payload());
        await settle();
        calls.length = 0;
        receiver.settle(new Set(['l1']));
        receiver.end('p1');
        expect(calls).toEqual([]);
    });

    it('keeps following the preview when an unrelated commit lands', async () => {
        const { receiver, host } = makeReceiver();
        receiver.receive('p1', payload());
        await settle();
        // A collaborator edits another layer meanwhile.
        receiver.settle(new Set(['other-layer']));
        receiver.end('p1');
        expect(host.revertModelLayers).toHaveBeenCalledTimes(1);
    });

    it('reverts every layer an earlier tick of the gesture previewed', async () => {
        const { receiver, host } = makeReceiver();
        receiver.receive('p1', payload('l1'));
        await settle();
        receiver.receive('p1', payload('l2'));
        await settle();
        receiver.end('p1');
        const reverted = host.revertModelLayers.mock.calls[0][0].map(
            (target) => target.layerId
        );
        expect(reverted.sort()).toEqual(['l1', 'l2']);
    });

    it('reverts the preview of a window that closes', async () => {
        const { receiver, host } = makeReceiver();
        receiver.receive('window-a:1', payload());
        await settle();
        receiver.endFromWindow('window-b');
        expect(host.revertModelLayers).not.toHaveBeenCalled();
        receiver.endFromWindow('window-a');
        expect(host.revertModelLayers).toHaveBeenCalledTimes(1);
    });

    it('ignores the end of another gesture', async () => {
        const { receiver, host } = makeReceiver();
        receiver.receive('p1', payload());
        await settle();
        receiver.end('other');
        expect(host.revertModelLayers).not.toHaveBeenCalled();
    });

    it('reverts a preview whose sender went quiet', async () => {
        const { receiver, host, time } = makeReceiver();
        receiver.receive('p1', payload());
        await settle();
        time.advance(LINKED_PREVIEW_STALE_MS + 10);
        expect(host.revertModelLayers).toHaveBeenCalledTimes(1);
    });

    it('keeps its own drag untouched', async () => {
        const { receiver, host } = makeReceiver({
            isBusyLocally: () => true
        });
        receiver.receive('p1', payload());
        await settle();
        expect(host.applyModelLayers).not.toHaveBeenCalled();
        expect(host.stageOverlay).not.toHaveBeenCalled();
    });
});

describe('PatchSyncEngine live preview layers', () => {
    afterEach(() => {
        delete window.fontManager;
    });

    it('syncs the model layer and restores it from the document', () => {
        const layer = {
            syncFromEditorLayerData: jest.fn(),
            invalidateContentCaches: jest.fn()
        };
        window.fontManager = {
            currentFont: {
                fontModel: {
                    findGlyph: () => ({ findLayerById: () => layer })
                }
            }
        };
        const bridge = new PatchSyncEngine('preview-test');
        bridge.initFromJson({
            upm: 1000,
            names: {},
            masters: [{ id: 'm', name: 'Regular', location: {}, metrics: {} }],
            glyphs: [
                {
                    name: 'A',
                    id: 'id-a',
                    layers: [
                        {
                            id: 'l1',
                            width: 400,
                            shapes: [],
                            master: { type: 'DefaultForMaster', master: 'm' }
                        }
                    ]
                }
            ]
        });
        bridge.applyLivePreviewLayers([
            {
                glyphName: 'A',
                layerId: 'l1',
                layerData: { width: 555, shapes: [{ type: 'path' }] }
            }
        ]);
        expect(layer.syncFromEditorLayerData).toHaveBeenLastCalledWith({
            width: 555,
            shapes: [{ type: 'path' }]
        });

        bridge.revertLivePreviewLayers([{ glyphName: 'A', layerId: 'l1' }]);
        expect(layer.syncFromEditorLayerData).toHaveBeenLastCalledWith(
            expect.objectContaining({ width: 400 })
        );
        bridge.destroy();
    });
});

describe('WindowSync live previews', () => {
    it('accepts the preview messages', () => {
        expect(
            parseWindowSyncMessage({
                type: 'live-preview',
                previewId: 'p',
                payload: {},
                windowId: 'w',
                sessionId: 's'
            })
        ).not.toBeNull();
        expect(
            parseWindowSyncMessage({
                type: 'live-preview-end',
                previewId: 'p',
                windowId: 'w',
                sessionId: 's'
            })
        ).not.toBeNull();
    });

    it('posts throttled previews, then the end after the pending commit', async () => {
        const bridge = new PatchSyncEngine('sender');
        const sync = new WindowSync(bridge, 'live-preview-test-channel');
        const sent = [];
        sync._send = (msg) => {
            sent.push(msg.type);
            return true;
        };
        expect(sync.hasLinkedPeers()).toBe(false);
        sync._peers.add('other');
        expect(sync.hasLinkedPeers()).toBe(true);

        sync.queueLivePreview({ overlay: [], model: [], compile: null });
        sync.endLivePreview();
        expect(sent).toEqual(['live-preview', 'live-preview-end']);

        sent.length = 0;
        // Linked windows follow at their own pace.
        await new Promise((resolve) => setTimeout(resolve, 120));
        sync.queueLivePreview({ overlay: [], model: [], compile: null });
        sync.queueLivePreview({ overlay: [], model: [], compile: null });
        // A commit supersedes the preview still waiting to go out.
        sync._queueOutboundBroadcast(new Uint8Array([1]), null, 'font-core');
        sync.endLivePreview();
        expect(sent.filter((type) => type === 'live-preview')).toHaveLength(1);
        sync.destroy();
        bridge.destroy();
    });
});

describe('linked preview host', () => {
    const { createLinkedPreviewHost } = require('../js/change-bridge-init');
    const originalFontManager = window.fontManager;
    const originalAutoCompile = window.autoCompileManager;

    afterEach(() => {
        window.fontManager = originalFontManager;
        window.autoCompileManager = originalAutoCompile;
    });

    const mountFontManager = () => {
        const fontManager = {
            setEditingCompileContext: jest.fn(),
            currentFont: { requestRecompileWithoutDataChange: jest.fn() }
        };
        window.fontManager = fontManager;
        window.autoCompileManager = { checkAndSchedule: jest.fn() };
        return fontManager;
    };

    it('compiles a sidebearing preview with layout, so the text reshapes', () => {
        const fontManager = mountFontManager();
        const host = createLinkedPreviewHost({});

        host.requestCompile({
            changeSource: 'mouse-drag-sidebearing',
            editType: 'sidebearing'
        });

        // The linked window has no live advance patch: an outline-only
        // compile would keep the old widths until the commit.
        expect(fontManager.setEditingCompileContext).toHaveBeenCalledWith(
            'mouse-drag-sidebearing',
            'anchor'
        );
        expect(
            fontManager.currentFont.requestRecompileWithoutDataChange
        ).toHaveBeenCalledWith({
            compileContext: {
                changeSource: 'mouse-drag-sidebearing',
                editType: 'anchor',
                dataFreshnessMode: 'live-drag-worker-preview'
            }
        });
        expect(window.autoCompileManager.checkAndSchedule).toHaveBeenCalled();
    });

    it('keeps the edit type of other previews', () => {
        const fontManager = mountFontManager();
        const host = createLinkedPreviewHost({});

        host.requestCompile({
            changeSource: 'mouse-drag-outline',
            editType: 'outline'
        });

        expect(fontManager.setEditingCompileContext).toHaveBeenCalledWith(
            'mouse-drag-outline',
            'outline'
        );
    });
});

describe('WindowSync preview pace', () => {
    it('posts a preview at once, then at most one per linked pace', async () => {
        const APP_SETTINGS = require('../js/settings').default;
        const bridge = new PatchSyncEngine('sender');
        const sync = new WindowSync(bridge, 'preview-pace-test-channel');
        const sent = [];
        sync._send = (msg) => {
            sent.push(msg.type);
            return true;
        };
        sync._peers.add('other');
        const preview = () =>
            sync.queueLivePreview({ overlay: [], model: [], compile: null });

        preview();
        expect(sent).toEqual(['live-preview']);

        // The editing window stages far more often than linked windows
        // follow; only the newest waits.
        preview();
        preview();
        expect(sent).toEqual(['live-preview']);

        await new Promise((resolve) =>
            setTimeout(resolve, APP_SETTINGS.LINKED_LIVE_PACE_MS + 20)
        );
        expect(sent).toEqual(['live-preview', 'live-preview']);
        sync.destroy();
        bridge.destroy();
    });
});
