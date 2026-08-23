import { RawData, WebSocket } from 'ws';
import { DaoDatabase } from './db';
import { DaoNode } from './crabs';
import {
  ClientMessage,
  EncryptedSnapshot,
  PublicUser,
  ServerMessage,
  StoredOperation,
} from '../../shared/src/types';

function base64ToBytes(base64: string): Uint8Array {
  return Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
}

export class ConnectionHandler {
  private sockets = new Set<WebSocket>();

  constructor(private db: DaoDatabase, private dao: DaoNode) {}

  addSocket(ws: WebSocket) {
    this.sockets.add(ws);
    ws.on('message', (data) => this.onMessage(ws, data));
    ws.on('close', () => this.sockets.delete(ws));
  }

  private send(ws: WebSocket, msg: ServerMessage) {
    if (ws.readyState === 1) ws.send(JSON.stringify(msg));
  }

  private broadcast(msg: ServerMessage) {
    const text = JSON.stringify(msg);
    for (const ws of this.sockets) {
      if (ws.readyState === 1) ws.send(text);
    }
  }

  private async onMessage(ws: WebSocket, raw: RawData) {
    let msg: ClientMessage;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return this.send(ws, { kind: 'error', message: 'Invalid JSON' });
    }

    switch (msg.kind) {
      case 'register': {
        if (await this.db.userExists(msg.username)) {
          return this.send(ws, { kind: 'error', message: 'Username taken' });
        }
        const keyVersion = this.dao.registerMember(msg.username, msg.publicKeyHex);
        const user: PublicUser = {
          username: msg.username,
          publicKeyHex: msg.publicKeyHex,
          registeredAt: Date.now(),
          keyVersion,
        };
        await this.db.putUser(user);
        const snapshot = await this.db.getSnapshot(msg.username);
        this.send(ws, {
          kind: 'registered',
          username: msg.username,
          publicKeyHex: msg.publicKeyHex,
          keyVersion,
          attributeMachine: 'role:member reputation:1',
          snapshot: snapshot || undefined,
        });
        break;
      }

      case 'login': {
        if (!(await this.db.userExists(msg.username))) {
          return this.send(ws, { kind: 'error', message: 'User not found' });
        }
        const snapshot = await this.db.getSnapshot(msg.username);
        this.send(ws, { kind: 'snapshot', snapshot });
        break;
      }

      case 'get_log': {
        const ops = await this.db.getOperations(msg.after);
        this.send(ws, { kind: 'log', operations: ops });
        break;
      }

      case 'submit_op': {
        const bytes = base64ToBytes(msg.operationBytes);
        let op;
        try {
          op = await this.dao.deserializeOperation(bytes);
          this.dao.executeOperation(op);
        } catch (err) {
          this.send(ws, { kind: 'op_rejected', reason: String(err) });
          break;
        }
        const index = await this.db.getOperationCount();
        const stored: StoredOperation = { index, bytes: msg.operationBytes };
        await this.db.putOperation(index, stored);
        this.broadcast({ kind: 'broadcast', operation: stored });
        this.send(ws, { kind: 'op_accepted', index });
        break;
      }

      case 'get_snapshot': {
        const snapshot = await this.db.getSnapshot(msg.username);
        this.send(ws, { kind: 'snapshot', snapshot });
        break;
      }
    }
  }
}
