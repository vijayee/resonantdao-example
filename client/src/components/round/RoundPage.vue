<template>
  <SectionHeading number="04" eyebrow="Round" title="The settlement cycle">
    <template #lede>Each round gathers accepted contributions; any member then closes it —
      audit, reckon, publish — and the aggregation pays the round's settled work. The wizard
      below always shows the current stage.</template>
  </SectionHeading>

  <Panel number="01" kicker="Settlement wizard">
    <div id="round-stepper" class="round-stepper">
      <span class="round-label">Round {{ current }} — stage: {{ stageNames[stage] ?? 'unknown' }}</span>
      <span v-for="(name, i) in stageNames" :key="name" :class="['round-step', i < stage ? 'round-step--complete' : i === stage ? 'round-step--current' : 'round-step--locked']">{{ name }}</span>
    </div>
    <div id="round-explanations" class="muted">{{ explanations }}</div>

    <div v-if="stageFlow" class="round-wizard">
      <WizardFlow
        :key="wizardKey"
        :flow="stageFlow"
        :target-id="String(current)"
        :initial-answers="stageResume?.answers"
        :initial-step="stageResume?.stepIndex"
        @close="onWizardClose"
      />
    </div>
    <div v-else id="round-published" class="muted">The round is published — the next round is gathering fresh work.</div>
  </Panel>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';
import WizardFlow from '../../wizard/WizardFlow.vue';
import { loadDraft, WizardDraft } from '../../wizard/drafts';
import { stageFlowFor } from '../../wizard/flows/round-flows';
import { useDaoStore } from '../../stores/dao';
import SectionHeading from '../../design/components/SectionHeading.vue';
import Panel from '../../design/components/Panel.vue';

const ds = useDaoStore();
const stageNames = ['Open', 'Audited', 'Reckoned', 'Published'];

const current = computed(() => { void ds.tick; return ds.dao?.getCurrentRound() ?? 1; });
const stage = computed(() => { void ds.tick; return ds.dao?.getRoundStage(current.value) ?? 0; });
const explanations = computed(() => {
  void ds.tick;
  const records = ds.dao?.getRoundRecords(current.value) ?? [];
  return records.map((r) => `${String(r.stepId)}: ${String(r.note ?? '')}`).join(' | ');
});

// No open/close state: the wizard IS the page. The key bakes stage + round +
// an epoch so a Cancel re-mounts from the flow's first step (the shell has
// already cleared the draft); stage/round changes remount naturally.
const wizardEpoch = ref(0);
const stageFlow = computed(() => { void ds.tick; return stageFlowFor(stage.value, current.value); });
// The epoch is read HERE, not just in the key: cancel() clears the draft
// before the close event arrives, and localStorage is not reactive. Without
// the epoch dependency this computed would serve its cached (stale) draft to
// the remounted wizard for up to one demo-clock second — Cancel would
// re-show the answers it just discarded.
const stageResume = computed(() => {
  void wizardEpoch.value;
  if (!ds.username || !stageFlow.value) return null;
  return loadDraft(localStorage, ds.username, stageFlow.value.id, String(current.value));
});
const wizardKey = computed(() => `${stage.value}-${current.value}-${wizardEpoch.value}`);
function onWizardClose() { wizardEpoch.value += 1; }
</script>

<style scoped>
.round-stepper { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-2); }
.round-label { font-family: var(--font-mono); font-size: .85rem; font-weight: 500; color: var(--ink); }
.round-step { font-family: var(--font-mono); font-size: .72rem; font-weight: 500; padding: .2rem var(--space-2); border-radius: 999px; border: 1px solid var(--line); color: var(--muted); }
.round-step--complete { color: var(--jade); border-color: rgba(95, 208, 160, .5); }
.round-step--current { color: var(--jade); border-color: var(--jade); background: rgba(95, 208, 160, .1); }
.round-step--locked { opacity: .6; border-style: dashed; }
.round-stepper + #round-explanations { margin-top: var(--space-3); }
.round-wizard { margin-top: var(--space-3); }
#round-published { margin-top: var(--space-3); }
</style>
