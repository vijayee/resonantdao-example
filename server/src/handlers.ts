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
import { CONTENT_LIMITS } from '../../shared/src/contribution';

function base64ToBytes(base64: string): Uint8Array {
  return Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
}

function isEncryptedSnapshot(value: unknown): value is { username: string; iv: string; ciphertext: string; updatedAt: number } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.username === 'string' &&
    typeof v.iv === 'string' &&
    typeof v.ciphertext === 'string' &&
    typeof v.updatedAt === 'number'
  );
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
          // Persist the operation bytes before executing so the canonical log is never
          // behind the in-memory mirror. Invalid operations are still appended to the
          // log and skipped on replay (see hydrateDao); a production system would
          // either prune invalid entries or use a two-phase commit.
          const operationBytes = msg.operationBytes;
          const socket = ws;
          this.submitQueue = this.submitQueue.then(async () => {
            let op: import('crabs-wasm').Operation | null = null;
            let syncOp: import('crabs-wasm').Operation | null = null;
            try {
              const index = await this.db.getOperationCount();
              const stored: StoredOperation = { index, bytes: operationBytes };
              await this.db.putOperation(index, stored);

              const bytes = base64ToBytes(operationBytes);
              op = await this.dao.deserializeOperation(bytes);
              this.dao.executeOperation(op);

              syncOp = await this.dao.observeOperation(op);
              if (syncOp) {
                const syncBytes = syncOp.serialize();
                const syncIndex = await this.db.getOperationCount();
                const syncStored: StoredOperation = { index: syncIndex, bytes: Buffer.from(syncBytes).toString('base64') };
                await this.db.putOperation(syncIndex, syncStored);
                this.broadcast({ kind: 'broadcast', operation: syncStored });
              }
              if (op.type === 'remove_member') {
                try {
                  const raw = typeof op.payload === 'string' ? op.payload : new TextDecoder().decode(op.payload as Uint8Array);
                  const parsed = JSON.parse(raw.replace(/\0$/, ''));
                  if (parsed && typeof parsed.username === 'string') {
                    this.dao.revokeMember(parsed.username);
                  }
                } catch (err) {
                  console.warn('remove_member revoke failed:', err);
                }
              }

              this.broadcast({ kind: 'broadcast', operation: stored });
              this.send(socket, { kind: 'op_accepted', index });
            } catch (err) {
              console.error('submit_op failed:', err);
              this.send(socket, { kind: 'op_rejected', reason: String(err) });
            } finally {
              if (op) {
                try { op.destroy(); } catch (destroyErr) { /* already destroyed */ }
              }
              if (syncOp) {
                try { syncOp.destroy(); } catch (destroyErr) { /* already destroyed */ }
              }
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

        case 'put_snapshot': {
          if (!isEncryptedSnapshot(msg.snapshot)) {
            return this.send(ws, { kind: 'error', message: 'Invalid put_snapshot payload' });
          }
          const boundUser = this.socketUsers.get(ws);
          if (boundUser !== msg.snapshot.username) {
            return this.send(ws, { kind: 'error', message: 'Not authorized for this snapshot' });
          }
          await this.db.putSnapshot(msg.snapshot);
          break;
        }

        case 'put_content': {
          if (!isNonEmptyString(msg.bytesBase64) || !isNonEmptyString(msg.mediaType) || msg.mediaType.length > 64) {
            return this.send(ws, { kind: 'error', message: 'Invalid put_content payload' });
          }
          const bytes = base64ToBytes(msg.bytesBase64);
          if (bytes.length > CONTENT_LIMITS.maxObjectBytes) {
            return this.send(ws, { kind: 'error', message: 'Content too large' });
          }
          const hash = await this.db.putContent(Buffer.from(bytes), msg.mediaType);
          this.send(ws, { kind: 'content_stored', hash });
          break;
        }

        case 'get_content': {
          if (!isNonEmptyString(msg.hash) || !/^[0-9a-f]{64}$/.test(msg.hash)) {
            return this.send(ws, { kind: 'error', message: 'Invalid get_content payload' });
          }
          const content = await this.db.getContent(msg.hash);
          this.send(ws, content
            ? { kind: 'content', hash: content.hash, mediaType: content.mediaType, bytesBase64: content.bytes }
            : { kind: 'content', hash: msg.hash, mediaType: '', bytesBase64: '' });
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
