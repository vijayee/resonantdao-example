import * as eauth from '/wasm/eauth/index.js';
import * as crabs from '/wasm/crabs/index.js';

const { EAuth, getModule: getEAuthModule } = eauth;
const { Node, KeyPair, Operation, getModule: getCRABSModule } = crabs;

export async function loadEAuth(): Promise<eauth.EAuth> {
  await getEAuthModule();
  return EAuth.create();
}

export async function loadCRABS(): Promise<any> {
  return getCRABSModule();
}

export { Node, KeyPair, Operation };
