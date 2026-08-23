export const DAO_NAME = 'resonant-dao-example';
export const PROPOSAL_THRESHOLD = 2;

export interface PublicUser {
  username: string;
  publicKeyHex: string;
  registeredAt: number;
}

export interface EncryptedSnapshot {
  username: string;
  iv: string; // base64
  ciphertext: string; // base64
  updatedAt: number;
}

export interface ServerOperation {
  type: string;
  signerId: string;
  nodeId: string;
  payload: string | null;
  signature: string | null;
  lamportTime?: number;
  hlc?: string;
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
  | { kind: 'submit_op'; operation: ServerOperation }
  | { kind: 'get_log'; after: number }
  | { kind: 'get_snapshot'; username: string };

export type ServerMessage =
  | { kind: 'registered'; attributeMachine: string; snapshot?: EncryptedSnapshot }
  | { kind: 'snapshot'; snapshot: EncryptedSnapshot | null }
  | { kind: 'log'; operations: ServerOperation[] }
  | { kind: 'op_accepted'; operation: ServerOperation }
  | { kind: 'op_rejected'; reason: string }
  | { kind: 'broadcast'; operation: ServerOperation }
  | { kind: 'error'; message: string };
