import { WaveDB } from '@vijayee/wavedb';
import { EncryptedSnapshot, PublicUser, ServerOperation } from '../../shared/src/types';

const DB_PATH = process.env.WAVEDB_PATH || './data/wavedb';

export class DaoDatabase {
  private db: WaveDB;

  constructor() {
    this.db = new WaveDB(DB_PATH, {
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
    return last ? parseInt(last as string, 10) : 0;
  }

  async setOperationCount(n: number): Promise<void> {
    await this.db.put('meta/operation_count', String(n));
  }

  async getOperations(after: number): Promise<ServerOperation[]> {
    const count = await this.getOperationCount();
    const keys: string[] = [];
    for (let i = after; i < count; i++) keys.push(`log/${i}`);
    if (keys.length === 0) return [];
    const values = await this.db.getMany(keys);
    return values.map((v) => JSON.parse(v as string));
  }

  async putSnapshot(snapshot: EncryptedSnapshot): Promise<void> {
    await this.db.putObject(`snapshots/${snapshot.username}`, snapshot);
  }

  async getSnapshot(username: string): Promise<EncryptedSnapshot | null> {
    return (await this.db.getObject(`snapshots/${username}`)) as EncryptedSnapshot | null;
  }

  async putUser(user: PublicUser): Promise<void> {
    await this.db.putObject(`users/${user.username}`, user);
  }

  async getUser(username: string): Promise<PublicUser | null> {
    return (await this.db.getObject(`users/${username}`)) as PublicUser | null;
  }

  async userExists(username: string): Promise<boolean> {
    return (await this.getUser(username)) !== null;
  }

  async getAllUsers(): Promise<PublicUser[]> {
    const iter = this.db.createReadStream({ start: 'users/', end: 'users/~' });
    const users: PublicUser[] = [];
    return new Promise((resolve, reject) => {
      iter.on('data', ({ value }: { value: string }) => users.push(JSON.parse(value)));
      iter.on('end', () => resolve(users));
      iter.on('error', reject);
    });
  }

  async close(): Promise<void> {
    this.db.close();
  }
}
