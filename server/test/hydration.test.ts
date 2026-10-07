import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { KeyPair, Operation } from 'crabs-wasm';
import { setOperationSignerKeyVersion } from '../../shared/src/crabs-helpers';
import { CONTRIB_NAMES, RECIP_NAMES, RES_CONFIG } from '../../shared/src/policies';
import { DaoDatabase } from '../src/db';
import { DaoNode } from '../src/crabs';
import { hydrateDao } from '../src/server';

function bytesToBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}

async function buildProposalOp(
  dao: DaoNode,
  signerKey: KeyPair,
  signerId: string
): Promise<Uint8Array> {
  const op = await Operation.create('create_proposal');
  op.signerId = signerId;
  op.nodeId = 'browser';
  const payloadJson = JSON.stringify({
    proposalId: 'p1',
    title: 'Test',
    description: 'A test proposal',
    proposalType: 'direct',
    options: ['Yes', 'No'],
    expiresAt: Date.now() + 5 * 60 * 1000,
  });
  op.payload = new TextEncoder().encode(payloadJson + '\0');
  // After registerUser + two grantRole calls, the signer's key_version is 3.
  setOperationSignerKeyVersion(op, 3);
  dao.node.sign(op, signerKey);
  return op.serialize();
}

describe('hydrateDao', () => {
  let dbPath: string;
  let db: DaoDatabase;

  beforeEach(async () => {
    dbPath = fs.mkdtempSync(path.join(os.tmpdir(), 'dao-db-'));
    db = new DaoDatabase(dbPath);
  });

  afterEach(() => {
    db.close();
    fs.rmSync(dbPath, { recursive: true, force: true });
  });

  it('restores members and proposal state from the database after restart', async () => {
    const aliceKey = await KeyPair.generate();

    // First server instance: register Alice and accept a proposal.
    const firstDao = new DaoNode();
    await firstDao.init();
    firstDao.registerMember('alice', aliceKey.publicKeyHex());

    const bytes = await buildProposalOp(firstDao, aliceKey, 'alice');
    const op = await firstDao.deserializeOperation(bytes);
    firstDao.executeOperation(op);

    await db.putUser({
      username: 'alice',
      publicKeyHex: aliceKey.publicKeyHex(),
      registeredAt: Date.now(),
      keyVersion: 3,
    });
    await db.putOperation(0, { index: 0, bytes: bytesToBase64(bytes) });

    // Simulate restart: fresh DAO node hydrated from persisted data.
    const restartedDao = new DaoNode();
    await restartedDao.init();
    await hydrateDao(db, restartedDao);

    expect(restartedDao.isMember('alice')).toBe(true);
    expect(restartedDao.node.setContains('proposals', 'p1')).toBeTruthy();
  });

  it('contribution lifecycle state survives hydrateDao op-log replay', async () => {
    // Path: DaoDatabase on a tmp dir; DaoNode with alice+bob (distinct key
    // pairs); execute submit (contributionId 'c-hyd', dims {'1': 1},
    // evidenceRef'd payload + schemaVersion 'v1'), verify (bob, pass),
    // settle (alice) via dao.executeOperation; persist every op to the DB
    // log like the hydration setup does; fresh DaoNode + hydrateDao replay.
    const aliceKey = await KeyPair.generate();
    const bobKey = await KeyPair.generate();

    const firstDao = new DaoNode();
    await firstDao.init();
    firstDao.registerMember('alice', aliceKey.publicKeyHex());
    firstDao.registerMember('bob', bobKey.publicKeyHex());

    let opCounter = 0;
    async function buildMemberOp(dao: DaoNode, signerId: string, keyPair: KeyPair, type: string, payload: object): Promise<Uint8Array> {
      const op = await Operation.create(type);
      op.signerId = signerId;
      op.nodeId = `browser-${++opCounter}`;
      op.payload = new TextEncoder().encode(JSON.stringify(payload) + '\0');
      setOperationSignerKeyVersion(op, dao.getUserKeyVersion(signerId));
      dao.node.sign(op, keyPair);
      return op.serialize();
    }

    const submitBytes = await buildMemberOp(firstDao, 'alice', aliceKey, 'submit_contribution', {
      contributionId: 'c-hyd',
      dims: { '1': 1 },
      summary: 'built a thing',
      evidenceRef: { hash: 'a'.repeat(64), uri: 'content://' + 'b'.repeat(64), mediaType: 'text/plain', size: 3 },
      schemaVersion: 'v1',
    });
    const verifyBytes = await buildMemberOp(firstDao, 'bob', bobKey, 'verify_contribution', {
      contributionId: 'c-hyd',
      submitter: 'alice',
      stepId: 'verify',
      dims: { '1': 1 },
      pass: true,
      reason: 'built and matches the claim',
      // Legacy v1 record verifies under v1 rules (single verify); the verify
      // payload must state the record's schema version — omitted means v2.
      schemaVersion: 'v1',
    });
    const settleBytes = await buildMemberOp(firstDao, 'alice', aliceKey, 'settle_contribution', {
      contributionId: 'c-hyd',
      submitter: 'alice',
      reason: 'accepting the verified outcome',
    });

    firstDao.executeOperation(await firstDao.deserializeOperation(submitBytes));
    firstDao.executeOperation(await firstDao.deserializeOperation(verifyBytes));
    firstDao.executeOperation(await firstDao.deserializeOperation(settleBytes));

    await db.putUser({
      username: 'alice',
      publicKeyHex: aliceKey.publicKeyHex(),
      registeredAt: Date.now(),
      keyVersion: 3,
    });
    await db.putUser({
      username: 'bob',
      publicKeyHex: bobKey.publicKeyHex(),
      registeredAt: Date.now(),
      keyVersion: 3,
    });
    let opIndex = 0;
    for (const bytes of [submitBytes, verifyBytes, settleBytes]) {
      await db.putOperation(opIndex, { index: opIndex, bytes: bytesToBase64(bytes) });
      opIndex += 1;
    }

    // Simulate restart: fresh DAO node hydrated from persisted data.
    const second = new DaoNode();
    await second.init();
    await hydrateDao(db, second);

    expect(second.getContributionStatus('c-hyd')).toBe('accepted');
    // Settle handler sets the status register, not the step register, so the
    // lifecycle position stays where verify left it (2).
    expect(second.node.getRegister(CONTRIB_NAMES.step('c-hyd'))).toBe(2);
    expect(second.getResBalance('alice')).toBe(RES_CONFIG.buildingBounty);
    expect(second.getResBalance('bob')).toBe(RES_CONFIG.verificationCheckCredit);
    expect(second.getDimensionBalance('alice', 1)).toBe(1);
  });

  it('round spine registers and published RCT survive hydrateDao op-log replay', async () => {
    // Full spine on the first node: custody bootstrap on closer (set_calibration_version
    // 'v1' via member-signed op) and alice's spine (audit → reckon →
    // complete) — role:member OR role:custodian lets either act. Alice's
    // contribution 'r-eco1' flows submit (dims {'1': 1}) → verify (bob) →
    // settle. Every op is persisted; then hydrateDao replays it onto a fresh
    // DaoNode and the post-spine registers must match the live ones.
    const aliceKey = await KeyPair.generate();
    const bobKey = await KeyPair.generate();
    const closerKey = await KeyPair.generate();

    const firstDao = new DaoNode();
    await firstDao.init();
    firstDao.registerMember('alice', aliceKey.publicKeyHex());
    firstDao.registerMember('bob', bobKey.publicKeyHex());
    firstDao.registerMember('closer', closerKey.publicKeyHex());

    let opCounter = 0;
    async function buildMemberOp(dao: DaoNode, signerId: string, keyPair: KeyPair, type: string, payload: object): Promise<Uint8Array> {
      const op = await Operation.create(type);
      op.signerId = signerId;
      op.nodeId = `browser-${++opCounter}`;
      op.payload = new TextEncoder().encode(JSON.stringify(payload) + '\0');
      setOperationSignerKeyVersion(op, dao.getUserKeyVersion(signerId));
      dao.node.sign(op, keyPair);
      return op.serialize();
    }

    // Custody bootstrap, mirroring crabs.test.ts: custodian-policy ops cannot
    // be admin-signed (pinned unauthorized there), so grant custody to a
    // member and sign with that member's key. node.sign() stamps the signer's
    // CURRENT CRABS key_version over whatever setOperationSignerKeyVersion
    // wrote, and grantCustodian bumps closer to v4 — so closer's calibration
    // op is signed at v4 and can never replay against a re-registered (v3)
    // closer (key_stale). Custody and the bumped version are out-of-band
    // state; that limitation is pinned below via the hydration skip.
    firstDao.grantCustodian('closer');
    const calBytes = await buildMemberOp(firstDao, 'closer', closerKey, 'set_calibration_version', { version: 'v1' });

    // The spine ops are signed by alice, a plain member: the spine policies
    // are 'role:member OR role:custodian', and (unlike custody-bumped closer)
    // alice re-registers at her signing-time key_version, so her ops replay.
    const submitBytes = await buildMemberOp(firstDao, 'alice', aliceKey, 'submit_contribution', {
      contributionId: 'r-eco1',
      dims: { '1': 1 },
      summary: 'built the spine fixture',
      evidenceRef: { hash: 'a'.repeat(64), uri: 'content://' + 'b'.repeat(64), mediaType: 'text/plain', size: 3 },
      schemaVersion: 'v1',
    });
    const verifyBytes = await buildMemberOp(firstDao, 'bob', bobKey, 'verify_contribution', {
      contributionId: 'r-eco1',
      submitter: 'alice',
      stepId: 'verify',
      dims: { '1': 1 },
      pass: true,
      reason: 'built and matches the claim',
      // Legacy v1 record verifies under v1 rules (single verify); the verify
      // payload must state the record's schema version — omitted means v2.
      schemaVersion: 'v1',
    });
    const settleBytes = await buildMemberOp(firstDao, 'alice', aliceKey, 'settle_contribution', {
      contributionId: 'r-eco1',
      submitter: 'alice',
      reason: 'accepting the verified outcome',
    });
    const auditBytes = await buildMemberOp(firstDao, 'alice', aliceKey, 'audit_round', {
      fair: true,
      note: 'fair against v1',
      calibrationVersion: 'v1',
    });
    const reckonBytes = await buildMemberOp(firstDao, 'alice', aliceKey, 'reckon_round', {
      note: 'records settled',
    });
    const completeBytes = await buildMemberOp(firstDao, 'alice', aliceKey, 'complete_round', {
      entries: [{ contributionId: 'r-eco1', submitter: 'alice', dims: { '1': 1 } }],
    });

    for (const bytes of [calBytes, submitBytes, verifyBytes, settleBytes, auditBytes, reckonBytes, completeBytes]) {
      firstDao.executeOperation(await firstDao.deserializeOperation(bytes));
    }
    expect(firstDao.getCurrentRound()).toBe(2);
    expect(firstDao.getRoundStage(1)).toBe(3);
    expect(firstDao.getRctBalance('alice')).toBe(1);

    await db.putUser({
      username: 'alice',
      publicKeyHex: aliceKey.publicKeyHex(),
      registeredAt: Date.now(),
      keyVersion: 3,
    });
    await db.putUser({
      username: 'bob',
      publicKeyHex: bobKey.publicKeyHex(),
      registeredAt: Date.now(),
      keyVersion: 3,
    });
    // keyVersion 4 reflects closer's custody bump; hydrateDao re-registers
    // every user from scratch (registerMember → keyVersion 3), so custody and
    // the bumped version are out-of-band state that plain replay cannot
    // restore — see the skip pin below.
    await db.putUser({
      username: 'closer',
      publicKeyHex: closerKey.publicKeyHex(),
      registeredAt: Date.now(),
      keyVersion: 4,
    });
    let opIndex = 0;
    for (const bytes of [calBytes, submitBytes, verifyBytes, settleBytes, auditBytes, reckonBytes, completeBytes]) {
      await db.putOperation(opIndex, { index: opIndex, bytes: bytesToBase64(bytes) });
      opIndex += 1;
    }

    // Simulate restart: fresh DAO node hydrated from persisted data. Custody
    // is out-of-band, so the persisted (closer-signed, key_version-4)
    // set_calibration_version op fails BOTH the key-version check and the
    // custodian policy on the re-registered (v3) closer, and hydrateDao skips
    // it with a warn — calibration on the fresh node comes from the 'v1'
    // bootstrap preset instead. Pin that skip rather than hiding it. The
    // spine ops replay fine: their policy is 'role:member OR role:custodian'
    // and a re-registered alice is a member.
    const warns: unknown[][] = [];
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => warns.push(args));
    const second = new DaoNode();
    await second.init();
    await hydrateDao(db, second);
    warnSpy.mockRestore();
    expect(warns.some((args) => String(args[0]).includes('Skipping invalid operation during hydration'))).toBe(true);

    expect(second.getCurrentRound()).toBe(2);        // spine completed round 1
    expect(second.getRoundStage(1)).toBe(3);         // published
    // Arithmetic: alpha(dim 1) unset in CRABS → handler defaults to 1; the
    // entry's dim-1 value is 1 → RCT = 1 x 1 = 1.
    expect(second.getRctBalance('alice')).toBe(1);   // alpha unset→1; tally dim1 = match 1 → RCT = 1×1
    expect(second.getContributionStatus('r-eco1')).toBe('accepted');
  });

  it('phase-3 v2 lifecycle, appeal, accuracy, and reciprocity state survive hydrateDao op-log replay', async () => {
    // Full v2 lifecycle with the phase-3 ops, all via signed member ops:
    // closer's custody bootstrap (set_calibration_version — persisted; the
    // replayed op warn-skips per the phase-2 pinned key-version behavior);
    // a two-verifier C_1 under schema v2 (all-parties, count 2); a second
    // alice contribution ('r-p3-2') that eve REJECTS, alice APPEALS (status
    // 3, quorum reset), and dave re-verifies to acceptance; plus a bob
    // submission carol verifies — which is why eve exists: the per-pair-once
    // reciprocity guard lets each member verify a submitter exactly once,
    // and carol had already verified alice's two-verifier C_1, so the C_2
    // rejection needed a fourth verifier. Every op is persisted; a fresh
    // DaoNode + hydrateDao must restore the contribution statuses, accuracy
    // registers, and recip: guard sets.
    const aliceKey = await KeyPair.generate();
    const bobKey = await KeyPair.generate();
    const carolKey = await KeyPair.generate();
    const daveKey = await KeyPair.generate();
    const eveKey = await KeyPair.generate();
    const closerKey = await KeyPair.generate();

    const firstDao = new DaoNode();
    await firstDao.init();
    for (const [name, key] of [
      ['alice', aliceKey], ['bob', bobKey], ['carol', carolKey],
      ['dave', daveKey], ['eve', eveKey], ['closer', closerKey],
    ] as const) {
      firstDao.registerMember(name, key.publicKeyHex());
    }

    let opCounter = 0;
    async function buildMemberOp(dao: DaoNode, signerId: string, keyPair: KeyPair, type: string, payload: object): Promise<Uint8Array> {
      const op = await Operation.create(type);
      op.signerId = signerId;
      op.nodeId = `browser-${++opCounter}`;
      op.payload = new TextEncoder().encode(JSON.stringify(payload) + '\0');
      setOperationSignerKeyVersion(op, dao.getUserKeyVersion(signerId));
      dao.node.sign(op, keyPair);
      return op.serialize();
    }

    // Custody bootstrap: mirrors the spine test above — closer signs post-
    // custody at key_version 4, which can never replay against the
    // re-registered (v3) closer, so hydration skips it with a warn while the
    // calibration value comes from the 'v1' bootstrap preset.
    firstDao.grantCustodian('closer');
    const calBytes = await buildMemberOp(firstDao, 'closer', closerKey, 'set_calibration_version', { version: 'v1' });

    // --- Contribution 1 (r-p3-1): v2 C_1, needs ALL two verifiers. ---
    const submit1Bytes = await buildMemberOp(firstDao, 'alice', aliceKey, 'submit_contribution', {
      contributionId: 'r-p3-1',
      dims: { '1': 1 },
      summary: 'built the phase-3 fixture',
      evidenceRef: { hash: 'a'.repeat(64), uri: 'content://' + 'b'.repeat(64), mediaType: 'text/plain', size: 3 },
      schemaVersion: 'v2',
    });
    const verify1aBytes = await buildMemberOp(firstDao, 'bob', bobKey, 'verify_contribution', {
      contributionId: 'r-p3-1',
      submitter: 'alice',
      stepId: 'verify',
      dims: { '1': 1 },
      pass: true,
      reason: 'first of two checks',
      priorVerifiers: [],
    });
    const verify1bBytes = await buildMemberOp(firstDao, 'carol', carolKey, 'verify_contribution', {
      contributionId: 'r-p3-1',
      submitter: 'alice',
      stepId: 'verify',
      dims: { '1': 1 },
      pass: true,
      reason: 'second of two checks completes the all-parties quorum',
      priorVerifiers: ['bob'],
    });
    const settle1Bytes = await buildMemberOp(firstDao, 'alice', aliceKey, 'settle_contribution', {
      contributionId: 'r-p3-1',
      submitter: 'alice',
      reason: 'accepting the two-verifier outcome',
      verifiers: ['bob', 'carol'],
    });

    // --- Contribution 2 (r-p3-2): rejected → appealed → re-verified. ---
    const submit2Bytes = await buildMemberOp(firstDao, 'alice', aliceKey, 'submit_contribution', {
      contributionId: 'r-p3-2',
      dims: { '2': 1 },
      summary: 'recorded the phase-3 fixture',
      evidenceRef: { hash: 'a'.repeat(64), uri: 'content://' + 'b'.repeat(64), mediaType: 'text/plain', size: 3 },
      schemaVersion: 'v2',
    });
    const reject2Bytes = await buildMemberOp(firstDao, 'eve', eveKey, 'verify_contribution', {
      contributionId: 'r-p3-2',
      submitter: 'alice',
      stepId: 'verify',
      dims: { '2': 1 },
      pass: false,
      reason: 'does not match the claim',
    });
    const appeal2Bytes = await buildMemberOp(firstDao, 'alice', aliceKey, 'appeal_verdict', {
      contributionId: 'r-p3-2',
      submitter: 'alice',
      reason: 'the record does match the claim',
    });
    const reverify2Bytes = await buildMemberOp(firstDao, 'dave', daveKey, 'verify_contribution', {
      contributionId: 'r-p3-2',
      submitter: 'alice',
      stepId: 'verify',
      dims: { '2': 1 },
      pass: true,
      reason: 'appealed re-review finds the record accurate',
      // The appeal reset the verify quorum, so the re-review starts from a
      // fresh (empty) verifier list — dave had not verified alice before.
      priorVerifiers: [],
    });
    const settle2Bytes = await buildMemberOp(firstDao, 'alice', aliceKey, 'settle_contribution', {
      contributionId: 'r-p3-2',
      submitter: 'alice',
      reason: 'the appealed re-review upheld the record',
      verifiers: ['dave'],
    });

    // --- Contribution 3 (r-p3-3): bob's record carol verifies — this is
    // what puts carol into recip:bob (asserted below on the replay). ---
    const submit3Bytes = await buildMemberOp(firstDao, 'bob', bobKey, 'submit_contribution', {
      contributionId: 'r-p3-3',
      dims: { '2': 1 },
      summary: 'bob records for the reciprocity assert',
      evidenceRef: { hash: 'a'.repeat(64), uri: 'content://' + 'b'.repeat(64), mediaType: 'text/plain', size: 3 },
      schemaVersion: 'v2',
    });
    const verify3Bytes = await buildMemberOp(firstDao, 'carol', carolKey, 'verify_contribution', {
      contributionId: 'r-p3-3',
      submitter: 'bob',
      stepId: 'verify',
      dims: { '2': 1 },
      pass: true,
      reason: 'carol has not verified bob before — per-pair fresh',
      priorVerifiers: [],
    });
    const settle3Bytes = await buildMemberOp(firstDao, 'bob', bobKey, 'settle_contribution', {
      contributionId: 'r-p3-3',
      submitter: 'bob',
      reason: 'accepting the recorded outcome',
      verifiers: ['carol'],
    });

    const opBytes = [
      calBytes, submit1Bytes, verify1aBytes, verify1bBytes, settle1Bytes,
      submit2Bytes, reject2Bytes, appeal2Bytes, reverify2Bytes, settle2Bytes,
      submit3Bytes, verify3Bytes, settle3Bytes,
    ];
    for (const bytes of opBytes) {
      firstDao.executeOperation(await firstDao.deserializeOperation(bytes));
    }
    expect(firstDao.getCurrentRound()).toBe(1);      // no spine ops: round 1 stays open
    expect(firstDao.getContributionStatus('r-p3-1')).toBe('accepted');
    expect(firstDao.getContributionStatus('r-p3-2')).toBe('accepted'); // appeal → re-verify → settle
    expect(firstDao.getContributionAppealed('r-p3-2')).toBe(true);
    expect(firstDao.getVerifierStats('bob')).toEqual({ total: 1, upheld: 1 });

    for (const [name, key] of [
      ['alice', aliceKey], ['bob', bobKey], ['carol', carolKey],
      ['dave', daveKey], ['eve', eveKey],
    ] as const) {
      await db.putUser({
        username: name,
        publicKeyHex: key.publicKeyHex(),
        registeredAt: Date.now(),
        keyVersion: 3,
      });
    }
    // closer persists at keyVersion 4 (custody bump) — see the spine test.
    await db.putUser({
      username: 'closer',
      publicKeyHex: closerKey.publicKeyHex(),
      registeredAt: Date.now(),
      keyVersion: 4,
    });
    let opIndex = 0;
    for (const bytes of opBytes) {
      await db.putOperation(opIndex, { index: opIndex, bytes: bytesToBase64(bytes) });
      opIndex += 1;
    }

    // Replay: the persisted closer calibration op warn-skips (phase-2 pinned
    // behavior — same spy convention as the spine test above); the member ops
    // replay cleanly onto the fresh node.
    const warns: unknown[][] = [];
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => warns.push(args));
    const second = new DaoNode();
    await second.init();
    await hydrateDao(db, second);
    warnSpy.mockRestore();
    expect(warns.some((args) => String(args[0]).includes('Skipping invalid operation during hydration'))).toBe(true);

    expect(second.getCurrentRound()).toBe(1);
    expect(second.getContributionStatus('r-p3-1')).toBe('accepted');
    expect(second.node.getRegister(CONTRIB_NAMES.step('r-p3-1'))).toBe(2); // parked at the settle step
    // r-p3-2's full appeal arc replays: rejected (status 2) → appeal (status 3,
    // step rewound to 1, quorum reset) → dave's re-verify advances to 2 →
    // settle finalizes as accepted, with the once-guard register still set.
    expect(second.getContributionStatus('r-p3-2')).toBe('accepted');
    expect(second.getContributionAppealed('r-p3-2')).toBe(true);
    expect(second.getContributionStatus('r-p3-3')).toBe('accepted');
    expect(second.getDimensionBalance('alice', 1)).toBe(1);
    // $RES arithmetic at settle: alice's C_1 bounty (12) fired at the
    // two-verifier acceptance; her C_2 bounty (3) fired at the APPEALED
    // re-verification (rejection pays no bounty, appeal re-review does).
    expect(second.getResBalance('alice')).toBe(RES_CONFIG.buildingBounty + RES_CONFIG.recordingBaseCredit);

    // Verifier-accuracy registers (total counts EVERY completed check — pass
    // or reject; upheld counts settle-side attestations):
    //   bob:   1 check (verify r-p3-1)      / upheld 1 (settle1 attests him)
    //   carol: 2 checks (verify r-p3-1, verify r-p3-3) / upheld 2 (settle1 + settle3 attest her)
    //   dave:  1 check (re-verify r-p3-2)   / upheld 1 (settle2 attests him)
    //   eve:   1 check (REJECT r-p3-2)      / upheld 0 (her verdict was overturned — settle2 attests only dave)
    expect(second.getVerifierStats('bob')).toEqual({ total: 1, upheld: 1 });
    expect(second.getVerifierStats('carol')).toEqual({ total: 2, upheld: 2 });
    expect(second.getVerifierStats('dave')).toEqual({ total: 1, upheld: 1 });
    expect(second.getVerifierStats('eve')).toEqual({ total: 1, upheld: 0 });

    // Reciprocity memory survives replay: everyone who checked a submitter
    // (verifier-side of the guard set) is still present, including the
    // rejecting check.
    expect(second.node.setContains(RECIP_NAMES.verifiedBy('alice'), 'bob')).toBeTruthy(); // real-wasm setContains returns 1
    expect(second.node.setContains(RECIP_NAMES.verifiedBy('alice'), 'carol')).toBeTruthy();
    expect(second.node.setContains(RECIP_NAMES.verifiedBy('alice'), 'dave')).toBeTruthy();
    expect(second.node.setContains(RECIP_NAMES.verifiedBy('alice'), 'eve')).toBeTruthy();
    expect(second.node.setContains(RECIP_NAMES.verifiedBy('bob'), 'carol')).toBeTruthy();
    expect(second.node.setContains(RECIP_NAMES.verifiedBy('carol'), 'alice')).toBeFalsy(); // nobody checked carol
  });
});
