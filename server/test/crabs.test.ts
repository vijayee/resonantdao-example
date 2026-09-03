import { KeyPair, Operation } from 'crabs-wasm';
import { setOperationSignerKeyVersion } from '../../shared/src/crabs-helpers';
import { DaoNode } from '../src/crabs';

describe('DaoNode', () => {
  it('registers a member and executes a user-signed proposal', async () => {
    const dao = new DaoNode();
    await dao.init();

    const aliceKey = await KeyPair.generate();
    dao.registerMember('alice', aliceKey.publicKeyHex());
    expect(dao.isMember('alice')).toBe(true);

    // Simulate a browser: Alice signs a proposal operation locally.
    const op = await Operation.create('create_proposal');
    op.signerId = 'alice';
    op.nodeId = 'browser';
    const payloadJson = JSON.stringify({ proposalId: 'p1', title: 'Test', description: 'A test proposal', proposalType: 'direct', options: ['Yes', 'No'], expiresAt: Date.now() + 5 * 60 * 1000 });
    op.payload = new TextEncoder().encode(payloadJson + '\0');
    // After registerUser + two grantRole calls, Alice's key_version is 3.
    setOperationSignerKeyVersion(op, 3);
    dao.node.sign(op, aliceKey);
    const bytes = op.serialize();

    // Server receives serialized bytes, deserializes, and executes.
    const received = await dao.deserializeOperation(bytes);
    dao.executeOperation(received);
    expect(dao.node.setContains('proposals', 'p1')).toBeTruthy();
  });
});
