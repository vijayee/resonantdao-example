/**
 * Browser WASM entry point.
 *
 * The raw Emscripten scripts /wasm/eauth/eauth.js and /wasm/crabs/crabs.js are
 * loaded via <script> tags in index.html before the app bundle. They expose
 * window.createEAuthModule and window.createCRABSModule.
 *
 * The original CommonJS wrappers in node_modules cannot be imported reliably
 * from Vite's production build (the namespace object ends up empty), so we use
 * browser-specific ESM copies in this source tree.
 */

export { EAuth, getModule as getEAuthModule } from './eauth-wasm-wrapper';
export { Node, KeyPair, Operation, getModule as getCRABSModule } from './crabs-wasm-wrapper';

import { getModule as getEAuthModule } from './eauth-wasm-wrapper';
import { EAuth as EAuthClass } from './eauth-wasm-wrapper';

export async function loadEAuth(): Promise<EAuthClass> {
  await getEAuthModule();
  return EAuthClass.create();
}

export async function loadCRABS(): Promise<any> {
  // The CRABS wrapper exports Node/KeyPair/Operation classes directly.
  // Returning an object with those properties keeps the API shape consistent.
  const mod = await import('./crabs-wasm-wrapper');
  return {
    Node: mod.Node,
    KeyPair: mod.KeyPair,
    Operation: mod.Operation,
    getModule: mod.getModule,
  };
}
