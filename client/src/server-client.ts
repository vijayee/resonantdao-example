import { base64ToBytes, bytesToBase64 } from './dao';
import {
  ClientMessage,
  EncryptedSnapshot,
  PublicUser,
  ServerMessage,
  StoredOperation,
} from '@shared/types';

export class TimeoutError extends Error {
  constructor(message = 'Request timed out waiting for server response') {
    super(message);
    this.name = 'TimeoutError';
  }
}

const SERVER_MESSAGE_KINDS: ServerMessage['kind'][] = [
  'registered',
  'login_ok',
  'snapshot',
  'log',
  'op_accepted',
  'op_rejected',
  'broadcast',
  'error',
  'members',
  'content_stored',
  'content',
];

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isEncryptedSnapshot(value: unknown): value is EncryptedSnapshot {
  if (!isPlainObject(value)) return false;
  return (
    typeof value.username === 'string' &&
    typeof value.iv === 'string' &&
    typeof value.ciphertext === 'string' &&
    typeof value.updatedAt === 'number'
  );
}

function isStoredOperation(value: unknown): value is StoredOperation {
  if (!isPlainObject(value)) return false;
  return typeof value.index === 'number' && typeof value.bytes === 'string';
}

function isPublicUser(value: unknown): value is PublicUser {
  if (!isPlainObject(value)) return false;
  return (
    typeof value.username === 'string' &&
    typeof value.publicKeyHex === 'string' &&
    typeof value.registeredAt === 'number' &&
    typeof value.keyVersion === 'number'
  );
}

function isServerMessage(value: unknown): value is ServerMessage {
  if (!isPlainObject(value)) return false;
  const kind = value.kind;
  if (
    typeof kind !== 'string' ||
    !SERVER_MESSAGE_KINDS.includes(kind as ServerMessage['kind'])
  ) {
    return false;
  }

  switch (kind) {
    case 'registered':
      return (
        typeof value.username === 'string' &&
        typeof value.publicKeyHex === 'string' &&
        typeof value.keyVersion === 'number' &&
        typeof value.attributeMachine === 'string' &&
        Array.isArray(value.members) &&
        value.members.every(isPublicUser) &&
        (value.snapshot === undefined || isEncryptedSnapshot(value.snapshot))
      );
    case 'login_ok':
      return (
        typeof value.username === 'string' &&
        Array.isArray(value.members) &&
        value.members.every(isPublicUser)
      );
    case 'snapshot':
      return value.snapshot === null || isEncryptedSnapshot(value.snapshot);
    case 'log':
      return (
        Array.isArray(value.operations) &&
        value.operations.every(isStoredOperation)
      );
    case 'op_accepted':
      return typeof value.index === 'number';
    case 'op_rejected':
      return typeof value.reason === 'string';
    case 'broadcast':
      return isStoredOperation(value.operation);
    case 'error':
      return typeof value.message === 'string';
    case 'members':
      return Array.isArray(value.users) && value.users.every(isPublicUser);
    case 'content_stored':
      return isNonEmptyString(value.hash);
    case 'content':
      return (
        isNonEmptyString(value.hash) &&
        typeof value.mediaType === 'string' &&
        typeof value.bytesBase64 === 'string'
      );
    default:
      return false;
  }
}

export class ServerClient {
  private ws: WebSocket;
  private listeners: ((msg: ServerMessage) => void)[] = [];
  private pendingSends: {
    msg: ClientMessage;
    resolve: () => void;
    reject: (err: Error) => void;
  }[] = [];
  private pendingWaits: {
    kind: ServerMessage['kind'];
    resolve: (msg: ServerMessage) => void;
    reject: (err: Error) => void;
    listener: (msg: ServerMessage) => void;
    timeoutId?: ReturnType<typeof setTimeout>;
  }[] = [];

  constructor(url = `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws`) {
    this.ws = new WebSocket(url);

    this.ws.onopen = () => {
      for (const { msg, resolve, reject } of this.pendingSends) {
        try {
          this.ws.send(JSON.stringify(msg));
          resolve();
        } catch (err) {
          reject(err instanceof Error ? err : new Error(String(err)));
        }
      }
      this.pendingSends = [];
    };

    this.ws.onmessage = (ev) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (!isServerMessage(parsed)) {
        return;
      }
      const msg: ServerMessage = parsed;
      for (const fn of this.listeners) fn(msg);
    };

    this.ws.onclose = () => this.handleDisconnect('closed');
    this.ws.onerror = () => this.handleDisconnect('error');
  }

  private handleDisconnect(reason: 'closed' | 'error') {
    const err = new Error(`WebSocket ${reason}`);
    for (const { reject } of this.pendingSends) {
      reject(err);
    }
    this.pendingSends = [];
    for (const wait of this.pendingWaits) {
      this.listeners = this.listeners.filter((l) => l !== wait.listener);
      if (wait.timeoutId !== undefined) {
        clearTimeout(wait.timeoutId);
      }
      wait.reject(err);
    }
    this.pendingWaits = [];
  }

  onMessage(fn: (msg: ServerMessage) => void) {
    this.listeners.push(fn);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== fn);
    };
  }

  send(msg: ClientMessage): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify(msg));
        resolve();
      } else if (this.ws.readyState === WebSocket.CONNECTING) {
        this.pendingSends.push({ msg, resolve, reject });
      } else {
        reject(
          new Error(
            `Cannot send message: WebSocket is not open (readyState: ${this.ws.readyState})`
          )
        );
      }
    });
  }

  waitFor(
    kind: ServerMessage['kind'],
    timeoutMs = 30000,
    failureKind?: ServerMessage['kind']
  ): Promise<ServerMessage> {
    return new Promise((resolve, reject) => {
      let timeoutId: ReturnType<typeof setTimeout> | undefined;

      const cleanup = () => {
        if (timeoutId !== undefined) {
          clearTimeout(timeoutId);
          timeoutId = undefined;
        }
        this.listeners = this.listeners.filter((l) => l !== listener);
        this.pendingWaits = this.pendingWaits.filter((w) => w.listener !== listener);
      };

      const listener = (msg: ServerMessage) => {
        if (msg.kind === kind) {
          cleanup();
          resolve(msg);
        } else if (failureKind !== undefined && msg.kind === failureKind) {
          cleanup();
          const reason =
            msg.kind === 'error'
              ? msg.message
              : msg.kind === 'op_rejected'
              ? msg.reason
              : '';
          reject(
            new Error(
              `Server responded with ${msg.kind}${reason ? `: ${reason}` : ''}`
            )
          );
        }
      };

      timeoutId = setTimeout(() => {
        cleanup();
        reject(new TimeoutError(`Timed out waiting for ${kind}`));
      }, timeoutMs);

      this.listeners.push(listener);
      this.pendingWaits.push({ kind, resolve, reject, listener, timeoutId });
    });
  }

  async register(username: string, publicKeyHex: string) {
    await this.send({ kind: 'register', username, publicKeyHex });
    return this.waitFor('registered', 30000, 'error');
  }

  async login(username: string) {
    await this.send({ kind: 'login', username });
    return this.waitFor('login_ok', 30000, 'error');
  }

  async submitOp(operationBytes: string) {
    await this.send({ kind: 'submit_op', operationBytes });
    return this.waitFor('op_accepted', 30000, 'op_rejected');
  }

  async getLog(after: number) {
    await this.send({ kind: 'get_log', after });
    return this.waitFor('log', 30000, 'error');
  }

  async getSnapshot(username: string) {
    await this.send({ kind: 'get_snapshot', username });
    return this.waitFor('snapshot', 30000, 'error');
  }

  async putSnapshot(snapshot: EncryptedSnapshot): Promise<void> {
    await this.send({ kind: 'put_snapshot', snapshot });
  }

  async putContent(bytes: Uint8Array, mediaType: string): Promise<string> {
    await this.send({ kind: 'put_content', bytesBase64: bytesToBase64(bytes), mediaType });
    const msg = await this.waitFor('content_stored', 30000, 'error');
    return (msg as { kind: 'content_stored'; hash: string }).hash;
  }

  // A cache miss is reported as a content reply with empty bytesBase64 (not an error).
  async getContent(hash: string): Promise<{ mediaType: string; bytes: Uint8Array } | null> {
    await this.send({ kind: 'get_content', hash });
    const msg = await this.waitFor('content', 30000, 'error');
    const content = msg as { kind: 'content'; hash: string; mediaType: string; bytesBase64: string };
    if (!content.bytesBase64) return null;
    return { mediaType: content.mediaType, bytes: base64ToBytes(content.bytesBase64) };
  }
}
