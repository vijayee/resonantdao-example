import { EncryptedSnapshot } from '@shared/types';
import { WalletKeys } from './eauth-wallet';

const DB_NAME = 'ResonantDAO';
const STORE_NAME = 'wallet';
const KEY = 'encryptedState';

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(STORE_NAME);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export interface LocalWalletState {
  username: string;
  loginInfo: Uint8Array;
  keyStore: Uint8Array;
  deviceLogin: Uint8Array;
  deviceKey: Uint8Array;
  daoState: Uint8Array;
  attributeMachine: string;
  keyVersion: number;
  keys: WalletKeys;
}

export async function aesGcmEncrypt(plaintext: Uint8Array, key: Uint8Array): Promise<EncryptedSnapshot> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cryptoKey = await crypto.subtle.importKey('raw', key as BufferSource, 'AES-GCM', false, ['encrypt']);
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, cryptoKey, plaintext as BufferSource));
  return {
    username: '',
    iv: btoa(String.fromCharCode(...iv)),
    ciphertext: btoa(String.fromCharCode(...ciphertext)),
    updatedAt: Date.now(),
  };
}

export async function aesGcmDecrypt(snapshot: EncryptedSnapshot, key: Uint8Array): Promise<Uint8Array> {
  const iv = Uint8Array.from(atob(snapshot.iv), (c) => c.charCodeAt(0));
  const ciphertext = Uint8Array.from(atob(snapshot.ciphertext), (c) => c.charCodeAt(0));
  const cryptoKey = await crypto.subtle.importKey('raw', key as BufferSource, 'AES-GCM', false, ['decrypt']);
  return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, cryptoKey, ciphertext as BufferSource));
}

export async function saveLocalState(state: LocalWalletState): Promise<void> {
  const db = await openDb();
  const encrypted = await aesGcmEncrypt(serializeLocalState(state), state.keys.encryptionKey);
  encrypted.username = state.username;
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).put(encrypted, KEY);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function loadLocalState(username: string, encryptionKey: Uint8Array): Promise<LocalWalletState | null> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const req = tx.objectStore(STORE_NAME).get(KEY);
    req.onsuccess = async () => {
      const snapshot: EncryptedSnapshot | undefined = req.result;
      if (!snapshot) return resolve(null);
      const plaintext = await aesGcmDecrypt(snapshot, encryptionKey);
      resolve(deserializeLocalState(plaintext));
    };
    req.onerror = () => reject(req.error);
  });
}

function serializeLocalState(state: LocalWalletState): Uint8Array {
  const json = JSON.stringify({
    username: state.username,
    loginInfo: Array.from(state.loginInfo),
    keyStore: Array.from(state.keyStore),
    deviceLogin: Array.from(state.deviceLogin),
    deviceKey: Array.from(state.deviceKey),
    daoState: Array.from(state.daoState),
    attributeMachine: state.attributeMachine,
    keyVersion: state.keyVersion,
    signingSeed: Array.from(state.keys.signingSeed),
    encryptionKey: Array.from(state.keys.encryptionKey),
  });
  return new TextEncoder().encode(json);
}

function deserializeLocalState(bytes: Uint8Array): LocalWalletState {
  const parsed = JSON.parse(new TextDecoder().decode(bytes));
  return {
    username: parsed.username,
    loginInfo: Uint8Array.from(parsed.loginInfo),
    keyStore: Uint8Array.from(parsed.keyStore),
    deviceLogin: Uint8Array.from(parsed.deviceLogin),
    deviceKey: Uint8Array.from(parsed.deviceKey),
    daoState: Uint8Array.from(parsed.daoState),
    attributeMachine: parsed.attributeMachine,
    keyVersion: parsed.keyVersion ?? 0,
    keys: {
      signingSeed: Uint8Array.from(parsed.signingSeed ?? []),
      encryptionKey: Uint8Array.from(parsed.encryptionKey ?? []),
    },
  };
}
