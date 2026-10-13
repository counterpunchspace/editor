import { CharacterSetPluginManager } from '../js/character-set-plugin-manager';

describe('CharacterSetPluginManager', () => {
    beforeEach(() => {
        global.fetch = jest.fn().mockResolvedValue({
            ok: true,
            json: async () => ({
                wheels: ['counterpunch_hyperglot-0.8.1-py3-none-any.whl']
            })
        });
        window.pyodide = {
            loadPackage: jest.fn().mockResolvedValue(undefined),
            runPythonAsync: jest.fn(async (code) => {
                if (code.includes('provider.characters')) {
                    return JSON.stringify([
                        {
                            codepoint: 65,
                            level: 'essential',
                            level_rank: 0,
                            categories: ['base']
                        }
                    ]);
                }
                if (code.includes('entry_points(group=')) {
                    return JSON.stringify([
                        {
                            id: 'org.rosettatype.hyperglot',
                            name: 'Hyperglot',
                            version: '0.8.1',
                            coverage_levels: [
                                {
                                    id: 'essential',
                                    label: 'Essential',
                                    default: true
                                }
                            ],
                            tree: [
                                {
                                    id: 'eng',
                                    label: 'English',
                                    selectable: false,
                                    children: [
                                        {
                                            id: 'eng/0',
                                            label: 'Latin',
                                            selectable: true
                                        }
                                    ]
                                }
                            ]
                        }
                    ]);
                }
                return '';
            })
        };
    });

    it('loads providers and queries selected character sets', async () => {
        const manager = new CharacterSetPluginManager();

        await manager.ensureReady();

        expect(manager.getProviders()).toEqual([
            expect.objectContaining({
                id: 'org.rosettatype.hyperglot',
                coverageLevels: [
                    expect.objectContaining({ id: 'essential', default: true })
                ],
                tree: [
                    expect.objectContaining({
                        children: [expect.objectContaining({ id: 'eng/0' })]
                    })
                ]
            })
        ]);
        await expect(
            manager.getCharacters(
                'org.rosettatype.hyperglot',
                ['eng/0'],
                ['essential']
            )
        ).resolves.toEqual([
            expect.objectContaining({ codepoint: 65, level: 'essential' })
        ]);
    });

    it('loads defined members for each character set', async () => {
        window.pyodide.runPythonAsync.mockImplementation(async (code) => {
            if (code.includes('provider.members_by_set')) {
                return JSON.stringify({
                    'eng/0': {
                        codepoints: [65, 66, -1, 'nope'],
                        glyph_names: ['A', '']
                    }
                });
            }
            if (code.includes('entry_points(group=')) {
                return JSON.stringify([]);
            }
            return '';
        });
        const manager = new CharacterSetPluginManager();
        await manager.ensureReady();

        await expect(
            manager.getMembersBySet('org.rosettatype.hyperglot', ['eng/0'], [])
        ).resolves.toEqual({
            'eng/0': { codepoints: [65, 66], glyphNames: ['A'] }
        });
    });
});
