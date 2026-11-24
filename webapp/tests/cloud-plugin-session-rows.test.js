/**
 * Rows kept while a reconnect leaves no cloud session go into the next
 * session in order. Only the session throwing is a refusal; nothing a
 * refusal report does may stop the rows behind it.
 */
const {
    keepRowUntilSession,
    keptSessionRowCount,
    writeKeptRowsIntoSession
} = require('../js/filesystem-plugins/plugins/cloud-plugin-session-rows.ts');
const { CloudWalPersistError } = require('../js/cloud-durable-wal.ts');

describe('kept session rows', () => {
    test('a write answering false is not a refusal', async () => {
        const owner = {};
        const written = [];
        keepRowUntilSession(owner, {
            assetId: 'a',
            documentId: 'glyph:A',
            write: async () => {
                written.push('A');
                return false;
            }
        });
        const refused = jest.fn();
        await writeKeptRowsIntoSession(owner, {}, 'a', {
            isCurrent: () => true,
            refused
        });
        expect(written).toEqual(['A']);
        expect(refused).not.toHaveBeenCalled();
        expect(keptSessionRowCount(owner)).toBe(0);
    });

    test('a storage failure is not a refusal', async () => {
        const owner = {};
        keepRowUntilSession(owner, {
            assetId: 'a',
            documentId: 'glyph:A',
            write: async () => {
                throw new CloudWalPersistError('disk full');
            }
        });
        const refused = jest.fn();
        await writeKeptRowsIntoSession(owner, {}, 'a', {
            isCurrent: () => true,
            refused
        });
        expect(refused).not.toHaveBeenCalled();
    });

    test('a refusal report that throws does not stop later rows or later sessions', async () => {
        const owner = {};
        const written = [];
        keepRowUntilSession(owner, {
            assetId: 'a',
            documentId: 'glyph:A',
            write: async () => {
                throw new Error('no envelope');
            }
        });
        keepRowUntilSession(owner, {
            assetId: 'a',
            documentId: 'glyph:B',
            write: async () => {
                written.push('B');
                return true;
            }
        });
        const errorSpy = jest
            .spyOn(console, 'error')
            .mockImplementation(() => {});
        const refused = jest.fn(() => {
            throw new Error('report failed');
        });
        await expect(
            writeKeptRowsIntoSession(owner, {}, 'a', {
                isCurrent: () => true,
                refused
            })
        ).resolves.toBeUndefined();
        expect(refused).toHaveBeenCalledWith('glyph:A', expect.any(Error));
        expect(written).toEqual(['B']);

        // The chain still runs for the next session.
        keepRowUntilSession(owner, {
            assetId: 'a',
            documentId: 'glyph:C',
            write: async () => {
                written.push('C');
                return true;
            }
        });
        await writeKeptRowsIntoSession(owner, {}, 'a', {
            isCurrent: () => true,
            refused: jest.fn()
        });
        expect(written).toEqual(['B', 'C']);
        errorSpy.mockRestore();
    });
});
