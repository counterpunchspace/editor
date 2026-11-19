jest.mock('../js/skills/host-python', () => ({
    runHostPython: jest.fn(() => 'null'),
    runHostPythonAsync: jest.fn(async () => '[]')
}));
jest.mock('../js/glyph-data', () => ({
    glyphDataIndex: {
        ensureReady: jest.fn(async () => {}),
        getGlyphDataForUnicode: jest.fn(() => null)
    }
}));

const { runHostPythonAsync } = require('../js/skills/host-python');
const { SkillManager } = require('../js/skills/skill-manager.ts');

// Adding the Arabic skill’s glyphs asked for the anchors of `uni0627.fina`,
// a name with no writing script, and the Python failed with
// “NameError: name 'null' is not defined”.
test('a glyph name without a writing script gives valid Python', async () => {
    const manager = new SkillManager();
    manager.ready = Promise.resolve();
    await manager.anchorsFor('uni0627.fina');
    const python = runHostPythonAsync.mock.calls.at(-1)[0];
    expect(python).toContain('builtins._cp_skill_for(json.loads("null"))');
    expect(python).not.toMatch(/(?<!")\bnull\b(?!")/);
});
