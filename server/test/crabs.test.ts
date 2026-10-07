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

  it('drives the full lifecycle through the real wasm node: submit, verify, settle', async () => {
    const dao = new DaoNode();
    await dao.init();
    const kpAlice = await KeyPair.generate();
    const kpBob = await KeyPair.generate();
    dao.registerMember('alice', kpAlice.publicKeyHex());
    dao.registerMember('bob', kpBob.publicKeyHex());

    // Alice submits a building-dimension contribution; submit auto-completes
    // step 0, so the lifecycle position register starts at 1 (verify).
    dao.executeOperation(await buildSignedMemberOp(dao, 'alice', kpAlice, 'submit_contribution', {
      contributionId: 'c-lifec',
      dims: { '1': 1 },
      summary: 'built a thing',
      evidenceRef: { hash: 'a'.repeat(64), uri: 'content://' + 'b'.repeat(64), mediaType: 'text/plain', size: 3 },
      schemaVersion: 'v1',
    }));
    expect(dao.getContributionStatus('c-lifec')).toBe('pending');
    expect(dao.node.getRegister(CONTRIB_NAMES.step('c-lifec'))).toBe(1);

    // Bob verifies (no-self anti-gaming honored naturally: bob != alice).
    // Per-check credit pays bob 2; the final completion pays alice the
    // per-dims building bounty (12) and advances the step to settle.
    dao.executeOperation(await buildSignedMemberOp(dao, 'bob', kpBob, 'verify_contribution', {
      contributionId: 'c-lifec',
      submitter: 'alice',
      stepId: 'verify',
      dims: { '1': 1 },
      pass: true,
      reason: 'built and matches the claim',
      // Legacy v1 record verifies under v1 rules (single verify); the verify
      // payload must state the record's schema version — omitted means v2.
      schemaVersion: 'v1',
    }));
    expect(dao.getContributionStatus('c-lifec')).toBe('pending');
    expect(dao.node.getRegister(CONTRIB_NAMES.step('c-lifec'))).toBe(2);
    expect(dao.getResBalance('bob')).toBe(2);
    expect(dao.getResBalance('alice')).toBe(12);
    expect(dao.getDimensionBalance('alice', 1)).toBe(1);

    // Alice settles — the submitter's final acknowledgment.
    dao.executeOperation(await buildSignedMemberOp(dao, 'alice', kpAlice, 'settle_contribution', {
      contributionId: 'c-lifec',
      submitter: 'alice',
      reason: 'accepting the verified outcome',
    }));
    expect(dao.getContributionStatus('c-lifec')).toBe('accepted');
    expect(dao.node.getPNCounter(CONTRIB_NAMES.stepDone('c-lifec', 'settle'))).toBe(1);
  });

  it('rejects verify_contribution by the submitter (no-self) through real wasm', async () => {
    const dao = new DaoNode();
    await dao.init();
    const kpAlice = await KeyPair.generate();
    dao.registerMember('alice', kpAlice.publicKeyHex());

    dao.executeOperation(await buildSignedMemberOp(dao, 'alice', kpAlice, 'submit_contribution', {
      contributionId: 'c-noself',
      dims: { '1': 1 },
      summary: 'built a thing',
      evidenceRef: { hash: 'a'.repeat(64), uri: 'content://' + 'b'.repeat(64), mediaType: 'text/plain', size: 3 },
      schemaVersion: 'v1',
    }));

    const selfVerify = await buildSignedMemberOp(dao, 'alice', kpAlice, 'verify_contribution', {
      contributionId: 'c-noself',
      submitter: 'alice',
      stepId: 'verify',
      dims: { '1': 1 },
      pass: true,
      reason: 'vouching for myself',
    });
    expect(() => dao.executeOperation(selfVerify)).toThrow();
    expect(dao.getResBalance('alice')).toBe(0);
    expect(dao.node.getRegister(CONTRIB_NAMES.step('c-noself'))).toBe(1);
  });

  it('drives the full round spine through the real wasm node', async () => {
    const dao = new DaoNode();
    await dao.init();
    const kpAlice = await KeyPair.generate();
    const kpBob = await KeyPair.generate();
    const kpCloser = await KeyPair.generate();
    dao.registerMember('alice', kpAlice.publicKeyHex());
    dao.registerMember('bob', kpBob.publicKeyHex());
    dao.registerMember('closer', kpCloser.publicKeyHex());

    // Calibration bootstrap: custodian-policy ops (`role:custodian`) cannot be
    // admin-signed — CRABS enforces the policy against the signer's CRABS
    // attributes and the admin has no user record, so an admin-signed
    // set_calibration_version execute throws `unauthorized` (pinned
    // empirically here; only `sync_roles`, which has NO policy, works
    // admin-signed). Grant custodian to a member and sign with that member's
    // key instead — the same path the UI must use.
    dao.grantCustodian('closer');
    dao.executeOperation(await buildSignedMemberOp(dao, 'closer', kpCloser, 'set_calibration_version', { version: 'v1' }));
    expect(dao.getCalibrationVersion()).toBe(1);

    // Alice submits a building-dimension contribution; the submit handler
    // stamps it with the round that was current at submission time (round 1).
    dao.executeOperation(await buildSignedMemberOp(dao, 'alice', kpAlice, 'submit_contribution', {
      contributionId: 'r-wasm-1',
      dims: { '1': 1 },
      summary: 'built it',
      evidenceRef: { hash: 'a'.repeat(64), uri: 'content://' + 'b'.repeat(64), mediaType: 'text/plain', size: 3 },
      schemaVersion: 'v1',
    }));
    expect(dao.getContributionStatus('r-wasm-1')).toBe('pending');

    // Bob verifies accepted (no-self: bob != alice); alice settles — the
    // aggregation input must be settled-accepted.
    dao.executeOperation(await buildSignedMemberOp(dao, 'bob', kpBob, 'verify_contribution', {
      contributionId: 'r-wasm-1',
      submitter: 'alice',
      stepId: 'verify',
      dims: { '1': 1 },
      pass: true,
      reason: 'built and matches the claim',
      // Legacy v1 record verifies under v1 rules (single verify); the verify
      // payload must state the record's schema version — omitted means v2.
      schemaVersion: 'v1',
    }));
    dao.executeOperation(await buildSignedMemberOp(dao, 'alice', kpAlice, 'settle_contribution', {
      contributionId: 'r-wasm-1',
      submitter: 'alice',
      reason: 'accepting the verified outcome',
    }));
    expect(dao.getContributionStatus('r-wasm-1')).toBe('accepted');

    // Spine: alice audits fair (citing the registered calibration), reckons,
    // then publishes the aggregate and advances the round. Historically closer
    // could NOT run these: grantCustodian replaced closer's single-valued role
    // attribute, and the member-only policies closed spine ops to custodians
    // (pinned empirically before commit {fix}); policies are now widened to
    // 'role:member OR role:custodian' and the spine is open to custodians again.
    dao.executeOperation(await buildSignedMemberOp(dao, 'alice', kpAlice, 'audit_round', {
      fair: true, note: 'fair', calibrationVersion: 'v1',
    }));
    dao.executeOperation(await buildSignedMemberOp(dao, 'alice', kpAlice, 'reckon_round', {
      note: 'settled',
    }));
    dao.executeOperation(await buildSignedMemberOp(dao, 'alice', kpAlice, 'complete_round', {
      entries: [{ contributionId: 'r-wasm-1', submitter: 'alice', dims: { '1': 1 } }],
    }));

    expect(dao.getCurrentRound()).toBe(2); // completed round 1 advanced to 2
    expect(dao.getRoundStage(1)).toBe(3); // published
    // Arithmetic: alpha(dim 1) unset in CRABS → handler defaults to 1; the
    // contribution's dim-1 value is 1 → RCT = 1 x 1 = 1.
    expect(dao.getRctBalance('alice')).toBe(1);
    expect(dao.getContributionStatus('r-wasm-1')).toBe('accepted');
  });

  it('a custodian keeps member ops after the custodian grant (role:member OR role:custodian)', async () => {
    const dao = new DaoNode();
    await dao.init();
    const kp = await KeyPair.generate();
    dao.registerMember('pat', kp.publicKeyHex());
    dao.grantCustodian('pat');
    // verify_contribution is role-gated: run a submit + self-submitting verify setup
    const kp2 = await KeyPair.generate();
    dao.registerMember('quin', kp2.publicKeyHex());
    const submit = await buildSignedMemberOp(dao, 'pat', kp, 'submit_contribution', {
      contributionId: 'c-cust', dims: { '2': 1 }, summary: 'custodian contribution',
      evidenceRef: { hash: 'a'.repeat(64), uri: 'content://' + 'b'.repeat(64), mediaType: 'text/plain', size: 3 },
      schemaVersion: 'v1',
    });
    dao.executeOperation(submit);
    const verify = await buildSignedMemberOp(dao, 'quin', kp2, 'verify_contribution', {
      contributionId: 'c-cust', submitter: 'pat', dims: { '2': 1 }, stepId: 'verify', pass: true, reason: 'custodian verifies fine',
    });
    const beforeBob = dao.getResBalance('quin');
    dao.executeOperation(verify);
    expect(dao.getResBalance('quin')).toBe(beforeBob + 2);

    // AND the custodian can run a custodian op (role:custodian):
    dao.grantCustodian('quin');
    const cal = await buildSignedMemberOp(dao, 'quin', kp2, 'set_calibration_version', { version: 'v1' });
    dao.executeOperation(cal);
    expect(dao.getCalibrationVersion()).toBe(1);
  });
});
