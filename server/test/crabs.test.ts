import { KeyPair, Operation } from 'crabs-wasm';
import { setOperationSignerKeyVersion } from '../../shared/src/crabs-helpers';
import { CONTRIB_NAMES } from '../../shared/src/policies';
import { DaoNode } from '../src/crabs';

describe('DaoNode', () => {
  let opCounter = 0;

  // Signs a member operation locally the way the browser client does after a
  // DaoNode.registerMember bootstrap: signer id, a unique node id per call,
  // JSON payload + NUL terminator, and the member's current CRABS key version.
  async function buildSignedMemberOp(
    dao: DaoNode,
    username: string,
    keyPair: KeyPair,
    type: string,
    payload: object
  ): Promise<Operation> {
    const op = await Operation.create(type);
    op.signerId = username;
    op.nodeId = `browser-${++opCounter}`;
    op.payload = new TextEncoder().encode(JSON.stringify(payload) + '\0');
    setOperationSignerKeyVersion(op, dao.getUserKeyVersion(username));
    dao.node.sign(op, keyPair);
    return op;
  }
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

  it('seeds a zero RES balance and registers a pending contribution', async () => {
    const dao = new DaoNode();
    await dao.init();
    const kp = await KeyPair.generate();
    dao.registerMember('alice', kp.publicKeyHex());
    expect(dao.getResBalance('alice')).toBe(0);

    dao.executeOperation(await buildSignedMemberOp(dao, 'alice', kp, 'submit_contribution', {
      contributionId: 'c-wire-1',
      dims: { '1': 1 },
      summary: 'built it',
      evidenceRef: { hash: 'a'.repeat(64), uri: 'content://' + 'b'.repeat(64), mediaType: 'text/plain', size: 3 },
      schemaVersion: 'v1',
    }));
    expect(dao.node.getRegister(CONTRIB_NAMES.step('c-wire-1'))).toBe(1); // real wasm: addRegister initial persists
    expect(dao.isContributionPending('c-wire-1')).toBe(true);
    expect(dao.getContributionStatus('c-wire-1')).toBe('pending');
    // Dimension tallies are only written at settlement; before that the
    // register is simply undeclared and reads as 0 (pinned below).
    expect(dao.getDimensionBalance('alice', 1)).toBe(0);
  });

  it('rejects submit_contribution from an unregistered signer (policy role:member)', async () => {
    const dao = new DaoNode();
    await dao.init();
    const kp = await KeyPair.generate();
    // Not registered as a member.
    const op = await buildSignedMemberOp(dao, 'nobody', kp, 'submit_contribution', {
      contributionId: 'c-wire-2',
      dims: { '2': 1 },
      summary: 'x',
      evidenceRef: { hash: 'c'.repeat(64), uri: 'content://' + 'd'.repeat(64), mediaType: 'text/plain', size: 0 },
      schemaVersion: 'v1',
    });
    expect(() => dao.executeOperation(op)).toThrow();
  });

  it('pins the truth: getRegister on an undeclared resource reads as 0', async () => {
    const dao = new DaoNode();
    await dao.init();
    expect(dao.node.getRegister('no_such_register')).toBe(0);
  });
});
