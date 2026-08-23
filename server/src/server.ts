import express from 'express';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import path from 'path';
import { DaoDatabase } from './db';
import { DaoNode } from './crabs';
import { ConnectionHandler } from './handlers';

const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;
const STATIC_DIR = path.join(__dirname, '../../client/dist');

export async function startServer() {
  const db = new DaoDatabase();
  const dao = new DaoNode();
  await dao.init();
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

  return { server, db, dao };
}
