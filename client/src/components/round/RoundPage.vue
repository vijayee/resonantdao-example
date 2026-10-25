<template>
  <SectionHeading number="04" eyebrow="Round" title="The settlement spine">
    <template #lede>Close the cycle: audit (C_10), reckon (C_20), complete and publish (C_21). Any member may drive the spine; weights gate the aggregation.</template>
  </SectionHeading>

  <Panel number="01" kicker="Round spine">
    <div id="round-stepper" class="round-stepper">
      <span class="round-label">Round {{ current }} — stage: {{ stageNames[stage] ?? 'unknown' }}</span>
      <span v-for="(name, i) in stageNames" :key="name" :class="['round-step', i < stage ? 'round-step--complete' : i === stage ? 'round-step--current' : 'round-step--locked']">{{ name }}</span>
    </div>
    <div id="round-explanations" class="muted">{{ explanations }}</div>
    <div class="proposal-form__actions">
      <button id="audit-round-btn" :class="['button', 'button--secondary', { hidden: stage !== STAGE_OPEN }]" type="button" :disabled="ds.submitting" @click="openFlow('audit')">Audit round…</button>
      <button id="reckon-round-btn" :class="['button', 'button--secondary', { hidden: stage !== STAGE_AUDITED }]" type="button" :disabled="ds.submitting" @click="openFlow('reckon')">Reckon round…</button>
      <button v-if="!activeFlow" id="complete-round-btn" :class="['button', 'button--primary', { hidden: stage !== STAGE_RECKONED }]" type="button" :disabled="ds.submitting" @click="ds.completeRound">Complete round &amp; publish</button>
    </div>

    <div v-if="activeFlow === 'audit'" class="round-wizard">
      <WizardFlow :key="activeFlow" :flow="auditFlow(current)" :target-id="String(current)" :initial-answers="auditResume?.answers" :initial-step="auditResume?.stepIndex" @close="onFlowClose" />
    </div>
    <div v-else-if="activeFlow === 'reckon'" class="round-wizard">
      <WizardFlow :key="activeFlow" :flow="reckonFlow(current)" :target-id="String(current)" :initial-answers="reckonResume?.answers" :initial-step="reckonResume?.stepIndex" @close="onFlowClose" />
    </div>
  </Panel>

  <Panel number="02" kicker="Weights (custodian)">
    <form class="proposal-form" :class="{ hidden: !ds.isCustodian }" @submit.prevent>
      <div class="form-group"><input id="alpha-c1" v-model="alpha.c1" class="form-input" type="text" placeholder="alpha C_1 (e.g. 2)" /></div>
      <div class="form-group"><input id="alpha-c2" v-model="alpha.c2" class="form-input" type="text" placeholder="alpha C_2 (e.g. 0.5)" /></div>
      <div class="form-group"><input id="alpha-version" v-model="alpha.version" class="form-input" type="text" placeholder="weights version label" /></div>
      <div class="proposal-form__actions">
        <button id="set-alpha-btn" class="button button--secondary" type="button" :disabled="ds.submitting" @click="onSetAlpha">Set weights</button>
        <button id="set-calibration-btn" class="button button--secondary" type="button" :disabled="ds.submitting" @click="ds.setCalibrationVersion">Set calibration v1</button>
      </div>
    </form>
    <p v-if="!ds.isCustodian" class="muted">Custodian-only controls.</p>
  </Panel>
</template>

<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue';
import { STAGE_AUDITED, STAGE_OPEN, STAGE_RECKONED } from '@shared/round';
import WizardFlow from '../../wizard/WizardFlow.vue';
import { loadDraft, WizardDraft } from '../../wizard/drafts';
import { auditFlow, reckonFlow } from '../../wizard/flows/round-flows';
import { useDaoStore } from '../../stores/dao';
import { useStatusStore } from '../../stores/status';
import SectionHeading from '../../design/components/SectionHeading.vue';
import Panel from '../../design/components/Panel.vue';

const ds = useDaoStore();
const status = useStatusStore();
const stageNames = ['Open', 'Audited', 'Reckoned', 'Published'];

const current = computed(() => { void ds.tick; return ds.dao?.getCurrentRound() ?? 1; });
const stage = computed(() => { void ds.tick; return ds.dao?.getRoundStage(current.value) ?? 0; });

const activeFlow = ref<'audit' | 'reckon' | null>(null);
const auditResume = ref<WizardDraft | null>(null);
const reckonResume = ref<WizardDraft | null>(null);

function openFlow(which: 'audit' | 'reckon') {
  if (!ds.username) return;
  const draft = loadDraft(localStorage, ds.username, which, String(current.value));
  if (which === 'audit') auditResume.value = draft; else reckonResume.value = draft;
  activeFlow.value = which;
}
function onFlowClose() {
  activeFlow.value = null;
  auditResume.value = null;
  reckonResume.value = null;
}

// When the stage changes away from a flow's stage (e.g. STAGE_OPEN →
// STAGE_AUDITED after a successful audit) the flow must close.
watch(stage, () => {
  const stageOk = (f: 'audit' | 'reckon') => (f === 'audit' ? stage.value === STAGE_OPEN : stage.value === STAGE_AUDITED);
  if (activeFlow.value && !stageOk(activeFlow.value)) onFlowClose();
});
const explanations = computed(() => {
  void ds.tick;
  const records = ds.dao?.getRoundRecords(current.value) ?? [];
  return records.map((r) => `${String(r.stepId)}: ${String(r.note ?? '')}`).join(' | ');
});

const alpha = reactive({ c1: '', c2: '', version: '' });

async function onSetAlpha() {
  const raw: Record<string, number> = {};
  const c1 = parseFloat(alpha.c1);
  const c2 = parseFloat(alpha.c2);
  if (Number.isFinite(c1) && c1 > 0) raw['1'] = c1;
  if (Number.isFinite(c2) && c2 > 0) raw['2'] = c2;
  const version = alpha.version;
  if (Object.keys(raw).length === 0 || !version.trim()) {
    status.set('At least one weight and a version label are required.', 'error');
    return;
  }
  await ds.setRctAlpha(raw, version.trim());
  if (status.kind === 'success') alpha.c1 = alpha.c2 = alpha.version = '';
}
</script>

<style scoped>
.round-stepper { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-2); }
.round-label { font-family: var(--font-mono); font-size: .85rem; font-weight: 500; color: var(--ink); }
.round-step { font-family: var(--font-mono); font-size: .72rem; font-weight: 500; padding: .2rem var(--space-2); border-radius: 999px; border: 1px solid var(--line); color: var(--muted); }
.round-step--complete { color: var(--jade); border-color: rgba(95, 208, 160, .5); }
.round-step--current { color: var(--jade); border-color: var(--jade); background: rgba(95, 208, 160, .1); }
.round-step--locked { opacity: .6; border-style: dashed; }
.round-stepper + #round-explanations { margin-top: var(--space-3); }
</style>
