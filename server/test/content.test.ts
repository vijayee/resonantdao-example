import { DaoDatabase } from '../../server/src/db';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { afterAll, describe, expect, it } from '@jest/globals';

const dir = mkdtempSync(join(tmpdir(), 'dao-content-'));
const db = new DaoDatabase(dir);

afterAll(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('content store', () => {
  it('stores bytes and returns their sha-256', async () => {
    const bytes = Buffer.from('hello wizard');
    const hash = await db.putContent(bytes, 'text/plain');
    expect(hash).toBe(createHash('sha256').update(bytes).digest('hex'));
  });

  it('is idempotent on duplicate puts', async () => {
    const bytes = Buffer.from('dedupe me');
    const h1 = await db.putContent(bytes, 'text/plain');
    const h2 = await db.putContent(bytes, 'text/plain');
    expect(h1).toBe(h2);
  });

  it('round-trips with media type', async () => {
    const bytes = Buffer.from('x'.repeat(1000));
    const hash = await db.putContent(bytes, 'application/octet-stream');
    const got = await db.getContent(hash);
    expect(got).toEqual({ hash, mediaType: 'application/octet-stream', bytes: bytes.toString('base64') });
  });

  it('returns null for unknown or malformed hashes', async () => {
    expect(await db.getContent('f'.repeat(64))).toBe(null);
    expect(await db.getContent('not-a-hash')).toBe(null);
  });
});