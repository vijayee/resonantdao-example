import { ref, shallowRef, computed } from 'vue';
import { defineStore } from 'pinia';
import {
  ProposalPayload, VotePayload, StartElectionPayload, VerifyContributionPayload,
  ServerMessage,
} from '@shared/types';
import {
  CONTENT_LIMITS, EvidenceRef, HarmVerdict, SCHEMA_VERSION,
} from '@shared/contribution';
import { RECIP_NAMES, RES_CONFIG } from '@shared/policies';
import { BrowserDao, ContributionMirrorEntry, bytesToBase64, base64ToBytes } from '../dao';
import { ServerClient } from '../server-client';
import { useStatusStore } from './status';

export const serverClient = new ServerClient();

// Uniform sha-256 for both evidence paths: stored files and text pointers.
async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as unknown as ArrayBuffer);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

// Server-message wiring lives in the module so it survives across store
// instances in dev. teardown() detaches; ensureMessageWiring() (called from
// the setup body and bootstrap()) re-attaches when unbound.
let bound = false;
let unsubscribeDaoMessages: (() => void) | null = null;

export const useDaoStore = defineStore('dao', () => {
  const status = useStatusStore();

  // The BrowserDao instance itself is never reactive (wasm-backed — deep proxies
  // would wrap raw registers); `tick` is the single invalidation lever: bump it
  // after every state-affecting change.
  const dao = shallowRef<BrowserDao | null>(null);
  const username = ref('');
  const submitting = ref(false);
  const tick = ref(0);
  const members = ref<string[]>([]);
  const votedProposals = ref<string[]>([]);

  function bump() {
    tick.value += 1;
  }

  const authed = computed(() => dao.value !== null);
  const custodians = computed(() => {
    void tick.value;
    return dao.value?.custodians ?? [];
  });
  const isCustodian = computed(() => authed.value && custodians.value.includes(username.value));

  let clock: ReturnType<typeof setInterval> | null = null;

  function pulse() {
    dao.value?.setTime(Date.now());
    tick.value += 1;
  }
  function startClock() {
    stopClock();
    pulse();
    clock = setInterval(pulse, 1000);
  }
  function stopClock() {
    if (clock) {
      clearInterval(clock);
      clock = null;
    }
  }

  async function safeExecuteRemote(bytes: Uint8Array) {
    if (!dao.value) return;
    try {
      await dao.value.executeRemote(bytes);
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

  async function replayLog(target?: BrowserDao) {
    const logMsg = await serverClient.getLog(0);
    if (logMsg.kind !== 'log') return;
    for (const stored of logMsg.operations) {
      try {
        await safeExecuteRemote(base64ToBytes(stored.bytes));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        status.set(`State sync failed: ${message}`, 'error');
        return;
      }
    }
  }

  // Owns the BrowserDao lifecycle. The devtools attach point (Task 13) hooks
  // here, after Node.create, guarded by import.meta.env.DEV.
  async function bootstrap(target: BrowserDao, user: string) {
    // teardown() detaches the server listener; re-run the setup-store body is
    // not an option, so re-attach here. Idempotent — the guard no-ops when
    // already bound.
    ensureMessageWiring();
    dao.value = target;
    username.value = user;
    startClock();
    // Devtools panel (dev only): the inspector exposes plaintext CRDT state,
    // so attaching to a production build is forbidden — the prod wasm isn't
    // compiled with devtools support and the dev scripts are never shipped.
    if (import.meta.env.DEV && window.CRABSDevtools) {
      try {
        window.CRABSDevtools.attach(target.node, { nodeId: target.nodeId });
      } catch (err) {
        console.warn('CRABS devtools attach failed (non-fatal):', err);
      }
    }
  }

  function teardown() {
    stopClock();
    unsubscribeDaoMessages?.();
    unsubscribeDaoMessages = null;
    bound = false;
    dao.value?.destroy();
    dao.value = null;
    username.value = '';
    members.value = [];
    submitting.value = false;
    votedProposals.value = [];
  }

  async function handleServerMessage(msg: ServerMessage) {
    if (msg.kind === 'broadcast') {
      try {
        await safeExecuteRemote(base64ToBytes(msg.operation.bytes));
        bump();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        status.set(`Failed to apply update: ${message}`, 'error');
      }
    } else if (msg.kind === 'members') {
      members.value = msg.users.map((user) => user.username);
      for (const user of msg.users) {
        if (user.username !== username.value && dao.value) {
          dao.value.registerMember(user.username, user.publicKeyHex, user.keyVersion);
        }
      }
    } else if (msg.kind === 'op_rejected') {
      status.set(`Rejected: ${msg.reason}`, 'error');
    } else if (msg.kind === 'error') {
      status.set(`Error: ${msg.message}`, 'error');
    }
  }
  function ensureMessageWiring() {
    if (bound) return;
    bound = true;
    unsubscribeDaoMessages = serverClient.onMessage((msg) => void handleServerMessage(msg));
  }
  ensureMessageWiring();

  // ---- proposal ops (ported verbatim from ui.ts) ----

  async function createProposal(payload: ProposalPayload) {
    if (!dao.value || submitting.value) return;
    submitting.value = true;
    try {
      const bytes = await dao.value.createProposal(username.value, payload);
      await serverClient.submitOp(bytesToBase64(bytes));
      await safeExecuteRemote(bytes);
      status.set('Proposal created.', 'success');
      bump();
    } catch (err) {
      status.set(`Create proposal error: ${err instanceof Error ? err.message : String(err)}`, 'error');
      console.error(err);
    } finally {
      submitting.value = false;
    }
  }

  async function vote(proposalId: string, choice: number) {
    if (!dao.value || submitting.value) return;
    const payload: VotePayload = { proposalId, choice };
    submitting.value = true;
    try {
      const bytes = await dao.value.vote(username.value, payload);
      await serverClient.submitOp(bytesToBase64(bytes));
      await safeExecuteRemote(bytes);
      if (dao.value.getProposalType(proposalId) === 'direct') {
        if (!votedProposals.value.includes(proposalId)) votedProposals.value.push(proposalId);
      }
      status.set(`Voted.`, 'success');
      bump();
    } catch (err) {
      status.set(`Vote error: ${err instanceof Error ? err.message : String(err)}`, 'error');
      console.error(err);
    } finally {
      submitting.value = false;
    }
  }

  async function execute(proposalId: string) {
    if (!dao.value || submitting.value) return;
    submitting.value = true;
    try {
      const bytes = await dao.value.execute(username.value, { proposalId });
      await serverClient.submitOp(bytesToBase64(bytes));
      await safeExecuteRemote(bytes);
      status.set('Execution submitted.', 'success');
      bump();
    } catch (err) {
      status.set(`Execute error: ${err instanceof Error ? err.message : String(err)}`, 'error');
      console.error(err);
    } finally {
      submitting.value = false;
    }
  }

  // ---- election ops ----

  async function startElection(candidates: string[]) {
    if (!dao.value || submitting.value) return;
    const payload: StartElectionPayload = {
      electionId: crypto.randomUUID(),
      candidates,
      expiresAt: dao.value.getNodeTimeMs() + 60 * 1000,
    };
    submitting.value = true;
    try {
      const bytes = await dao.value.startElection(username.value, payload);
      await serverClient.submitOp(bytesToBase64(bytes));
      await safeExecuteRemote(bytes);
      status.set('Election started.', 'success');
      bump();
    } catch (err) {
      status.set(`Election error: ${err instanceof Error ? err.message : String(err)}`, 'error');
      console.error(err);
    } finally {
      submitting.value = false;
    }
  }

  async function castBallot(electionId: string, picks: string[]) {
    if (!dao.value || submitting.value) return;
    submitting.value = true;
    try {
      const bytes = await dao.value.castBallot(username.value, { electionId, picks });
      await serverClient.submitOp(bytesToBase64(bytes));
      await safeExecuteRemote(bytes);
      status.set('Ballot cast.', 'success');
      bump();
    } catch (err) {
      status.set(`Ballot error: ${err instanceof Error ? err.message : String(err)}`, 'error');
      console.error(err);
    } finally {
      submitting.value = false;
    }
  }

  async function finalizeElection(electionId: string, candidates: string[]) {
    if (!dao.value || submitting.value) return;
    submitting.value = true;
    try {
      const bytes = await dao.value.finalizeElection(username.value, { electionId, candidates });
      await serverClient.submitOp(bytesToBase64(bytes));
      await safeExecuteRemote(bytes);
      status.set('Election finalized.', 'success');
      bump();
    } catch (err) {
      status.set(`Finalize error: ${err instanceof Error ? err.message : String(err)}`, 'error');
      console.error(err);
    } finally {
      submitting.value = false;
    }
  }

  async function castRunoffVote(electionId: string, candidate: string) {
    if (!dao.value || submitting.value) return;
    submitting.value = true;
    try {
      const bytes = await dao.value.castRunoffVote(username.value, { electionId, candidate });
      await serverClient.submitOp(bytesToBase64(bytes));
      await safeExecuteRemote(bytes);
      status.set(`Runoff vote cast for ${candidate}.`, 'success');
      bump();
    } catch (err) {
      status.set(`Runoff error: ${err instanceof Error ? err.message : String(err)}`, 'error');
      console.error(err);
    } finally {
      submitting.value = false;
    }
  }

  // ---- contribution ops ----

  async function submitContribution(summary: string, dim: number, evidenceFile: File | null, evidenceText: string): Promise<boolean> {
    if (!dao.value || submitting.value) return false;
    submitting.value = true;
    try {
      // Evidence priority: attached file → text pointer. Files go to the
      // content-addressed store; pointers are hashed directly.
      let evidenceRef: EvidenceRef;
      if (evidenceFile) {
        const bytes = new Uint8Array(await evidenceFile.arrayBuffer());
        if (bytes.length > CONTENT_LIMITS.maxObjectBytes) {
          status.set(`Evidence exceeds ${CONTENT_LIMITS.maxObjectBytes / (1024 * 1024)}MB — split it up.`, 'error');
          return false;
        }
        const mediaType = evidenceFile.type || 'application/octet-stream';
        const hash = await serverClient.putContent(bytes, mediaType);
        evidenceRef = { hash, uri: `content://${hash}`, mediaType, size: bytes.length };
      } else if (evidenceText) {
        const bytes = new TextEncoder().encode(evidenceText);
        evidenceRef = { hash: await sha256Hex(bytes), uri: evidenceText, mediaType: 'text/uri-list', size: bytes.length };
      } else {
        status.set('Attach evidence or give a pointer — pay follows proven outcomes.', 'error');
        return false;
      }

      const payload = {
        contributionId: crypto.randomUUID(),
        dims: { [dim]: 1 },
        summary,
        evidenceRef,
        schemaVersion: SCHEMA_VERSION,
      };
      const bytes = await dao.value.submitContribution(username.value, payload);
      await serverClient.submitOp(bytesToBase64(bytes));
      await safeExecuteRemote(bytes);
      status.set('Contribution submitted — awaiting verification.', 'success');
      bump();
      return true;
    } catch (err) {
      status.set(`Contribution error: ${err instanceof Error ? err.message : String(err)}`, 'error');
      console.error(err);
      return false;
    } finally {
      submitting.value = false;
    }
  }

  // Verify flow (ported): no-self verify, distinct-actor + reciprocity bars,
  // harm-choice prompt, mandatory written reason.
  async function verifyContribution(entry: ContributionMirrorEntry) {
    const d = dao.value;
    if (!d || submitting.value) return;
    if (entry.submitter === username.value) return;
    const prior = entry.verifiedBy ? [entry.verifiedBy] : [];
    if (prior.includes(username.value)) {
      status.set('You already verified this contribution.', 'error');
      return;
    }
    const verifier = username.value;
    if (
      d.node.setContains(RECIP_NAMES.verifiedBy(entry.submitter), verifier) ||
      d.node.setContains(RECIP_NAMES.verifiedBy(verifier), entry.submitter)
    ) {
      status.set('You already verified this submitter’s earlier work — reciprocity bars re-verification.', 'error');
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
      status.set('Answer with yes / yes-harm / voided / no.', 'error');
      return;
    }
    const reason = prompt('Written reason for your verification (recorded permanently):') ?? '';
    if (!reason.trim()) {
      status.set('A written reason is required for every verification.', 'error');
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
    submitting.value = true;
    try {
      const bytes = await d.verifyContribution(username.value, payload);
      await serverClient.submitOp(bytesToBase64(bytes));
      await safeExecuteRemote(bytes);
      status.set(`Verification recorded (+${RES_CONFIG.verificationCheckCredit} $RES).`, 'success');
      bump();
    } catch (err) {
      status.set(`Verify error: ${err instanceof Error ? err.message : String(err)}`, 'error');
      console.error(err);
    } finally {
      submitting.value = false;
    }
  }

  async function settleContribution(entry: ContributionMirrorEntry) {
    const d = dao.value;
    if (!d || submitting.value || entry.submitter !== username.value) return;
    const reason = prompt('Settlement note (recorded permanently):') ?? '';
    if (!reason.trim()) {
      status.set('A written reason is required to settle.', 'error');
      return;
    }
    submitting.value = true;
    try {
      const bytes = await d.settleContribution(username.value, {
        contributionId: entry.record.contributionId,
        submitter: entry.submitter,
        reason,
        verifiers: entry.verifiers ?? [],
      });
      await serverClient.submitOp(bytesToBase64(bytes));
      await safeExecuteRemote(bytes);
      status.set('Contribution settled.', 'success');
      bump();
    } catch (err) {
      status.set(`Settle error: ${err instanceof Error ? err.message : String(err)}`, 'error');
      console.error(err);
    } finally {
      submitting.value = false;
    }
  }

  async function appealContribution(entry: ContributionMirrorEntry) {
    const d = dao.value;
    if (!d || submitting.value || entry.submitter !== username.value) return;
    const reason = prompt('Appeal reason (recorded permanently):') ?? '';
    if (!reason.trim()) {
      status.set('A written reason is required to appeal.', 'error');
      return;
    }
    submitting.value = true;
    try {
      const bytes = await d.appealVerdict(username.value, {
        contributionId: entry.record.contributionId,
        submitter: entry.submitter,
        reason,
      });
      await serverClient.submitOp(bytesToBase64(bytes));
      await safeExecuteRemote(bytes);
      status.set('Appeal recorded — awaiting re-verification.', 'success');
      bump();
    } catch (err) {
      status.set(`Appeal error: ${err instanceof Error ? err.message : String(err)}`, 'error');
      console.error(err);
    } finally {
      submitting.value = false;
    }
  }

  // ---- round-spine ops ----

  async function auditRound() {
    const d = dao.value;
    if (!d || submitting.value) return;
    const fair = confirm('Close the round as FAIR? OK = fair, Cancel = UNFAIR (records the round debt and skips aggregation).');
    const note = prompt('Audit note (recorded permanently):') ?? '';
    if (!note.trim()) {
      status.set('An audit note is required.', 'error');
      return;
    }
    submitting.value = true;
    try {
      const bytes = await d.auditRound(username.value, {
        fair,
        note,
        calibrationVersion: 'v1',
      });
      await serverClient.submitOp(bytesToBase64(bytes));
      await safeExecuteRemote(bytes);
      status.set(fair ? 'Round audited as fair.' : 'Round closed with a debt record; next round begins.', fair ? 'success' : 'error');
      bump();
    } catch (err) {
      status.set(`Audit error: ${err instanceof Error ? err.message : String(err)}`, 'error');
      console.error(err);
    } finally {
      submitting.value = false;
    }
  }

  async function reckonRound() {
    const d = dao.value;
    if (!d || submitting.value) return;
    const note = prompt('Reckoning note (recorded permanently):') ?? '';
    if (!note.trim()) {
      status.set('A reckoning note is required.', 'error');
      return;
    }
    submitting.value = true;
    try {
      const bytes = await d.reckonRound(username.value, { note });
      await serverClient.submitOp(bytesToBase64(bytes));
      await safeExecuteRemote(bytes);
      status.set('Round reckoned — ready to complete.', 'success');
      bump();
    } catch (err) {
      status.set(`Reckon error: ${err instanceof Error ? err.message : String(err)}`, 'error');
      console.error(err);
    } finally {
      submitting.value = false;
    }
  }

  async function completeRound() {
    const d = dao.value;
    if (!d || submitting.value) return;
    submitting.value = true;
    try {
      const currentRound = d.getCurrentRound();
      const entries = d.getContributions()
        .filter((entry) => d.getContributionStatus(entry.record.contributionId) === 'accepted'
          && d.getContributionRound(entry.record.contributionId) === currentRound)
        .map((entry) => ({ contributionId: entry.record.contributionId, submitter: entry.submitter, dims: entry.record.dims, harm: entry.harm ?? ('none' as const) }));
      if (entries.length === 0) {
        status.set('Nothing settled to aggregate in this round.', 'error');
        return;
      }
      const bytes = await d.completeRound(username.value, { entries });
      await serverClient.submitOp(bytesToBase64(bytes));
      await safeExecuteRemote(bytes);
      status.set(`Round published — ${entries.length} contribution(s) aggregated.`, 'success');
      bump();
    } catch (err) {
      status.set(`Complete error: ${err instanceof Error ? err.message : String(err)}`, 'error');
      console.error(err);
    } finally {
      submitting.value = false;
    }
  }

  async function setRctAlpha(raw: Record<string, number>, version: string) {
    const d = dao.value;
    if (!d || submitting.value) return;
    submitting.value = true;
    try {
      const bytes = await d.setRctAlpha(username.value, { weights: raw, version: version.trim() });
      await serverClient.submitOp(bytesToBase64(bytes));
      await safeExecuteRemote(bytes);
      status.set('RCT weights updated.', 'success');
      bump();
    } catch (err) {
      status.set(`Weights error: ${err instanceof Error ? err.message : String(err)}`, 'error');
      console.error(err);
    } finally {
      submitting.value = false;
    }
  }

  async function setCalibrationVersion() {
    const d = dao.value;
    if (!d || submitting.value) return;
    submitting.value = true;
    try {
      const bytes = await d.setCalibrationVersion(username.value, { version: 'v1' });
      await serverClient.submitOp(bytesToBase64(bytes));
      await safeExecuteRemote(bytes);
      status.set('Calibration version set to v1.', 'success');
      bump();
    } catch (err) {
      status.set(`Calibration error: ${err instanceof Error ? err.message : String(err)}`, 'error');
      console.error(err);
    } finally {
      submitting.value = false;
    }
  }

  async function removeMember(target: string) {
    const d = dao.value;
    if (!d || submitting.value || target === username.value) return;
    submitting.value = true;
    try {
      const bytes = await d.removeMember(username.value, { username: target });
      await serverClient.submitOp(bytesToBase64(bytes));
      await safeExecuteRemote(bytes);
      members.value = members.value.filter((m) => m !== target);
      status.set(`${target} removed from the DAO.`, 'success');
      bump();
    } catch (err) {
      status.set(`Remove error: ${err instanceof Error ? err.message : String(err)}`, 'error');
      console.error(err);
    } finally {
      submitting.value = false;
    }
  }

  function evidenceSummary(evidenceRef: EvidenceRef): string {
    if (evidenceRef.uri.startsWith('content://')) return `stored evidence (${(evidenceRef.size / 1024).toFixed(1)} KB, ${evidenceRef.mediaType})`;
    return `pointer: ${evidenceRef.uri}`;
  }

  return {
    dao, username, submitting, tick, members, authed, custodians, isCustodian,
    votedProposals,
    bootstrap, teardown, replayLog,
    createProposal, vote, execute,
    startElection, castBallot, finalizeElection, castRunoffVote,
    submitContribution, verifyContribution, settleContribution, appealContribution,
    auditRound, reckonRound, completeRound, setRctAlpha, setCalibrationVersion,
    removeMember,
    evidenceSummary,
  };
});
