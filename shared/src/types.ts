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

export interface TokenConfig {
  initialTokens: number;
  distributionRate: number; // tokens per distribution interval
  distributionIntervalMs: number;
  defaultExpiryMs: number;
}

export type ClientMessage =
  | { kind: 'register'; username: string; publicKeyHex: string }
  | { kind: 'login'; username: string }
  | { kind: 'submit_op'; operationBytes: string }
  | { kind: 'get_log'; after: number }
  | { kind: 'get_snapshot'; username: string }
  | { kind: 'put_snapshot'; snapshot: EncryptedSnapshot };

export type ServerMessage =
  | { kind: 'registered'; username: string; publicKeyHex: string; keyVersion: number; attributeMachine: string; members: PublicUser[]; snapshot?: EncryptedSnapshot }
  | { kind: 'login_ok'; username: string; members: PublicUser[] }
  | { kind: 'members'; users: PublicUser[] }
  | { kind: 'snapshot'; snapshot: EncryptedSnapshot | null }
  | { kind: 'log'; operations: StoredOperation[] }
  | { kind: 'op_accepted'; index: number }
  | { kind: 'op_rejected'; reason: string }
  | { kind: 'broadcast'; operation: StoredOperation }
  | { kind: 'error'; message: string };
