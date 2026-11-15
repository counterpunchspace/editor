describe('editor View menu', () => {
    beforeEach(() => {
        localStorage.clear();
        window.glyphCanvas = {
            outlineEditor: {
                active: false,
                guidelinesVisible: true,
                isPairedDrawingVisible: () => false
            },
            stackPreviewAnimator: {
                isActive: false,
                isReversing: false
            }
        };
    });

    test('stays enabled in text mode and grays out outline-only items', () => {
        const {
            createStackPreviewMenuHtml
        } = require('../js/editor-stack-preview-menu');
        const html = createStackPreviewMenuHtml();

        expect(html).toContain('Preview Area');
        expect(html).toContain('data-preview-area="small"');
        expect(html).toContain('data-preview-area="medium"');
        expect(html).toContain('data-preview-area="full"');

        expect(html).toMatch(
            /data-action="toggle-stack-preview"[^>]*aria-disabled="true"/
        );
        expect(html).toMatch(
            /data-action="toggle-guidelines"[^>]*aria-disabled="true"/
        );
        expect(html).toMatch(
            /data-action="toggle-paired-drawing"[^>]*aria-disabled="true"/
        );
        expect(html).toMatch(
            /data-action="toggle-show-all-metrics"[^>]*aria-disabled="true"/
        );
        expect(html).toMatch(
            /data-action="toggle-node-snapping"[^>]*aria-disabled="true"/
        );
        expect(html).not.toMatch(
            /data-action="toggle-follow-stack-scroll"[^>]*aria-disabled="true"/
        );
        expect(html).toContain('class="plugin-menu-fill-host"');
        expect(html).toContain('data-action="zoom-in"');
        expect(html).toContain('data-action="zoom-out"');
        expect(html).toContain('data-action="zoom-to-fit"');
        expect(html).toContain('shortcut-command-modifier');
        expect(html).toContain('1-2×');
        expect(html).not.toContain('⌘0');
        expect(html).not.toMatch(
            /data-action="zoom-in"[^>]*aria-disabled="true"/
        );
        expect(html).not.toMatch(
            /data-action="zoom-to-fit"[^>]*aria-disabled="true"/
        );
    });

    test('enables outline items in edit mode', () => {
        window.glyphCanvas.outlineEditor.active = true;
        const {
            createStackPreviewMenuHtml
        } = require('../js/editor-stack-preview-menu');
        const html = createStackPreviewMenuHtml();

        expect(html).not.toMatch(
            /data-action="toggle-stack-preview"[^>]*aria-disabled="true"/
        );
        expect(html).not.toMatch(
            /data-action="toggle-guidelines"[^>]*aria-disabled="true"/
        );
        expect(html).not.toMatch(
            /data-action="toggle-node-snapping"[^>]*aria-disabled="true"/
        );
        expect(html).toMatch(
            /data-action="toggle-node-snapping"[^>]*aria-checked="false"/
        );
        expect(html).toContain('class="plugin-menu-fill-host"');
    });
});
