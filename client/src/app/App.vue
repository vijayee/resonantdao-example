<template>
  <main v-if="!auth.authed" id="auth" class="auth-stage">
    <AuthView />
  </main>
  <div v-else id="dashboard" class="app-shell">
    <header class="site-header">
      <div class="brand">
        <span class="brand__wordmark">Resonant<span class="glow">DAO</span></span>
        <span class="brand__dao">example</span>
      </div>
      <nav class="nav-links">
        <RouterLink v-for="item in NAV" :key="item.to" :to="item.to" :class="{ on: route.path === item.to }">{{ item.label }}</RouterLink>
      </nav>
      <div class="header-end">
        <button class="theme-toggle" type="button" aria-label="Toggle theme" @click="toggle">
          <span :class="['seg', { on: theme === 'light' }]">☀</span>
          <span :class="['seg', { on: theme === 'dark' }]">☾</span>
        </button>
        <span id="username" class="header-user mono">{{ ds.username }}</span>
        <span id="token-balance" class="token-balance mono">🪙 {{ resBalance }} $RES</span>
        <button id="logout" class="button button--secondary button--small" type="button" @click="onLogout">Logout</button>
      </div>
    </header>
    <main class="app-main">
      <RouterView />
    </main>
    <footer class="app-footer mono">ResonantDAO Example — browser-based DAO proof of concept</footer>
  </div>
  <StatusBar />
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { RouterView, RouterLink, useRouter, useRoute } from 'vue-router';
import { useAuthStore } from '../stores/auth';
import { useDaoStore } from '../stores/dao';
import { useTheme } from '../design/composables/use-theme';
import AuthView from '../components/auth/AuthView.vue';
import StatusBar from '../components/status/StatusBar.vue';

const auth = useAuthStore();
const ds = useDaoStore();
const router = useRouter();
const route = useRoute();
const { theme, toggle } = useTheme();

const NAV = [
  { to: '/', label: 'Feed' },
  { to: '/proposals', label: 'Proposals' },
  { to: '/elections', label: 'Elections' },
  { to: '/contribute', label: 'Contribute' },
  { to: '/round', label: 'Round' },
  { to: '/custodians', label: 'Custodians' },
  { to: '/account', label: 'Account' },
];

const resBalance = computed(() => {
  void ds.tick;
  return ds.dao && ds.username ? ds.dao.getResBalance(ds.username) : 0;
});

async function onLogout() {
  await auth.logout();
  void router.push('/');
}
</script>

<style scoped>
.app-shell { min-height: 100vh; display: flex; flex-direction: column; }
.auth-stage { min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: var(--space-6); }
.site-header {
  position: sticky; top: 0; z-index: 40;
  display: flex; align-items: center; justify-content: space-between; gap: 20px;
  min-height: 64px; border-bottom: 1px solid var(--line);
  background: var(--glass);
  -webkit-backdrop-filter: blur(16px); backdrop-filter: blur(16px);
  padding: 0 max(16px, calc((100% - var(--max-width)) / 2));
}
.brand { font-family: var(--font-mono); font-weight: 500; font-size: 1.06rem; display: flex; align-items: baseline; gap: 10px; white-space: nowrap; }
.brand__wordmark { font-weight: 600; letter-spacing: -.02em; }
.brand__dao { font-size: .6rem; font-style: italic; color: var(--faint); }
.nav-links { display: flex; align-items: center; gap: clamp(10px, 1.6vw, 22px); font-family: var(--font-mono); font-size: .8rem; letter-spacing: .03em; color: var(--muted); }
.nav-links a { transition: color .2s; }
.nav-links a:hover { color: var(--ink); }
.nav-links a.router-link-active.on, .nav-links a.on { color: var(--jade); }
.header-end { display: flex; align-items: center; gap: var(--space-4); color: var(--muted); font-size: .875rem; }
.token-balance { color: var(--amber); }
.theme-toggle {
  display: inline-flex; align-items: center; gap: 2px; border: 1px solid var(--line);
  border-radius: 100px; padding: 4px; cursor: pointer; background: transparent;
  font-family: var(--font-mono); font-size: .7rem; color: var(--muted); letter-spacing: .06em;
}
.theme-toggle .seg { display: inline-flex; align-items: center; justify-content: center; width: 26px; height: 26px; border-radius: 100px; color: var(--faint); transition: all .2s; }
.theme-toggle .seg.on { background: rgba(95, 208, 160, .18); color: var(--jade); }
[data-theme="light"] .theme-toggle .seg.on { background: rgba(15, 122, 86, .16); }
.app-footer { border-top: 1px solid var(--line); padding: var(--space-4) var(--space-6); color: var(--faint); font-size: .75rem; text-align: center; }
@media (max-width: 900px) {
  .site-header { flex-wrap: wrap; min-height: auto; padding: 10px 14px; }
  .nav-links { flex: 1 1 auto; justify-content: flex-end; gap: 10px; }
  .brand__dao { display: none; }
}
</style>