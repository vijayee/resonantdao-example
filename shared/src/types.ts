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

export interface ProposalPayload {
  proposalId: string;
  title: string;
  description: string;
}

export interface VotePayload {
  proposalId: string;
  vote: 'yes' | 'no';
}

export interface ExecutePayload {
  proposalId: string;
}

export interface AddMemberPayload {
  username: string;
  publicKeyHex: string;
}

export type ClientMessage =
  | { kind: 'register'; username: string; publicKeyHex: string }
  | { kind: 'login'; username: string }
  | { kind: 'submit_op'; operationBytes: string }
  | { kind: 'get_log'; after: number }
  | { kind: 'get_snapshot'; username: string };

export type ServerMessage =
  | { kind: 'registered'; username: string; publicKeyHex: string; keyVersion: number; attributeMachine: string; snapshot?: EncryptedSnapshot }
  | { kind: 'login_ok'; username: string }
  | { kind: 'snapshot'; snapshot: EncryptedSnapshot | null }
  | { kind: 'log'; operations: StoredOperation[] }
  | { kind: 'op_accepted'; index: number }
  | { kind: 'op_rejected'; reason: string }
  | { kind: 'broadcast'; operation: StoredOperation }
  | { kind: 'error'; message: string };
