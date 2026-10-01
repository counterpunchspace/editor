const {
    allocateClientTransactionId,
    createMutationIdentity,
    isExactDurableAck
} = require('../js/generated/collab-protocol-durability-contract.ts');

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
        expect(allocateClientTransactionId('tx')).toMatch(/^tx:/);
        const expected = {
            clientTransactionId: 'tx-1',
            seq: 4
        };
        expect(
            isExactDurableAck(
                {
                    type: 'ack',
                    durable: true,
                    clientTransactionId: 'tx-1',
                    seq: 4
                },
                expected
            )
        ).toBe(true);
        expect(isExactDurableAck({ type: 'ack', seq: 4 }, expected)).toBe(
            false
        );
        expect(
            isExactDurableAck(
                {
                    type: 'ack',
                    durable: true,
                    clientTransactionId: 'tx-other',
                    seq: 4
                },
                expected
            )
        ).toBe(false);
    });
});
