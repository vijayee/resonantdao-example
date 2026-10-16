<template>
  <div class="auth-card" role="tabpanel" aria-label="Authentication">
    <div class="auth-brand">
      <h1 class="auth-brand__mark">Resonant<span class="glow">DAO</span></h1>
      <p class="auth-brand__sub">Contribution economy demo</p>
    </div>

    <div class="auth-tabs" role="tablist" aria-label="Register or login">
      <button
        :class="['auth-tab', { 'auth-tab--on': tab === 'register' }]"
        type="button"
        role="tab"
        :aria-selected="tab === 'register'"
        @click="tab = 'register'"
      >Register</button>
      <button
        :class="['auth-tab', { 'auth-tab--on': tab === 'login' }]"
        type="button"
        role="tab"
        :aria-selected="tab === 'login'"
        @click="tab = 'login'"
      >Login</button>
    </div>

    <form v-if="tab === 'register'" id="register-form" class="auth-form" @submit.prevent="onRegister">
      <div class="form-group">
        <label class="form-label" for="register-username">Username</label>
        <input id="register-username" v-model="username" class="form-input" type="text" autocomplete="username" required />
      </div>
      <div class="form-group">
        <label class="form-label" for="register-password">Password</label>
        <input id="register-password" v-model="password" class="form-input" type="password" autocomplete="new-password" required />
        <div class="password-strength" aria-live="polite" aria-atomic="true">
          <div class="password-strength__bar" aria-hidden="true"><div class="password-strength__fill" :style="{ width: strength.width, background: strength.color }" /></div>
          <span class="password-strength__label">{{ strength.label }}</span>
        </div>
      </div>
      <div class="form-group">
        <label class="form-label" for="register-password-confirm">Confirm password</label>
        <input id="register-password-confirm" v-model="confirmPassword" class="form-input" type="password" autocomplete="new-password" required />
      </div>
      <button class="button button--primary" type="submit">Create account</button>
    </form>
    <form v-else id="login-form" class="auth-form" @submit.prevent="onLogin">
      <div class="form-group">
        <label class="form-label" for="login-username">Username</label>
        <input id="login-username" v-model="username" class="form-input" type="text" autocomplete="username" required />
      </div>
      <div class="form-group">
        <label class="form-label" for="login-password">Password</label>
        <input id="login-password" v-model="password" class="form-input" type="password" autocomplete="current-password" required />
      </div>
      <button class="button button--primary" type="submit">Sign in</button>
    </form>
  </div>
</template>

<script setup lang="ts">
import { ref, computed } from 'vue';
import { useRouter } from 'vue-router';
import { useAuthStore } from '../../stores/auth';

const auth = useAuthStore();
const router = useRouter();

const tab = ref<'register' | 'login'>('register');
const username = ref('');
const password = ref('');
const confirmPassword = ref('');

const strength = computed(() => {
  const pw = password.value;
  let score = 0;
  if (pw.length >= 8) score += 1;
  if (/[A-Z]/.test(pw)) score += 1;
  if (/[0-9]/.test(pw)) score += 1;
  if (/[^A-Za-z0-9]/.test(pw)) score += 1;
  const labels = ['Too short', 'Weak', 'Fair', 'Good', 'Strong'];
  const widths = ['0%', '33%', '66%', '100%', '100%'];
  const colors = ['var(--danger)', 'var(--danger)', 'var(--amber)', 'var(--jade)', 'var(--jade)'];
  return { label: labels[score], width: widths[score], color: colors[score] };
});

async function onRegister() {
  const ok = await auth.register(username.value, password.value, confirmPassword.value);
  if (ok) void router.push('/proposals');
}

async function onLogin() {
  const ok = await auth.login(username.value, password.value);
  if (ok) void router.push('/proposals');
}
</script>

<style scoped>
.auth-card {
  width: 100%; max-width: 440px;
  border: 1px solid var(--line); border-radius: var(--radius-lg);
  padding: var(--space-10) var(--space-8);
  background: var(--card-bg);
  -webkit-backdrop-filter: blur(8px); backdrop-filter: blur(8px);
  display: flex; flex-direction: column; gap: var(--space-6);
}
.auth-brand { text-align: center; }
.auth-brand__mark { font-size: 2.2rem; }
.auth-brand__sub { color: var(--muted); margin-top: var(--space-2); font-size: .875rem; }
.auth-tabs { display: flex; gap: var(--space-2); padding: var(--space-1); border: 1px solid var(--line); border-radius: 100px; }
.auth-tab {
  flex: 1; background: transparent; border: none; border-radius: 100px;
  font-family: var(--font-mono); font-size: .78rem; letter-spacing: .06em;
  color: var(--muted); padding: var(--space-2) var(--space-3); cursor: pointer; transition: all .2s;
}
.auth-tab:hover { color: var(--ink); }
.auth-tab--on { background: rgba(95, 208, 160, .18); color: var(--jade); }
.auth-form { display: flex; flex-direction: column; gap: var(--space-4); }
.password-strength { display: flex; align-items: center; gap: var(--space-2); min-height: 1.25rem; font-size: .8125rem; color: var(--muted); }
.password-strength__bar { flex: 1; height: 4px; background: var(--line); border-radius: 2px; overflow: hidden; }
.password-strength__fill { height: 100%; transition: width .2s, background .2s; }
.password-strength__label { white-space: nowrap; }
</style>
