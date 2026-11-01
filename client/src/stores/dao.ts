import { ref, shallowRef, computed } from 'vue';
import { defineStore } from 'pinia';
import {
  ProposalPayload, VotePayload, StartElectionPayload, VerifyContributionPayload,
  ServerMessage,
} from '@shared/types';
import {
  CONTENT_LIMITS, schemaForDims, EvidenceRef, HarmVerdict, SCHEMA_VERSION, STATUS_APPEALED,
} from '@shared/contribution';
import type { ContributionFacts } from '@shared/wizard';
import { RECIP_NAMES, RES_CONFIG } from '@shared/policies';
import type { FeedEvent } from '@shared/feed';
import { BrowserDao, ContributionMirrorEntry, bytesToBase64, base64ToBytes } from '../dao';
import { ServerClient } from '../server-client';
import { useStatusStore } from './status';

export const serverClient = new ServerClient();

// Per-entry fact assembly for the contribution wizards (extracted from the
// retired contribution card's computed). Takes the dao as a param — it must
// not read store refs from module scope.
export function contributionFacts(d: BrowserDao, entry: ContributionMirrorEntry): { schema: ReturnType<typeof schemaForDims>; facts: ContributionFacts } {
  const status = d.getContributionStatus(entry.record.contributionId);
  const schema = schemaForDims(entry.record.dims);
  const appealed = status === 'pending' && d.getContributionAppealed(entry.record.contributionId);
  const facts: ContributionFacts = {
    // STATUS_APPEALED renders through wizardModel like pending with the
    // appealed flag lit — the register's raw mapping would lose the appeal.
    status: appealed ? STATUS_APPEALED : status === 'unknown' ? -1 : status === 'accepted' ? 1 : status === 'rejected' ? 2 : 0,
    stepIndex: d.getContributionStepIndex(entry.record.contributionId),
    done: Object.fromEntries(schema.steps.map((s) => [
      s.stepId, d.getContributionStepDone(entry.record.contributionId, s.stepId),
    ])),
    submitter: entry.submitter,
  };
  return { schema, facts };
}

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

  // Boot-time ingest rides the replay path (BrowserDao.replayRemote →
  // node.replayOp, clamp policy): historic ops materialize instead of
  // aborting the whole replay with 'protocol_violation'. Skips (e.g.
  // 'unauthorized' entries the server-side hydrate also skips) never throw —
  // log them (throttled to the same shape as the wrapper's replayOps warns)
  // and keep converging.
  const REPLAY_LOG_WARN_LIMIT = 10;
  async function replayLog(target?: BrowserDao) {
    const logMsg = await serverClient.getLog(0);
    if (logMsg.kind !== 'log' || !dao.value) return;
    let skipCount = 0;
    for (const stored of logMsg.operations) {
      if (!dao.value) return;
      try {
        const skip = await dao.value.replayRemote(base64ToBytes(stored.bytes));
        if (skip) {
          skipCount++;
          if (skipCount <= REPLAY_LOG_WARN_LIMIT) {
            console.warn(`dao replay: skipped op at index ${stored.index}: ${skip.message}`);
          }
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        status.set(`State sync failed: ${message}`, 'error');
        return;
      }
    }
    if (skipCount > REPLAY_LOG_WARN_LIMIT) {
      console.warn(`dao replay: ...and ${skipCount - REPLAY_LOG_WARN_LIMIT} more skipped (total ${skipCount})`);
    }
  }

  // Owns the BrowserDao lifecycle: message wiring, demo clock, and the
  // devtools attach (dev only) all hang off bootstrap/teardown.
  async function bootstrap(target: BrowserDao, user: string) {
    // teardown() detaches the server listener; re-run the setup-store body is
    // not an option, so re-attach here. Idempotent — the guard no-ops when
    // already bound.
    ensureMessageWiring();
    // Push reactivity: any CRABS mutation (this dao's own executes included)
    // invalidates every tick-gated computed — updates become exact, not 1s.
    target.onChange = () => bump();
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

  async function submitContribution(summary: string, dim: number, evidenceFile: File | null, evidenceText: string): Promise<string | null> {
    if (!dao.value || submitting.value) return null;
    submitting.value = true;
    try {
      // Evidence priority: attached file → text pointer. Files go to the
      // content-addressed store; pointers are hashed directly.
      let evidenceRef: EvidenceRef;
      if (evidenceFile) {
        const bytes = new Uint8Array(await evidenceFile.arrayBuffer());
        if (bytes.length > CONTENT_LIMITS.maxObjectBytes) {
          status.set(`Evidence exceeds ${CONTENT_LIMITS.maxObjectBytes / (1024 * 1024)}MB — split it up.`, 'error');
          return null;
        }
        const mediaType = evidenceFile.type || 'application/octet-stream';
        const hash = await serverClient.putContent(bytes, mediaType);
        evidenceRef = { hash, uri: `content://${hash}`, mediaType, size: bytes.length };
      } else if (evidenceText) {
        const bytes = new TextEncoder().encode(evidenceText);
        evidenceRef = { hash: await sha256Hex(bytes), uri: evidenceText, mediaType: 'text/uri-list', size: bytes.length };
      } else {
        status.set('Attach evidence or give a pointer — pay follows proven outcomes.', 'error');
        return null;
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
      return payload.contributionId;
    } catch (err) {
      status.set(`Contribution error: ${err instanceof Error ? err.message : String(err)}`, 'error');
      console.error(err);
      return null;
    } finally {
      submitting.value = false;
    }
  }

  // Verify flow (ported): no-self verify, distinct-actor + reciprocity bars,
  // mandatory written reason. The decision UI lives in
  // flows/contribute-flows.ts (verifyFlow); this store op is the gate +
  // payload assembler.
  async function verifyContribution(entry: ContributionMirrorEntry, input: { pass: boolean; harm: HarmVerdict; reason: string }): Promise<boolean> {
    const d = dao.value;
    if (!d || submitting.value) return false;
    if (entry.submitter === username.value) return false;
    const prior = entry.verifiedBy ? [entry.verifiedBy] : [];
    if (prior.includes(username.value)) {
      status.set('You already verified this contribution.', 'error');
      return false;
    }
    const verifier = username.value;
    if (
      d.node.setContains(RECIP_NAMES.verifiedBy(entry.submitter), verifier) ||
      d.node.setContains(RECIP_NAMES.verifiedBy(verifier), entry.submitter)
    ) {
      status.set('You already verified this submitter’s earlier work — reciprocity bars re-verification.', 'error');
      return false;
    }
    if (!input.reason.trim()) {
      status.set('A written reason is required for every verification.', 'error');
      return false;
    }
    const payload: VerifyContributionPayload = {
      contributionId: entry.record.contributionId,
      submitter: entry.submitter,
      dims: entry.record.dims,
      stepId: 'verify',
      pass: input.pass,
      reason: input.reason.trim(),
      harm: input.harm,
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
      return true;
    } catch (err) {
      status.set(`Verify error: ${err instanceof Error ? err.message : String(err)}`, 'error');
      console.error(err);
      return false;
    } finally {
      submitting.value = false;
    }
  }

  async function settleContribution(entry: ContributionMirrorEntry, input: { reason: string }): Promise<boolean> {
    const d = dao.value;
    if (!d || submitting.value || entry.submitter !== username.value) return false;
    if (!input.reason.trim()) {
      status.set('A written reason is required to settle.', 'error');
      return false;
    }
    submitting.value = true;
    try {
      const bytes = await d.settleContribution(username.value, {
        contributionId: entry.record.contributionId,
        submitter: entry.submitter,
        reason: input.reason.trim(),
        verifiers: entry.verifiers ?? [],
      });
      await serverClient.submitOp(bytesToBase64(bytes));
      await safeExecuteRemote(bytes);
      status.set('Contribution settled.', 'success');
      bump();
      return true;
    } catch (err) {
      status.set(`Settle error: ${err instanceof Error ? err.message : String(err)}`, 'error');
      console.error(err);
      return false;
    } finally {
      submitting.value = false;
    }
  }

  async function appealContribution(entry: ContributionMirrorEntry, input: { reason: string }): Promise<boolean> {
    const d = dao.value;
    if (!d || submitting.value || entry.submitter !== username.value) return false;
    if (!input.reason.trim()) {
      status.set('A written reason is required to appeal.', 'error');
      return false;
    }
    submitting.value = true;
    try {
      const bytes = await d.appealVerdict(username.value, {
        contributionId: entry.record.contributionId,
        submitter: entry.submitter,
        reason: input.reason.trim(),
      });
      await serverClient.submitOp(bytesToBase64(bytes));
      await safeExecuteRemote(bytes);
      status.set('Appeal recorded — awaiting re-verification.', 'success');
      bump();
      return true;
    } catch (err) {
      status.set(`Appeal error: ${err instanceof Error ? err.message : String(err)}`, 'error');
      console.error(err);
      return false;
    } finally {
      submitting.value = false;
    }
  }

  // ---- round-spine ops ----

  async function auditRound(input: { fair: boolean; note: string }): Promise<boolean> {
    const d = dao.value;
    if (!d || submitting.value) return false;
    if (!input.note.trim()) {
      status.set('An audit note is required.', 'error');
      return false;
    }
    submitting.value = true;
    try {
      const bytes = await d.auditRound(username.value, {
        fair: input.fair,
        note: input.note.trim(),
        calibrationVersion: 'v1',
      });
      await serverClient.submitOp(bytesToBase64(bytes));
      await safeExecuteRemote(bytes);
      status.set(input.fair ? 'Round audited as fair.' : 'Round closed with a debt record; next round begins.', input.fair ? 'success' : 'error');
      bump();
      return true;
    } catch (err) {
      status.set(`Audit error: ${err instanceof Error ? err.message : String(err)}`, 'error');
      console.error(err);
      return false;
    } finally {
      submitting.value = false;
    }
  }

  async function reckonRound(input: { note: string }): Promise<boolean> {
    const d = dao.value;
    if (!d || submitting.value) return false;
    if (!input.note.trim()) {
      status.set('A reckoning note is required.', 'error');
      return false;
    }
    submitting.value = true;
    try {
      const bytes = await d.reckonRound(username.value, { note: input.note.trim() });
      await serverClient.submitOp(bytesToBase64(bytes));
      await safeExecuteRemote(bytes);
      status.set('Round reckoned — ready to complete.', 'success');
      bump();
      return true;
    } catch (err) {
      status.set(`Reckon error: ${err instanceof Error ? err.message : String(err)}`, 'error');
      console.error(err);
      return false;
    } finally {
      submitting.value = false;
    }
  }

  async function completeRound(): Promise<boolean> {
    const d = dao.value;
    if (!d || submitting.value) return false;
    submitting.value = true;
    try {
      const currentRound = d.getCurrentRound();
      const entries = d.getContributions()
        .filter((entry) => d.getContributionStatus(entry.record.contributionId) === 'accepted'
          && d.getContributionRound(entry.record.contributionId) === currentRound)
        .map((entry) => ({ contributionId: entry.record.contributionId, submitter: entry.submitter, dims: entry.record.dims, harm: entry.harm ?? ('none' as const) }));
      if (entries.length === 0) {
        status.set('Nothing settled to aggregate in this round.', 'error');
        return false;
      }
      const bytes = await d.completeRound(username.value, { entries });
      await serverClient.submitOp(bytesToBase64(bytes));
      await safeExecuteRemote(bytes);
      status.set(`Round published — ${entries.length} contribution(s) aggregated.`, 'success');
      bump();
      return true;
    } catch (err) {
      status.set(`Complete error: ${err instanceof Error ? err.message : String(err)}`, 'error');
      console.error(err);
      return false;
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

  // ---- feed accessors ----

  // Tick-gated read over the dao's own mirror read (which already replays
  // pending ops) — no second accumulator lives in the store.
  function feedEvents(): FeedEvent[] {
    void tick.value;
    return dao.value?.getFeedEvents() ?? [];
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
    feedEvents,
  };
});
