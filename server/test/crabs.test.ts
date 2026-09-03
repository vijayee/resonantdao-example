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
    expect(dao.getProposalOptionVotes('p1')).toEqual([0, 0]);
  });

  it('enforces the custodian policy on set_token_config', async () => {
    const dao = new DaoNode();
    await dao.init();
    const key = await KeyPair.generate();
    dao.registerMember('alice', key.publicKeyHex());

    const buildConfigOp = async (version: number) => {
      const op = await Operation.create('set_token_config');
      op.signerId = 'alice';
      op.nodeId = 'browser';
      op.payload = new TextEncoder().encode(JSON.stringify({ intervalMs: 1000, rate: 5 }) + '\0');
      setOperationSignerKeyVersion(op, version);
      dao.node.sign(op, key);
      return op.serialize();
    };

    // Not a custodian -> policy rejects the execute.
    const rejectedBytes = await buildConfigOp(3);
    const rejectedOp = await dao.deserializeOperation(rejectedBytes);
    expect(() => dao.executeOperation(rejectedOp)).toThrow();

    // Grant custodian (bumps alice's key_version to 4).
    dao.grantCustodian('alice');
    const acceptedBytes = await buildConfigOp(4);
    dao.executeOperation(await dao.deserializeOperation(acceptedBytes));
    expect(dao.node.getRegister('config:distribution_interval')).toBe(1000);
    expect(dao.node.getRegister('config:distribution_rate')).toBe(5);
  });
});
