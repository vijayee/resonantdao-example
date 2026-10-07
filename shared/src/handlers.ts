import { HandlerState, HandlerOperation } from 'crabs-wasm';
import { AddMemberPayload, AuditRoundPayload, CastBallotPayload, CastRunoffVotePayload, ContributionPayload, ExecutePayload, FinalizeElectionPayload, ProposalPayload, ProposalType, ReckonRoundPayload, RemoveMemberPayload, SetCalibrationVersionPayload, SetRctAlphaPayload, SettleContributionPayload, StartElectionPayload, VerifyContributionPayload, VotePayload } from './types';
import {
  CALIBRATIONS, CONTRIB_NAMES, CUSTODIAN_SEATS, ELECTION_NAMES, RES_CONFIG, RES_NAMES, ROUND_NAMES, RUNOFF_SUFFIX, runoffId, STATE_NAMES, TIMING, TOKEN_NAMES, VOTE_THRESHOLD,
} from './policies';
import { CALIBRATION_VERSION_NUMBERS, STAGE_AUDITED, STAGE_OPEN, STAGE_PUBLISHED, STAGE_RECKONED } from './round';
import {
  CALIBRATION_VERSION, DIMENSION_COUNT, SCHEMA_VERSION, dimensionDeltaFor, isValidDims,
  paymentFor, schemaForDims, validateEvidenceRef,
} from './contribution';

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value !== '';
}

function isValidProposalType(value: unknown): value is ProposalType {
  return value === 'direct' || value === 'quadratic';
}

function isValidOptions(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length >= 2 &&
    value.length <= 10 &&
    value.every(isNonEmptyString) &&
    new Set(value).size === value.length
  );
}

// Every schema starts with a submit step whose op is 'submit_contribution',
// so a successful submission auto-completes step 0: the lifecycle position
// register starts at index 1.
export function makeSubmitContributionHandler(
  node: { addORSet(name: string): void; addPNCounter(name: string): void; addRegister(name: string, initial?: number): void },
  config: { getTimeMs?: () => number } = {}
) {
  return (state: HandlerState, op: HandlerOperation): number => {
    const payload: ContributionPayload = JSON.parse(op.payload || '{}');
    if (
      !isNonEmptyString(payload.contributionId) ||
      !isNonEmptyString(payload.summary) ||
      payload.schemaVersion !== SCHEMA_VERSION ||
      !isValidDims(payload.dims) ||
      !validateEvidenceRef(payload.evidenceRef) ||
      !state.setContains(STATE_NAMES.members, op.signerId) ||
      state.setContains(STATE_NAMES.contributions, payload.contributionId)
    ) {
      return -1;
    }

    const schema = schemaForDims(payload.dims);

    try { node.addORSet(CONTRIB_NAMES.explanations(payload.contributionId)); } catch (err) { /* ignore duplicate */ }
    // The real CRABS wrapper rejects state.setRegister on an undeclared
    // resource, so declare the status register here before writing to it.
    try { node.addRegister(CONTRIB_NAMES.status(payload.contributionId), 0); } catch (err) { /* ignore duplicate */ }
    try { node.addRegister(CONTRIB_NAMES.step(payload.contributionId), 1); } catch (err) { /* ignore duplicate */ }
    for (const step of schema.steps) {
      try { node.addPNCounter(CONTRIB_NAMES.stepDone(payload.contributionId, step.stepId)); } catch (err) { /* ignore duplicate */ }
    }
    state.setRegister(CONTRIB_NAMES.status(payload.contributionId), 0, op.signerId);
    state.incrementPNCounter(CONTRIB_NAMES.stepDone(payload.contributionId, 'submit'), 1, op.signerId);

    const nowMs = config.getTimeMs ? config.getTimeMs() : Date.now();
    const record = {
      contributionId: payload.contributionId,
      submitter: op.signerId,
      dims: payload.dims,
      summary: payload.summary,
      evidenceRef: payload.evidenceRef,
      schemaVersion: payload.schemaVersion,
      submittedAt: nowMs,
    };
    // Explanation record for the submit decision (invariant: every decision
    // emits an explanation record). Element is the JSON record; tag is
    // deterministic and unique per record type — CRABS OR-Sets dedupe by tag,
    // so reusing op.signerId would collide with other records from the same
    // signer and silently drop one of them.
    state.setAdd(CONTRIB_NAMES.explanations(payload.contributionId), JSON.stringify(record), `submit:${op.signerId}`);
    // CRABS OR-Set add dedups by tag, so the tag must be unique per submission
    // (op.signerId would silently drop every contribution after a member's first).
    state.setAdd(STATE_NAMES.contributions, payload.contributionId, payload.contributionId);
    return 0;
  };
}

// Generic lifecycle verify step (op 'verify_contribution'). The schema is
// recomputed deterministically from the payload dims on every replica, so the
// step is resolved against it rather than trusted from the op. Anti-gaming:
// the verifier must differ from the submitter (the submitter is carried in the
// payload, asserted by the caller's client flow).
//
// Declaration safety (real CRABS wrapper): state.setRegister on an undeclared
// register throws resource_not_found, so every register this handler might
// write that was NOT already declared by makeSubmitContributionHandler
// (status/step registers, per-step done counters, explanations ORSet) is
// addRegister'd first — balances and dimension tallies.
export function makeVerifyContributionHandler(
  node: { addRegister(name: string, initial?: number): void },
  config: { getTimeMs?: () => number } = {}
) {
  return (state: HandlerState, op: HandlerOperation): number => {
    const payload: VerifyContributionPayload = JSON.parse(op.payload || '{}');
    if (
      !isNonEmptyString(payload.contributionId) ||
      !isNonEmptyString(payload.submitter) ||
      !isNonEmptyString(payload.stepId) ||
      !isNonEmptyString(payload.reason) ||
      typeof payload.pass !== 'boolean' ||
      !isValidDims(payload.dims) ||
      payload.submitter === op.signerId
    ) {
      return -1;
    }
    if (
      !state.setContains(STATE_NAMES.members, payload.submitter) ||
      !state.setContains(STATE_NAMES.contributions, payload.contributionId)
    ) {
      return -1;
    }

    const statusReg = CONTRIB_NAMES.status(payload.contributionId);
    const stepReg = CONTRIB_NAMES.step(payload.contributionId);
    const status = state.getRegister(statusReg);
    if (status === undefined || status !== 0) {
      return -1; // already accepted/rejected or never submitted
    }
    const stepIndex = state.getRegister(stepReg);
    if (stepIndex === undefined || !Number.isInteger(stepIndex) || stepIndex < 0) {
      return -1;
    }
    const schema = schemaForDims(payload.dims);
    const step = schema.steps[stepIndex];
    if (!step || step.op !== 'verify_contribution' || step.stepId !== payload.stepId) {
      return -1;
    }

    // Per-check credit for the ACTOR on every completed verification,
    // pass or reject (C_18 Moon).
    const actorBalance = RES_NAMES.balance(op.signerId);
    try { node.addRegister(actorBalance, 0); } catch (err) { /* ignore duplicate */ }
    state.setRegister(actorBalance, (state.getRegister(actorBalance) || 0) + RES_CONFIG.verificationCheckCredit, op.signerId);

    const doneName = CONTRIB_NAMES.stepDone(payload.contributionId, step.stepId);
    state.incrementPNCounter(doneName, 1, op.signerId);
    const done = state.getPNCounter(doneName) || 0;
    const isFinal = done >= step.requirement.count;

    const nowMs = config.getTimeMs ? config.getTimeMs() : Date.now();
    const verification = { verifier: op.signerId, pass: payload.pass, reason: payload.reason, at: nowMs };

    if (!payload.pass) {
      // Rejection terminates the lifecycle immediately; dimension tallies are
      // NOT touched (outcome voided).
      try { node.addRegister(statusReg, 0); } catch (err) { /* ignore duplicate */ }
      state.setRegister(statusReg, 2, op.signerId);
      const record = {
        contributionId: payload.contributionId,
        stepId: step.stepId,
        verification,
        payments: {} as Record<string, number>,
        calibrationVersion: CALIBRATION_VERSION,
        schemaVersion: schema.schemaVersion,
      };
      state.setAdd(CONTRIB_NAMES.explanations(payload.contributionId), JSON.stringify(record), `verify:${op.signerId}`);
      return 0;
    }

    const payments: Record<string, number> = {};
    if (isFinal) {
      // Submitter outcome bounties: every non-per-check rule fires once at the
      // step's final requirement completion. The actor entry (per-check) was
      // already paid above.
      let submitterAmount = 0;
      for (const pay of step.pays ?? []) {
        if (pay.rule === 'per-dims') {
          for (const [dimKey, match] of Object.entries(payload.dims)) {
            submitterAmount += paymentFor(Number(dimKey), match);
          }
        } else if (pay.rule === 'flat') {
          submitterAmount += pay.amount ?? 0;
        }
      }
      if (submitterAmount > 0 && payload.submitter !== op.signerId) {
        const submitterBalance = RES_NAMES.balance(payload.submitter);
        try { node.addRegister(submitterBalance, 0); } catch (err) { /* ignore duplicate */ }
        state.setRegister(submitterBalance, (state.getRegister(submitterBalance) || 0) + submitterAmount, op.signerId);
        payments[payload.submitter] = submitterAmount;
      }

      // Dimension tallies grow by the accept delta — but only for dimensions
      // with an implemented payment rule; classification-only dims (payment 0)
      // cannot be distinguished from never-set on the register and are skipped.
      for (const [dimKey, match] of Object.entries(payload.dims)) {
        const dimIndex = Number(dimKey);
        if (paymentFor(dimIndex, match) <= 0) {
          continue;
        }
        const tallyReg = CONTRIB_NAMES.dimensionBalance(payload.submitter, dimIndex);
        try { node.addRegister(tallyReg, 0); } catch (err) { /* ignore duplicate */ }
        state.setRegister(tallyReg, (state.getRegister(tallyReg) || 0) + dimensionDeltaFor(dimIndex, match), op.signerId);
      }

      // Step advance: at a terminal step the contribution is accepted.
      try { node.addRegister(stepReg, 0); } catch (err) { /* ignore duplicate */ }
      try { node.addRegister(statusReg, 0); } catch (err) { /* ignore duplicate */ }
      if (stepIndex + 1 < schema.steps.length) {
        state.setRegister(stepReg, stepIndex + 1, op.signerId);
      } else {
        state.setRegister(statusReg, 1, op.signerId);
      }
    }

    const record = {
      contributionId: payload.contributionId,
      stepId: step.stepId,
      verification,
      payments,
      calibrationVersion: CALIBRATION_VERSION,
      schemaVersion: schema.schemaVersion,
    };
    state.setAdd(CONTRIB_NAMES.explanations(payload.contributionId), JSON.stringify(record), `verify:${op.signerId}`);
    return 0;
  };
}

// Terminal lifecycle settle step (op 'settle_contribution'): the submitter
// acknowledges the verified outcome; the lifecycle finalizes as accepted. No
// payments — every payout already fired at the final verify completion.
// Positional validation (documented limitation): handlers cannot read the
// fact record's dims, so the settle step is validated by position — the
// settle step exists only as the terminal step (index 2) in phase-1 schemas.
// Future multi-step schemas will pass dims like verify does to locate the
// settle step in the schema instead of pinning the register index.
export function makeSettleContributionHandler(
  _node: { addRegister(name: string, initial?: number): void },
  config: { getTimeMs?: () => number } = {}
) {
  return (state: HandlerState, op: HandlerOperation): number => {
    const payload: SettleContributionPayload = JSON.parse(op.payload || '{}');
    if (
      !isNonEmptyString(payload.contributionId) ||
      !isNonEmptyString(payload.submitter) ||
      !isNonEmptyString(payload.reason)
    ) {
      return -1;
    }
    if (payload.submitter !== op.signerId) {
      return -1; // settlement is the submitter's final acknowledgment
    }
    if (!state.setContains(STATE_NAMES.contributions, payload.contributionId)) {
      return -1;
    }
    const statusReg = CONTRIB_NAMES.status(payload.contributionId);
    if (state.getRegister(statusReg) !== 0) {
      return -1; // already accepted/rejected, or never submitted
    }
    if (state.getRegister(CONTRIB_NAMES.step(payload.contributionId)) !== 2) {
      return -1;
    }

    const doneReg = CONTRIB_NAMES.stepDone(payload.contributionId, 'settle');
    state.incrementPNCounter(doneReg, 1, op.signerId);
    state.setRegister(statusReg, 1, op.signerId);

    const nowMs = config.getTimeMs ? config.getTimeMs() : Date.now();
    const explanation = {
      contributionId: payload.contributionId,
      stepId: 'settle',
      settlement: { settler: op.signerId, reason: payload.reason, at: nowMs },
      calibrationVersion: CALIBRATION_VERSION,
    };
    state.setAdd(CONTRIB_NAMES.explanations(payload.contributionId), JSON.stringify(explanation), `settle:${op.signerId}`);
    return 0;
  };
}

export function makeAddMemberHandler() {
  return (state: HandlerState, op: HandlerOperation): number => {
    const payload: AddMemberPayload = JSON.parse(op.payload || '{}');
    if (!isNonEmptyString(payload.username) || !isNonEmptyString(payload.publicKeyHex)) {
      return -1;
    }
    state.setAdd(STATE_NAMES.members, payload.username, payload.publicKeyHex);
    return 0;
  };
}

export function makeCreateProposalHandler(
  node: { addORSet(name: string): void; addPNCounter(name: string): void; addRegister(name: string, initial?: number): void; addOneShotSet(name: string): void },
  config: { getTimeMs?: () => number } = {}
) {
  return (state: HandlerState, op: HandlerOperation): number => {
    const payload: ProposalPayload = JSON.parse(op.payload || '{}');
    if (
      !isNonEmptyString(payload.proposalId) ||
      !isNonEmptyString(payload.title) ||
      !isValidProposalType(payload.proposalType) ||
      !isValidOptions(payload.options)
    ) {
      return -1;
    }

    const optionCount = payload.options.length;
    try { node.addRegister(TOKEN_NAMES.proposalOptionCount(payload.proposalId), 0); } catch (err) { /* ignore duplicate */ }
    for (let i = 0; i < optionCount; i++) {
      try { node.addORSet(TOKEN_NAMES.optionVoteSet(payload.proposalId, i)); } catch (err) { if (!(err instanceof Error) || !err.message.toLowerCase().includes('duplicate_operation')) console.warn('create_proposal resource init warning:', err); }
      try { node.addPNCounter(TOKEN_NAMES.optionVoteCount(payload.proposalId, i)); } catch (err) { if (!(err instanceof Error) || !err.message.toLowerCase().includes('duplicate_operation')) console.warn('create_proposal resource init warning:', err); }
    }
    try { node.addOneShotSet(TOKEN_NAMES.voteTypeSet(payload.proposalId)); } catch (err) { /* ignore duplicate */ }
    try { node.addORSet(TOKEN_NAMES.proposalMirrorSet(payload.proposalId)); } catch (err) { /* ignore duplicate */ }
    try { node.addRegister(TOKEN_NAMES.proposalType(payload.proposalId), 0); } catch (err) { /* ignore duplicate */ }
    try { node.addRegister(TOKEN_NAMES.proposalExpiresAt(payload.proposalId), 0); } catch (err) { /* ignore duplicate */ }
    try { node.addRegister(TOKEN_NAMES.proposalExecuted(payload.proposalId), 0); } catch (err) { /* ignore duplicate */ }
    try { node.addRegister(TOKEN_NAMES.proposalPassed(payload.proposalId), 0); } catch (err) { /* ignore duplicate */ }
    try { node.addRegister(TOKEN_NAMES.proposalWinner(payload.proposalId), 0); } catch (err) { /* ignore duplicate */ }

    const nowMs = config.getTimeMs ? config.getTimeMs() : Date.now();
    const expiresAt = typeof payload.expiresAt === 'number' && payload.expiresAt > nowMs ? payload.expiresAt : nowMs + TIMING.defaultExpiryMs;

    state.setRegister(TOKEN_NAMES.proposalType(payload.proposalId), payload.proposalType === 'direct' ? 1 : 2, op.signerId);
    state.setRegister(TOKEN_NAMES.proposalExpiresAt(payload.proposalId), expiresAt, op.signerId);
    state.setRegister(TOKEN_NAMES.proposalOptionCount(payload.proposalId), optionCount, op.signerId);
    state.setAdd(STATE_NAMES.proposals, payload.proposalId, JSON.stringify(payload));
    return 0;
  };
}

export function makeVoteHandler(
  config: { getTimeMs?: () => number } = {}
) {
  return (state: HandlerState, op: HandlerOperation): number => {
    const payload: VotePayload = JSON.parse(op.payload || '{}');
    const optionCount = state.getRegister(TOKEN_NAMES.proposalOptionCount(payload.proposalId)) || 0;
    if (
      !isNonEmptyString(payload.proposalId) ||
      optionCount <= 0 ||
      !Number.isInteger(payload.choice) ||
      payload.choice < 0 ||
      payload.choice >= optionCount
    ) {
      return -1;
    }

    const nowMs = config.getTimeMs ? config.getTimeMs() : Date.now();

    const proposalTypeReg = TOKEN_NAMES.proposalType(payload.proposalId);
    const expiresAtReg = TOKEN_NAMES.proposalExpiresAt(payload.proposalId);
    const proposalType = state.getRegister(proposalTypeReg) || 1;
    const expiresAt = state.getRegister(expiresAtReg) || 0;

    if (expiresAt > 0 && nowMs > expiresAt) {
      return -1;
    }

    // Direct vote: state machine rejects duplicate votes per user per proposal.
    let voteNumber = 1;
    if (proposalType === 1) {
      const votersSet = TOKEN_NAMES.voteTypeSet(payload.proposalId);
      if (state.setContains(votersSet, op.signerId)) {
        return -1;
      }
      state.setAdd(votersSet, op.signerId, op.signerId);
    }

    // Quadratic vote: allow multiple votes. Each additional vote costs n^2
    // $RES from a mirrored per-proposal token pool. Balances are not globally
    // consumed; the mirror tracks the cumulative cost spent on this proposal.
    if (proposalType === 2) {
      const balance = state.getRegister(RES_NAMES.balance(op.signerId)) || 0;
      const mirrorSet = TOKEN_NAMES.proposalMirrorSet(payload.proposalId);
      let used = 0;
      const maxVoteCheck = 100;
      for (let i = 1; i <= maxVoteCheck; i++) {
        const el = TOKEN_NAMES.proposalMirrorElement(payload.proposalId, op.signerId, i);
        if (state.setContains(mirrorSet, el)) {
          used = i;
        } else {
          break;
        }
      }
      voteNumber = used + 1;
      // Cumulative quadratic cost after voteNumber votes: sum_{i=1}^{voteNumber} i^2
      const cumulativeCost = (voteNumber * (voteNumber + 1) * (2 * voteNumber + 1)) / 6;
      if (balance < cumulativeCost) {
        return -1;
      }
      state.setAdd(mirrorSet, TOKEN_NAMES.proposalMirrorElement(payload.proposalId, op.signerId, voteNumber), `${op.signerId}:${voteNumber}`);
    }

    const voteKey = `${op.signerId}:${voteNumber}`;
    state.setAdd(TOKEN_NAMES.optionVoteSet(payload.proposalId, payload.choice), voteKey, op.signerId);
    state.incrementPNCounter(TOKEN_NAMES.optionVoteCount(payload.proposalId, payload.choice), 1, op.signerId);
    return 0;
  };
}

export function makeExecuteHandler(
  config: { getTimeMs?: () => number; threshold?: number } = {}
) {
  const threshold = config.threshold ?? VOTE_THRESHOLD;
  return (state: HandlerState, op: HandlerOperation): number => {
    const payload: ExecutePayload = JSON.parse(op.payload || '{}');
    const optionCount = state.getRegister(TOKEN_NAMES.proposalOptionCount(payload.proposalId)) || 0;
    if (!isNonEmptyString(payload.proposalId) || optionCount <= 0) {
      return -1;
    }

    const nowMs = config.getTimeMs ? config.getTimeMs() : Date.now();
    const expiresAt = state.getRegister(TOKEN_NAMES.proposalExpiresAt(payload.proposalId)) || 0;

    let leaderIdx = 0;
    let leaderCount = 0;
    let total = 0;
    for (let i = 0; i < optionCount; i++) {
      const count = state.getPNCounter(TOKEN_NAMES.optionVoteCount(payload.proposalId, i)) || 0;
      total += count;
      if (count > leaderCount) {
        leaderCount = count;
        leaderIdx = i;
      }
    }
    const hasMajority = total > 0 && leaderCount * 2 > total;

    if (expiresAt > 0 && nowMs < expiresAt) {
      // Before expiry, only auto-execute if the leader reached the vote
      // threshold AND already holds a strict majority of votes cast so far.
      if (!(leaderCount >= threshold && hasMajority)) {
        return 0;
      }
    }

    state.setRegister(TOKEN_NAMES.proposalPassed(payload.proposalId), hasMajority ? 1 : 0, op.signerId);
    // Register stores winnerIndex + 1; 0 = no winner (avoids a negative
    // register initial value, which the CRABS WASM wrapper does not guarantee).
    state.setRegister(TOKEN_NAMES.proposalWinner(payload.proposalId), hasMajority ? leaderIdx + 1 : 0, op.signerId);
    state.setRegister(TOKEN_NAMES.proposalExecuted(payload.proposalId), 1, op.signerId);
    state.setAdd(STATE_NAMES.executedProposals, payload.proposalId, op.signerId);
    return 0;
  };
}

export function makeStartElectionHandler(
  node: { addORSet(name: string): void; addPNCounter(name: string): void; addRegister(name: string, initial?: number): void },
  config: { getTimeMs?: () => number } = {}
) {
  return (state: HandlerState, op: HandlerOperation): number => {
    const payload: StartElectionPayload = JSON.parse(op.payload || '{}');
    const id = payload.electionId;
    if (
      !isNonEmptyString(id) ||
      !Array.isArray(payload.candidates) ||
      payload.candidates.length === 0 ||
      payload.candidates.length > 50 ||
      !payload.candidates.every(isNonEmptyString) ||
      new Set(payload.candidates).size !== payload.candidates.length
    ) {
      return -1;
    }
    for (const candidate of payload.candidates) {
      if (!state.setContains(STATE_NAMES.members, candidate)) {
        return -1;
      }
    }

    try {
      node.addORSet(ELECTION_NAMES.ballots(id));
    } catch (err) {
      if (err instanceof Error && err.message.toLowerCase().includes('duplicate_operation')) {
        return -1; // election id already in use
      }
      console.warn('start_election resource init warning:', err);
    }
    try { node.addORSet(ELECTION_NAMES.candidates(id)); } catch (err) { console.warn('start_election resource init warning:', err); }
    for (const candidate of payload.candidates) {
      try { node.addPNCounter(ELECTION_NAMES.candVotes(id, candidate)); } catch (err) { console.warn('start_election resource init warning:', err); }
      // Use the candidate name as the ORSet tag so every candidate gets a
      // unique tag within this election (CRABS setAdd with a duplicate tag
      // would only retain one element).
      state.setAdd(ELECTION_NAMES.candidates(id), candidate, candidate);
    }
    try { node.addRegister(ELECTION_NAMES.expires(id), 0); } catch (err) { /* ignore duplicate */ }
    try { node.addRegister(ELECTION_NAMES.finalized(id), 0); } catch (err) { /* ignore duplicate */ }
    try { node.addRegister(ELECTION_NAMES.isRunoff(id), 0); } catch (err) { /* ignore duplicate */ }
    try { node.addRegister(ELECTION_NAMES.seats(id), 0); } catch (err) { /* ignore duplicate */ }

    const nowMs = config.getTimeMs ? config.getTimeMs() : Date.now();
    const expiresAt = typeof payload.expiresAt === 'number' && payload.expiresAt > nowMs
      ? payload.expiresAt
      : nowMs + TIMING.defaultExpiryMs;

    state.setRegister(ELECTION_NAMES.expires(id), expiresAt, op.signerId);
    state.setRegister(ELECTION_NAMES.finalized(id), 0, op.signerId);
    state.setRegister(ELECTION_NAMES.isRunoff(id), 0, op.signerId);
    state.setRegister(ELECTION_NAMES.seats(id), CUSTODIAN_SEATS, op.signerId);
    return 0;
  };
}

export function makeCastBallotHandler(
  config: { getTimeMs?: () => number } = {}
) {
  return (state: HandlerState, op: HandlerOperation): number => {
    const payload: CastBallotPayload = JSON.parse(op.payload || '{}');
    const id = payload.electionId;
    if (!isNonEmptyString(id) || !Array.isArray(payload.picks)) {
      return -1;
    }
    if (payload.picks.length < 1 || payload.picks.length > CUSTODIAN_SEATS) {
      return -1;
    }
    if (!payload.picks.every(isNonEmptyString) || new Set(payload.picks).size !== payload.picks.length) {
      return -1;
    }

    const nowMs = config.getTimeMs ? config.getTimeMs() : Date.now();
    const expiresAt = state.getRegister(ELECTION_NAMES.expires(id)) || 0;
    if (expiresAt <= 0 || nowMs > expiresAt) {
      return -1;
    }
    if (state.getRegister(ELECTION_NAMES.finalized(id)) === 1) {
      return -1;
    }

    const ballots = ELECTION_NAMES.ballots(id);
    if (state.setContains(ballots, op.signerId)) {
      return -1; // one ballot per voter
    }

    for (const pick of payload.picks) {
      if (!state.setContains(ELECTION_NAMES.candidates(id), pick)) {
        return -1;
      }
    }

    state.setAdd(ballots, op.signerId, op.signerId);
    for (const pick of payload.picks) {
      state.incrementPNCounter(ELECTION_NAMES.candVotes(id, pick), 1, op.signerId);
    }
    return 0;
  };
}

// Shared ranking used by the finalize handler, the server's custodian grant
// flow, and the client's election mirroring so all three compute identical
// results. Ties sort alphabetically. Zero-vote candidates never win.
export function rankCandidates(
  candidates: string[],
  getVotes: (candidate: string) => number,
  seats: number,
  allowRunoff: boolean
): { winners: string[]; runoffCandidates: string[]; runoffSeats: number } {
  if (!Number.isInteger(seats) || seats <= 0) {
    return { winners: [], runoffCandidates: [], runoffSeats: 0 };
  }

  const ranked = candidates
    .map((candidate) => ({ candidate, votes: getVotes(candidate) }))
    .filter((entry) => entry.votes > 0)
    .sort((a, b) => b.votes - a.votes || (a.candidate < b.candidate ? -1 : a.candidate > b.candidate ? 1 : 0));

  if (ranked.length <= seats) {
    return { winners: ranked.map((e) => e.candidate), runoffCandidates: [], runoffSeats: 0 };
  }

  const cutoffVotes = ranked[seats].votes;
  if (ranked[seats - 1].votes !== cutoffVotes) {
    return { winners: ranked.slice(0, seats).map((e) => e.candidate), runoffCandidates: [], runoffSeats: 0 };
  }

  if (!allowRunoff) {
    // Runoff deadlock guard: alphabetical order already applied by the sort.
    return { winners: ranked.slice(0, seats).map((e) => e.candidate), runoffCandidates: [], runoffSeats: 0 };
  }

  const clear = ranked.filter((e) => e.votes > cutoffVotes).map((e) => e.candidate);
  const tied = ranked.filter((e) => e.votes === cutoffVotes).map((e) => e.candidate);
  return { winners: clear, runoffCandidates: tied, runoffSeats: seats - clear.length };
}

// PoC limitation: a spawned runoff stays pending (parent finalized=2) until a
// member calls finalize_election on the runoff after its expiry. The client UI
// always offers this action once the runoff expires.
export function makeFinalizeElectionHandler(
  node: { addORSet(name: string): void; addPNCounter(name: string): void; addRegister(name: string, initial?: number): void },
  config: { getTimeMs?: () => number } = {}
) {
  return (state: HandlerState, op: HandlerOperation): number => {
    const payload: FinalizeElectionPayload = JSON.parse(op.payload || '{}');
    const id = payload.electionId;
    if (
      !isNonEmptyString(id) ||
      !Array.isArray(payload.candidates) ||
      !payload.candidates.every(isNonEmptyString) ||
      new Set(payload.candidates).size !== payload.candidates.length
    ) {
      return -1;
    }
    const expiresAt = state.getRegister(ELECTION_NAMES.expires(id)) || 0;
    if (expiresAt <= 0) {
      return -1;
    }
    const nowMs = config.getTimeMs ? config.getTimeMs() : Date.now();
    if (nowMs < expiresAt) {
      return 0; // not expired yet; no-op
    }
    const finalized = state.getRegister(ELECTION_NAMES.finalized(id));
    if (finalized === 1 || finalized === 2) {
      return 0; // idempotent
    }
    const isRunoff = state.getRegister(ELECTION_NAMES.isRunoff(id)) === 1;
    const seats = state.getRegister(ELECTION_NAMES.seats(id)) || 0;
    if (seats <= 0) {
      return -1;
    }
    for (const candidate of payload.candidates) {
      if (!state.setContains(ELECTION_NAMES.candidates(id), candidate)) {
        return -1;
      }
    }

    const getVotes = (candidate: string) => state.getPNCounter(ELECTION_NAMES.candVotes(id, candidate)) || 0;
    const result = rankCandidates(payload.candidates, getVotes, seats, !isRunoff);

    try { node.addORSet(ELECTION_NAMES.winners(id)); } catch (err) { console.warn('finalize resource init warning:', err); }
    for (const winner of result.winners) {
      state.setAdd(ELECTION_NAMES.winners(id), winner, winner);
    }

    if (result.runoffCandidates.length > 0) {
      const rid = runoffId(id);
      try { node.addORSet(ELECTION_NAMES.ballots(rid)); } catch (err) { console.warn('finalize resource init warning:', err); }
      try { node.addORSet(ELECTION_NAMES.candidates(rid)); } catch (err) { console.warn('finalize resource init warning:', err); }
      try { node.addORSet(ELECTION_NAMES.mirrorSet(rid)); } catch (err) { console.warn('finalize resource init warning:', err); }
      for (const candidate of result.runoffCandidates) {
        try { node.addPNCounter(ELECTION_NAMES.candVotes(rid, candidate)); } catch (err) { console.warn('finalize resource init warning:', err); }
        state.setAdd(ELECTION_NAMES.candidates(rid), candidate, candidate);
      }
      try { node.addRegister(ELECTION_NAMES.expires(rid), 0); } catch (err) { /* ignore duplicate */ }
      try { node.addRegister(ELECTION_NAMES.finalized(rid), 0); } catch (err) { /* ignore duplicate */ }
      try { node.addRegister(ELECTION_NAMES.isRunoff(rid), 0); } catch (err) { /* ignore duplicate */ }
      try { node.addRegister(ELECTION_NAMES.seats(rid), 0); } catch (err) { /* ignore duplicate */ }

      state.setRegister(ELECTION_NAMES.expires(rid), nowMs + TIMING.defaultExpiryMs, op.signerId);
      state.setRegister(ELECTION_NAMES.isRunoff(rid), 1, op.signerId);
      state.setRegister(ELECTION_NAMES.seats(rid), result.runoffSeats, op.signerId);
      state.setRegister(ELECTION_NAMES.finalized(id), 2, op.signerId); // awaiting runoff
      return 0;
    }

    if (isRunoff) {
      const parentId = id.slice(0, -RUNOFF_SUFFIX.length);
      try { node.addORSet(ELECTION_NAMES.winners(parentId)); } catch (err) { console.warn('finalize resource init warning:', err); }
      for (const winner of result.winners) {
        state.setAdd(ELECTION_NAMES.winners(parentId), winner, winner);
      }
      state.setRegister(ELECTION_NAMES.finalized(parentId), 1, op.signerId);
    }
    state.setRegister(ELECTION_NAMES.finalized(id), 1, op.signerId);
    return 0;
  };
}

export function makeCastRunoffVoteHandler(
  config: { getTimeMs?: () => number } = {}
) {
  return (state: HandlerState, op: HandlerOperation): number => {
    const payload: CastRunoffVotePayload = JSON.parse(op.payload || '{}');
    const id = payload.electionId;
    if (!isNonEmptyString(id) || !isNonEmptyString(payload.candidate)) {
      return -1;
    }
    if (state.getRegister(ELECTION_NAMES.isRunoff(id)) !== 1) {
      return -1;
    }
    const nowMs = config.getTimeMs ? config.getTimeMs() : Date.now();
    const expiresAt = state.getRegister(ELECTION_NAMES.expires(id)) || 0;
    if (expiresAt <= 0 || nowMs > expiresAt) {
      return -1;
    }
    if (state.getRegister(ELECTION_NAMES.finalized(id)) === 1) {
      return -1;
    }
    if (!state.setContains(ELECTION_NAMES.candidates(id), payload.candidate)) {
      return -1;
    }

    // Quadratic cost from the voter's global $RES balance, mirrored per runoff.
    const balance = state.getRegister(RES_NAMES.balance(op.signerId)) || 0;
    const mirror = ELECTION_NAMES.mirrorSet(id);
    let used = 0;
    const maxVoteCheck = 100;
    for (let i = 1; i <= maxVoteCheck; i++) {
      const element = ELECTION_NAMES.mirrorElement(id, op.signerId, i);
      if (state.setContains(mirror, element)) {
        used = i;
      } else {
        break;
      }
    }
    const nextVote = used + 1;
    const cumulativeCost = (nextVote * (nextVote + 1) * (2 * nextVote + 1)) / 6;
    if (balance < cumulativeCost) {
      return -1;
    }
    state.setAdd(mirror, ELECTION_NAMES.mirrorElement(id, op.signerId, nextVote), `${op.signerId}:${nextVote}`);
    state.incrementPNCounter(ELECTION_NAMES.candVotes(id, payload.candidate), 1, op.signerId);
    return 0;
  };
}

export function makeRemoveMemberHandler() {
  return (state: HandlerState, op: HandlerOperation): number => {
    const payload: RemoveMemberPayload = JSON.parse(op.payload || '{}');
    if (!isNonEmptyString(payload.username)) {
      return -1;
    }
    if (!state.setContains(STATE_NAMES.members, payload.username)) {
      return -1;
    }
    state.setRemove(STATE_NAMES.members, payload.username);
    state.setRegister(RES_NAMES.balance(payload.username), 0, 'system');
    return 0;
  };
}

// Custodian op 'set_rct_alpha': update sparse per-dimension alpha weights
// (dimension index -> alpha in (0, 10]). Bumps the alpha-version register
// (previous + 1) and appends an explanation record to the round-agnostic
// alpha explanation ORSet, so a weight change is always explainable and
// reproducible from the log.
export function makeSetRctAlphaHandler(
  node: { addRegister(name: string, initial?: number): void; addORSet(name: string): void }
) {
  return (state: HandlerState, op: HandlerOperation): number => {
    const payload: SetRctAlphaPayload = JSON.parse(op.payload || '{}');
    if (
      payload.weights === null || typeof payload.weights !== 'object' || Array.isArray(payload.weights)
    ) {
      return -1;
    }
    const entries = Object.entries(payload.weights as Record<string, unknown>);
    if (
      entries.length === 0 ||
      !isNonEmptyString(payload.version) ||
      payload.version.length > 64
    ) {
      return -1;
    }
    for (const [key, value] of entries) {
      const dim = Number(key);
      // Canonical integer string keys only: '01', '1.5', '-1', '22' all fail.
      // Values are finite alphas in (0, 10].
      const ok =
        Number.isInteger(dim) && dim >= 0 && dim < DIMENSION_COUNT &&
        String(dim) === key &&
        typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= 10;
      if (!ok) {
        return -1;
      }
    }

    // Declare before write (real wasm: setRegister on an undeclared resource
    // throws resource_not_found). Declaring before reading the current alpha
    // version keeps the read well-defined on fresh replicas too.
    try { node.addRegister(CALIBRATIONS.alphaVersion(), 0); } catch (err) { /* ignore duplicate */ }
    for (const [key] of entries) {
      try { node.addRegister(CALIBRATIONS.alpha(Number(key)), 0); } catch (err) { /* ignore duplicate */ }
    }
    const newAlphaVersion = (state.getRegister(CALIBRATIONS.alphaVersion()) || 0) + 1;
    state.setRegister(CALIBRATIONS.alphaVersion(), newAlphaVersion, op.signerId);
    for (const [key, value] of entries) {
      state.setRegister(CALIBRATIONS.alpha(Number(key)), value as number, op.signerId);
    }

    // Explanation record (invariant: every decision emits an explanation
    // record). Element is the JSON record; the tag is deterministic and unique
    // per alpha version (CRABS OR-Sets dedupe by tag). The set is declared at
    // node init by the wiring task; the handler declares it defensively too.
    const explanation = {
      alphaVersion: newAlphaVersion,
      version: payload.version,
      weights: payload.weights,
    };
    try { node.addORSet(CALIBRATIONS.explanations()); } catch (err) { /* ignore duplicate / node-init declared */ }
    state.setAdd(CALIBRATIONS.explanations(), JSON.stringify(explanation), `alpha:${newAlphaVersion}`);
    return 0;
  };
}

// Custodian op 'set_calibration_version': register the active Justice
// calibration version. The payload version must be a known CALIBRATIONS
// entry ('v1' in phase 2); the register stores its numeric index.
export function makeSetCalibrationVersionHandler(
  node: { addRegister(name: string, initial?: number): void }
) {
  return (state: HandlerState, op: HandlerOperation): number => {
    const payload: SetCalibrationVersionPayload = JSON.parse(op.payload || '{}');
    const mapped = CALIBRATION_VERSION_NUMBERS.get(payload.version ?? '');
    if (mapped === undefined) {
      return -1; // unknown calibration version
    }
    // Declare before write (real wasm: setRegister on an undeclared resource
    // throws resource_not_found) — also on the first-ever registration.
    try { node.addRegister(CALIBRATIONS.calibrationVersion(), 0); } catch (err) { /* ignore duplicate */ }
    state.setRegister(CALIBRATIONS.calibrationVersion(), mapped, op.signerId);
    return 0;
  };
}

// Round-spine op 'audit_round' (C_10): a member audits the current round
// against the current Justice calibration. A fair audit opens the reckon
// step; an unfair audit records the round's debt and completes it with NO
// aggregation (the next round begins — retry semantics).
export function makeAuditRoundHandler(
  node: { addORSet(name: string): void; addRegister(name: string, initial?: number): void },
  config: { getTimeMs?: () => number } = {}
) {
  return (state: HandlerState, op: HandlerOperation): number => {
    const payload: AuditRoundPayload = JSON.parse(op.payload || '{}');
    if (
      typeof payload.fair !== 'boolean' ||
      !isNonEmptyString(payload.note) ||
      !isNonEmptyString(payload.calibrationVersion)
    ) {
      return -1;
    }
    if (!state.setContains(STATE_NAMES.members, op.signerId)) {
      return -1;
    }
    const round = state.getRegister(ROUND_NAMES.current()) || 1;
    // Undeclared stage register reads as 0 (STAGE_OPEN) — on the real wasm
    // Node getRegister('undeclared') returns 0, so a fresh round audits.
    if ((state.getRegister(ROUND_NAMES.stage(round)) ?? 0) !== STAGE_OPEN) {
      return -1;
    }
    // Justice calibration: the audit must cite the currently registered
    // calibration version ('v1' maps to 1; unset register falls back to 'v1').
    const registered = state.getRegister(CALIBRATIONS.calibrationVersion()) || 1;
    if (CALIBRATION_VERSION_NUMBERS.get(payload.calibrationVersion) !== registered) {
      return -1;
    }

    // Declare before write (real wasm: setRegister/setAdd on an undeclared
    // resource throws resource_not_found). Re-declare throws
    // duplicate_operation WITHOUT resetting, so lazy try-declare is safe.
    try { node.addORSet(ROUND_NAMES.explanations(round)); } catch (err) { /* ignore duplicate */ }
    try { node.addRegister(ROUND_NAMES.stage(round), 0); } catch (err) { /* ignore duplicate */ }
    const nowMs = config.getTimeMs ? config.getTimeMs() : Date.now();
    const record = {
      stepId: 'audit',
      fair: payload.fair,
      note: payload.note,
      calibrationVersion: payload.calibrationVersion,
      at: nowMs,
    };
    state.setAdd(ROUND_NAMES.explanations(round), JSON.stringify(record), `audit:${op.signerId}`);
    if (payload.fair) {
      state.setRegister(ROUND_NAMES.stage(round), STAGE_AUDITED, op.signerId);
    } else {
      // Debt path: record stands as the round's debt; round completes with
      // NO aggregation and the next round begins.
      state.setRegister(ROUND_NAMES.stage(round), STAGE_PUBLISHED, op.signerId);
      state.setRegister(ROUND_NAMES.current(), round + 1, op.signerId);
    }
    return 0;
  };
}

// Round-spine op 'reckon_round' (C_20): a member confirms the round's
// records are settled, closing the audited round for aggregation. Gated on
// a current Justice calibration existing in CRABS.
export function makeReckonRoundHandler(
  node: { addORSet(name: string): void; addRegister(name: string, initial?: number): void },
  config: { getTimeMs?: () => number } = {}
) {
  return (state: HandlerState, op: HandlerOperation): number => {
    const payload: ReckonRoundPayload = JSON.parse(op.payload || '{}');
    if (!isNonEmptyString(payload.note)) {
      return -1;
    }
    if (!state.setContains(STATE_NAMES.members, op.signerId)) {
      return -1;
    }
    const round = state.getRegister(ROUND_NAMES.current()) || 1;
    // ?? 0 mirrors real-wasm undeclared-register reads; 0 can never equal
    // STAGE_AUDITED, so a fresh round correctly rejects reckoning.
    if ((state.getRegister(ROUND_NAMES.stage(round)) ?? 0) !== STAGE_AUDITED) {
      return -1;
    }
    // Justice gate: a current calibration must exist in CRABS.
    if ((state.getRegister(CALIBRATIONS.calibrationVersion()) || 0) < 1) {
      return -1;
    }

    // Declare before write (real wasm throws resource_not_found on
    // undeclared writes; re-declare is a safe duplicate_operation).
    try { node.addORSet(ROUND_NAMES.explanations(round)); } catch (err) { /* ignore duplicate */ }
    try { node.addRegister(ROUND_NAMES.stage(round), 0); } catch (err) { /* ignore duplicate */ }
    const nowMs = config.getTimeMs ? config.getTimeMs() : Date.now();
    const record = { stepId: 'reckon', note: payload.note, at: nowMs };
    state.setAdd(ROUND_NAMES.explanations(round), JSON.stringify(record), `reckon:${op.signerId}`);
    state.setRegister(ROUND_NAMES.stage(round), STAGE_RECKONED, op.signerId);
    return 0;
  };
}
