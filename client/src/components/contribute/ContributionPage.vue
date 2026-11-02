<template>
  <div v-if="denial" class="lc-denial muted">{{ denial }}</div>
  <template v-else-if="entry">
    <SectionHeading number="03" eyebrow="Contribution" title="The flow">
      <template #lede>One flow for this contribution — submission, verification, settlement.
        Whoever's turn it is acts here.</template>
    </SectionHeading>

    <Panel number="01" kicker="Lifecycle">
      <LifecycleWizard
        :model="model"
        :page-flow="pageFlow"
        :resume="resume"
        @flow-close="onFlowClose"
      />
      <div v-if="harmReceipt" class="lc-harm">{{ harmReceipt }}</div>
      <div v-if="!model.appealed && model.outcome === 'rejected' && entry.submitter === ds.username && !appealUsed" class="lc-appeal">
        <WizardFlow
          :key="'appeal'"
          :flow="appealFlow!"
          :target-id="entry.record.contributionId"
          :initial-answers="appealResume?.answers"
          :initial-step="appealResume?.stepIndex"
          @close="onAppealClose"
        />
      </div>
      <div v-if="reassignAvailable" class="lc-reassign">
        <WizardFlow
          :key="'reassign'"
          :flow="reassignFlow!"
          :target-id="entry.record.contributionId"
          :initial-answers="reassignResume?.answers"
          :initial-step="reassignResume?.stepIndex"
          @close="onReassignClose"
        />
      </div>
    </Panel>

    <Panel number="02" kicker="Evidence">
      <button
        v-if="evidenceRef.uri.startsWith('content://') && !evidenceImgUrl && !evidenceDlUrl"
        type="button"
        class="button button--secondary evidence-load"
        :disabled="ds.submitting"
        @click="loadEvidence"
      >Load evidence</button>
      <img v-if="evidenceImgUrl" alt="contribution evidence" :src="evidenceImgUrl" class="evidence-img" />
      <a v-else-if="evidenceDlUrl" class="evidence-dl" :href="evidenceDlUrl" :download="`evidence-${entry.record.contributionId.slice(0, 8)}`">Download evidence ({{ evidenceRef.mediaType }})</a>
      <span v-else class="muted">{{ evidenceLabel }}</span>
    </Panel>
  </template>
  <div v-else class="lc-denial muted">Unknown contribution.</div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue';
import { useRoute } from 'vue-router';
import { harmFactorFor, paymentFor } from '@shared/contribution';
import { useDaoStore, contributionFacts, serverClient } from '../../stores/dao';
import { appealFlow as appealFlowFactory, eligibleVerifierOptions, settleFlow, verifyFlow } from '../../wizard/flows/contribute-flows';
import { lifecycleModel, isParticipant } from '../../wizard/lifecycle';
import { loadDraft } from '../../wizard/drafts';
import type { FlowAnswers, FlowDefinition } from '../../wizard/types';
import type { ContributionMirrorEntry } from '../../dao';
import LifecycleWizard from '../../wizard/LifecycleWizard.vue';
import WizardFlow from '../../wizard/WizardFlow.vue';
import SectionHeading from '../../design/components/SectionHeading.vue';
import Panel from '../../design/components/Panel.vue';

const ds = useDaoStore();
const route = useRoute();
// Live params: vue-router reuses the component record across same-route
// navigation, so a setup-time read would go stale; the computed re-derives.
const contributionId = computed(() => String(route.params.contributionId ?? ''));

const located = computed(() => {
  void ds.tick;
  const d = ds.dao;
  return d ? d.getContributions().find((e) => e.record.contributionId === contributionId.value) : undefined;
});

const composed = computed(() => {
  void ds.tick;
  const entry = located.value;
  if (!entry || !ds.dao || !ds.username) return null;
  const { schema, facts } = contributionFacts(ds.dao, entry, ds.members);
  const model = lifecycleModel(schema, facts, entry, ds.username, (ds.custodians ?? []).includes(ds.username), ds.feedEvents());
  // Attach the CURRENT phase's form (page-side duty; never in the pure model).
  const current = model.phases.find((p) => p.state === 'current' && p.mayAct);
  const FACTORIES: Record<string, (e: ContributionMirrorEntry) => FlowDefinition> = {
    verify: verifyFlow, settle: settleFlow,
  };
  return {
    entry,
    model,
    pageFlow: current ? (FACTORIES[current.stepId]?.(entry) ?? null) : null,
    resume: current ? loadDraft(localStorage, ds.username, current.stepId, entry.record.contributionId) : null,
  };
});

const entry = computed(() => composed.value?.entry ?? located.value);
const model = computed(() => composed.value!.model);
const pageFlow = computed(() => composed.value!.pageFlow);
const resume = computed(() => composed.value!.resume);

const appealFlow = computed(() => (entry.value ? appealFlowFactory(entry.value) : null));
// The raw once-guard register: an appeal survives re-review, so after an
// appealed contribution is RE-rejected the handler bars a second appeal —
// the retired card hid its button here, and this page must not render a
// form every submit of which fails. (model.appealed alone can't carry this:
// it is scoped to the pending window by contributionFacts.)
const appealUsed = computed(() => {
  void ds.tick;
  return ds.dao?.getContributionAppealed(entry.value?.record.contributionId ?? '') ?? false;
});
const appealResume = computed(() => (ds.username && entry.value ? loadDraft(localStorage, ds.username, 'appeal', entry.value.record.contributionId) : null));
function onAppealClose() {
  // The shell already cleared/closed the draft; the tick re-derives the
  // appealed pill. (The listener exists so the close event is heard.)
}
function onFlowClose() {
  // The flow's phase advances (or fails legibly); tick re-derives everything.
}

// ---- Reassign (slice #4c): name ADDITIONAL verifiers while verify slots remain.

function onReassignClose() {
  // The shell already cleared the draft; the tick re-derives the available
  // gate. (The listener exists so the close event is heard.)
}
const reassignResume = computed(() => (ds.username && entry.value ? loadDraft(localStorage, ds.username, 'reassign', entry.value.record.contributionId) : null));

// Submitter-only, verify incomplete (slots remain), targeted contribution
// (the named register is non-empty — an untargeted legacy flow never
// reassigns). The APPEAL window stays reassignable — the machine accepts
// status pending OR appealed here (the appeal rewinds the counters, so the
// slots are open again, and the named verifier is often now reciprocity-
// barred: exactly when the escape valve is needed).
const reassignAvailable = computed(() => {
  void ds.tick;
  const e = entry.value; const d = ds.dao;
  if (!e || !d || !ds.username) return false;
  if (e.submitter !== ds.username) return false;
  // getContributionStatus maps BOTH the pending and appealed registers to
  // 'pending' — the machine's legal reassign states are exactly this set.
  if (d.getContributionStatus(e.record.contributionId) !== 'pending') return false;
  const named = d.getDefinedVerifiers(e.record.contributionId, ds.members);
  if (named.length === 0) return false;
  const { schema, facts } = contributionFacts(d, e, ds.members);
  const verifyStep = schema.steps.find((s) => s.op === 'verify_contribution')!;
  return facts.done[verifyStep.stepId] < verifyStep.requirement.count;
});

// The members step's exact count: remaining verify slots (requirement minus
// done). 0 when the reads are not ready — the gate keeps the section closed.
function remainingVerifyCount(): number {
  void ds.tick;
  const e = entry.value; const d = ds.dao;
  if (!e || !d) return 0;
  const { schema, facts } = contributionFacts(d, e, ds.members);
  const verifyStep = schema.steps.find((s) => s.op === 'verify_contribution')!;
  return Math.max(0, verifyStep.requirement.count - (facts.done[verifyStep.stepId] ?? 0));
}

const reassignFlow = computed(() => {
  const e = entry.value; if (!e) return null;
  return {
    id: 'reassign', title: 'Name additional verifiers',
    steps: [
      { kind: 'members' as const, id: 'verifiers', title: 'Who else verifies?',
        options: eligibleVerifierOptions(ds), count: remainingVerifyCount() },
      { kind: 'review' as const },
    ],
    reviewSummary: (a: FlowAnswers) => [`Adding: ${(a.verifiers ?? '').split(',').filter(Boolean).join(', ')}`],
    submit: async (a: FlowAnswers) => {
      const ok = await ds.reassignVerifiers(e.record.contributionId, (a.verifiers ?? '').split(',').filter(Boolean));
      if (!ok) throw new Error('The reassignment did not record — check the message below the page.');
    },
  } as FlowDefinition;
});

// Participants-only (spec decision 4). The denial branch never mounts the
// wizard — replica bytes remain the honest caveat documented in the spec.
const denial = computed(() => {
  void ds.tick;
  const e = located.value;
  if (!ds.dao || !ds.username) return 'Loading…';
  if (!e) return 'Unknown contribution.';
  const { schema, facts } = contributionFacts(ds.dao, e, ds.members);
  return isParticipant(e, ds.username, (ds.custodians ?? []).includes(ds.username), schema, facts)
    ? null
    : "You're not part of this contribution.";
});

// Harm receipt (moved verbatim from the retired contribution card):
const harmReceipt = computed(() => {
  void ds.tick;
  const e = entry.value;
  if (!e || ds.dao?.getContributionStatus(e.record.contributionId) !== 'accepted' || !e.harm || e.harm === 'none') return null;
  if (e.harm === 'voided') return 'accepted — outcome voided (harm)';
  const base = Object.entries(e.record.dims).reduce((sum, [dimKey, match]) => sum + paymentFor(Number(dimKey), match), 0);
  const factor = harmFactorFor(e.harm);
  const label = Object.keys(e.record.dims).includes('1') ? 'bounty' : 'credit';
  const fmt = (n: number) => String(Number(n.toFixed(6)));
  return `accepted — ${label} ${fmt(base)} → ${fmt(base * factor)} (harm reduced)`;
});

// Evidence display (moved verbatim from the retired contribution card):
const evidenceRef = computed(() => entry.value?.record.evidenceRef ?? { hash: '', uri: '', mediaType: '', size: 0 });
const evidenceImgUrl = ref<string | null>(null);
const evidenceDlUrl = ref<string | null>(null);
const evidenceFailed = ref(false);
const evidenceLabel = computed(() => {
  if (evidenceFailed.value) return 'evidence unavailable';
  return evidenceRef.value.uri.startsWith('content://')
    ? `stored evidence (${(evidenceRef.value.size / 1024).toFixed(1)} KB, ${evidenceRef.value.mediaType})`
    : `pointer: ${evidenceRef.value.uri}`;
});
const ownedUrls: string[] = [];
onBeforeUnmount(() => { for (const url of ownedUrls) URL.revokeObjectURL(url); });

async function loadEvidence() {
  const r = evidenceRef.value;
  const hash = r.uri.slice('content://'.length);
  try {
    const content = await serverClient.getContent(hash);
    if (!content) throw new Error('evidence unavailable');
    const blob = new Blob([content.bytes as BlobPart], { type: content.mediaType });
    const url = URL.createObjectURL(blob);
    ownedUrls.push(url);
    if (content.mediaType.startsWith('image/')) evidenceImgUrl.value = url;
    else evidenceDlUrl.value = url;
  } catch (err) {
    void err;
    evidenceFailed.value = true;
  }
}
</script>

<style scoped>
.lc-denial { padding: var(--space-6); text-align: center; }
.lc-appeal { margin-top: var(--space-3); }
.lc-reassign { margin-top: var(--space-3); }
.lc-harm { color: var(--amber); font-size: .8125rem; }
.evidence-img { max-width: 100%; border-radius: var(--radius); }
.evidence-dl { color: var(--jade); font-family: var(--font-mono); font-size: .8125rem; }
</style>