import { loadEAuth } from './wasm';

const webCrypto = globalThis.crypto;

export interface WalletKeys {
  signingSeed: Uint8Array; // 32 bytes
  encryptionKey: Uint8Array; // 32 bytes
}

export interface RegistrationBundle {
  username: string;
  loginInfo: Uint8Array;
  keyStore: Uint8Array;
  deviceLogin: Uint8Array;
  deviceKey: Uint8Array;
  keys: WalletKeys;
}

export async function registerWallet(username: string, password: string): Promise<RegistrationBundle> {
  if (!webCrypto || !webCrypto.getRandomValues) {
    throw new Error('Web Crypto API is not available. Registration requires a secure browser context.');
  }
  const eauth = await loadEAuth();
  // Use 64 random bytes as application keys; first 32 = signing seed, next 32 = encryption key
  const appKeys = webCrypto.getRandomValues(new Uint8Array(64));
  const reg = await eauth.register(password, appKeys, { config: { fast: true } });
  if (!reg.loginInfo || !reg.keyStore || !reg.deviceLogin || !reg.deviceKey) {
    throw new Error('EAuth registration returned incomplete data');
  }
  const bundle: RegistrationBundle = {
    username,
    loginInfo: reg.loginInfo,
    keyStore: reg.keyStore,
    deviceLogin: reg.deviceLogin,
    deviceKey: reg.deviceKey,
    keys: {
      signingSeed: appKeys.slice(0, 32),
      encryptionKey: appKeys.slice(32, 64),
    },
  };
  reg.destroy();
  return bundle;
}

export async function loginWallet(
  username: string,
  password: string,
  loginInfo: Uint8Array,
  keyStore: Uint8Array
): Promise<WalletKeys> {
  const eauth = await loadEAuth();
  const result = await eauth.login(password, loginInfo, keyStore, { config: { fast: true } });
  if (!result.applicationKeys) {
    throw new Error('EAuth login returned incomplete data');
  }
  const appKeys = result.applicationKeys;
  const keys: WalletKeys = {
    signingSeed: appKeys.slice(0, 32),
    encryptionKey: appKeys.slice(32, 64),
  };
  result.destroy();
  return keys;
}
