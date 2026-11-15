const path = require('path');
const { spawnSync } = require('child_process');

describe('fonteditor Drawing.selection bridge', () => {
    test('supports live list mutation and assignment in Python', () => {
        const helperPath = path.join(
            __dirname,
            'helpers',
            'fonteditor_selection_bridge_test.py'
        );
        const result = spawnSync('python3', [helperPath], {
            encoding: 'utf-8'
        });

        if (result.error) {
            throw result.error;
        }

        expect(result.status).toBe(0);
        expect(result.stderr).toContain('OK');
    });
});
