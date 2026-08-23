import { DaoDatabase } from '../src/db';
import { EncryptedSnapshot, PublicUser } from '../../shared/src/types';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

describe('DaoDatabase', () => {
  let dbPath: string;
  let db: DaoDatabase;

  beforeEach(() => {
    dbPath = fs.mkdtempSync(path.join(os.tmpdir(), 'dao-db-'));
    db = new DaoDatabase(dbPath);
  });

  afterEach(() => {
    db.close();
    fs.rmSync(dbPath, { recursive: true, force: true });
  });

  it('stores and retrieves operations', async () => {
    await db.putOperation(0, { index: 0, bytes: 'eyJ0eXBlIjoibm9vcCJ9' });
    const ops = await db.getOperations(0);
    expect(ops).toHaveLength(1);
    expect(ops[0].bytes).toBe('eyJ0eXBlIjoibm9vcCJ9');
  });

  it('stores and retrieves snapshots', async () => {
    const snapshot: EncryptedSnapshot = {
      username: 'alice',
      iv: 'aXY=',
      ciphertext: 'Y2lwaGVy',
      updatedAt: Date.now(),
    };
    await db.putSnapshot(snapshot);
    const got = await db.getSnapshot('alice');
    expect(got).toEqual(snapshot);
  });

  it('stores and retrieves users', async () => {
    const user: PublicUser = {
      username: 'alice',
      publicKeyHex: 'alice-public-key',
      registeredAt: Date.now(),
      keyVersion: 3,
    };
    await db.putUser(user);
    const got = await db.getUser('alice');
    expect(got).toEqual(user);
  });

  it('reports user existence', async () => {
    expect(await db.userExists('bob')).toBe(false);
    await db.putUser({ username: 'bob', publicKeyHex: 'bob-public-key', registeredAt: Date.now(), keyVersion: 3 });
    expect(await db.userExists('bob')).toBe(true);
  });

  it('lists all users', async () => {
    const alice: PublicUser = { username: 'alice', publicKeyHex: 'alice-public-key', registeredAt: 1, keyVersion: 3 };
    const bob: PublicUser = { username: 'bob', publicKeyHex: 'bob-public-key', registeredAt: 2, keyVersion: 3 };
    await db.putUser(alice);
    await db.putUser(bob);
    const all = await db.getAllUsers();
    expect(all.map((u) => u.username).sort()).toEqual(['alice', 'bob']);
  });
});
