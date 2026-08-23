import { DaoDatabase } from '../src/db';

describe('DaoDatabase', () => {
  it('stores and retrieves operations', async () => {
    const db = new DaoDatabase();
    await db.putOperation(0, { type: 'noop', signerId: 'alice', nodeId: 'server', payload: null, signature: null });
    const ops = await db.getOperations(0);
    expect(ops).toHaveLength(1);
    expect(ops[0].type).toBe('noop');
    await db.close();
  });
});
