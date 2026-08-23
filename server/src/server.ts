import express from 'express';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import path from 'path';
import { DaoDatabase } from './db';
import { DaoNode } from './crabs';
import { ConnectionHandler } from './handlers';

const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;
const STATIC_DIR = path.join(__dirname, '../../client/dist');

function base64ToBytes(base64: string): Uint8Array {
  return new Uint8Array(Buffer.from(base64, 'base64'));
}

export async function hydrateDao(db: DaoDatabase, dao: DaoNode): Promise<void> {
  for (const user of await db.getAllUsers()) {
    dao.registerMember(user.username, user.publicKeyHex);
  }
  const ops = await db.getOperations(0);
  for (const op of ops) {
    const bytes = base64ToBytes(op.bytes);
    const operation = await dao.deserializeOperation(bytes);
    dao.executeOperation(operation);
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
