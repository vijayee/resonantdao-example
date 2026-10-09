import {
  ProposalPayload,
  VotePayload,
  ExecutePayload,
  ServerMessage,
  StartElectionPayload,
  AppealVerdictPayload,
  SettleContributionPayload,
  VerifyContributionPayload,
} from '@shared/types';
import {
  CONTENT_LIMITS,
  DIMENSIONS,
  EvidenceRef,
  HarmVerdict,
  SCHEMA_VERSION,
  harmFactorFor,
  paymentFor,
  schemaForDims,
} from '@shared/contribution';
import { RECIP_NAMES, RES_CONFIG } from '@shared/policies';
import { STAGE_AUDITED, STAGE_OPEN, STAGE_RECKONED } from '@shared/round';
import { ContributionFacts, wizardModel } from '@shared/wizard';
import { BrowserDao, ContributionMirrorEntry, bytesToBase64, bytesToHex, base64ToBytes } from './dao';
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

// Escape untrusted strings before templating them into innerHTML.
function esc(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Uniform sha-256 for both evidence paths: stored files and text pointers.
async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as unknown as ArrayBuffer);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

export class AppUI {
  private client = new ServerClient();
  private wallet: WalletState | null = null;
  private dao: BrowserDao | null = null;
  private submitting = false;
  private activeTab: 'register' | 'login' = 'register';
  private memberUsernames = new Set<string>();
  private votedProposals = new Set<string>();
  private evidenceUrls: string[] = [];

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

    const contributionForm = document.getElementById('contribution-form') as HTMLFormElement | null;
    contributionForm?.addEventListener('submit', (ev) => {
      ev.preventDefault();
      void this.onSubmitContribution();
    });

    const auditRoundBtn = document.getElementById('audit-round-btn');
    auditRoundBtn?.addEventListener('click', () => void this.onAuditRound());
    const reckonRoundBtn = document.getElementById('reckon-round-btn');
    reckonRoundBtn?.addEventListener('click', () => void this.onReckonRound());
    const completeRoundBtn = document.getElementById('complete-round-btn');
    completeRoundBtn?.addEventListener('click', () => void this.onCompleteRound());
    const setAlphaBtn = document.getElementById('set-alpha-btn');
    setAlphaBtn?.addEventListener('click', () => void this.onSetAlpha());
    const setCalibrationBtn = document.getElementById('set-calibration-btn');
    setCalibrationBtn?.addEventListener('click', () => void this.onSetCalibration());

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
      this.renderContributions();
      this.renderRound();
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
    // CRABS user ids reject dots, spaces, and other punctuation.
    if (!/^[A-Za-z0-9_-]+$/.test(username)) {
      this.setStatus('Username may only contain letters, numbers, underscores, and dashes.', 'error');
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
    const salientDims = Array.from(document.querySelectorAll<HTMLInputElement>('.salient-dim:checked'))
      .map((el) => Number(el.value))
      .filter((dim) => Number.isInteger(dim));
    if (salientDims.length > 0) {
      payload.salientDims = salientDims;
    }

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
    this.renderRound();
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

    const dao = this.dao;
    if (!dao) return li;

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
    const pType = dao.getProposalType(proposal.proposalId);
    typeLabel.textContent = pType === 'quadratic' ? 'Quadratic Vote' : 'Direct Vote';
    li.appendChild(typeLabel);

    const expiresAt = dao.getProposalExpiry(proposal.proposalId);
    const remainingMs = Math.max(0, expiresAt - dao.getNodeTimeMs());
    const timer = document.createElement('div');
    timer.className = 'proposal-card__timer';
    timer.textContent = executed ? 'Voting closed' : `Closes in ${Math.ceil(remainingMs / 1000)}s`;
    li.appendChild(timer);

    const options = proposal.options ?? ['Yes', 'No'];
    const counts = dao.getProposalOptionVotes(proposal.proposalId);

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
      const used = dao.getProposalTokenUsage(proposal.proposalId, this.wallet.username);
      const voteCount = dao.getProposalVoteCount(proposal.proposalId, this.wallet.username);
      nextCumulativeCost = ((voteCount + 1) * (voteCount + 2) * (2 * voteCount + 3)) / 6;
      const balance = dao.getVoteBalance(proposal.proposalId, this.wallet.username);
      const tokenInfo = document.createElement('div');
      tokenInfo.className = 'proposal-card__tokens';
      tokenInfo.textContent = `Tokens used here: ${used} | Next vote cost: ${nextCumulativeCost} | Your balance for this question: ${balance}`;
      li.appendChild(tokenInfo);
    }

    const actions = document.createElement('div');
    actions.className = 'proposal-card__actions';

    const alreadyVoted = this.votedProposals.has(proposal.proposalId);
    const canVoteQuadratic = pType === 'quadratic' && this.wallet && dao.getVoteBalance(proposal.proposalId, this.wallet.username) >= nextCumulativeCost && nextCumulativeCost > 0;
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
      tokenBadge.textContent = `🪙 ${this.dao.getResBalance(this.wallet.username)}`;
      youItem.appendChild(tokenBadge);
      const rctBadge = document.createElement('span');
      rctBadge.className = 'rct-badge';
      rctBadge.dataset.memberRct = this.wallet.username;
      youItem.appendChild(rctBadge);
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
      if (this.dao) {
        const rctBadge = document.createElement('span');
        rctBadge.className = 'rct-badge';
        rctBadge.dataset.memberRct = username;
        item.appendChild(rctBadge);
      }
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

  private async onSubmitContribution() {
    if (!this.dao || !this.wallet || this.client === null || this.submitting) return;
    const summary = this.inputValue('contribution-summary');
    if (!summary) {
      this.setStatus('A summary is required.', 'error');
      return;
    }
    const dim = Number((document.querySelector('input[name="contrib-dim"]:checked') as HTMLInputElement)?.value ?? 2);
    const evidenceText = this.inputValue('contribution-evidence-text');
    const fileInput = document.getElementById('contribution-evidence-file') as HTMLInputElement | null;
    const file = fileInput?.files?.[0];

    this.setSubmitting(true);
    try {
      // Evidence priority: attached file → text pointer. Files go to the
      // content-addressed store; pointers are hashed directly.
      let evidenceRef: EvidenceRef;
      if (file) {
        const bytes = new Uint8Array(await file.arrayBuffer());
        if (bytes.length > CONTENT_LIMITS.maxObjectBytes) {
          this.setStatus(`Evidence exceeds ${CONTENT_LIMITS.maxObjectBytes / (1024 * 1024)}MB — split it up.`, 'error');
          return;
        }
        const mediaType = file.type || 'application/octet-stream';
        const hash = await this.client.putContent(bytes, mediaType);
        evidenceRef = { hash, uri: `content://${hash}`, mediaType, size: bytes.length };
      } else if (evidenceText) {
        const bytes = new TextEncoder().encode(evidenceText);
        evidenceRef = { hash: await sha256Hex(bytes), uri: evidenceText, mediaType: 'text/uri-list', size: bytes.length };
      } else {
        this.setStatus('Attach evidence or give a pointer — pay follows proven outcomes.', 'error');
        return;
      }

      const payload = {
        contributionId: crypto.randomUUID(),
        dims: { [dim]: 1 },
        summary,
        evidenceRef,
        schemaVersion: SCHEMA_VERSION,
      };
      this.renderContributionReview(payload);
      const bytes = await this.dao.submitContribution(this.wallet.username, payload);
      await this.client.submitOp(bytesToBase64(bytes));
      await this.safeExecuteRemote(bytes);
      this.setStatus('Contribution submitted — awaiting verification.', 'success');
      this.clearForm('contribution-form');
      this.renderContributions();
    } catch (err) {
      this.setStatus(`Contribution error: ${err instanceof Error ? err.message : String(err)}`, 'error');
      console.error(err);
    } finally {
      this.setSubmitting(false);
    }
  }

  private async onVerifyContribution(entry: ContributionMirrorEntry) {
    if (!this.dao || !this.wallet || this.client === null || this.submitting) return;
    const dao = this.dao;
    if (entry.submitter === this.wallet.username) return; // no-self verify
    // Distinct-actor rule, client-attested: this contribution's prior verifier
    // is barred from re-verifying — the same priorVerifiers list the server
    // re-checks. After an appeal this one check also excludes the original
    // verifier from the re-verification (spec D-note).
    const prior = entry.verifiedBy ? [entry.verifiedBy] : [];
    if (prior.includes(this.wallet.username)) {
      this.setStatus('You already verified this contribution.', 'error');
      return;
    }
    // Per-pair reciprocity (per-pair once + mutual loop bar) — read from the
    // replicated CRABS state directly (deterministic, same guards as the
    // server handler), because the mirror's single verifiedBy field cannot
    // represent both verifiers of a two-check step.
    const verifier = this.wallet.username;
    if (
      dao.node.setContains(RECIP_NAMES.verifiedBy(entry.submitter), verifier) ||
      dao.node.setContains(RECIP_NAMES.verifiedBy(verifier), entry.submitter)
    ) {
      this.setStatus('You already verified this submitter’s earlier work — reciprocity bars re-verification.', 'error');
      return;
    }
    const choice = prompt('Accept this contribution? Type: yes / yes-harm (reduced) / voided / no. (Cancel = nothing)');
    if (choice === null) return;
    const normalized = choice.trim().toLowerCase();
    let pass = false;
    let harm: HarmVerdict = 'none';
    if (normalized === 'yes' || normalized === 'y') { pass = true; }
    else if (normalized === 'yes-harm' || normalized === 'reduced') { pass = true; harm = 'reduced'; }
    else if (normalized === 'voided') { pass = true; harm = 'voided'; }
    else if (normalized === 'no' || normalized === 'n') { pass = false; }
    else {
      this.setStatus('Answer with yes / yes-harm / voided / no.', 'error');
      return;
    }
    const reason = prompt('Written reason for your verification (recorded permanently):') ?? '';
    if (!reason.trim()) {
      this.setStatus('A written reason is required for every verification.', 'error');
      return;
    }
    const payload: VerifyContributionPayload = {
      contributionId: entry.record.contributionId,
      submitter: entry.submitter,
      dims: entry.record.dims,
      stepId: 'verify',
      pass,
      reason,
      harm,
      priorVerifiers: prior,
      ...(entry.verifiedBy ? { priorHarm: entry.harm ?? ('none' as HarmVerdict) } : {}),
    };
    this.setSubmitting(true);
    try {
      const bytes = await this.dao.verifyContribution(this.wallet.username, payload);
      await this.client.submitOp(bytesToBase64(bytes));
      await this.safeExecuteRemote(bytes);
      this.setStatus(`Verification recorded (+${RES_CONFIG.verificationCheckCredit} $RES).`, 'success');
      this.renderContributions();
    } catch (err) {
      this.setStatus(`Verify error: ${err instanceof Error ? err.message : String(err)}`, 'error');
      console.error(err);
    } finally {
      this.setSubmitting(false);
    }
  }

  private async onSettleContribution(entry: ContributionMirrorEntry) {
    if (!this.dao || !this.wallet || this.client === null || this.submitting) return;
    if (entry.submitter !== this.wallet.username) return;
    const reason = prompt('Settlement note (recorded permanently):') ?? '';
    if (!reason.trim()) {
      this.setStatus('A written reason is required to settle.', 'error');
      return;
    }
    const payload: SettleContributionPayload = {
      contributionId: entry.record.contributionId,
      submitter: entry.submitter,
      reason,
      verifiers: entry.verifiers ?? [],
    };
    this.setSubmitting(true);
    try {
      const bytes = await this.dao.settleContribution(this.wallet.username, payload);
      await this.client.submitOp(bytesToBase64(bytes));
      await this.safeExecuteRemote(bytes);
      this.setStatus('Contribution settled.', 'success');
      this.renderContributions();
    } catch (err) {
      this.setStatus(`Settle error: ${err instanceof Error ? err.message : String(err)}`, 'error');
      console.error(err);
    } finally {
      this.setSubmitting(false);
    }
  }

  private async onAppealContribution(entry: ContributionMirrorEntry) {
    if (!this.dao || !this.wallet || this.client === null || this.submitting) return;
    if (entry.submitter !== this.wallet.username) return; // submitter-only
    const reason = prompt('Appeal reason (recorded permanently):') ?? '';
    if (!reason.trim()) {
      this.setStatus('A written reason is required to appeal.', 'error');
      return;
    }
    const payload: AppealVerdictPayload = {
      contributionId: entry.record.contributionId,
      submitter: entry.submitter,
      reason,
    };
    this.setSubmitting(true);
    try {
      const bytes = await this.dao.appealVerdict(this.wallet.username, payload);
      await this.client.submitOp(bytesToBase64(bytes));
      await this.safeExecuteRemote(bytes);
      this.setStatus('Appeal recorded — awaiting re-verification.', 'success');
      this.renderContributions();
    } catch (err) {
      this.setStatus(`Appeal error: ${err instanceof Error ? err.message : String(err)}`, 'error');
      console.error(err);
    } finally {
      this.setSubmitting(false);
    }
  }

  private renderContributions() {
    const list = document.getElementById('contributions-list');
    if (!list || !this.dao || !this.wallet) return;
    for (const url of this.evidenceUrls) URL.revokeObjectURL(url);
    this.evidenceUrls = [];
    list.innerHTML = '';
    const entries = [...this.dao.getContributions()].reverse();
    if (entries.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'muted';
      empty.textContent = 'No contributions yet.';
      list.appendChild(empty);
      return;
    }
    for (const entry of entries) {
      list.appendChild(this.buildContributionCard(entry));
    }
  }

  private buildContributionCard(entry: ContributionMirrorEntry): HTMLElement {
    const dao = this.dao;
    const viewer = this.wallet;
    if (!dao || !viewer) return document.createElement('div');
    const schema = schemaForDims(entry.record.dims);
    const status = dao.getContributionStatus(entry.record.contributionId);
    const facts: ContributionFacts = {
      status: status === 'unknown' ? -1 : status === 'accepted' ? 1 : status === 'rejected' ? 2 : 0,
      stepIndex: dao.getContributionStepIndex(entry.record.contributionId),
      done: Object.fromEntries(schema.steps.map((s) => [
        s.stepId, dao.getContributionStepDone(entry.record.contributionId, s.stepId),
      ])),
      submitter: entry.submitter,
    };
    const model = wizardModel(schema, facts, viewer.username, dao.custodians.includes(viewer.username));

    const card = document.createElement('div');
    card.className = 'contribution-card';
    card.dataset.contributionId = entry.record.contributionId;

    const header = document.createElement('div');
    header.className = 'contribution-card__header';
    const title = document.createElement('strong');
    title.textContent = entry.record.summary;
    const pill = document.createElement('span');
    // status 3 (appealed) reads as 'pending' off getContributionStatus —
    // surface it explicitly until re-review finalizes. The appealed register
    // survives settlement, so gate on the still-open lifecycle, not the flag.
    const appealed =
      dao.getContributionAppealed(entry.record.contributionId) && status === 'pending';
    pill.className = `contribution-pill contribution-pill--${appealed ? 'appealed' : model.outcome}`;
    pill.textContent = appealed ? 'appealed' : model.outcome;
    header.append(title, pill);
    card.appendChild(header);

    const stepper = document.createElement('div');
    stepper.className = 'contribution-stepper';
    model.steps.forEach((step, i) => {
      const chip = document.createElement('span');
      chip.className = `contribution-step contribution-step--${step.state}`;
      chip.textContent = step.state === 'current'
        ? `${i + 1}. ${step.title} (${step.progress.done}/${step.progress.required})`
        : `${i + 1}. ${step.title}`;
      stepper.appendChild(chip);
    });
    card.appendChild(stepper);

    const byline = document.createElement('div');
    byline.className = 'muted';
    byline.textContent = `by ${entry.submitter}`;
    card.appendChild(byline);

    const evidence = document.createElement('div');
    evidence.className = 'muted';
    evidence.textContent = this.evidenceSummary(entry.record.evidenceRef);
    card.appendChild(evidence);

    const ref = entry.record.evidenceRef;
    if (ref.uri.startsWith('content://')) {
      // Lazy load only — the demo clock re-renders every second, so fetch stored
      // media on click instead of per render (avoids per-second network spam).
      const loadBtn = document.createElement('button');
      loadBtn.type = 'button';
      loadBtn.className = 'button button--secondary contribution-card__evidence-load';
      loadBtn.textContent = 'Load evidence';
      loadBtn.disabled = this.submitting;
      loadBtn.addEventListener('click', () => void this.loadEvidenceMedia(ref, entry.record.contributionId, evidence, loadBtn));
      card.appendChild(loadBtn);
    }

    if (model.outcome === 'rejected' && entry.verdictReason) {
      const verdict = document.createElement('div');
      verdict.className = 'contribution-card__verdict';
      verdict.textContent = `Rejected by ${entry.verifiedBy}: ${entry.verdictReason}`;
      card.appendChild(verdict);
    }

    if (appealed) {
      const note = document.createElement('div');
      note.className = 'muted';
      note.textContent = 'appealed — awaiting re-verification';
      card.appendChild(note);
    } else if (
      model.outcome === 'rejected' &&
      entry.submitter === viewer.username &&
      // Once-guard off the register getter (not the mirror): a re-rejection
      // after an unsuccessful appeal cannot be appealed again.
      !dao.getContributionAppealed(entry.record.contributionId)
    ) {
      const appealBtn = document.createElement('button');
      appealBtn.type = 'button';
      appealBtn.className = 'button button--secondary appeal-contribution';
      appealBtn.textContent = 'Appeal…';
      appealBtn.disabled = this.submitting;
      appealBtn.addEventListener('click', () => void this.onAppealContribution(entry));
      card.appendChild(appealBtn);
    }

    // Harm receipt: a reduced/voided verdict adjusts the submitter outcome
    // before payment — surface the adjusted figure (logical units; both
    // paymentFor and harmFactorFor are logical, no register scaling here).
    if (status === 'accepted' && entry.harm && entry.harm !== 'none') {
      const receipt = document.createElement('div');
      receipt.className = `contribution-card__harm contribution-card__harm--${entry.harm}`;
      if (entry.harm === 'voided') {
        receipt.textContent = 'accepted — outcome voided (harm)';
      } else {
        const base = Object.entries(entry.record.dims)
          .reduce((sum, [dimKey, match]) => sum + paymentFor(Number(dimKey), match), 0);
        const factor = harmFactorFor(entry.harm);
        const label = Object.keys(entry.record.dims).includes('1') ? 'bounty' : 'credit';
        const fmt = (n: number) => String(Number(n.toFixed(6)));
        receipt.textContent = `accepted — ${label} ${fmt(base)} → ${fmt(base * factor)} (harm reduced)`;
      }
      card.appendChild(receipt);
    }

    const currentStep = model.steps[model.currentStepIndex];
    if (currentStep) {
      const actions = document.createElement('div');
      actions.className = 'contribution-card__actions';
      for (const actor of ['submitter', 'verifier', 'custodian', 'member'] as const) {
        const role = currentStep.roles[actor];
        if (!role || !role.mayAct) continue;
        if (role.op === 'verify_contribution' && actor === 'verifier') {
          const stats = dao.getVerifierStats(viewer.username);
          const btn = document.createElement('button');
          btn.type = 'button';
          btn.className = 'button button--secondary verify-contribution';
          // A prior verifier on this contribution (first of two checks, or the
          // original verdict on an appealed card) marks this check as the 2nd.
          btn.textContent = entry.verifiedBy ? 'Verify (2nd)' : 'Verify…';
          btn.title = `Your checks: ${stats.total} (${stats.upheld} upheld)`;
          btn.disabled = this.submitting;
          btn.addEventListener('click', () => void this.onVerifyContribution(entry));
          actions.appendChild(btn);
        }
        if (role.op === 'settle_contribution' && actor === 'submitter') {
          const btn = document.createElement('button');
          btn.type = 'button';
          btn.className = 'button button--primary settle-contribution';
          btn.textContent = 'Settle…';
          btn.disabled = this.submitting;
          btn.addEventListener('click', () => void this.onSettleContribution(entry));
          actions.appendChild(btn);
        }
      }
      if (actions.childElementCount > 0) card.appendChild(actions);
    }
    return card;
  }

  private renderContributionReview(payload: { dims: Record<string, number>; summary: string; evidenceRef: EvidenceRef }) {
    const el = document.getElementById('contribution-review');
    if (!el) return;
    const dimLabels = Object.keys(payload.dims)
      .map((k) => `C_${k} ${DIMENSIONS[Number(k)].name}`)
      .join(', ');
    el.innerHTML = `<p><strong>${esc(payload.summary)}</strong></p><p>${esc(dimLabels)} — ${esc(this.evidenceSummary(payload.evidenceRef))}</p>`;
  }

  private evidenceSummary(ref: EvidenceRef): string {
    if (ref.uri.startsWith('content://')) return `stored evidence (${(ref.size / 1024).toFixed(1)} KB, ${ref.mediaType})`;
    return `pointer: ${ref.uri}`;
  }

  // Click-triggered fetch of stored evidence bytes; the load button swaps for
  // the rendered image or a download link. Errors degrade to a muted note.
  private async loadEvidenceMedia(
    ref: EvidenceRef,
    contributionId: string,
    row: HTMLElement,
    button: HTMLElement,
  ): Promise<void> {
    const hash = ref.uri.slice('content://'.length);
    try {
      const content = await this.client!.getContent(hash);
      if (!content) throw new Error('evidence unavailable');
      const blob = new Blob([content.bytes as BlobPart], { type: content.mediaType });
      const url = URL.createObjectURL(blob);
      this.evidenceUrls.push(url);
      if (content.mediaType.startsWith('image/')) {
        const img = document.createElement('img');
        img.className = 'contribution-card__evidence-img';
        img.alt = 'contribution evidence';
        img.src = url;
        button.replaceWith(img);
      } else {
        const anchor = document.createElement('a');
        anchor.className = 'contribution-card__evidence-dl';
        anchor.href = url;
        anchor.download = `evidence-${contributionId.slice(0, 8)}`;
        anchor.textContent = `Download evidence (${ref.mediaType})`;
        button.replaceWith(anchor);
      }
    } catch (err) {
      void err;
      row.textContent = 'evidence unavailable';
      button.remove();
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

  private async onAuditRound() {
    if (!this.dao || !this.wallet || !this.client || this.submitting) return;
    const fair = confirm('Close the round as FAIR? OK = fair, Cancel = UNFAIR (records the round debt and skips aggregation).');
    const note = prompt('Audit note (recorded permanently):') ?? '';
    if (!note.trim()) {
      this.setStatus('An audit note is required.', 'error');
      return;
    }
    this.setSubmitting(true);
    try {
      const bytes = await this.dao.auditRound(this.wallet.username, {
        fair,
        note,
        calibrationVersion: 'v1',
      });
      await this.client.submitOp(bytesToBase64(bytes));
      await this.safeExecuteRemote(bytes);
      this.setStatus(fair ? 'Round audited as fair.' : 'Round closed with a debt record; next round begins.', fair ? 'success' : 'error');
      this.renderRound();
    } catch (err) {
      this.setStatus(`Audit error: ${err instanceof Error ? err.message : String(err)}`, 'error');
      console.error(err);
    } finally {
      this.setSubmitting(false);
    }
  }

  private async onReckonRound() {
    if (!this.dao || !this.wallet || !this.client || this.submitting) return;
    const note = prompt('Reckoning note (recorded permanently):') ?? '';
    if (!note.trim()) {
      this.setStatus('A reckoning note is required.', 'error');
      return;
    }
    this.setSubmitting(true);
    try {
      const bytes = await this.dao.reckonRound(this.wallet.username, { note });
      await this.client.submitOp(bytesToBase64(bytes));
      await this.safeExecuteRemote(bytes);
      this.setStatus('Round reckoned — ready to complete.', 'success');
      this.renderRound();
    } catch (err) {
      this.setStatus(`Reckon error: ${err instanceof Error ? err.message : String(err)}`, 'error');
      console.error(err);
    } finally {
      this.setSubmitting(false);
    }
  }

  private async onCompleteRound() {
    if (!this.dao || !this.wallet || !this.client || this.submitting) return;
    this.setSubmitting(true);
    try {
      const currentRound = this.dao.getCurrentRound();
      const entries = this.dao.getContributions()
        .filter((entry) => this.dao!.getContributionStatus(entry.record.contributionId) === 'accepted'
          && this.dao!.getContributionRound(entry.record.contributionId) === currentRound)
        .map((entry) => ({ contributionId: entry.record.contributionId, submitter: entry.submitter, dims: entry.record.dims, harm: entry.harm ?? ('none' as const) }));
      if (entries.length === 0) {
        this.setStatus('Nothing settled to aggregate in this round.', 'error');
        return;
      }
      const bytes = await this.dao.completeRound(this.wallet.username, { entries });
      await this.client.submitOp(bytesToBase64(bytes));
      await this.safeExecuteRemote(bytes);
      this.setStatus(`Round published — ${entries.length} contribution(s) aggregated.`, 'success');
      this.renderRound();
      this.renderTokenBalance();
    } catch (err) {
      this.setStatus(`Complete error: ${err instanceof Error ? err.message : String(err)}`, 'error');
      console.error(err);
    } finally {
      this.setSubmitting(false);
    }
  }

  private async onSetAlpha() {
    if (!this.dao || !this.wallet || !this.client || this.submitting) return;
    const raw: Record<string, number> = {};
    const c1 = parseFloat(this.inputValue('alpha-c1'));
    const c2 = parseFloat(this.inputValue('alpha-c2'));
    if (Number.isFinite(c1) && c1 > 0) raw['1'] = c1;
    if (Number.isFinite(c2) && c2 > 0) raw['2'] = c2;
    const version = this.inputValue('alpha-version');
    if (Object.keys(raw).length === 0 || !version.trim()) {
      this.setStatus('At least one weight and a version label are required.', 'error');
      return;
    }
    this.setSubmitting(true);
    try {
      const bytes = await this.dao.setRctAlpha(this.wallet.username, { weights: raw, version: version.trim() });
      await this.client.submitOp(bytesToBase64(bytes));
      await this.safeExecuteRemote(bytes);
      this.setStatus('RCT weights updated.', 'success');
      this.renderRound();
    } catch (err) {
      this.setStatus(`Weights error: ${err instanceof Error ? err.message : String(err)}`, 'error');
      console.error(err);
    } finally {
      this.setSubmitting(false);
    }
  }

  private async onSetCalibration() {
    if (!this.dao || !this.wallet || !this.client || this.submitting) return;
    this.setSubmitting(true);
    try {
      const bytes = await this.dao.setCalibrationVersion(this.wallet.username, { version: 'v1' });
      await this.client.submitOp(bytesToBase64(bytes));
      await this.safeExecuteRemote(bytes);
      this.setStatus('Calibration version set to v1.', 'success');
      this.renderRound();
    } catch (err) {
      this.setStatus(`Calibration error: ${err instanceof Error ? err.message : String(err)}`, 'error');
      console.error(err);
    } finally {
      this.setSubmitting(false);
    }
  }

  private renderRound() {
    if (!this.dao || !this.wallet) return;
    const stepper = document.getElementById('round-stepper');
    if (!stepper) return;
    const current = this.dao.getCurrentRound();
    const stage = this.dao.getRoundStage(current);
    const stageNames = ['Open', 'Audited', 'Reckoned', 'Published'];
    stepper.innerHTML = '';
    const roundLabel = document.createElement('span');
    roundLabel.className = 'round-label';
    roundLabel.textContent = `Round ${current} — stage: ${stageNames[stage] ?? 'unknown'}`;
    stepper.appendChild(roundLabel);
    for (let i = 0; i < stageNames.length; i++) {
      const chip = document.createElement('span');
      chip.className = i < stage
        ? 'round-step round-step--complete'
        : i === stage ? 'round-step round-step--current' : 'round-step round-step--locked';
      chip.textContent = stageNames[i];
      stepper.appendChild(chip);
    }

    const isCustodian = this.dao.custodians.includes(this.wallet.username);
    const auditBtn = document.getElementById('audit-round-btn');
    const reckonBtn = document.getElementById('reckon-round-btn');
    const completeBtn = document.getElementById('complete-round-btn');
    const alphaForm = document.getElementById('round-alpha-form');
    if (auditBtn) auditBtn.classList.toggle('hidden', stage !== STAGE_OPEN);
    if (reckonBtn) reckonBtn.classList.toggle('hidden', stage !== STAGE_AUDITED);
    if (completeBtn) completeBtn.classList.toggle('hidden', stage !== STAGE_RECKONED);
    if (alphaForm) alphaForm.classList.toggle('hidden', !isCustodian);

    const explanations = document.getElementById('round-explanations');
    if (explanations) {
      const records = this.dao.getRoundRecords(current);
      explanations.textContent = records.length === 0 ? '' : records.map((r) => `${String(r.stepId)}: ${String(r.note ?? '')}`).join(' | ');
    }

    // RCT badges in the members list.
    for (const username of [this.wallet.username, ...this.memberUsernames]) {
      const el = document.querySelector(`[data-member-rct="${username}"]`);
      if (!el) continue;
      el.textContent = `${this.dao.getRctBalance(username)} RCT`;
    }
  }

  private renderElections() {
    const area = document.getElementById('election-area');
    if (!area || !this.dao || !this.wallet) return;
    // The demo clock re-renders every second; snapshot ballot selections so
    // the rebuild does not wipe them before the user submits.
    const checkedByElection = new Map<string, Set<string>>();
    for (const card of Array.from(area.querySelectorAll<HTMLDivElement>('.proposal-card[data-election-id]'))) {
      const id = card.dataset.electionId;
      if (!id) continue;
      checkedByElection.set(id, new Set(
        Array.from(card.querySelectorAll<HTMLInputElement>('.ballot-option:checked')).map((el) => el.dataset.member || '')
      ));
    }
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
        const checked = checkedByElection.get(election.electionId);
        for (const candidate of election.candidates) {
          const label = document.createElement('label');
          label.style.display = 'block';
          const checkbox = document.createElement('input');
          checkbox.type = 'checkbox';
          checkbox.className = 'ballot-option';
          checkbox.dataset.member = candidate;
          if (checked?.has(candidate)) {
            checkbox.checked = true;
          }
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
        cost.textContent = `Tokens used: ${this.dao.getRunoffUsage(election.electionId)} | Balance: ${this.dao.getResBalance(this.wallet.username)}`;
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
    if (!controls || !this.dao || !this.wallet) return;
    const isCustodian = this.dao.custodians.includes(this.wallet.username);
    controls.innerHTML = '';
    if (!isCustodian) return;

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
    const balance = this.dao.getResBalance(this.wallet.username);
    el.textContent = `🪙 ${balance} $RES`;
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
