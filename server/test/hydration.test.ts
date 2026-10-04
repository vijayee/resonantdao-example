import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { KeyPair, Operation } from 'crabs-wasm';
import { setOperationSignerKeyVersion } from '../../shared/src/crabs-helpers';
import { CONTRIB_NAMES, RES_CONFIG } from '../../shared/src/policies';
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
});
