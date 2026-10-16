import { shallowRef, computed } from 'vue';
import { defineStore } from 'pinia';
import type { PublicUser } from '@shared/types';
import { BrowserDao, bytesToHex } from '../dao';
import { registerWallet, loginWallet } from '../eauth-wallet';
import {
  saveLoginBundle, loadLoginBundle, saveWalletState, loadWalletState,
  importWalletState, WalletState,
} from '../storage';
import { loadCRABS } from '../wasm';
import { serverClient, useDaoStore } from './dao';
import { useStatusStore } from './status';

export const useAuthStore = defineStore('auth', () => {
  const status = useStatusStore();
  // Secret key material — keep it out of deep reactivity proxies; whole-object
  // replacement is the only mutation this needs.
  const wallet = shallowRef<WalletState | null>(null);
  const authed = computed(() => useDaoStore().authed);

  async function register(
    usernameRaw: string,
    password: string,
    confirmPassword: string
  ): Promise<boolean> {
    const daoStore = useDaoStore();
    // Strip every invisible character class that rides in on pastes/IMEs and
    // defeats trim(): Unicode format characters (Cf — zero-widths, joiners,
    // soft hyphen, BOM), variation selectors (+ supplement), Mongolian free
    // variation selectors, the Hangul fillers (invisible-width letters), and
    // control characters (Cc — e.g. a literal DEL from a remote-desktop
    // Backspace or a terminal clipboard, which renders invisibly and fails
    // the CRABS id charset check).
    const username = usernameRaw
      .replace(
        /[\p{Cc}\p{Cf}\u{FE00}-\u{FE0F}\u{E0100}-\u{E01EF}\u{180B}-\u{180E}\u{115F}\u{1160}\u{034F}\u{2065}]/gu,
        ''
      )
      .trim();
    if (!username || !password) {
      status.set('Username and password are required.', 'error');
      return false;
    }
    // CRABS user ids reject dots, spaces, and other punctuation.
    if (!/^[A-Za-z0-9_-]+$/.test(username)) {
      // Name the exact offenders in U+ form: invisible characters render
      // through JSON.stringify without an escape, so pointing at code points
      // (not just quoting) is the only way the failure is self-diagnosing.
      const offenders = [...username]
        .filter((ch) => !/^[A-Za-z0-9_-]+$/.test(ch))
        .map((ch) => `U+${ch.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}`);
      const shown = JSON.stringify(username);
      status.set(
        `Username ${shown} (length ${username.length}; offending characters: ${offenders.join(' ')}) — letters, numbers, underscores, dashes only.`,
        'error'
      );
      return false;
    }
    if (password.length < 8) {
      status.set('Password must be at least 8 characters.', 'error');
      return false;
    }
    if (password !== confirmPassword) {
      status.set('Passwords do not match.', 'error');
      return false;
    }
    try {
      status.set('Registering wallet...', 'loading');
      const bundle = await registerWallet(username, password);
      const crabs = await loadCRABS();
      const publicKeyHex = await crabs.KeyPair.derivePublicHex(bytesToHex(bundle.keys.signingSeed));

      status.set('Registering with server...', 'loading');
      const res = await serverClient.register(username, publicKeyHex);
      if (res.kind !== 'registered') {
        status.set('Registration failed.', 'error');
        return false;
      }

      const d = new BrowserDao();
      await d.init(username, bytesToHex(bundle.keys.signingSeed), res.keyVersion);
      d.setWalletUser(username);

      for (const member of res.members) {
        if (member.username !== username) {
          d.registerMember(member.username, member.publicKeyHex, member.keyVersion);
        }
      }
      daoStore.members = res.members.map((m) => m.username);

      await saveLoginBundle({
        username,
        loginInfo: bundle.loginInfo,
        keyStore: bundle.keyStore,
      });

      const walletState: WalletState = {
        username,
        signingSeed: bundle.keys.signingSeed,
        encryptionKey: bundle.keys.encryptionKey,
        keyVersion: res.keyVersion,
      };
      const snapshot = await saveWalletState(walletState);
      await serverClient.putSnapshot(snapshot);

      wallet.value = walletState;
      await daoStore.bootstrap(d, username);
      await daoStore.replayLog();
      status.set('Registered and logged in.', 'success');
      return true;
    } catch (err) {
      status.set(`Registration error: ${err instanceof Error ? err.message : String(err)}`, 'error');
      console.error(err);
      return false;
    }
  }

  async function login(username: string, password: string): Promise<boolean> {
    const daoStore = useDaoStore();
    if (!username.trim() || !password) {
      status.set('Username and password are required.', 'error');
      return false;
    }
    try {
      status.set('Logging in...', 'loading');
      const loginRes = await serverClient.login(username.trim());
      if (loginRes.kind !== 'login_ok') {
        status.set('Login failed.', 'error');
        return false;
      }

      const bundle = await loadLoginBundle(username.trim());
      if (!bundle) {
        status.set('No wallet found for this browser.', 'error');
        return false;
      }

      status.set('Unlocking wallet...', 'loading');
      const keys = await loginWallet(username.trim(), password, bundle.loginInfo, bundle.keyStore);

      let state = await loadWalletState(username.trim(), keys.encryptionKey);
      if (!state) {
        status.set('Fetching wallet snapshot from server...', 'loading');
        const snapshotRes = await serverClient.getSnapshot(username.trim());
        if (snapshotRes.kind !== 'snapshot' || !snapshotRes.snapshot) {
          status.set('No wallet state found locally or on server.', 'error');
          return false;
        }
        const restored = await importWalletState(username.trim(), keys.encryptionKey, snapshotRes.snapshot);
        if (!restored) {
          status.set('Failed to restore wallet from server snapshot.', 'error');
          return false;
        }
        await saveWalletState(restored);
        state = restored;
      }

      const d = new BrowserDao();
      await d.init(username.trim(), bytesToHex(state.signingSeed), state.keyVersion);
      d.setWalletUser(username.trim());

      wallet.value = state;
      daoStore.members = loginRes.members.map((m: PublicUser) => m.username);

      for (const member of loginRes.members) {
        if (member.username !== username.trim()) {
          d.registerMember(member.username, member.publicKeyHex, member.keyVersion);
        }
      }

      await daoStore.bootstrap(d, username.trim());
      await daoStore.replayLog();

      status.set('Logged in.', 'success');
      return true;
    } catch (err) {
      status.set(`Login error: ${err instanceof Error ? err.message : String(err)}`, 'error');
      console.error(err);
      return false;
    }
  }

  async function logout(): Promise<void> {
    const daoStore = useDaoStore();
    if (wallet.value) {
      try {
        const snapshot = await saveWalletState(wallet.value);
        await serverClient.putSnapshot(snapshot);
      } catch (err) {
        console.warn('Failed to upload snapshot on logout:', err);
      }
    }
    daoStore.teardown();
    wallet.value = null;
    status.set('');
  }

  return { wallet, authed, register, login, logout };
});
