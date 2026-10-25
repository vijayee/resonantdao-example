<template>
  <SectionHeading number="03" eyebrow="Contribute" title="Work, witnessed">
    <template #lede>Submit a contribution with evidence. Another member verifies it;
      accepted outcomes pay bounties and build your dimension tallies.</template>
  </SectionHeading>

  <Panel number="01" kicker="Submit contribution">
    <form id="contribution-form" class="proposal-form" @submit.prevent="onSubmitContribution">
      <fieldset id="contribution-step-1" class="wizard-fieldset">
        <legend>1 — What kind of contribution?</legend>
        <label class="wizard-choice"><input v-model="dim" type="radio" name="contrib-dim" :value="2" /> C_2 Recording — durable, findable record (base credit 3 $RES)</label>
        <label class="wizard-choice"><input v-model="dim" type="radio" name="contrib-dim" :value="1" /> C_1 Building — built something real (bounty 12 $RES)</label>
      </fieldset>
      <fieldset class="wizard-fieldset">
        <legend>2 — Describe it and attach evidence</legend>
        <input id="contribution-summary" v-model="summary" class="form-input" placeholder="What did you make or record?" required />
        <input id="contribution-evidence-text" v-model="evidenceText" class="form-input" placeholder="Evidence pointer (URL, commit, record id)…" />
        <input id="contribution-evidence-file" ref="fileInput" class="form-input" type="file" @change="onFileChange" />
      </fieldset>
      <fieldset class="wizard-fieldset">
        <legend>3 — Review</legend>
        <div id="contribution-review" class="muted">
          <p><strong>{{ summary || '(no summary yet)' }}</strong></p>
          <p>{{ reviewLine }}</p>
        </div>
      </fieldset>
      <div class="proposal-form__actions">
        <button class="button button--primary" type="submit" :disabled="ds.submitting">Submit contribution</button>
      </div>
    </form>
  </Panel>

  <section id="contributions-list" aria-live="polite">
    <p v-if="entries.length === 0" class="muted">No contributions yet.</p>
    <ContributionCard
      v-for="entry in entries"
      :key="entry.record.contributionId"
      :entry="entry"
      :active-flow-key="activeFlow"
      :drafts="cardDrafts"
      @start-flow="onFlowStart"
      @close-flow="onFlowClose"
    />
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { DIMENSIONS } from '@shared/contribution';
import { listDrafts, cleanStaleDrafts, WizardDraft } from '../../wizard/drafts';
import { useDaoStore } from '../../stores/dao';
import { useStatusStore } from '../../stores/status';
import SectionHeading from '../../design/components/SectionHeading.vue';
import Panel from '../../design/components/Panel.vue';
import ContributionCard from './ContributionCard.vue';

const ds = useDaoStore();
const status = useStatusStore();

const dim = ref<number>(2);
const summary = ref('');
const evidenceText = ref('');
const evidenceFile = ref<File | null>(null);
const fileInput = ref<HTMLInputElement | null>(null);

const entries = computed(() => {
  void ds.tick;
  return [...(ds.dao?.getContributions() ?? [])].reverse();
});

const activeFlow = ref<string | null>(null);          // `{flowId}/{contributionId}`

// Re-derives on tick AND on activeFlow changes: a Cancel deletes a draft in
// localStorage without touching the dao, so open/close must invalidate too.
const cardDrafts = computed(() => {
  void ds.tick;
  void activeFlow.value;
  const empty = new Map<string, WizardDraft>();
  if (!ds.username) return { verify: empty, settle: empty, appeal: empty };
  return {
    verify: listDrafts(localStorage, ds.username, 'verify'),
    settle: listDrafts(localStorage, ds.username, 'settle'),
    appeal: listDrafts(localStorage, ds.username, 'appeal'),
  };
});

// Drop drafts whose contribution left the actionable set — NEVER against an
// empty mirror (replay may not have finished at mount; an empty sweep would
// nuke every draft).
function sweepStaleDrafts() {
  void ds.tick;
  if (!ds.username || !ds.dao) return;
  const ids = new Set(ds.dao.getContributions().map((e) => e.record.contributionId));
  if (ids.size === 0) return;
  cleanStaleDrafts(localStorage, ds.username, 'verify', ids);
  cleanStaleDrafts(localStorage, ds.username, 'settle', ids);
  cleanStaleDrafts(localStorage, ds.username, 'appeal', ids);
}
onMounted(sweepStaleDrafts);

function onFlowStart(key: string) { activeFlow.value = key; }
function onFlowClose() {
  activeFlow.value = null;
  sweepStaleDrafts();
}

const reviewLine = computed(() => {
  const dims = Object.keys({ [dim.value]: 1 }).map((k) => `C_${k} ${DIMENSIONS[Number(k)].name}`).join(', ');
  return `${dims} — ${evidenceFile.value ? 'stored evidence (file)' : evidenceText.value ? `pointer: ${evidenceText.value}` : 'no evidence yet'}`;
});

function onFileChange(ev: Event) {
  evidenceFile.value = (ev.target as HTMLInputElement).files?.[0] ?? null;
}

async function onSubmitContribution() {
  if (!ds.dao || ds.submitting) return;
  if (!summary.value) {
    status.set('A summary is required.', 'error');
    return;
  }
  const ok = await ds.submitContribution(summary.value, dim.value, evidenceFile.value, evidenceText.value);
  if (ok) {
    summary.value = '';
    evidenceText.value = '';
    evidenceFile.value = null;
    if (fileInput.value) fileInput.value.value = '';
  }
}
</script>

<style scoped>
.wizard-fieldset {
  border: 1px solid var(--line); border-radius: var(--radius);
  padding: var(--space-3) var(--space-4); margin: 0;
  display: flex; flex-direction: column; gap: var(--space-2);
}
.wizard-fieldset legend { color: var(--muted); font-size: .8125rem; font-weight: 600; padding: 0 var(--space-1); }
.wizard-choice { display: flex; align-items: center; gap: var(--space-2); font-size: .9375rem; cursor: pointer; }
#contributions-list { display: flex; flex-direction: column; gap: var(--space-4); }
</style>
