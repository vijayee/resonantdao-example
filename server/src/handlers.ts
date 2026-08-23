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

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value !== '';
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

export class ConnectionHandler {
  private sockets = new Set<WebSocket>();
  private socketUsers = new WeakMap<WebSocket, string>();
  private submitQueue = Promise.resolve();
  private registering = new Set<string>();

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

    try {
      switch (msg.kind) {
        case 'register': {
          if (!isNonEmptyString(msg.username) || !isNonEmptyString(msg.publicKeyHex)) {
            return this.send(ws, { kind: 'error', message: 'Invalid register payload' });
          }
          if (this.registering.has(msg.username)) {
            return this.send(ws, { kind: 'error', message: 'Registration already in progress' });
          }
          this.registering.add(msg.username);
          try {
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
            this.socketUsers.set(ws, msg.username);
            const snapshot = await this.db.getSnapshot(msg.username);
            const members = await this.db.getAllUsers();
            this.send(ws, {
              kind: 'registered',
              username: msg.username,
              publicKeyHex: msg.publicKeyHex,
              keyVersion,
              attributeMachine: 'role:member reputation:1',
              members,
              snapshot: snapshot || undefined,
            });
            this.broadcast({ kind: 'members', users: members });
          } finally {
            this.registering.delete(msg.username);
          }
          break;
        }

        case 'login': {
          if (!isNonEmptyString(msg.username)) {
            return this.send(ws, { kind: 'error', message: 'Invalid login payload' });
          }
          if (!(await this.db.userExists(msg.username))) {
            return this.send(ws, { kind: 'error', message: 'User not found' });
          }
          this.socketUsers.set(ws, msg.username);
          const members = await this.db.getAllUsers();
          this.send(ws, { kind: 'login_ok', username: msg.username, members });
          break;
        }

        case 'get_log': {
          if (!isNonNegativeInteger(msg.after)) {
            return this.send(ws, { kind: 'error', message: 'Invalid get_log payload' });
          }
          const ops = await this.db.getOperations(msg.after);
          this.send(ws, { kind: 'log', operations: ops });
          break;
        }

        case 'submit_op': {
          if (!isNonEmptyString(msg.operationBytes)) {
            return this.send(ws, { kind: 'error', message: 'Invalid submit_op payload' });
          }
          // Intentional PoC trade-off: execute before persisting so invalid operations
          // are rejected before entering the log. If persistence fails after execution,
          // the in-memory DAO mirror will be ahead of the persisted log; a production
          // implementation would need rollback via state snapshots or a two-phase commit.
          const operationBytes = msg.operationBytes;
          const socket = ws;
          this.submitQueue = this.submitQueue.then(async () => {
            try {
              const bytes = base64ToBytes(operationBytes);
              const op = await this.dao.deserializeOperation(bytes);
              this.dao.executeOperation(op);
              const index = await this.db.getOperationCount();
              const stored: StoredOperation = { index, bytes: operationBytes };
              await this.db.putOperation(index, stored);
              this.broadcast({ kind: 'broadcast', operation: stored });
              this.send(socket, { kind: 'op_accepted', index });
            } catch (err) {
              console.error('submit_op failed:', err);
              this.send(socket, { kind: 'op_rejected', reason: String(err) });
            }
          });
          break;
        }

        case 'get_snapshot': {
          if (!isNonEmptyString(msg.username)) {
            return this.send(ws, { kind: 'error', message: 'Invalid get_snapshot payload' });
          }
          const boundUser = this.socketUsers.get(ws);
          if (boundUser !== msg.username) {
            return this.send(ws, { kind: 'error', message: 'Not authorized for this snapshot' });
          }
          if (!(await this.db.userExists(msg.username))) {
            return this.send(ws, { kind: 'snapshot', snapshot: null });
          }
          // Snapshot access: snapshots are stored server-side for recovery and returned
          // on login/get_snapshot without extra authentication in this PoC.
          const snapshot = await this.db.getSnapshot(msg.username);
          this.send(ws, { kind: 'snapshot', snapshot });
          break;
        }

        default: {
          this.send(ws, { kind: 'error', message: 'Unknown message kind' });
        }
      }
    } catch (err) {
      this.send(ws, { kind: 'error', message: String(err) });
    }
  }
}
