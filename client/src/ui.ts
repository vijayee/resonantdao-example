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
  private activeTab: 'register' | 'login' = 'register';
  private memberUsernames = new Set<string>();

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

    const registerTab = document.getElementById('tab-register');
    const loginTab = document.getElementById('tab-login');
    registerTab?.addEventListener('click', () => this.switchTab('register'));
    loginTab?.addEventListener('click', () => this.switchTab('login'));
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

  private switchTab(tab: 'register' | 'login') {
    this.activeTab = tab;
    const registerPanel = document.getElementById('register-panel');
    const loginPanel = document.getElementById('login-panel');
    const registerTab = document.getElementById('tab-register');
    const loginTab = document.getElementById('tab-login');

    if (tab === 'register') {
      registerPanel?.classList.remove('hidden');
      loginPanel?.classList.add('hidden');
      registerTab?.setAttribute('aria-selected', 'true');
      loginTab?.setAttribute('aria-selected', 'false');
    } else {
      registerPanel?.classList.add('hidden');
      loginPanel?.classList.remove('hidden');
      registerTab?.setAttribute('aria-selected', 'false');
      loginTab?.setAttribute('aria-selected', 'true');
    }
  }

  private setStatus(text: string, kind: 'neutral' | 'error' | 'success' | 'loading' = 'neutral') {
    const el = document.getElementById('status');
    if (!el) return;
    el.textContent = text;
    el.className = `status-bar status-bar--${kind}`;
    el.setAttribute('role', kind === 'error' ? 'alert' : 'status');
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
        this.setStatus(`State sync failed: ${message}`, 'error');
        return;
      }
    }
    this.renderProposals();
  }

  private async onRegister() {
    const username = this.inputValue('register-username').trim();
    const password = this.inputValue('register-password');
    if (!username || !password) {
      this.setStatus('Username and password are required.', 'error');
      return;
    }

    try {
      this.setStatus('Registering wallet...', 'loading');
      const bundle = await registerWallet(username, password);
      const publicKeyHex = await CRABSKeyPair.derivePublicHex(bytesToHex(bundle.keys.signingSeed));

      this.setStatus('Registering with server...', 'loading');
      const res = await this.client.register(username, publicKeyHex);
      if (res.kind !== 'registered') {
        this.setStatus('Registration failed.', 'error');
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
      this.memberUsernames.clear();
      this.memberUsernames.add(username);
      await this.replayLog(dao);
      this.showDashboard();
      this.setStatus('Registered and logged in.', 'success');
    } catch (err) {
      this.setStatus(`Registration error: ${err instanceof Error ? err.message : String(err)}`, 'error');
      console.error(err);
    }
  }

  private async onLogin() {
    const username = this.inputValue('login-username').trim();
    const password = this.inputValue('login-password');
    if (!username || !password) {
      this.setStatus('Username and password are required.', 'error');
      return;
    }

    try {
      this.setStatus('Logging in...', 'loading');
      const loginRes = await this.client.login(username);
      if (loginRes.kind !== 'login_ok') {
        this.setStatus('Login failed.', 'error');
        return;
      }

      const bundle = await loadLoginBundle(username);
      if (!bundle) {
        this.setStatus('No wallet found for this browser.', 'error');
        return;
      }

      this.setStatus('Unlocking wallet...', 'loading');
      const keys = await loginWallet(username, password, bundle.loginInfo, bundle.keyStore);

      let wallet = await loadWalletState(username, keys.encryptionKey);
      if (!wallet) {
        this.setStatus('Fetching wallet snapshot from server...', 'loading');
        const snapshotRes = await this.client.getSnapshot(username);
        if (snapshotRes.kind !== 'snapshot' || !snapshotRes.snapshot) {
          this.setStatus('No wallet state found locally or on server.', 'error');
          return;
        }
        const restored = await importWalletState(username, keys.encryptionKey, snapshotRes.snapshot);
        if (!restored) {
          this.setStatus('Failed to restore wallet from server snapshot.', 'error');
          return;
        }
        await saveWalletState(restored);
        wallet = restored;
      }

      const dao = new BrowserDao();
      await dao.init(username, bytesToHex(wallet.signingSeed), wallet.keyVersion);

      this.dao = dao;
      this.wallet = wallet;
      this.memberUsernames.clear();
      this.memberUsernames.add(username);

      for (const member of loginRes.members) {
        if (member.username !== username) {
          this.dao?.registerMember(member.username, member.publicKeyHex);
          this.memberUsernames.add(member.username);
        }
      }

      await this.replayLog(dao);

      this.showDashboard();
      this.setStatus('Logged in.', 'success');
    } catch (err) {
      this.setStatus(`Login error: ${err instanceof Error ? err.message : String(err)}`, 'error');
      console.error(err);
    }
  }

  private async onCreateProposal() {
    if (!this.dao || !this.wallet || this.submitting) return;

    const title = this.inputValue('proposal-title');
    const description = this.inputValue('proposal-description');
    if (!title) {
      this.setStatus('Proposal title is required.', 'error');
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
      this.setStatus('Proposal created.', 'success');
    } catch (err) {
      this.setStatus(`Create proposal error: ${err instanceof Error ? err.message : String(err)}`, 'error');
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
      this.setStatus(`Voted ${vote}.`, 'success');
      this.renderProposals();
    } catch (err) {
      this.setStatus(`Vote error: ${err instanceof Error ? err.message : String(err)}`, 'error');
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
      this.setStatus('Execution submitted.', 'success');
      this.renderProposals();
    } catch (err) {
      this.setStatus(`Execute error: ${err instanceof Error ? err.message : String(err)}`, 'error');
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
        this.setStatus(`Failed to apply update: ${message}`, 'error');
      }
    } else if (msg.kind === 'members') {
      for (const user of msg.users) {
        if (user.username !== this.wallet?.username && !this.memberUsernames.has(user.username)) {
          this.dao?.registerMember(user.username, user.publicKeyHex);
          this.memberUsernames.add(user.username);
        }
      }
      this.renderMembers();
    } else if (msg.kind === 'op_rejected') {
      this.setStatus(`Rejected: ${msg.reason}`, 'error');
    } else if (msg.kind === 'error') {
      this.setStatus(`Error: ${msg.message}`, 'error');
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
    this.switchTab('register');
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
    this.memberUsernames.clear();
    this.showAuth();
    this.setStatus('');
  }

  private renderProposals() {
    const list = document.getElementById('proposals');
    if (!list || !this.dao) return;

    list.innerHTML = '';
    const proposals = this.dao.getProposals();
    if (proposals.length === 0) {
      list.appendChild(this.createEmptyState('No proposals yet. Create the first one above.'));
      return;
    }

    for (const proposal of proposals) {
      const { yes, no } = this.dao.getProposalVotes(proposal.proposalId);
      const executed = this.dao.isProposalExecuted(proposal.proposalId);
      list.appendChild(this.createProposalCard(proposal, yes, no, executed));
    }

    this.setButtonsDisabled(this.submitting);
  }

  private createEmptyState(text: string): HTMLElement {
    const li = document.createElement('li');
    li.className = 'empty-state';
    li.textContent = text;
    return li;
  }

  private createProposalCard(
    proposal: ProposalPayload,
    yes: number,
    no: number,
    executed: boolean
  ): HTMLElement {
    const li = document.createElement('li');
    li.className = 'proposal-card';

    const header = document.createElement('div');
    header.className = 'proposal-card__header';

    const title = document.createElement('h3');
    title.className = 'proposal-card__title';
    title.textContent = proposal.title;
    header.appendChild(title);

    const badge = document.createElement('span');
    badge.className = executed
      ? 'proposal-card__badge proposal-card__badge--executed'
      : 'proposal-card__badge proposal-card__badge--open';
    badge.textContent = executed ? 'Executed' : 'Open';
    badge.setAttribute('aria-label', executed ? 'Proposal executed' : 'Proposal open for voting');
    header.appendChild(badge);
    li.appendChild(header);

    if (proposal.description) {
      const desc = document.createElement('p');
      desc.className = 'proposal-card__description';
      desc.textContent = proposal.description;
      li.appendChild(desc);
    }

    const id = document.createElement('div');
    id.className = 'proposal-card__id';
    id.textContent = proposal.proposalId;
    id.title = 'Proposal ID';
    li.appendChild(id);

    const votes = document.createElement('div');
    votes.className = 'proposal-card__votes';

    const yesStat = document.createElement('div');
    yesStat.className = 'vote-stat vote-stat--yes';
    yesStat.innerHTML = `<span class="vote-stat__label">Yes</span><span class="vote-stat__value">${yes}</span>`;
    votes.appendChild(yesStat);

    const noStat = document.createElement('div');
    noStat.className = 'vote-stat vote-stat--no';
    noStat.innerHTML = `<span class="vote-stat__label">No</span><span class="vote-stat__value">${no}</span>`;
    votes.appendChild(noStat);
    li.appendChild(votes);

    const actions = document.createElement('div');
    actions.className = 'proposal-card__actions';

    const yesBtn = document.createElement('button');
    yesBtn.type = 'button';
    yesBtn.className = 'button button--secondary vote-yes';
    yesBtn.textContent = 'Yes';
    yesBtn.disabled = executed;
    yesBtn.addEventListener('click', () => void this.onVote(proposal.proposalId, 'yes'));
    actions.appendChild(yesBtn);

    const noBtn = document.createElement('button');
    noBtn.type = 'button';
    noBtn.className = 'button button--secondary vote-no';
    noBtn.textContent = 'No';
    noBtn.disabled = executed;
    noBtn.addEventListener('click', () => void this.onVote(proposal.proposalId, 'no'));
    actions.appendChild(noBtn);

    const executeBtn = document.createElement('button');
    executeBtn.type = 'button';
    executeBtn.className = 'button button--primary execute';
    executeBtn.textContent = 'Execute';
    executeBtn.disabled = executed;
    executeBtn.addEventListener('click', () => void this.onExecute(proposal.proposalId));
    actions.appendChild(executeBtn);

    li.appendChild(actions);
    return li;
  }

  private renderMembers() {
    const list = document.getElementById('members');
    if (!list || !this.wallet) return;

    list.innerHTML = '';

    const youItem = document.createElement('li');
    youItem.className = 'member-item';
    const youName = document.createElement('span');
    youName.className = 'member-item__name';
    youName.textContent = this.wallet.username;
    const youBadge = document.createElement('span');
    youBadge.className = 'member-item__badge';
    youBadge.textContent = 'you';
    youItem.appendChild(youName);
    youItem.appendChild(youBadge);
    list.appendChild(youItem);

    for (const username of this.memberUsernames) {
      if (username === this.wallet.username) continue;
      const item = document.createElement('li');
      item.className = 'member-item';
      const name = document.createElement('span');
      name.className = 'member-item__name';
      name.textContent = username;
      item.appendChild(name);
      list.appendChild(item);
    }
  }

  private inputValue(id: string): string {
    const el = document.getElementById(id) as HTMLInputElement | null;
    return el?.value ?? '';
  }

  private clearForm(id: string) {
    const el = document.getElementById(id) as HTMLFormElement | null;
    el?.reset();
  }
}
