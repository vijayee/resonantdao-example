import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { KeyPair, Operation } from 'crabs-wasm';
import { setOperationSignerKeyVersion } from '../../shared/src/crabs-helpers';
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
});
