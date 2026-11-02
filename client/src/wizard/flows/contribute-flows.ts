import { DIMENSIONS, HarmVerdict, SCHEMAS, schemaForDims } from '@shared/contribution';
import { RECIP_NAMES } from '@shared/policies';
import type { ContributionMirrorEntry } from '../../dao';
import { useDaoStore } from '../../stores/dao';
import type { FlowAnswers, FlowDefinition } from '../types';

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

// ---- The derived picker (slice #6a) ----

// The picker derives from the machine's own vocabulary: submittable =
// implemented ∧ schema-wired (C_19 enters the form without a hand-edit). The
// descs are client copy (the domain carries names/classes; the selling lines
// live here).
const DIM_DESCS: Record<number, string> = {
  1: 'built something real — bounty 12 $RES',
  2: 'a durable, findable record — base credit 3 $RES',
  19: 'recognize someone’s proven work — credits their C_19 tally (the tie is machine-checked)',
};

export function dimensionOptions(): Array<{ value: string; label: string; desc: string }> {
  const ds = useDaoStore();
  void ds.tick; // reactivity anchor: re-derive when the machine's vocabulary changes
  return [...DIMENSIONS.filter((d) => d.implemented && SCHEMAS.has(d.index))]
    .map((d) => ({ value: String(d.index), label: `${d.code} ${d.name} — ${d.cls}`, desc: DIM_DESCS[d.index] ?? '' }));
}

// The recognition claim's recognized-member screen (slice #6a): members minus
// self — recognition is the submitter's act ABOUT someone else's proven work;
// the machine's only barring is self-recognition (S-B), so the picker mirrors
// exactly that.
export function recognizableMemberOptions(ds: ReturnType<typeof useDaoStore>): string[] {
  void ds.tick;
  return ds.members.filter((m) => m && m !== ds.username).sort();
}

// The record-tie screen (slice #6a): the viewer's OWN ACCEPTED contributions
// (via the dao mirror) — the tie must be a contribution whose status register
// is the machine's accepted, and the recognizer's own accepted records are the
// pick list. Values are the contribution ids (LOW-cosmetic: the picker prints
// the raw ids; the review line shows the mapped summary).
export function ownAcceptedRecordOptions(ds: ReturnType<typeof useDaoStore>): string[] {
  void ds.tick;
  const d = ds.dao;
  const me = ds.username;
  if (!d || !me) return [];
  return d.getContributions()
    .filter((e) => e.submitter === me && d.getContributionStatus(e.record.contributionId) === 'accepted')
    .map((e) => e.record.contributionId);
}

// The new-contribution wizard: linear flow at /contribute/new. The step list
// is a function of the answers (slice #6a): C_19's recognition claim gains the
// two tie picks; C_1/C_2 walk the plain form. The submit success routes to the
// new lifecycle page — the page supplies onSubmitted (the store returns the
// id; routing is the page's business, never the factory's).
export function contributeNewFlow(onSubmitted: (contributionId: string) => void): FlowDefinition {
  const ds = useDaoStore();
  return {
    id: 'contribute-new',
    title: 'New contribution',
    steps: (a) => [
      {
        kind: 'choice', id: 'dim', title: 'What kind of contribution?',
        options: dimensionOptions(),
      },
      ...(Number(a.dim) === 19 ? [
        {
          kind: 'members' as const, id: 'recognized', title: 'Whose work is recognized?',
          options: recognizableMemberOptions(ds),
          count: 1,
        },
        {
          kind: 'members' as const, id: 'record', title: 'Tie it to a proven record',
          options: ownAcceptedRecordOptions(ds),
          count: 1,
        },
      ] : []),
      {
        kind: 'members', id: 'verifiers', title: 'Who verifies this?',
        // Screened at pick: non-self members the projection says may verify.
        // Reciprocity bars name their reason in the pick list's title attr.
        options: eligibleVerifierOptions(ds),
        count: () => schemaForDims({ [Number(a.dim ?? '2')]: 1 }).steps.find((s) => s.op === 'verify_contribution')!.requirement.count,
      },
      { kind: 'text', id: 'summary', title: 'Describe it', placeholder: 'What did you make or record?' },
      { kind: 'evidence', id: 'evidence', title: 'Evidence', pointerPlaceholder: 'URL, commit, record id…' },
      { kind: 'review' },
    ],
    reviewSummary: (a, files) => [
      `Type: ${a.dim}`,
      ...(Number(a.dim) === 19 ? tiesReviewLines(ds, a) : []),
      `Summary: ${(a.summary ?? '').trim()}`,
      `Verifiers: ${(a.verifiers ?? '').split(',').filter(Boolean).join(', ')}`,
      files?.['evidence'] ? 'Evidence: stored file' : a.evidence ? `Pointer: ${a.evidence}` : 'No evidence yet',
    ],
    submit: async (a, files) => {
      const named = (a.verifiers ?? '').split(',').filter(Boolean);
      // The recognition claim's ties ride (slice #6a) ONLY on a C_19 claim —
      // the 5-arg call (byte-identical payload) for every other type.
      const ties = Number(a.dim) === 19
        ? { recognized: (a.recognized ?? '').trim(), recordId: (a.record ?? '').trim() }
        : undefined;
      const id = await ds.submitContribution((a.summary ?? '').trim(), Number(a.dim), files?.['evidence'] ?? null, (a.evidence ?? '').trim(), named, ties);
      if (!id) throw new Error('The contribution did not record — check the message below the page.');
      onSubmitted(id);
    },
  };
}

// The review's tie lines (slice #6a): the recognized member by name; the tied
// record mapped to its summary through the mirror (the raw id rides along so
// the review stays honest to the submitted payload; unmapped → the raw id).
// LOW-cosmetic note: the PICK itself shows the raw id — the review is where
// the summary shows.
function tiesReviewLines(ds: ReturnType<typeof useDaoStore>, a: FlowAnswers): string[] {
  void ds.tick;
  const lines: string[] = [];
  if (a.recognized) lines.push(`Recognized: ${a.recognized}`);
  if (a.record) {
    const tied = (ds.dao?.getContributions() ?? []).find((e) => e.record.contributionId === a.record);
    lines.push(`Tied record: ${tied ? `"${tied.record.summary}" (${a.record})` : a.record}`);
  }
  return lines;
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
