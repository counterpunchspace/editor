const {
    allocateClientTransactionId,
    createGenerationIdentity,
    createMutationIdentity,
    isExactDurableAck
} = require('../js/cloud-durability-contract.ts');

describe('cloud durability contract', () => {
    test('requires complete identities and rejects ambiguous ACKs', () => {
        expect(
            createMutationIdentity({
                clientId: 'client-1',
                clientTransactionId: 'tx-1',
                clientSequence: 3
            })
        ).toEqual({
            clientId: 'client-1',
            clientTransactionId: 'tx-1',
            clientSequence: 3
        });
        expect(
            createMutationIdentity({
                clientId: 'client-1',
                clientTransactionId: 'tx-1'
            })
        ).toBeNull();
        expect(
            createGenerationIdentity({
                generationId: 'gen-2',
                parentGenerationId: 'gen-1',
                schemaVersion: 6
            })
        ).toEqual({
            generationId: 'gen-2',
            parentGenerationId: 'gen-1',
            schemaVersion: 6
        });
        expect(allocateClientTransactionId('tx')).toMatch(/^tx:/);
        const expected = {
            clientTransactionId: 'tx-1',
            seq: 4,
            generationId: 'gen-1',
            lastLogId: 12
        };
        expect(
            isExactDurableAck(
                {
                    type: 'ack',
                    durable: true,
                    seq: 4,
                    clientTransactionId: 'tx-1',
                    generationId: 'gen-1',
                    lastLogId: 12
                },
                expected
            )
        ).toBe(true);
        expect(isExactDurableAck({ type: 'ack', seq: 4 }, expected)).toBe(
            false
        );
    });
});
