<template>
  <div class="contribution-card" :data-contribution-id="entry.record.contributionId">
    <div class="contribution-card__header">
      <strong>{{ entry.record.summary }}</strong>
      <span :class="['contribution-pill', `contribution-pill--${appealed ? 'appealed' : model.outcome}`]">
        {{ appealed ? 'appealed' : model.outcome }}
      </span>
    </div>

    <div class="contribution-stepper">
      <span
        v-for="(step, i) in model.steps"
        :key="step.stepId"
        :class="['contribution-step', `contribution-step--${step.state}`]"
      >{{ step.state === 'current'
        ? `${i + 1}. ${step.title} (${step.progress.done}/${step.progress.required})`
        : `${i + 1}. ${step.title}` }}</span>
    </div>

    <div class="muted">by {{ entry.submitter }}</div>
    <div class="muted">{{ evidenceLabel }}</div>

    <button
      v-if="evidenceRef.uri.startsWith('content://') && !evidenceImgUrl && !evidenceDlUrl"
      type="button"
      class="button button--secondary contribution-card__evidence-load"
      :disabled="ds.submitting"
      @click="loadEvidence"
    >Load evidence</button>
    <img v-if="evidenceImgUrl" class="contribution-card__evidence-img" alt="contribution evidence" :src="evidenceImgUrl" />
    <a v-else-if="evidenceDlUrl" class="contribution-card__evidence-dl" :href="evidenceDlUrl" :download="`evidence-${entry.record.contributionId.slice(0, 8)}`">Download evidence ({{ evidenceRef.mediaType }})</a>

    <div v-if="model.outcome === 'rejected' && entry.verdictReason" class="contribution-card__verdict">
      Rejected by {{ entry.verifiedBy }}: {{ entry.verdictReason }}
    </div>

    <div v-if="appealed" class="muted">appealed — awaiting re-verification</div>
    <button
      v-else-if="model.outcome === 'rejected' && entry.submitter === ds.username && !contributionAppealed"
      type="button"
      class="button button--secondary appeal-contribution"
      :disabled="ds.submitting"
      @click="ds.appealContribution(entry)"
    >Appeal…</button>

    <div v-if="harmReceipt" :class="['contribution-card__harm', `contribution-card__harm--${entry.harm}`]">{{ harmReceipt }}</div>

    <div v-if="actions.length > 0" class="contribution-card__actions">
      <button
        v-for="action in actions"
        :key="action.label"
        type="button"
        :class="['button', `button--${action.variant}`, action.cls]"
        :title="action.title"
        :disabled="ds.submitting"
        @click="action.run()"
      >{{ action.label }}</button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, onBeforeUnmount } from 'vue';
import { harmFactorFor, paymentFor, schemaForDims } from '@shared/contribution';
import { ContributionFacts, wizardModel } from '@shared/wizard';
import { serverClient, useDaoStore } from '../../stores/dao';
import type { ContributionMirrorEntry } from '../../dao';

const props = defineProps<{ entry: ContributionMirrorEntry }>();

const ds = useDaoStore();

const schema = computed(() => schemaForDims(props.entry.record.dims));
const statusOf = computed(() => {
  void ds.tick;
  return ds.dao?.getContributionStatus(props.entry.record.contributionId) ?? 'unknown';
});
// NOTE the unconditional tick read: the old form short-circuited before ever
// reading statusOf (appealed is false while pending), leaving the computed
// with no tick dep — the register flipped to the appealed state but the pill
// never re-rendered. The legacy page re-rendered the whole list every second,
// which is why this only surfaced on the Vue port.
const appealed = computed(() => {
  void ds.tick;
  return (ds.dao?.getContributionAppealed(props.entry.record.contributionId) ?? false) && statusOf.value === 'pending';
});
const contributionAppealed = computed(() => {
  void ds.tick;
  return ds.dao?.getContributionAppealed(props.entry.record.contributionId) ?? false;
});

const model = computed(() => {
  void ds.tick;
  const d = ds.dao!;
  const status = statusOf.value;
  const facts: ContributionFacts = {
    status: status === 'unknown' ? -1 : status === 'accepted' ? 1 : status === 'rejected' ? 2 : 0,
    stepIndex: d.getContributionStepIndex(props.entry.record.contributionId),
    done: Object.fromEntries(schema.value.steps.map((s) => [
      s.stepId, d.getContributionStepDone(props.entry.record.contributionId, s.stepId),
    ])),
    submitter: props.entry.submitter,
  };
  return wizardModel(schema.value, facts, ds.username, (ds.custodians ?? []).includes(ds.username));
});

const evidenceRef = computed(() => props.entry.record.evidenceRef);

const harmReceipt = computed(() => {
  void ds.tick;
  const entry = props.entry;
  if (statusOf.value !== 'accepted' || !entry.harm || entry.harm === 'none') return null;
  if (entry.harm === 'voided') return 'accepted — outcome voided (harm)';
  const base = Object.entries(entry.record.dims)
    .reduce((sum, [dimKey, match]) => sum + paymentFor(Number(dimKey), match), 0);
  const factor = harmFactorFor(entry.harm);
  const label = Object.keys(entry.record.dims).includes('1') ? 'bounty' : 'credit';
  const fmt = (n: number) => String(Number(n.toFixed(6)));
  return `accepted — ${label} ${fmt(base)} → ${fmt(base * factor)} (harm reduced)`;
});

// Enablement mirrors buildContributionCard: the current step's roles gate who
// may act — with no extra 'appealed' gate, so a fresh verifier (and, after a
// re-verification, the submitter) can still act on an appealed card exactly
// as the legacy DOM did.
type CardAction = { label: string; variant: string; cls?: string; title?: string; run: () => void };
const actions = computed<CardAction[]>(() => {
  void ds.tick;
  const currentStep = model.value.steps[model.value.currentStepIndex];
  if (!currentStep) return [];
  const out: CardAction[] = [];
  for (const actor of ['submitter', 'verifier', 'custodian', 'member'] as const) {
    const role = currentStep.roles[actor];
    if (!role || !role.mayAct) continue;
    if (role.op === 'verify_contribution' && actor === 'verifier') {
      const stats = ds.dao?.getVerifierStats(ds.username) ?? { total: 0, upheld: 0 };
      out.push({
        label: props.entry.verifiedBy ? 'Verify (2nd)' : 'Verify…',
        variant: 'secondary',
        cls: 'verify-contribution',
        title: `Your checks: ${stats.total} (${stats.upheld} upheld)`,
        run: () => void ds.verifyContribution(props.entry),
      });
    }
    if (role.op === 'settle_contribution' && actor === 'submitter') {
      out.push({ label: 'Settle…', variant: 'primary', cls: 'settle-contribution', run: () => void ds.settleContribution(props.entry) });
    }
  }
  return out;
});

// Click-triggered fetch of stored evidence bytes; errors degrade to a note.
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
    if (content.mediaType.startsWith('image/')) {
      evidenceImgUrl.value = url;
    } else {
      evidenceDlUrl.value = url;
    }
  } catch (err) {
    void err;
    evidenceFailed.value = true;
  }
}
</script>

<style scoped>
.contribution-card {
  border: 1px solid var(--line); border-radius: var(--radius); padding: var(--space-4);
  background: var(--glass); -webkit-backdrop-filter: blur(8px); backdrop-filter: blur(8px);
  display: flex; flex-direction: column; gap: var(--space-2);
}
.contribution-card__header { display: flex; align-items: center; justify-content: space-between; gap: var(--space-3); }
.contribution-pill { font-family: var(--font-mono); font-size: .75rem; font-weight: 700; text-transform: uppercase; letter-spacing: .03em; padding: .15rem var(--space-2); border-radius: 999px; flex-shrink: 0; }
.contribution-pill--pending { color: var(--muted); border: 1px solid var(--line); }
.contribution-pill--accepted { color: var(--jade); border: 1px solid rgba(95, 208, 160, .5); }
.contribution-pill--rejected { color: var(--danger); border: 1px solid rgba(226, 128, 126, .5); }
.contribution-pill--appealed { color: var(--amber); border: 1px solid rgba(232, 168, 76, .5); }
.contribution-stepper { display: flex; flex-wrap: wrap; gap: var(--space-2); }
.contribution-step { font-family: var(--font-mono); font-size: .72rem; font-weight: 500; padding: .2rem var(--space-2); border-radius: 999px; border: 1px solid var(--line); color: var(--muted); }
.contribution-step--complete { color: var(--jade); border-color: rgba(95, 208, 160, .5); }
.contribution-step--current { color: var(--jade); border-color: var(--jade); background: rgba(95, 208, 160, .1); }
.contribution-step--locked { opacity: .6; border-style: dashed; }
.contribution-card__verdict { color: var(--danger); font-size: .8125rem; }
.contribution-card__harm { color: var(--amber); font-size: .8125rem; }
.contribution-card__actions { display: flex; gap: var(--space-2); }
.contribution-card__evidence-img { max-width: 100%; border-radius: var(--radius); }
.contribution-card__evidence-dl { color: var(--jade); font-family: var(--font-mono); font-size: .8125rem; }
</style>
