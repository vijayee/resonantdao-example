import express from 'express';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import fs from 'fs';
import path from 'path';
import { Operation } from 'crabs-wasm';
import { DaoDatabase } from './db';
import { DaoNode } from './crabs';
import { ConnectionHandler } from './handlers';

const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 9000;
// Source runs from server/src; compiled output is dist/server/src.
const STATIC_DIR = (() => {
  const candidates = [
    path.join(__dirname, '../../client/dist'),
    path.join(__dirname, '../../../client/dist'),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return candidates[0];
})();

function base64ToBytes(base64: string): Uint8Array {
  return new Uint8Array(Buffer.from(base64, 'base64'));
}

export async function hydrateDao(db: DaoDatabase, dao: DaoNode): Promise<void> {
  for (const user of await db.getAllUsers()) {
    try {
      dao.registerMember(user.username, user.publicKeyHex);
    } catch (err) {
      console.warn('Failed to re-register user during hydration:', user.username, err);
    }
  }
  const ops = await db.getOperations(0);
  for (const op of ops) {
    let operation: Operation | undefined;
    try {
      const bytes = base64ToBytes(op.bytes);
      operation = await dao.deserializeOperation(bytes);
      dao.executeOperation(operation);
      const syncOp = await dao.observeOperation(operation);
      if (syncOp) {
        const syncIndex = await db.getOperationCount();
        await db.putOperation(syncIndex, { index: syncIndex, bytes: Buffer.from(syncOp.serialize()).toString('base64') });
        dao.executeOperation(syncOp);
        syncOp.destroy();
      }
      operation.destroy();
    } catch (err) {
      console.warn('Skipping invalid operation during hydration:', op.index, err);
      try { operation?.destroy(); } catch {}
    }
  }
}

export async function startServer() {
  const db = new DaoDatabase();
  const dao = new DaoNode();
  await dao.init();
  await hydrateDao(db, dao);
  const handler = new ConnectionHandler(db, dao);

  const app = express();
  app.use(express.json());
  app.use(express.static(STATIC_DIR));

  const server = createServer(app);
  const wss = new WebSocketServer({ server, path: '/ws' });
  wss.on('connection', (ws) => handler.addSocket(ws));

  server.listen(PORT, () => {
    console.log(`ResonantDAO Example server listening on http://localhost:${PORT}`);
  });

  return {
    server,
    db,
    dao,
    stop: () =>
      new Promise<void>((resolve) => {
        wss.close(() => {
          server.close(() => {
            db.close();
            resolve();
          });
        });
      }),
  };
}
