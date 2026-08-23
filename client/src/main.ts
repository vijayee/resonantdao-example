import { registerWallet, loginWallet } from './eauth-wallet';
import { saveLocalState, loadLocalState } from './storage';
import { Node, KeyPair } from './wasm';

console.log('ResonantDAO client modules loaded', { registerWallet, loginWallet, saveLocalState, loadLocalState, Node, KeyPair });
