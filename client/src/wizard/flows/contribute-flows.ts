import { DIMENSIONS, HarmVerdict, SCHEMAS, schemaForDims } from '@shared/contribution';
import { RECIP_NAMES } from '@shared/policies';
import type { ContributionMirrorEntry } from '../../dao';
import { useDaoStore } from '../../stores/dao';
import type { FlowAnswers, FlowDefinition } from '../types';
import { claimTieSteps } from './claim-steps';

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
// implemented ∧ schema-wired ∧ pickable (C_19 enters the form without a
// hand-edit; C_18 leaves it by rule — its verify rule is embedded in the
// claims it verifies). The descs are client copy (the domain carries
// names/classes; the selling lines live here).
const DIM_DESCS: Record<number, string> = {
  1: 'built something real — bounty 12 $RES',
  2: 'a durable, findable record — base credit 3 $RES',
  5: 'taught something real — credited on the student’s demonstrated competence',
  19: 'recognize someone’s proven work — credits their C_19 tally (the tie is machine-checked)',
};

export function dimensionOptions(): Array<{ value: string; label: string; desc: string }> {
  const ds = useDaoStore();
  void ds.tick; // reactivity anchor: re-derive when the machine's vocabulary changes
  return [...DIMENSIONS.filter((d) => d.implemented && SCHEMAS.has(d.index) && d.pickable)]
    .map((d) => ({ value: String(d.index), label: `${d.code} ${d.name} — ${d.cls}`, desc: DIM_DESCS[d.index] ?? '' }));
}

// The claim family's partner screen (slices #6a/#6e): members minus self —
// a recognition names someone else's proven work and a teaching claims
// competence in ANOTHER member; the machines' self-bars (S-B / S-5-B) are the
// only barrings, so the picker mirrors exactly that.
export function recognizableMemberOptions(ds: ReturnType<typeof useDaoStore>): string[] {
  void ds.tick;
  return ds.members.filter((m) => m && m !== ds.username).sort();
}

// The claim tie steps' mirror read (slices #6a/#6e): the store's known members,
// the viewer, and the machine-ACCEPTED contributions (id + submitter) both
// tie picks screen by — the tie must be a contribution whose status register
// is the machine's accepted, and the C_19/C_5 rules each further screen
// ownership inside claimTieSteps (the recognizer's own records / the chosen
// taught member's records). Values are the contribution ids (LOW-cosmetic:
// the picker prints the raw ids; the review line shows the mapped summary).
function claimTieWorld(ds: ReturnType<typeof useDaoStore>) {
  void ds.tick;
  const d = ds.dao;
  const me = ds.username;
  return {
    members: [...ds.members],
    username: me,
    acceptedContributions: d
      ? d.getContributions()
        .filter((e) => d.getContributionStatus(e.record.contributionId) === 'accepted')
        .map((e) => ({ id: e.record.contributionId, submitter: e.submitter }))
      : [],
  };
}

// The new-contribution wizard: linear flow at /contribute/new. The step list
// is a function of the answers (slices #6a/#6e): the claim-family types gain
// the two tie picks (C_19: recognized + own record; C_5: taught + the student's
// record — the options DYNAMIC per the taught answer); C_1/C_2 walk the plain
// form. The submit success routes to the new lifecycle page — the page
// supplies onSubmitted (the store returns the id; routing is the page's
// business, never the factory's).
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
      ...claimTieSteps(Number(a.dim), a, claimTieWorld(ds)),
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
      ...claimReviewLines(ds, a),
      `Summary: ${(a.summary ?? '').trim()}`,
      `Verifiers: ${(a.verifiers ?? '').split(',').filter(Boolean).join(', ')}`,
      files?.['evidence'] ? 'Evidence: stored file' : a.evidence ? `Pointer: ${a.evidence}` : 'No evidence yet',
    ],
    submit: async (a, files) => {
      const named = (a.verifiers ?? '').split(',').filter(Boolean);
      // The claim's ties ride (slices #6a/#6e) ONLY on a claim type —
      // the 5-arg call (byte-identical payload) for every other type.
      const dim = Number(a.dim);
      const ties = dim === 19
        ? { recognized: (a.recognized ?? '').trim(), recordId: (a.record ?? '').trim() }
        : dim === 5
          ? { taught: (a.taught ?? '').trim(), recordId: (a.record ?? '').trim() }
          : undefined;
      const id = await ds.submitContribution((a.summary ?? '').trim(), dim, files?.['evidence'] ?? null, (a.evidence ?? '').trim(), named, ties);
      if (!id) throw new Error('The contribution did not record — check the message below the page.');
      onSubmitted(id);
    },
  };
}

// The review's tie lines (slices #6a/#6e): the claim's partner by name (the
// recognized member / the taught member); the tied record mapped to its
// summary through the mirror (the raw id rides along so the review stays
// honest to the submitted payload; unmapped → the raw id). LOW-cosmetic note:
// the PICK itself shows the raw id — the review is where the summary shows.
function claimReviewLines(ds: ReturnType<typeof useDaoStore>, a: FlowAnswers): string[] {
  const dim = Number(a.dim);
  if (dim !== 19 && dim !== 5) return [];
  void ds.tick;
  const lines: string[] = [];
  if (a.recognized) lines.push(`Recognized: ${a.recognized}`);
  if (a.taught) lines.push(`Taught: ${a.taught}`);
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
