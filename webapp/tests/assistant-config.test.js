const {
    ASSISTANT_SYSTEM_PROMPT,
    ASSISTANT_TOOLS
} = require('../js/assistant-config.ts');

describe('assistant configuration', () => {
    test('exposes the direct Python font-model tool', () => {
        const tool = ASSISTANT_TOOLS.find(
            ({ function: candidate }) =>
                candidate.name === 'execute_python_code'
        );

        expect(tool.function).toMatchObject({
            parameters: {
                required: ['code'],
                properties: {
                    code: { type: 'string' }
                }
            }
        });
        expect(tool.function.description).toContain('Font()');
        expect(tool.function.description).toContain('print(station.name.dflt)');
        expect(tool.function.description).not.toContain('Pyodide');
    });

    test('directs users to enable font editing from the Assistant title bar', () => {
        expect(ASSISTANT_SYSTEM_PROMPT).toContain(
            'enable editing with the pen button in the Assistant title bar'
        );
        expect(ASSISTANT_SYSTEM_PROMPT).toContain(
            'before sending a new prompt'
        );
    });

    test('allows Python inspection while Assistant font editing is disabled', () => {
        expect(ASSISTANT_SYSTEM_PROMPT).toContain(
            'inspect the font, including with execute_python_code'
        );
        expect(ASSISTANT_SYSTEM_PROMPT).toContain(
            'Do not use Python or any other tool to modify font data.'
        );
        expect(ASSISTANT_SYSTEM_PROMPT).not.toContain(
            'must not modify font data or run execute_python_code'
        );
        expect(ASSISTANT_SYSTEM_PROMPT).toContain('print(station.name.dflt)');
        expect(ASSISTANT_SYSTEM_PROMPT).toContain(
            'Never serialize the whole font to JSON to read one field'
        );
        expect(ASSISTANT_SYSTEM_PROMPT).not.toContain('Pyodide');
    });

    test('gives a literal Python document workflow before substantive edits', () => {
        expect(ASSISTANT_SYSTEM_PROMPT).toContain(
            'follow this exact workflow for Python authoring'
        );
        expect(ASSISTANT_SYSTEM_PROMPT).toContain('get_active_python_document');
        expect(ASSISTANT_SYSTEM_PROMPT).toContain(
            'call python_authoring_guide only after the kind is clear'
        );
        expect(ASSISTANT_SYSTEM_PROMPT).toContain(
            'do not treat editorKind general-script as authoritative'
        );
        expect(ASSISTANT_SYSTEM_PROMPT).toContain(
            'validate_python_document after every create or replace'
        );
        const activeDocumentTool = ASSISTANT_TOOLS.find(
            ({ function: tool }) => tool.name === 'get_active_python_document'
        );
        expect(activeDocumentTool.function.description).toContain(
            'inspect kindConfidence and kindMessage'
        );
        const guideTool = ASSISTANT_TOOLS.find(
            ({ function: tool }) => tool.name === 'python_authoring_guide'
        );
        expect(guideTool.function.parameters).toMatchObject({
            required: ['kind'],
            properties: {
                kind: {
                    enum: ['general-script', 'glyph-filter']
                }
            }
        });
        expect(
            guideTool.function.parameters.properties.kind.description
        ).toContain('user runs from Script Editor');
        expect(guideTool.function.description).toContain(
            'handbook discovery is not required'
        );
    });
});
