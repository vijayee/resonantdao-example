// localStorage-backed wizard drafts, keyed per username/flow/target. A draft
// is written only once a host shell commits a step (its first save is the
// "first relevant step is saved" event) and lives until the flow completes
// or the user cancels. Reasons are permanently-on-chain material after
// submit — before that, draft content is local-only by design.
export interface WizardDraft {
  answers: Record<string, string>;
  stepIndex: number;
  savedAt: number;
}

export interface DraftStore {
  readonly length: number;
  key(index: number): string | null;
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

const PREFIX = 'wizard-draft';

export function draftKey(username: string, flowId: string, targetId: string): string {
  return `${PREFIX}/${username}/${flowId}/${targetId}`;
}

export function loadDraft(store: DraftStore, username: string, flowId: string, targetId: string): WizardDraft | null {
  const raw = store.getItem(draftKey(username, flowId, targetId));
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<WizardDraft>;
    if (typeof parsed !== 'object' || parsed === null) return null;
    if (typeof parsed.stepIndex !== 'number' || typeof parsed.answers !== 'object' || parsed.answers === null) return null;
    return { answers: parsed.answers as Record<string, string>, stepIndex: parsed.stepIndex, savedAt: typeof parsed.savedAt === 'number' ? parsed.savedAt : 0 };
  } catch {
    return null;
  }
}

export function saveDraft(store: DraftStore, username: string, flowId: string, targetId: string, draft: WizardDraft): void {
  store.setItem(draftKey(username, flowId, targetId), JSON.stringify(draft));
}

export function clearDraft(store: DraftStore, username: string, flowId: string, targetId: string): void {
  store.removeItem(draftKey(username, flowId, targetId));
}

export function listDrafts(store: DraftStore, username: string, flowId: string): Map<string, WizardDraft> {
  const out = new Map<string, WizardDraft>();
  for (let i = 0; i < store.length; i++) {
    const key = store.key(i);
    if (key === null) continue;
    const [prefix, user, flowIdPart, ...targetParts] = key.split('/');
    if (prefix !== PREFIX || user !== username || flowIdPart !== flowId || targetParts.length === 0) continue;
    const targetId = targetParts.join('/');
    const draft = loadDraft(store, username, flowId, targetId);
    if (draft !== null) out.set(targetId, draft);
  }
  return out;
}

// Drop drafts whose target no longer exists / is terminal. Callers pass the
// set of target ids their page can currently act on.
export function cleanStaleDrafts(store: DraftStore, username: string, flowId: string, actionableTargetIds: Iterable<string>): void {
  const keep = new Set(actionableTargetIds);
  for (const targetId of listDrafts(store, username, flowId).keys()) {
    if (!keep.has(targetId)) clearDraft(store, username, flowId, targetId);
  }
}