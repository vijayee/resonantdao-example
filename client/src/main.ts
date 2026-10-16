import { createApp } from 'vue';
import { createPinia } from 'pinia';
import App from './app/App.vue';
import router from './app/router';
import './design/tokens.css';
import './design/base.css';

// Devtools-enabled CRABS build, only outside production releases
// (import.meta.env.DEV is false for `vite build`). Artifacts under
// client/dev-wasm are never copied into dist/.
async function injectDevtoolsScripts() {
  const sources = ['/dev-wasm/crabs.dev.js', '/dev-wasm/devtools-api.js', '/dev-wasm/crabs-devtools.js'];
  for (const src of sources) {
    await new Promise<void>((resolve, reject) => {
      const script = document.createElement('script');
      script.src = src;
      script.onload = () => resolve();
      script.onerror = () => reject(new Error(`devtools script not available: ${src}`));
      document.head.appendChild(script);
    });
  }
}

async function boot() {
  if (import.meta.env.DEV) {
    await injectDevtoolsScripts();
  }
  createApp(App).use(createPinia()).use(router).mount('#app');
}

void boot();
