import {
  ProposalPayload,
  VotePayload,
  ExecutePayload,
  ServerMessage,
  StartElectionPayload,
  SetTokenConfigPayload,
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
import { loadCRABS } from './wasm';

export class AppUI {
  private client = new ServerClient();
  private wallet: WalletState | null = null;
  private dao: BrowserDao | null = null;
  private submitting = false;
  private activeTab: 'register' | 'login' = 'register';
  private memberUsernames = new Set<string>();
  private votedProposals = new Set<string>();

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

    const passwordInput = document.getElementById('register-password') as HTMLInputElement | null;
    passwordInput?.addEventListener('input', () => this.updatePasswordStrength());
  }

  private bindDashboard() {
    const logoutBtn = document.getElementById('logout');
    logoutBtn?.addEventListener('click', () => void this.onLogout());

    const proposalForm = document.getElementById('proposal-form') as HTMLFormElement | null;
    proposalForm?.addEventListener('submit', (ev) => {
      ev.preventDefault();
      void this.onCreateProposal();
    });

    const startElectionBtn = document.getElementById('start-election');
    startElectionBtn?.addEventListener('click', () => void this.onStartElection());

    const tokenConfigForm = document.getElementById('token-config-form') as HTMLFormElement | null;
    tokenConfigForm?.addEventListener('submit', (ev) => {
      ev.preventDefault();
      void this.onSetTokenConfig();
    });

    // Time-travel control for demo: advance the node clock at a fixed rate so
    // 5-minute expiry and 3-minute token distribution play out quickly.
    this.startDemoClock();
  }

  private startDemoClock() {
    // Keep the local node clock synchronized with wall-clock time so the client
    // and server agree on proposal expiry and token distribution.
    const update = () => {
      this.dao?.setTime(Date.now());
      this.renderTokenBalance();
      this.renderMembers();
      this.renderProposals();
      this.renderElections();
      this.renderCustodians();
      this.renderCustodianControls();
    };
    update();
    setInterval(update, 1000);
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
    document.querySelectorAll<HTMLButtonElement>('#proposal-form button, .vote-option, .execute').forEach((btn) => {
      btn.disabled = disabled;
    });
  }

  private async safeExecuteRemote(bytes: Uint8Array) {
    if (!this.dao) return;
    try {
      await this.dao.executeRemote(bytes);
    } catch (err) {
      if (
        err instanceof Error &&
        (
          err.message.includes('duplicate_operation') ||
          err.message.includes('already_executed') ||
          err.message.includes('unauthorized') ||
          err.message.includes('key_stale')
        )
      ) {
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

  private evaluatePasswordStrength(password: string): { score: number; label: string; className: string } {
    let score = 0;
    if (password.length >= 8) score += 1;
    if (/[A-Z]/.test(password)) score += 1;
    if (/[0-9]/.test(password)) score += 1;
    if (/[^A-Za-z0-9]/.test(password)) score += 1;

    const levels = [
      { label: 'Too short', className: 'password-strength--weak' },
      { label: 'Weak', className: 'password-strength--weak' },
      { label: 'Fair', className: 'password-strength--fair' },
      { label: 'Good', className: 'password-strength--good' },
      { label: 'Strong', className: 'password-strength--good' },
    ];
    return { score, ...levels[score] };
  }

  private updatePasswordStrength() {
    const password = this.inputValue('register-password');
    const container = document.getElementById('password-strength');
    if (!container) return;

    const { score, label, className } = this.evaluatePasswordStrength(password);
    container.className = `password-strength ${className}`;
    container.innerHTML = `
      <div class="password-strength__bar" aria-hidden="true"><div class="password-strength__fill"></div></div>
      <span class="password-strength__label">${label}</span>
    `;
    // Ensure the fill width matches the chosen class; set inline width for the visual bar.
    const widths = ['0%', '33%', '66%', '100%', '100%'];
    const fill = container.querySelector('.password-strength__fill') as HTMLElement | null;
    if (fill) fill.style.width = widths[score];
  }

  private async onRegister() {
    const username = this.inputValue('register-username').trim();
    const password = this.inputValue('register-password');
    const confirmPassword = this.inputValue('register-password-confirm');
    if (!username || !password) {
      this.setStatus('Username and password are required.', 'error');
      return;
    }
    if (password.length < 8) {
      this.setStatus('Password must be at least 8 characters.', 'error');
      return;
    }
    if (password !== confirmPassword) {
      this.setStatus('Passwords do not match.', 'error');
      return;
    }

    try {
      this.setStatus('Registering wallet...', 'loading');
      const bundle = await registerWallet(username, password);
      const crabs = await loadCRABS();
      const publicKeyHex = await crabs.KeyPair.derivePublicHex(bytesToHex(bundle.keys.signingSeed));

      this.setStatus('Registering with server...', 'loading');
      const res = await this.client.register(username, publicKeyHex);
      if (res.kind !== 'registered') {
        this.setStatus('Registration failed.', 'error');
        return;
      }

      const dao = new BrowserDao();
      await dao.init(username, bytesToHex(bundle.keys.signingSeed), res.keyVersion);
      dao.setWalletUser(username);

      for (const member of res.members) {
        if (member.username !== username) {
          dao.registerMember(member.username, member.publicKeyHex, member.keyVersion);
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
      dao.setWalletUser(username);

      this.dao = dao;
      this.wallet = wallet;
      this.memberUsernames.clear();
      this.memberUsernames.add(username);

      for (const member of loginRes.members) {
        if (member.username !== username) {
          this.dao?.registerMember(member.username, member.publicKeyHex, member.keyVersion);
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

    const rawOptions = this.inputValue('proposal-options');
    const parsed = rawOptions.split(',').map((s) => s.trim()).filter((s) => s.length > 0);
    let options: string[];
    if (parsed.length === 0) {
      options = ['Yes', 'No'];
    } else if (parsed.length >= 2 && parsed.length <= 10 && new Set(parsed).size === parsed.length) {
      options = parsed;
    } else {
      this.setStatus('Options must be 2-10 unique, non-empty comma-separated values.', 'error');
      return;
    }

    const proposalType = this.inputValue('proposal-type') as 'direct' | 'quadratic';
    // Use the DAO node time so expiry stays consistent with the local
    // state machine clock.
    const nowMs = this.dao.getNodeTimeMs();
    const payload: ProposalPayload = {
      proposalId: crypto.randomUUID(),
      title,
      description,
      proposalType: proposalType === 'quadratic' ? 'quadratic' : 'direct',
      options,
      expiresAt: nowMs + 60 * 1000,
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

  private async onVote(proposalId: string, choice: number) {
    if (!this.dao || !this.wallet || this.submitting) return;

    const payload: VotePayload = { proposalId, choice };
    this.setSubmitting(true);
    try {
      const bytes = await this.dao.vote(this.wallet.username, payload);
      await this.client.submitOp(bytesToBase64(bytes));
      await this.safeExecuteRemote(bytes);
      if (this.dao.getProposalType(proposalId) === 'direct') {
        this.votedProposals.add(proposalId);
      }
      this.setStatus(`Voted.`, 'success');
      this.renderProposals();
    } catch (err) {
      this.setStatus(`Vote error: ${err instanceof Error ? err.message : String(err)}`, 'error');
      console.error(err);
    } finally {
      this.setSubmitting(false);
      this.renderProposals();
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
      this.memberUsernames = new Set(msg.users.map((user) => user.username));
      for (const user of msg.users) {
        if (user.username !== this.wallet?.username) {
          this.dao?.registerMember(user.username, user.publicKeyHex, user.keyVersion);
        }
      }
      this.renderMembers();
      this.renderCustodianControls();
      this.renderCustodians();
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

    this.renderTokenBalance();
    this.renderMembers();
    this.renderProposals();
    this.renderElections();
    this.renderCustodians();
    this.renderCustodianControls();
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
    this.votedProposals.clear();
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
      const executed = this.dao.isProposalExecuted(proposal.proposalId);
      list.appendChild(this.createProposalCard(proposal, executed));
    }
  }

  private createEmptyState(text: string): HTMLElement {
    const li = document.createElement('li');
    li.className = 'empty-state';
    li.textContent = text;
    return li;
  }

  private createProposalCard(
    proposal: ProposalPayload,
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

    const typeLabel = document.createElement('div');
    typeLabel.className = 'proposal-card__type';
    const pType = this.dao.getProposalType(proposal.proposalId);
    typeLabel.textContent = pType === 'quadratic' ? 'Quadratic Vote' : 'Direct Vote';
    li.appendChild(typeLabel);

    const expiresAt = this.dao.getProposalExpiry(proposal.proposalId);
    const remainingMs = Math.max(0, expiresAt - this.dao.getNodeTimeMs());
    const timer = document.createElement('div');
    timer.className = 'proposal-card__timer';
    timer.textContent = executed ? 'Voting closed' : `Closes in ${Math.ceil(remainingMs / 1000)}s`;
    li.appendChild(timer);

    const options = proposal.options ?? ['Yes', 'No'];
    const counts = this.dao.getProposalOptionVotes(proposal.proposalId);

    const voteRows = document.createElement('div');
    voteRows.className = 'proposal-card__votes';
    options.forEach((label, i) => {
      const row = document.createElement('div');
      row.className = 'vote-stat';
      const labelEl = document.createElement('span');
      labelEl.className = 'vote-stat__label';
      labelEl.textContent = label;
      const valueEl = document.createElement('span');
      valueEl.className = 'vote-stat__value';
      valueEl.textContent = String(counts[i] ?? 0);
      row.appendChild(labelEl);
      row.appendChild(valueEl);
      voteRows.appendChild(row);
    });
    li.appendChild(voteRows);

    let nextCumulativeCost = 0;
    if (pType === 'quadratic' && this.wallet) {
      const used = this.dao.getProposalTokenUsage(proposal.proposalId, this.wallet.username);
      const voteCount = this.dao.getProposalVoteCount(proposal.proposalId, this.wallet.username);
      nextCumulativeCost = ((voteCount + 1) * (voteCount + 2) * (2 * voteCount + 3)) / 6;
      const balance = this.dao.getTokenBalance(this.wallet.username);
      const tokenInfo = document.createElement('div');
      tokenInfo.className = 'proposal-card__tokens';
      tokenInfo.textContent = `Tokens used here: ${used} | Next vote cost: ${nextCumulativeCost} | Balance: ${balance}`;
      li.appendChild(tokenInfo);
    }

    const actions = document.createElement('div');
    actions.className = 'proposal-card__actions';

    const alreadyVoted = this.votedProposals.has(proposal.proposalId);
    const canVoteQuadratic = pType === 'quadratic' && this.wallet && this.dao.getTokenBalance(this.wallet.username) >= nextCumulativeCost && nextCumulativeCost > 0;
    const actionsDisabled = executed || this.submitting || (alreadyVoted && !canVoteQuadratic);

    options.forEach((label, i) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'button button--secondary vote-option';
      btn.textContent = label;
      btn.disabled = actionsDisabled;
      btn.addEventListener('click', () => void this.onVote(proposal.proposalId, i));
      actions.appendChild(btn);
    });

    const executeBtn = document.createElement('button');
    executeBtn.type = 'button';
    executeBtn.className = 'button button--primary execute';
    executeBtn.textContent = 'Execute';
    executeBtn.disabled = executed || this.submitting;
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
    if (this.dao?.custodians.includes(this.wallet.username)) {
      const custodianBadge = document.createElement('span');
      custodianBadge.className = 'member-item__badge';
      custodianBadge.textContent = 'custodian';
      youItem.appendChild(custodianBadge);
    }
    if (this.dao) {
      const tokenBadge = document.createElement('span');
      tokenBadge.className = 'member-item__tokens';
      tokenBadge.textContent = `🪙 ${this.dao.getTokenBalance(this.wallet.username)}`;
      youItem.appendChild(tokenBadge);
    }
    list.appendChild(youItem);

    for (const username of this.memberUsernames) {
      if (username === this.wallet.username) continue;
      const item = document.createElement('li');
      item.className = 'member-item';
      const name = document.createElement('span');
      name.className = 'member-item__name';
      name.textContent = username;
      item.appendChild(name);
      if (this.dao?.custodians.includes(username)) {
        const badge = document.createElement('span');
        badge.className = 'member-item__badge';
        badge.textContent = 'custodian';
        item.appendChild(badge);
      }
      list.appendChild(item);
    }
  }

  private async onStartElection() {
    if (!this.dao || !this.wallet || this.submitting) return;
    const candidates = Array.from(new Set([...this.memberUsernames, this.wallet.username])).sort();
    const payload: StartElectionPayload = {
      electionId: crypto.randomUUID(),
      candidates,
      expiresAt: this.dao.getNodeTimeMs() + 60 * 1000,
    };
    this.setSubmitting(true);
    try {
      const bytes = await this.dao.startElection(this.wallet.username, payload);
      await this.client.submitOp(bytesToBase64(bytes));
      await this.safeExecuteRemote(bytes);
      this.setStatus('Election started.', 'success');
      this.renderElections();
    } catch (err) {
      this.setStatus(`Election error: ${err instanceof Error ? err.message : String(err)}`, 'error');
      console.error(err);
    } finally {
      this.setSubmitting(false);
    }
  }

  private async onCastBallot(electionId: string) {
    if (!this.dao || !this.wallet || this.submitting) return;
    const picks = Array.from(
      document.querySelectorAll<HTMLInputElement>(
        `.proposal-card[data-election-id="${electionId}"] .ballot-option:checked`
      )
    ).map((el) => el.dataset.member || '').filter((m) => m.length > 0);
    if (picks.length < 1 || picks.length > 5) {
      this.setStatus('Pick between 1 and 5 candidates.', 'error');
      return;
    }
    this.setSubmitting(true);
    try {
      const bytes = await this.dao.castBallot(this.wallet.username, { electionId, picks });
      await this.client.submitOp(bytesToBase64(bytes));
      await this.safeExecuteRemote(bytes);
      this.setStatus('Ballot cast.', 'success');
      this.renderElections();
    } catch (err) {
      this.setStatus(`Ballot error: ${err instanceof Error ? err.message : String(err)}`, 'error');
      console.error(err);
    } finally {
      this.setSubmitting(false);
    }
  }

  private async onFinalizeElection(electionId: string) {
    if (!this.dao || !this.wallet || this.submitting) return;
    const election = this.dao.getElections().find((e) => e.electionId === electionId);
    if (!election) return;
    this.setSubmitting(true);
    try {
      const bytes = await this.dao.finalizeElection(this.wallet.username, {
        electionId,
        candidates: election.candidates,
      });
      await this.client.submitOp(bytesToBase64(bytes));
      await this.safeExecuteRemote(bytes);
      this.setStatus('Election finalized.', 'success');
      this.renderElections();
      this.renderCustodians();
      this.renderCustodianControls();
    } catch (err) {
      this.setStatus(`Finalize error: ${err instanceof Error ? err.message : String(err)}`, 'error');
      console.error(err);
    } finally {
      this.setSubmitting(false);
    }
  }

  private async onCastRunoffVote(electionId: string, candidate: string) {
    if (!this.dao || !this.wallet || this.submitting) return;
    this.setSubmitting(true);
    try {
      const bytes = await this.dao.castRunoffVote(this.wallet.username, { electionId, candidate });
      await this.client.submitOp(bytesToBase64(bytes));
      await this.safeExecuteRemote(bytes);
      this.setStatus(`Runoff vote cast for ${candidate}.`, 'success');
      this.renderElections();
    } catch (err) {
      this.setStatus(`Runoff error: ${err instanceof Error ? err.message : String(err)}`, 'error');
      console.error(err);
    } finally {
      this.setSubmitting(false);
    }
  }

  private async onSetTokenConfig() {
    if (!this.dao || !this.wallet || this.submitting) return;
    const intervalMs = parseInt(this.inputValue('config-interval'), 10);
    const rate = parseInt(this.inputValue('config-rate'), 10);
    if (!Number.isInteger(intervalMs) || intervalMs < 1000 || !Number.isInteger(rate) || rate < 1) {
      this.setStatus('Interval must be >= 1000ms and rate >= 1.', 'error');
      return;
    }
    this.setSubmitting(true);
    try {
      const bytes = await this.dao.setTokenConfig(this.wallet.username, { intervalMs, rate });
      await this.client.submitOp(bytesToBase64(bytes));
      await this.safeExecuteRemote(bytes);
      this.setStatus('Token settings updated.', 'success');
    } catch (err) {
      this.setStatus(`Config error: ${err instanceof Error ? err.message : String(err)}`, 'error');
      console.error(err);
    } finally {
      this.setSubmitting(false);
    }
  }

  private async onRemoveMember(username: string) {
    if (!this.dao || !this.wallet || this.submitting || username === this.wallet.username) return;
    this.setSubmitting(true);
    try {
      const bytes = await this.dao.removeMember(this.wallet.username, { username });
      await this.client.submitOp(bytesToBase64(bytes));
      await this.safeExecuteRemote(bytes);
      this.memberUsernames.delete(username);
      this.renderMembers();
      this.renderCustodianControls();
      this.renderCustodians();
      this.setStatus(`${username} removed from the DAO.`, 'success');
    } catch (err) {
      this.setStatus(`Remove error: ${err instanceof Error ? err.message : String(err)}`, 'error');
      console.error(err);
    } finally {
      this.setSubmitting(false);
    }
  }

  private renderElections() {
    const area = document.getElementById('election-area');
    if (!area || !this.dao || !this.wallet) return;
    area.innerHTML = '';
    const elections = this.dao.getElections().slice().reverse();
    if (elections.length === 0) return;

    for (const election of elections) {
      const card = document.createElement('div');
      card.className = 'proposal-card';
      card.dataset.electionId = election.electionId;

      const title = document.createElement('h3');
      title.className = 'proposal-card__title';
      title.textContent = election.isRunoff ? 'Custodian runoff (quadratic)' : 'Custodian election';
      card.appendChild(title);

      const state = this.dao.getElectionFinalized(election.electionId);
      const badge = document.createElement('span');
      badge.className = 'proposal-card__badge';
      badge.textContent = state === 1 ? 'Finalized' : state === 2 ? 'Runoff pending' : 'Open';
      card.appendChild(badge);

      const votes = this.dao.getElectionVotes(election.electionId);
      const ballots = this.dao.hasBallot(election.electionId);
      const expiresAt = this.dao.getElectionExpiry(election.electionId);
      const remainingMs = Math.max(0, expiresAt - this.dao.getNodeTimeMs());

      const info = document.createElement('div');
      info.className = 'proposal-card__type';
      info.textContent = `Closes in ${Math.ceil(remainingMs / 1000)}s${ballots ? ' — you voted' : ''}`;
      card.appendChild(info);

      if (!election.isRunoff && state === 0 && !ballots) {
        const form = document.createElement('div');
        for (const candidate of election.candidates) {
          const label = document.createElement('label');
          label.style.display = 'block';
          const checkbox = document.createElement('input');
          checkbox.type = 'checkbox';
          checkbox.className = 'ballot-option';
          checkbox.dataset.member = candidate;
          label.appendChild(checkbox);
          label.appendChild(document.createTextNode(` ${candidate}`));
          form.appendChild(label);
        }
        const submit = document.createElement('button');
        submit.type = 'button';
        submit.className = 'button button--primary';
        submit.textContent = 'Submit ballot (1-5 picks)';
        submit.disabled = this.submitting;
        submit.addEventListener('click', () => void this.onCastBallot(election.electionId));
        form.appendChild(submit);
        card.appendChild(form);
      } else {
        const tally = document.createElement('div');
        for (const [candidate, count] of Object.entries(votes)) {
          const row = document.createElement('div');
          row.className = 'vote-stat';
          const labelEl = document.createElement('span');
          labelEl.className = 'vote-stat__label';
          labelEl.textContent = candidate;
          const valueEl = document.createElement('span');
          valueEl.className = 'vote-stat__value';
          valueEl.textContent = String(count);
          row.appendChild(labelEl);
          row.appendChild(valueEl);
          tally.appendChild(row);
        }
        card.appendChild(tally);
      }

      if (election.isRunoff && state === 0) {
        const runoffForm = document.createElement('div');
        for (const candidate of election.candidates) {
          const btn = document.createElement('button');
          btn.type = 'button';
          btn.className = 'button button--secondary runoff-vote';
          btn.textContent = `Vote ${candidate}`;
          btn.disabled = this.submitting;
          btn.addEventListener('click', () => void this.onCastRunoffVote(election.electionId, candidate));
          runoffForm.appendChild(btn);
        }
        const cost = document.createElement('div');
        cost.className = 'proposal-card__tokens';
        cost.textContent = `Tokens used: ${this.dao.getRunoffUsage(election.electionId)} | Balance: ${this.dao.getTokenBalance(this.wallet.username)}`;
        runoffForm.appendChild(cost);
        card.appendChild(runoffForm);
      }

      if (state === 0 && remainingMs <= 0) {
        const finalizeBtn = document.createElement('button');
        finalizeBtn.type = 'button';
        finalizeBtn.className = 'button button--primary finalize-election';
        finalizeBtn.textContent = 'Finalize election';
        finalizeBtn.disabled = this.submitting;
        finalizeBtn.addEventListener('click', () => void this.onFinalizeElection(election.electionId));
        card.appendChild(finalizeBtn);
      }

      area.appendChild(card);
    }
  }

  private renderCustodians() {
    const list = document.getElementById('custodians');
    if (!list || !this.dao) return;
    list.innerHTML = '';
    const custodians = this.dao.custodians;
    if (custodians.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'empty-state';
      empty.textContent = 'No custodians elected yet.';
      list.appendChild(empty);
      return;
    }
    custodians.forEach((username, i) => {
      const item = document.createElement('span');
      item.className = 'member-item__badge';
      item.textContent = `Seat ${i + 1}: ${username}`;
      list.appendChild(item);
    });
  }

  private renderCustodianControls() {
    const controls = document.getElementById('remove-controls');
    const configForm = document.getElementById('token-config-form');
    if (!controls || !this.dao || !this.wallet) return;
    const isCustodian = this.dao.custodians.includes(this.wallet.username);
    configForm?.classList.toggle('hidden', !isCustodian);
    controls.innerHTML = '';
    if (!isCustodian) return;

    const config = this.dao.getDistributionConfig();
    const intervalInput = document.getElementById('config-interval') as HTMLInputElement | null;
    const rateInput = document.getElementById('config-rate') as HTMLInputElement | null;
    if (intervalInput && !intervalInput.value) intervalInput.value = String(config.intervalMs);
    if (rateInput && !rateInput.value) rateInput.value = String(config.rate);

    for (const username of this.memberUsernames) {
      if (username === this.wallet.username) continue;
      const row = document.createElement('div');
      row.className = 'member-item';
      const name = document.createElement('span');
      name.className = 'member-item__name';
      name.textContent = username;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'button button--secondary remove-member';
      btn.textContent = 'Remove';
      btn.disabled = this.submitting;
      btn.addEventListener('click', () => void this.onRemoveMember(username));
      row.appendChild(name);
      row.appendChild(btn);
      controls.appendChild(row);
    }
  }

  private renderTokenBalance() {
    const el = document.getElementById('token-balance');
    if (!el || !this.dao || !this.wallet) return;
    const balance = this.dao.getTokenBalance(this.wallet.username);
    el.textContent = `🪙 ${balance} tokens`;
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
