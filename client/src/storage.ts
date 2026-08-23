import { EncryptedSnapshot } from '@shared/types';

const DB_NAME = 'ResonantDAO';
const DB_VERSION = 2;
const LOGIN_STORE = 'login';
const WALLET_STORE = 'wallet';

function bytesToBase64(bytes: Uint8Array): string {
  const chunkSize = 0x8000; // 32k
  let result = '';
  for (let i = 0; i < bytes.length; i += chunkSize) {
    result += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(result);
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(LOGIN_STORE)) {
          db.createObjectStore(LOGIN_STORE);
        }
        if (!db.objectStoreNames.contains(WALLET_STORE)) {
          db.createObjectStore(WALLET_STORE);
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

export interface LoginBundle {
  username: string;
  loginInfo: Uint8Array;
  keyStore: Uint8Array;
}

export interface WalletState {
  username: string;
  signingSeed: Uint8Array;
  encryptionKey: Uint8Array;
  keyVersion: number;
}

export async function aesGcmEncrypt(
  key: Uint8Array,
  plaintext: Uint8Array,
  username: string
): Promise<EncryptedSnapshot> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cryptoKey = await crypto.subtle.importKey('raw', key as BufferSource, 'AES-GCM', false, ['encrypt']);
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv as BufferSource }, cryptoKey, plaintext as BufferSource));
  return {
    username,
    iv: bytesToBase64(iv),
    ciphertext: bytesToBase64(ciphertext),
    updatedAt: Date.now(),
  };
}

export async function aesGcmDecrypt(
  key: Uint8Array,
  snapshot: EncryptedSnapshot
): Promise<Uint8Array> {
  const iv = base64ToBytes(snapshot.iv);
  const ciphertext = base64ToBytes(snapshot.ciphertext);
  const cryptoKey = await crypto.subtle.importKey('raw', key as BufferSource, 'AES-GCM', false, ['decrypt']);
  return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: iv as BufferSource }, cryptoKey, ciphertext as BufferSource));
}

export async function saveLoginBundle(bundle: LoginBundle): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(LOGIN_STORE, 'readwrite');
    tx.objectStore(LOGIN_STORE).put(bundle, bundle.username);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function loadLoginBundle(username: string): Promise<LoginBundle | null> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(LOGIN_STORE, 'readonly');
    const req = tx.objectStore(LOGIN_STORE).get(username);
    req.onsuccess = () => {
      try {
        const bundle: LoginBundle | undefined = req.result;
        resolve(bundle ?? null);
      } catch (err) {
        reject(err);
      }
    };
    req.onerror = () => reject(req.error);
  });
}

export async function saveWalletState(state: WalletState): Promise<EncryptedSnapshot> {
  const db = await openDb();
  const encrypted = await aesGcmEncrypt(
    state.encryptionKey,
    serializeWalletState(state),
    state.username
  );
  return new Promise((resolve, reject) => {
    const tx = db.transaction(WALLET_STORE, 'readwrite');
    tx.objectStore(WALLET_STORE).put(encrypted, state.username);
    tx.oncomplete = () => resolve(encrypted);
    tx.onerror = () => reject(tx.error);
  });
}

export async function importWalletState(
  username: string,
  encryptionKey: Uint8Array,
  snapshot: EncryptedSnapshot
): Promise<WalletState | null> {
  if (snapshot.username !== username) return null;
  try {
    const plaintext = await aesGcmDecrypt(encryptionKey, snapshot);
    const parsed = deserializeWalletState(plaintext);
    if (parsed.username !== username) return null;
    return parsed;
  } catch {
    return null;
  }
}

export async function loadWalletState(
  username: string,
  encryptionKey: Uint8Array
): Promise<WalletState | null> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(WALLET_STORE, 'readonly');
    const req = tx.objectStore(WALLET_STORE).get(username);
    req.onsuccess = async () => {
      try {
        const snapshot: EncryptedSnapshot | undefined = req.result;
        if (!snapshot) return resolve(null);
        const plaintext = await aesGcmDecrypt(encryptionKey, snapshot);
        const parsed = deserializeWalletState(plaintext);
        if (parsed.username !== username) return resolve(null);
        resolve(parsed);
      } catch (err) {
        reject(err);
      }
    };
    req.onerror = () => reject(req.error);
  });
}

function serializeWalletState(state: WalletState): Uint8Array {
  const json = JSON.stringify({
    username: state.username,
    signingSeed: Array.from(state.signingSeed),
    encryptionKey: Array.from(state.encryptionKey),
    keyVersion: state.keyVersion,
  });
  return new TextEncoder().encode(json);
}

function deserializeWalletState(bytes: Uint8Array): WalletState {
  const parsed = JSON.parse(new TextDecoder().decode(bytes));
  return {
    username: parsed.username,
    signingSeed: Uint8Array.from(parsed.signingSeed ?? []),
    encryptionKey: Uint8Array.from(parsed.encryptionKey ?? []),
    keyVersion: parsed.keyVersion ?? 0,
  };
}
