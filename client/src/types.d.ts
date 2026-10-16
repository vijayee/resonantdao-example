declare module '/wasm/eauth/index.js' {
  export * from 'eauth-wasm';
}
declare module '/wasm/crabs/index.js' {
  export * from 'crabs-wasm';
}

declare module '*.vue' {
  import type { DefineComponent } from 'vue';
  const component: DefineComponent<Record<string, never>, Record<string, never>, unknown>;
  export default component;
}

interface Window {
  createCRABSModule?: () => Promise<unknown>;
  createCRABSModuleDev?: () => Promise<unknown>;
  CRABSDevtools?: { attach: (node: unknown, options?: { nodeId?: string; mount?: Element }) => unknown };
  CRABSDevtoolsApi?: unknown;
}
