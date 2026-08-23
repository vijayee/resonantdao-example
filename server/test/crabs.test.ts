import { KeyPair } from 'crabs-wasm';
import { DaoNode } from '../src/crabs';

describe('DaoNode', () => {
  it('registers a member and creates a proposal', async () => {
    const dao = new DaoNode();
    await dao.init();
    const aliceKey = await KeyPair.generate();
    dao.registerMember('alice', aliceKey.publicKeyHex());
    expect(dao.isMember('alice')).toBe(true);

    const op = await dao.createSignedOperation(
      'create_proposal',
      'alice',
      {
        proposalId: 'p1',
        title: 'Test',
        description: 'A test proposal',
      },
      aliceKey
    );
    dao.executeOperation(op);
    expect(dao.node.setContains('proposals', 'p1')).toBeTruthy();
  });
});
