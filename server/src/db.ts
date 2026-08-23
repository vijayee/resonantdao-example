import { WaveDB } from '@vijayee/wavedb';
import { EncryptedSnapshot, PublicUser, ServerOperation } from '../../shared/src/types';

const DB_PATH = process.env.WAVEDB_PATH || './data/wavedb';

function valueToString(v: string | Buffer | null): string | null {
  if (v === null) return null;
  if (typeof v === 'string') return v;
  if (Buffer.isBuffer(v)) return v.toString('utf8');
  throw new Error(`Unexpected value type: ${typeof v}`);
}

export class DaoDatabase {
  private db: WaveDB;

  constructor(path = DB_PATH) {
    this.db = new WaveDB(path, {
      delimiter: '/',
      wal: { syncMode: 'debounced' },
    });
  }

  async putOperation(index: number, op: ServerOperation): Promise<void> {
    await this.db.put(`log/${index}`, JSON.stringify(op));
    const current = await this.getOperationCount();
    if (index + 1 > current) {
      await this.setOperationCount(index + 1);
    }
  }

  async getOperationCount(): Promise<number> {
    const last = await this.db.get('meta/operation_count');
    const s = valueToString(last);
    return s ? parseInt(s, 10) : 0;
  }

  private async setOperationCount(n: number): Promise<void> {
    await this.db.put('meta/operation_count', String(n));
  }

  async getOperations(after: number): Promise<ServerOperation[]> {
    const count = await this.getOperationCount();
    const keys: string[] = [];
    for (let i = after; i < count; i++) keys.push(`log/${i}`);
    if (keys.length === 0) return [];
    const values = await this.db.getMany(keys);
    return values.map((v) => {
      const s = valueToString(v);
      if (s === null) throw new Error('Missing operation entry');
      return JSON.parse(s) as ServerOperation;
    });
  }

  async putSnapshot(snapshot: EncryptedSnapshot): Promise<void> {
    await this.db.putObject(`snapshots/${snapshot.username}`, snapshot);
  }

  async getSnapshot(username: string): Promise<EncryptedSnapshot | null> {
    return this.db.getObject<EncryptedSnapshot>(`snapshots/${username}`);
  }

  async putUser(user: PublicUser): Promise<void> {
    await this.db.putObject(`users/${user.username}`, user);
  }

  async getUser(username: string): Promise<PublicUser | null> {
    return this.db.getObject<PublicUser>(`users/${username}`);
  }

  async userExists(username: string): Promise<boolean> {
    return (await this.getUser(username)) !== null;
  }

  async getAllUsers(): Promise<PublicUser[]> {
    const iter = this.db.createReadStream({ start: 'users/', end: 'users/~', keys: true, values: false });
    const usernames = new Set<string>();
    await new Promise<void>((resolve, reject) => {
      iter.on('data', ({ key }: { key: string | Buffer | null }) => {
        const s = valueToString(key);
        if (s === null) return;
        const match = s.match(/^users\/([^/]+)(?:\/|$)/);
        if (match) usernames.add(match[1]);
      });
      iter.on('end', () => resolve());
      iter.on('error', reject);
    });
    return Promise.all(
      [...usernames].map(async (username) => {
        const user = await this.getUser(username);
        if (user === null) throw new Error(`User missing: ${username}`);
        return user;
      })
    );
  }

  close(): void {
    this.db.close();
  }
}
