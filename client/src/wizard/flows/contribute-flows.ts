import { HarmVerdict, schemaForDims } from '@shared/contribution';
import { RECIP_NAMES } from '@shared/policies';
import type { ContributionMirrorEntry } from '../../dao';
import { useDaoStore } from '../../stores/dao';
import type { FlowDefinition } from '../types';

// Flow factories close over the dao store + target entry; each returns a
// plain FlowDefinition the shell renders. Semantics are 1:1 with the removed
// prompts — the option VALUES below are the historical tokens
// ('yes' / 'yes-harm' / 'voided' / 'no') the store's payload mapping once
// parsed from free text.
export function verifyFlow(entry: ContributionMirrorEntry): FlowDefinition {
  const ds = useDaoStore();
  return {
    id: 'verify',
    title: `Verify — "${entry.record.summary}"`,
    steps: [
      {
        kind: 'choice', id: 'decision', title: 'Your verdict',
        options: [
          { value: 'yes', label: 'Uphold', desc: 'the work checks out — full payment path' },
          { value: 'yes-harm', label: 'Uphold, harm reduced', desc: 'checks out but harm found — payment scales down per the settlement scale' },
          { value: 'voided', label: 'Void', desc: 'accepted, but the outcome does not pay' },
          { value: 'no', label: 'Reject', desc: 'record this contribution as not verifiable' },
        ],
      },
      { kind: 'text', id: 'reason', title: 'Written reason', placeholder: 'What did you check? (recorded permanently)' },
      { kind: 'review' },
    ],
    reviewSummary: (a) => [
      `Verdict: ${a.decision}`,
      `Reason: ${(a.reason ?? '').trim()}`,
    ],
    submit: async (a) => {
      const ok = await ds.verifyContribution(entry, {
        pass: a.decision !== 'no',
        harm: (a.decision === 'yes-harm' ? 'reduced' : a.decision === 'voided' ? 'voided' : 'none') as HarmVerdict,
        reason: (a.reason ?? '').trim(),
      });
      if (!ok) throw new Error('The verification did not record — check the message below the page.');
    },
  };
}

export function settleFlow(entry: ContributionMirrorEntry): FlowDefinition {
  const ds = useDaoStore();
  return {
    id: 'settle',
    title: `Settle — "${entry.record.summary}"`,
    steps: [
      { kind: 'text', id: 'note', title: 'Settlement note', placeholder: 'Recorded permanently' },
      { kind: 'review' },
    ],
    reviewSummary: (a) => [`Note: ${(a.note ?? '').trim()}`],
    submit: async (a) => {
      const ok = await ds.settleContribution(entry, { reason: (a.note ?? '').trim() });
      if (!ok) throw new Error('The settlement did not record — check the message below the page.');
    },
  };
}

export function appealFlow(entry: ContributionMirrorEntry): FlowDefinition {
  const ds = useDaoStore();
  return {
    id: 'appeal',
    title: `Appeal — "${entry.record.summary}"`,
    steps: [
      { kind: 'text', id: 'reason', title: 'Appeal reason', placeholder: 'Why is this verdict wrong? (recorded permanently)' },
      { kind: 'review' },
    ],
    reviewSummary: (a) => [`Reason: ${(a.reason ?? '').trim()}`],
    submit: async (a) => {
      const ok = await ds.appealContribution(entry, { reason: (a.reason ?? '').trim() });
      if (!ok) throw new Error('The appeal did not record — check the message below the page.');
    },
  };
}

// The new-contribution wizard: linear flow at /contribute/new. The submit
// success routes to the new lifecycle page — the page supplies onSubmitted
// (the store returns the id; routing is the page's business, never the
// factory's).
export function contributeNewFlow(onSubmitted: (contributionId: string) => void): FlowDefinition {
  const ds = useDaoStore();
  return {
    id: 'contribute-new',
    title: 'New contribution',
    steps: [
      {
        kind: 'choice', id: 'dim', title: 'What kind of contribution?',
        options: [
          { value: '2', label: 'C_2 Recording', desc: 'a durable, findable record — base credit 3 $RES' },
          { value: '1', label: 'C_1 Building', desc: 'built something real — bounty 12 $RES' },
        ],
      },
      {
        kind: 'members', id: 'verifiers', title: 'Who verifies this?',
        // Screened at pick: non-self members the projection says may verify.
        // Reciprocity bars name their reason in the pick list's title attr.
        options: eligibleVerifierOptions(ds),
        count: (a) => schemaForDims({ [Number(a.dim ?? '2')]: 1 }).steps.find((s) => s.op === 'verify_contribution')!.requirement.count,
      },
      { kind: 'text', id: 'summary', title: 'Describe it', placeholder: 'What did you make or record?' },
      { kind: 'evidence', id: 'evidence', title: 'Evidence', pointerPlaceholder: 'URL, commit, record id…' },
      { kind: 'review' },
    ],
    reviewSummary: (a, files) => [
      `Type: ${a.dim}`,
      `Summary: ${(a.summary ?? '').trim()}`,
      `Verifiers: ${(a.verifiers ?? '').split(',').filter(Boolean).join(', ')}`,
      files?.['evidence'] ? 'Evidence: stored file' : a.evidence ? `Pointer: ${a.evidence}` : 'No evidence yet',
    ],
    submit: async (a, files) => {
      const named = (a.verifiers ?? '').split(',').filter(Boolean);
      const id = await ds.submitContribution((a.summary ?? '').trim(), Number(a.dim), files?.['evidence'] ?? null, (a.evidence ?? '').trim(), named);
      if (!id) throw new Error('The contribution did not record — check the message below the page.');
      onSubmitted(id);
    },
  };
}

// Screened eligible-verifier options — shared by the submit picker above and
// the reassign flow (ContributionPage). Non-self members only; the
// reciprocity projection bars both halves of the mutual loop (m already
// verified this submitter, or the submitter already verified m — the verify
// handler rejects either pair on arrival, so the picker never offers them).
export function eligibleVerifierOptions(ds: ReturnType<typeof useDaoStore>): string[] {
  void ds.tick; // reactivity anchor: re-screen when the projection changes
  const d = ds.dao;
  const me = ds.username;
  if (!d || !me) return [];
  return ds.members
    .filter((m) => m && m !== me)
    .filter((m) => !(d.node.setContains(RECIP_NAMES.verifiedBy(m), me) || d.node.setContains(RECIP_NAMES.verifiedBy(me), m)))
    .sort();
}
