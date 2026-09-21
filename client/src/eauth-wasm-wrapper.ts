// Auto-generated browser wrapper for EAuth WASM
//
// index.js — WebAssembly bindings for EAuth.
//
// Provides a high-level JS API over the Emscripten-generated module.
// Works in browsers, Node.js, Deno, Bun, etc.
//

'use strict';

let _modulePromise = null;

export function getModule() {
  if (!_modulePromise) {
    if (typeof window !== 'undefined' && typeof window.createEAuthModule === 'function') {
      _modulePromise = window.createEAuthModule();
    } else {
      throw new Error('EAuth WASM module not loaded. Ensure /wasm/eauth/eauth.js is included before the app bundle.');
    }
  }
  return _modulePromise;
}

function writeString(M, str) {
  if (!str) return 0;
  const len = M.lengthBytesUTF8(str) + 1;
  const ptr = M._malloc(len);
  if (!ptr) throw new Error('Failed to allocate WASM memory for string');
  M.stringToUTF8(str, ptr, len);
  return ptr;
}

function writeBytes(M, bytes) {
  if (!bytes || bytes.length === 0) return { ptr: 0, len: 0 };
  const ptr = M._malloc(bytes.length);
  if (!ptr) throw new Error('Failed to allocate WASM memory for bytes');
  M.HEAPU8.set(bytes, ptr);
  return { ptr, len: bytes.length };
}

function readBytes(M, ptr, len) {
  if (!ptr || len === 0) return null;
  return M.HEAPU8.slice(ptr, ptr + len);
}

function secureFree(M, ptr, len) {
  if (ptr) {
    if (len > 0) M.HEAPU8.fill(0, ptr, ptr + len);
    M._free(ptr);
  }
}

function configToPtr(M, config) {
  if (config && config.fast) return { ptr: M._eauth_wasm_fast_config(), owns: true };
  return { ptr: M._eauth_crypto_config_default(), owns: false };
}

function freeConfig(M, cfg) {
  if (cfg && cfg.ptr && cfg.owns) M._eauth_crypto_config_free(cfg.ptr);
}

class Registration {
  constructor(M, ptr) {
    this._M = M;
    this._ptr = ptr;
  }

  get loginInfo() {
    const M = this._M;
    return readBytes(M, M._eauth_wasm_registration_login_info(this._ptr), M._eauth_wasm_registration_login_info_len(this._ptr));
  }

  get keyStore() {
    const M = this._M;
    return readBytes(M, M._eauth_wasm_registration_key_store(this._ptr), M._eauth_wasm_registration_key_store_len(this._ptr));
  }

  get deviceLogin() {
    const M = this._M;
    return readBytes(M, M._eauth_wasm_registration_device_login(this._ptr), M._eauth_wasm_registration_device_login_len(this._ptr));
  }

  get deviceKey() {
    const M = this._M;
    return readBytes(M, M._eauth_wasm_registration_device_key(this._ptr), M._eauth_wasm_registration_device_key_len(this._ptr));
  }

  destroy() {
    if (this._ptr) { this._M._eauth_registration_result_free(this._ptr); this._ptr = null; }
  }
}

class LoginResult {
  constructor(M, ptr) {
    this._M = M;
    this._ptr = ptr;
  }

  get applicationKeys() {
    const M = this._M;
    return readBytes(M, M._eauth_wasm_login_application_keys(this._ptr), M._eauth_wasm_login_application_keys_len(this._ptr));
  }

  get keyStoreKey() {
    const M = this._M;
    return readBytes(M, M._eauth_wasm_login_key_store_key(this._ptr), M._eauth_wasm_login_key_store_key_len(this._ptr));
  }

  destroy() {
    if (this._ptr) { this._M._eauth_login_result_free(this._ptr); this._ptr = null; }
  }
}

export class EAuth {
  constructor(M) {
    this._M = M;
  }

  static async create() {
    const M = await getModule();
    return new EAuth(M);
  }

  async register(password, applicationKeys, options = {}) {
    const M = this._M;
    let cfg = null;
    let paramsPtr = 0;
    let resultPtrPtr = 0;
    let pwdPtr = 0;
    let appKeysPtr = 0;
    let appKeysLen = 0;

    try {
      cfg = configToPtr(M, options.config);
      resultPtrPtr = M._malloc(4);
      if (!resultPtrPtr) throw new Error('Failed to allocate WASM memory for register result pointer');

      pwdPtr = writeString(M, password);
      const appKeys = writeBytes(M, applicationKeys);
      appKeysPtr = appKeys.ptr;
      appKeysLen = appKeys.len;

      paramsPtr = M._eauth_wasm_register_params_build(
        pwdPtr, M.lengthBytesUTF8(password),
        appKeysPtr, appKeysLen,
        0, 0);
      if (!paramsPtr) throw new Error('Failed to build register params');

      const rc = M._eauth_register(cfg.ptr, paramsPtr, resultPtrPtr);
      if (rc !== 0) throw new Error('eauth_register failed: ' + rc);

      const resultPtr = M.getValue(resultPtrPtr, '*');
      return new Registration(M, resultPtr);
    } finally {
      if (paramsPtr) M._eauth_wasm_params_free(paramsPtr);
      secureFree(M, pwdPtr, M.lengthBytesUTF8(password) + 1);
      secureFree(M, appKeysPtr, appKeysLen);
      M._free(resultPtrPtr);
      freeConfig(M, cfg);
    }
  }

  async login(password, loginInfo, keyStore, options = {}) {
    const M = this._M;
    let cfg = null;
    let paramsPtr = 0;
    let resultPtrPtr = 0;
    let pwdPtr = 0;
    let liPtr = 0;
    let liLen = 0;
    let ksPtr = 0;
    let ksLen = 0;

    try {
      cfg = configToPtr(M, options.config);
      resultPtrPtr = M._malloc(4);
      if (!resultPtrPtr) throw new Error('Failed to allocate WASM memory for login result pointer');

      pwdPtr = writeString(M, password);
      const li = writeBytes(M, loginInfo);
      liPtr = li.ptr;
      liLen = li.len;
      const ks = writeBytes(M, keyStore);
      ksPtr = ks.ptr;
      ksLen = ks.len;

      paramsPtr = M._eauth_wasm_login_params_build(
        pwdPtr, M.lengthBytesUTF8(password),
        liPtr, liLen,
        ksPtr, ksLen);
      if (!paramsPtr) throw new Error('Failed to build login params');

      const rc = M._eauth_login_interactive(cfg.ptr, paramsPtr, resultPtrPtr);
      if (rc !== 0) throw new Error('eauth_login_interactive failed: ' + rc);

      const resultPtr = M.getValue(resultPtrPtr, '*');
      return new LoginResult(M, resultPtr);
    } finally {
      if (paramsPtr) M._eauth_wasm_params_free(paramsPtr);
      secureFree(M, pwdPtr, M.lengthBytesUTF8(password) + 1);
      secureFree(M, liPtr, liLen);
      secureFree(M, ksPtr, ksLen);
      M._free(resultPtrPtr);
      freeConfig(M, cfg);
    }
  }
}
