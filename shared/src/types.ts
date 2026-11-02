import { EvidenceRef, HarmVerdict } from './contribution';
import { RoundEntry } from './round';

export const DAO_NAME = 'resonant-dao-example';

export interface PublicUser {
  username: string;
  publicKeyHex: string;
  registeredAt: number;
  keyVersion: number;
}

export interface EncryptedSnapshot {
  username: string;
  iv: string; // base64
  ciphertext: string; // base64
  updatedAt: number;
}

// Serialized CRABS operation stored in the server log and broadcast to peers.
export interface StoredOperation {
  index: number;
  bytes: string; // base64
}

export type ProposalType = 'direct' | 'quadratic';

export interface ProposalPayload {
  proposalId: string;
  title: string;
  description: string;
  proposalType: ProposalType;
  options: string[]; // 2-10 non-empty, unique options; binary = ['Yes','No']
  expiresAt: number; // epoch ms
  salientDims?: number[]; // question-declared salient dimensions (0..21, unique); absent = base-only
}

export interface VotePayload {
  proposalId: string;
  choice: number; // index into options (0-based)
}

export interface ExecutePayload {
  proposalId: string;
}

export interface AddMemberPayload {
  username: string;
  publicKeyHex: string;
}

export interface StartElectionPayload {
  electionId: string;
  candidates: string[];
  expiresAt: number; // epoch ms
}

export interface CastBallotPayload {
  electionId: string;
  picks: string[]; // 1-5 member usernames
}

export interface FinalizeElectionPayload {
  electionId: string;
  candidates: string[];
}

export interface CastRunoffVotePayload {
  electionId: string;
  candidate: string;
}

export interface RemoveMemberPayload {
  username: string;
}

export interface SyncRolesPayload {
  custodians: string[];
  roleVersions: Record<string, number>; // total custodian-role mutations per user
}

export interface ContributionPayload {
  contributionId: string;
  dims: Record<string, number>; // sparse P(a): dimension index -> match weight (0,1]
  summary: string;
  evidenceRef: EvidenceRef;
  schemaVersion: string;
  // Targeted verification (slice #4c): the submitter names exactly
  // schema-requirement.count verifiers. ABSENT (or the field missing) keeps
  // legacy untargeted behavior — any non-submitter member may verify.
  verifiers?: string[];
  // Recognition ties (slice #6a, C_19): set ONLY on C_19 claims.
  recognized?: string; // the member whose work is recognized (≠ the submitter)
  recordId?: string;   // the tied contribution (machine-checked accepted)
}

// Recognition claims (slice #6a, C_19): a ContributionPayload whose
// recognition ties are REQUIRED. The schema carries the same base fields —
// the submit/verify handlers validate the tie fields whenever the dims carry
// dimension 19; this type narrows them for claim builders and mirrors.
export interface RecognitionPayload extends ContributionPayload {
  recognized: string;
  recordId: string;
}

export interface VerifyContributionPayload {
  contributionId: string;
  submitter: string;
  stepId: string;
  dims: Record<string, number>;
  pass: boolean;
  reason: string;
  // Schema version the contribution was submitted under; the verify handler
  // defaults to SCHEMA_VERSION ('v2') when omitted, so legacy v1 records
  // verify under v1 rules only when the payload states 'v1' explicitly.
  schemaVersion?: string;
  // Client-attested usernames of verifiers on earlier completions of this
  // step (same PoC trust class as dims/submitter). The handler refuses the
  // signer when they appear in this list — the deterministic all-parties
  // distinct-actor rule CRABS cannot express handler-side on its own.
  priorVerifiers?: string[];
  harm?: HarmVerdict;      // this check's harm verdict (absent = none)
  priorHarm?: HarmVerdict; // client-attested verdict of the earlier check in this step (all-parties flows)
  // Recognition ties (slice #6a, C_19): re-carried on the verify payload for
  // C_19 claims — the machine cannot enumerate the claim's tie OR-set, so the
  // gate reads the recordId (the tied record must hold the machine's accepted
  // status) and the tally credit targets recognized. Absent on every other
  // dimension (same PoC trust class as dims/submitter).
  recognized?: string; // the member whose work the claim recognizes
  recordId?: string;   // the claim's tied contribution
}

export interface SettleContributionPayload {
  contributionId: string;
  submitter: string;
  reason: string;
  verifiers?: string[]; // client-attested verifiers whose checks this settlement upholds (same PoC trust class as dims/submitter)
}

export interface AppealVerdictPayload {
  contributionId: string;
  submitter: string; // must equal op.signerId (submitter-only)
  reason: string;
}

// Targeted verification (slice #4c): op 'reassign_verifiers'. The SUBMITTER
// adds replacement verifiers to the named set while verification still has
// open slots. The new names only — the existing set is grown, never rewritten.
export interface ReassignVerifiersPayload {
  contributionId: string;
  verifiers: string[]; // the NEW names only — added to the existing set
}

export interface SetRctAlphaPayload {
  weights: Record<string, number>; // sparse: dimension index -> alpha in (0, 10]
  version: string;                 // alpha version label, recorded in the explanation record
}

export interface SetCalibrationVersionPayload {
  version: string; // must be a known calibration version ('v1' in phase 2)
}

export interface AuditRoundPayload {
  fair: boolean;
  note: string;
  calibrationVersion: string; // must match the current registered calibration (numeric map)
}

export interface ReckonRoundPayload {
  note: string;
}

export interface CompleteRoundPayload {
  entries: RoundEntry[]; // the round's settled+accepted contributions (client-collected)
}

export type ClientMessage =
  | { kind: 'register'; username: string; publicKeyHex: string }
  | { kind: 'login'; username: string }
  | { kind: 'submit_op'; operationBytes: string }
  | { kind: 'get_log'; after: number }
  | { kind: 'get_snapshot'; username: string }
  | { kind: 'put_snapshot'; snapshot: EncryptedSnapshot }
  | { kind: 'put_content'; bytesBase64: string; mediaType: string }
  | { kind: 'get_content'; hash: string };

export type ServerMessage =
  | { kind: 'registered'; username: string; publicKeyHex: string; keyVersion: number; attributeMachine: string; members: PublicUser[]; snapshot?: EncryptedSnapshot }
  | { kind: 'login_ok'; username: string; members: PublicUser[] }
  | { kind: 'members'; users: PublicUser[] }
  | { kind: 'snapshot'; snapshot: EncryptedSnapshot | null }
  | { kind: 'log'; operations: StoredOperation[] }
  | { kind: 'op_accepted'; index: number }
  | { kind: 'op_rejected'; reason: string }
  | { kind: 'broadcast'; operation: StoredOperation }
  | { kind: 'content_stored'; hash: string }
  | { kind: 'content'; hash: string; mediaType: string; bytesBase64: string }
  | { kind: 'error'; message: string };
