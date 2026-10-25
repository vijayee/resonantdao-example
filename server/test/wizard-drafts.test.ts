import { loadDraft, saveDraft, clearDraft, listDrafts, cleanStaleDrafts, WizardDraft } from '../../client/src/wizard/drafts';

function fakeStorage(): { value: Record<string, string>; length: number; key(i: number): string | null; getItem(k: string): string | null; setItem(k: string, v: string): void; removeItem(k: string): void } {
  const value: Record<string, string> = {};
  return {
    value,
    get length() { return Object.keys(value).length; },
    key(i: number) { return Object.keys(value)[i] ?? null; },
    getItem: (k) => value[k] ?? null,
    setItem: (k, v) => { value[k] = v; },
    removeItem: (k) => { delete value[k]; },
  };
}

const draft = (stepIndex: number): WizardDraft => ({ answers: { decision: 'yes' }, stepIndex, savedAt: 1000 });

describe('wizard draft store', () => {
  it('persists per username/flow/target and reads back round-trip', () => {
    const store = fakeStorage();
    saveDraft(store, 'alice', 'verify', 'c-1', draft(1));
    expect(loadDraft(store, 'alice', 'verify', 'c-1')).toEqual(draft(1));
    expect(loadDraft(store, 'alice', 'verify', 'c-2')).toBeNull();
    expect(loadDraft(store, 'bob', 'verify', 'c-1')).toBeNull();
    expect(loadDraft(store, 'alice', 'settle', 'c-1')).toBeNull();
  });

  it('overwrites on re-save (latest step wins)', () => {
    const store = fakeStorage();
    saveDraft(store, 'alice', 'verify', 'c-1', draft(1));
    saveDraft(store, 'alice', 'verify', 'c-1', { answers: { decision: 'no' }, stepIndex: 2, savedAt: 2000 });
    expect(loadDraft(store, 'alice', 'verify', 'c-1')?.stepIndex).toBe(2);
  });

  it('clear deletes only that key', () => {
    const store = fakeStorage();
    saveDraft(store, 'alice', 'verify', 'c-1', draft(1));
    saveDraft(store, 'alice', 'verify', 'c-2', draft(1));
    clearDraft(store, 'alice', 'verify', 'c-1');
    expect(loadDraft(store, 'alice', 'verify', 'c-1')).toBeNull();
    expect(loadDraft(store, 'alice', 'verify', 'c-2')).not.toBeNull();
  });

  it('listDrafts returns target -> draft for one user+flow, ignoring other flows', () => {
    const store = fakeStorage();
    saveDraft(store, 'alice', 'verify', 'c-1', draft(1));
    saveDraft(store, 'alice', 'settle', 'c-2', draft(0));
    const drafts = listDrafts(store, 'alice', 'verify');
    expect(drafts.size).toBe(1);
    expect(drafts.get('c-1')).toEqual(draft(1));
  });

  it('cleanStaleDrafts removes drafts whose target is no longer actionable', () => {
    const store = fakeStorage();
    saveDraft(store, 'alice', 'verify', 'c-1', draft(1));
    saveDraft(store, 'alice', 'verify', 'c-2', draft(1));
    cleanStaleDrafts(store, 'alice', 'verify', new Set(['c-2']));
    expect(loadDraft(store, 'alice', 'verify', 'c-1')).toBeNull();
    expect(loadDraft(store, 'alice', 'verify', 'c-2')).not.toBeNull();
  });

  it('corrupt drafts are dropped, not thrown', () => {
    const store = fakeStorage();
    saveDraft(store, 'alice', 'verify', 'c-1', draft(1));
    store.value['wizard-draft/alice/verify/c-9'] = 'not-json{';
    expect(loadDraft(store, 'alice', 'verify', 'c-9')).toBeNull();
    expect(listDrafts(store, 'alice', 'verify').size).toBe(1);
  });
});
