import {
  ProposalPayload,
  VotePayload,
  ExecutePayload,
  ServerMessage,
} from '@shared/types';
import { BrowserDao, bytesToBase64, bytesToHex, base64ToBytes } from './dao';
import { registerWallet, loginWallet } from './eauth-wallet';
import {
  saveLoginBundle,
  loadLoginBundle,
  saveWalletState,
  loadWalletState,
  importWalletState,
  WalletState,
} from './storage';
import { ServerClient } from './server-client';
import { KeyPair as CRABSKeyPair } from './wasm';

export class AppUI {
  private client = new ServerClient();
  private wallet: WalletState | null = null;
  private dao: BrowserDao | null = null;
  private submitting = false;

  constructor() {
    this.bindAuth();
    this.bindDashboard();
    this.client.onMessage((msg) => void this.onServerMessage(msg));
  }

  private get authSection() {
    return document.getElementById('auth');
  }

  private get dashboardSection() {
    return document.getElementById('dashboard');
  }

  private bindAuth() {
    const registerForm = document.getElementById('register-form') as HTMLFormElement | null;
    registerForm?.addEventListener('submit', (ev) => {
      ev.preventDefault();
      void this.onRegister();
    });

    const loginForm = document.getElementById('login-form') as HTMLFormElement | null;
    loginForm?.addEventListener('submit', (ev) => {
      ev.preventDefault();
      void this.onLogin();
    });
  }

  private bindDashboard() {
    const logoutBtn = document.getElementById('logout');
    logoutBtn?.addEventListener('click', () => void this.onLogout());

    const proposalForm = document.getElementById('proposal-form') as HTMLFormElement | null;
    proposalForm?.addEventListener('submit', (ev) => {
      ev.preventDefault();
      void this.onCreateProposal();
    });
  }

  private setStatus(text: string) {
    const el = document.getElementById('status');
    if (el) el.textContent = text;
  }

  private setSubmitting(value: boolean) {
    this.submitting = value;
    this.setButtonsDisabled(value);
  }

  private setButtonsDisabled(disabled: boolean) {
    document.querySelectorAll<HTMLButtonElement>('#proposal-form button, .vote-yes, .vote-no, .execute').forEach((btn) => {
      btn.disabled = disabled;
    });
  }

  private async safeExecuteRemote(bytes: Uint8Array) {
    if (!this.dao) return;
    try {
      await this.dao.executeRemote(bytes);
    } catch (err) {
      if (err instanceof Error && err.message.includes('duplicate_operation')) {
        // Broadcast already applied the operation; this is expected.
        return;
      }
      throw err;
    }
  }

  private async replayLog(dao: BrowserDao) {
    const logMsg = await this.client.getLog(0);
    if (logMsg.kind !== 'log') return;
    for (const stored of logMsg.operations) {
      try {
        await this.safeExecuteRemote(base64ToBytes(stored.bytes));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.setStatus(`State sync failed: ${message}`);
        return;
      }
    }
    this.renderProposals();
  }

  private async onRegister() {
    const username = this.inputValue('register-username').trim();
    const password = this.inputValue('register-password');
    if (!username || !password) {
      this.setStatus('Username and password are required.');
      return;
    }

    try {
      this.setStatus('Registering wallet...');
      const bundle = await registerWallet(username, password);
      const publicKeyHex = await CRABSKeyPair.derivePublicHex(bytesToHex(bundle.keys.signingSeed));

      this.setStatus('Registering with server...');
      const res = await this.client.register(username, publicKeyHex);
      if (res.kind !== 'registered') {
        this.setStatus('Registration failed.');
        return;
      }

      const dao = new BrowserDao();
      await dao.init(username, bytesToHex(bundle.keys.signingSeed), res.keyVersion);

      for (const member of res.members) {
        if (member.username !== username) {
          dao.registerMember(member.username, member.publicKeyHex);
        }
      }

      await saveLoginBundle({
        username,
        loginInfo: bundle.loginInfo,
        keyStore: bundle.keyStore,
      });

      const walletState = {
        username,
        signingSeed: bundle.keys.signingSeed,
        encryptionKey: bundle.keys.encryptionKey,
        keyVersion: res.keyVersion,
      };
      const snapshot = await saveWalletState(walletState);
      await this.client.putSnapshot(snapshot);

      this.dao = dao;
      this.wallet = walletState;
      await this.replayLog(dao);
      this.showDashboard();
      this.setStatus('Registered and logged in.');
    } catch (err) {
      this.setStatus(`Registration error: ${err instanceof Error ? err.message : String(err)}`);
      console.error(err);
    }
  }

  private async onLogin() {
    const username = this.inputValue('login-username').trim();
    const password = this.inputValue('login-password');
    if (!username || !password) {
      this.setStatus('Username and password are required.');
      return;
    }

    try {
      this.setStatus('Logging in...');
      const loginRes = await this.client.login(username);
      if (loginRes.kind !== 'login_ok') {
        this.setStatus('Login failed.');
        return;
      }

      const bundle = await loadLoginBundle(username);
      if (!bundle) {
        this.setStatus('No wallet found for this browser.');
        return;
      }

      this.setStatus('Unlocking wallet...');
      const keys = await loginWallet(username, password, bundle.loginInfo, bundle.keyStore);

      let wallet = await loadWalletState(username, keys.encryptionKey);
      if (!wallet) {
        this.setStatus('Fetching wallet snapshot from server...');
        const snapshotRes = await this.client.getSnapshot(username);
        if (snapshotRes.kind !== 'snapshot' || !snapshotRes.snapshot) {
          this.setStatus('No wallet state found locally or on server.');
          return;
        }
        const restored = await importWalletState(username, keys.encryptionKey, snapshotRes.snapshot);
        if (!restored) {
          this.setStatus('Failed to restore wallet from server snapshot.');
          return;
        }
        await saveWalletState(restored);
        wallet = restored;
      }

      const dao = new BrowserDao();
      await dao.init(username, bytesToHex(wallet.signingSeed), wallet.keyVersion);

      this.dao = dao;
      this.wallet = wallet;

      for (const member of loginRes.members) {
        if (member.username !== username) {
          this.dao?.registerMember(member.username, member.publicKeyHex);
        }
      }

      await this.replayLog(dao);

      this.showDashboard();
      this.setStatus('Logged in.');
    } catch (err) {
      this.setStatus(`Login error: ${err instanceof Error ? err.message : String(err)}`);
      console.error(err);
    }
  }

  private async onCreateProposal() {
    if (!this.dao || !this.wallet || this.submitting) return;

    const title = this.inputValue('proposal-title');
    const description = this.inputValue('proposal-description');
    if (!title) {
      this.setStatus('Proposal title is required.');
      return;
    }

    const payload: ProposalPayload = {
      proposalId: crypto.randomUUID(),
      title,
      description,
    };

    this.setSubmitting(true);
    try {
      const bytes = await this.dao.createProposal(this.wallet.username, payload);
      await this.client.submitOp(bytesToBase64(bytes));
      await this.safeExecuteRemote(bytes);
      this.renderProposals();
      this.clearForm('proposal-form');
      this.setStatus('Proposal created.');
    } catch (err) {
      this.setStatus(`Create proposal error: ${err instanceof Error ? err.message : String(err)}`);
      console.error(err);
    } finally {
      this.setSubmitting(false);
    }
  }

  private async onVote(proposalId: string, vote: 'yes' | 'no') {
    if (!this.dao || !this.wallet || this.submitting) return;

    const payload: VotePayload = { proposalId, vote };
    this.setSubmitting(true);
    try {
      const bytes = await this.dao.vote(this.wallet.username, payload);
      await this.client.submitOp(bytesToBase64(bytes));
      await this.safeExecuteRemote(bytes);
      this.setStatus(`Voted ${vote}.`);
      this.renderProposals();
    } catch (err) {
      this.setStatus(`Vote error: ${err instanceof Error ? err.message : String(err)}`);
      console.error(err);
    } finally {
      this.setSubmitting(false);
    }
  }

  private async onExecute(proposalId: string) {
    if (!this.dao || !this.wallet || this.submitting) return;

    const payload: ExecutePayload = { proposalId };
    this.setSubmitting(true);
    try {
      const bytes = await this.dao.execute(this.wallet.username, payload);
      await this.client.submitOp(bytesToBase64(bytes));
      await this.safeExecuteRemote(bytes);
      this.setStatus('Execution submitted.');
      this.renderProposals();
    } catch (err) {
      this.setStatus(`Execute error: ${err instanceof Error ? err.message : String(err)}`);
      console.error(err);
    } finally {
      this.setSubmitting(false);
    }
  }

  private async onServerMessage(msg: ServerMessage) {
    if (msg.kind === 'broadcast') {
      try {
        await this.safeExecuteRemote(base64ToBytes(msg.operation.bytes));
        this.renderProposals();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.setStatus(`Failed to apply update: ${message}`);
      }
    } else if (msg.kind === 'members') {
      for (const user of msg.users) {
        if (user.username !== this.wallet?.username) {
          this.dao?.registerMember(user.username, user.publicKeyHex);
        }
      }
    } else if (msg.kind === 'op_rejected') {
      this.setStatus(`Rejected: ${msg.reason}`);
    } else if (msg.kind === 'error') {
      this.setStatus(`Error: ${msg.message}`);
    }
  }

  private showDashboard() {
    this.authSection?.classList.add('hidden');
    this.dashboardSection?.classList.remove('hidden');

    const usernameSpan = document.getElementById('username');
    if (usernameSpan && this.wallet) {
      usernameSpan.textContent = this.wallet.username;
    }

    this.renderMembers();
    this.renderProposals();
  }

  private showAuth() {
    this.authSection?.classList.remove('hidden');
    this.dashboardSection?.classList.add('hidden');
  }

  private async onLogout() {
    if (this.wallet) {
      try {
        const snapshot = await saveWalletState(this.wallet);
        await this.client.putSnapshot(snapshot);
      } catch (err) {
        console.warn('Failed to upload snapshot on logout:', err);
      }
    }
    this.dao?.destroy();
    this.wallet = null;
    this.dao = null;
    this.showAuth();
    this.setStatus('');
  }

  private renderProposals() {
    const list = document.getElementById('proposals');
    if (!list || !this.dao) return;

    list.innerHTML = '';
    const proposals = this.dao.getProposals();
    for (const proposal of proposals) {
      const { yes, no } = this.dao.getProposalVotes(proposal.proposalId);
      const executed = this.dao.isProposalExecuted(proposal.proposalId);

      const li = document.createElement('li');
      li.innerHTML = `
        <strong>${this.escapeHtml(proposal.title)}</strong>
        <p>${this.escapeHtml(proposal.description)}</p>
        <div class="vote-counts">Yes: ${yes} / No: ${no}</div>
        <div class="actions">
          <button class="vote-yes" data-id="${this.escapeHtml(proposal.proposalId)}">Yes</button>
          <button class="vote-no" data-id="${this.escapeHtml(proposal.proposalId)}">No</button>
          <button class="execute" data-id="${this.escapeHtml(proposal.proposalId)}" ${executed ? 'disabled' : ''}>Execute</button>
        </div>
      `;
      list.appendChild(li);
    }

    list.querySelectorAll('.vote-yes').forEach((btn) => {
      btn.addEventListener('click', () => {
        const id = (btn as HTMLElement).dataset.id;
        if (id) void this.onVote(id, 'yes');
      });
    });
    list.querySelectorAll('.vote-no').forEach((btn) => {
      btn.addEventListener('click', () => {
        const id = (btn as HTMLElement).dataset.id;
        if (id) void this.onVote(id, 'no');
      });
    });
    list.querySelectorAll('.execute').forEach((btn) => {
      btn.addEventListener('click', () => {
        const id = (btn as HTMLElement).dataset.id;
        if (id) void this.onExecute(id);
      });
    });

    this.setButtonsDisabled(this.submitting);
  }

  private renderMembers() {
    const list = document.getElementById('members');
    if (!list || !this.wallet) return;
    list.innerHTML = '';
    const li = document.createElement('li');
    li.textContent = `${this.wallet.username} (you)`;
    list.appendChild(li);
  }

  private inputValue(id: string): string {
    const el = document.getElementById(id) as HTMLInputElement | null;
    return el?.value ?? '';
  }

  private clearForm(id: string) {
    const el = document.getElementById(id) as HTMLFormElement | null;
    el?.reset();
  }

  private escapeHtml(text: string): string {
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }
}
