// The Python document an Assistant chat session reads and edits. The main
// Assistant edits the Script Editor buffer; other chats (the glyph filter
// editor) supply their own target, for example a second Ace editor.

import type { ScriptDocumentKind } from '../python-document-kind';

export type PythonDocumentState = {
    content: string;
    kind: ScriptDocumentKind;
    path: string | null;
    revision: string;
    isModified: boolean;
};

export interface PythonDocumentTarget {
    /** Name used in tool results and diffs, for example "Script Editor". */
    readonly label: string;
    /** Throws when the document is not available. */
    getDocumentState(): PythonDocumentState;
    /**
     * Replace the single exact occurrence of `oldText`. Throws when the
     * revision is stale or `oldText` is missing or ambiguous.
     */
    replaceExactText(
        oldText: string,
        newText: string,
        expectedRevision: string
    ): PythonDocumentState;
    /** Subscribe to buffer changes; returns the unsubscribe function. */
    onDidChange(listener: (state: PythonDocumentState) => void): () => void;
    /** Extra problems `validate_python_document` reports for this document. */
    validate?(state: PythonDocumentState): string[];
    /** Open a managed Settings Folder file. Absent when the chat is bound to one document. */
    openFile?(path: string): Promise<boolean>;
    /** Replace the buffer with a new unsaved draft. */
    createDraft?(
        kind: ScriptDocumentKind,
        content?: string
    ): PythonDocumentState;
    /** Shows the document, e.g. the "Open in Script Editor" button in tool details. */
    reveal?: { label: string; icon: string; run(): void };
}

type AcePosition = { row: number; column: number };

/** The part of an Ace editor the Python targets use. */
export interface AceEditorLike {
    getValue(): string;
    session: {
        getDocument(): {
            replace(
                range: { start: AcePosition; end: AcePosition },
                text: string
            ): unknown;
            indexToPosition(index: number, startRow: number): AcePosition;
        };
    };
    on(event: 'change', handler: () => void): void;
    off(event: 'change', handler: () => void): void;
}

export function assertExpectedRevision(
    expectedRevision: string,
    currentRevision: string
): void {
    if (expectedRevision !== currentRevision) {
        throw new Error(
            'The script changed since it was last read. Read it again before editing.'
        );
    }
}

/** Replace the single exact occurrence of `oldText` in an Ace buffer. */
export function replaceExactTextInAce(
    editor: AceEditorLike,
    oldText: string,
    newText: string
): void {
    const content = editor.getValue();
    const firstIndex = content.indexOf(oldText);
    if (firstIndex < 0) {
        throw new Error('The requested text was not found in the script.');
    }
    if (content.indexOf(oldText, firstIndex + oldText.length) >= 0) {
        throw new Error(
            'The requested text appears more than once. Read a narrower section before editing.'
        );
    }
    const document = editor.session.getDocument();
    document.replace(
        {
            start: document.indexToPosition(firstIndex, 0),
            end: document.indexToPosition(firstIndex + oldText.length, 0)
        },
        newText
    );
}

/**
 * Adapter for the Script Editor. `window.scriptEditor` is resolved on every
 * call, so the target works before the editor initializes and with test doubles.
 */
export function createScriptEditorTarget(): PythonDocumentTarget {
    const scriptEditor = () => {
        const editor = window.scriptEditor;
        if (!editor) throw new Error('The Script Editor is not ready yet.');
        return editor;
    };
    return {
        label: 'Script Editor',
        getDocumentState: () => scriptEditor().getDocumentState(),
        replaceExactText: (oldText, newText, expectedRevision) =>
            scriptEditor().replaceExactText(oldText, newText, expectedRevision),
        onDidChange(listener) {
            const handler = (event: Event) =>
                listener((event as CustomEvent<PythonDocumentState>).detail);
            window.addEventListener('scriptEditorDocumentChanged', handler);
            return () =>
                window.removeEventListener(
                    'scriptEditorDocumentChanged',
                    handler
                );
        },
        openFile: (path) => scriptEditor().openFile(path, 'settings'),
        createDraft(kind, content) {
            scriptEditor().createDraft(kind, content);
            return scriptEditor().getDocumentState();
        },
        reveal: {
            label: 'Open in Script Editor',
            icon: 'code',
            run: () => document.getElementById('view-scripts')?.click()
        }
    };
}

/**
 * A target backed by any Ace editor, with its own revision counter. Used for
 * documents that live outside the Script Editor, such as the filter editor.
 */
export class AcePythonDocumentTarget implements PythonDocumentTarget {
    readonly label: string;
    private revision = 0;
    private readonly listeners = new Set<
        (state: PythonDocumentState) => void
    >();
    private readonly handleChange = () => {
        this.revision += 1;
        const state = this.getDocumentState();
        this.listeners.forEach((listener) => listener(state));
    };

    constructor(
        private readonly editor: AceEditorLike,
        private readonly document: {
            label: string;
            kind: ScriptDocumentKind;
            path?: () => string | null;
            isModified?: () => boolean;
            validate?: (state: PythonDocumentState) => string[];
        }
    ) {
        this.label = document.label;
        editor.on('change', this.handleChange);
    }

    validate(state: PythonDocumentState): string[] {
        return this.document.validate?.(state) ?? [];
    }

    getDocumentState(): PythonDocumentState {
        return {
            content: this.editor.getValue(),
            kind: this.document.kind,
            path: this.document.path?.() ?? null,
            revision: `${this.label.toLowerCase().replace(/\W+/g, '-')}-${this.revision}`,
            isModified: this.document.isModified?.() ?? true
        };
    }

    replaceExactText(
        oldText: string,
        newText: string,
        expectedRevision: string
    ): PythonDocumentState {
        assertExpectedRevision(
            expectedRevision,
            this.getDocumentState().revision
        );
        replaceExactTextInAce(this.editor, oldText, newText);
        return this.getDocumentState();
    }

    onDidChange(listener: (state: PythonDocumentState) => void): () => void {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    dispose(): void {
        this.editor.off('change', this.handleChange);
        this.listeners.clear();
    }
}
