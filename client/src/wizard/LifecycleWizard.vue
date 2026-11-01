<template>
  <div class="lc-wizard" role="region" :aria-label="'Contribution flow — ' + model.summary">
    <div class="lc-wizard__head">
      <strong>{{ model.summary }}</strong>
      <!-- Outcome is only knowable when the registers resolved; under unknown
           schema we render a neutral 'unknown' pill instead of a verdict. -->
      <span v-if="!model.readOnly" :class="['lc-pill', `lc-pill--${model.appealed ? 'appealed' : model.outcome}`]">
        {{ model.appealed ? 'appealed' : model.outcome }}
      </span>
      <span v-else class="lc-pill lc-pill--unknown">unknown</span>
    </div>
    <div class="muted lc-wizard__meta">by {{ model.submitter }}</div>

    <p v-if="model.readOnly" id="lc-readonly" class="muted">
      This contribution's schema version isn't recognized — rendering read-only.
    </p>

    <div v-else class="lc-wizard__phases">
      <div
        v-for="(phase, i) in model.phases"
        :key="phase.stepId"
        :class="['lc-phase', `lc-phase--${phase.state}`]"
      >
        <div class="lc-phase__head">
          <span class="lc-phase__dot">{{ phase.state === 'complete' ? '✓' : phase.state === 'current' ? '●' : '○' }}</span>
          <span class="lc-phase__title">{{ i + 1 }}. {{ phase.title }}</span>
          <span v-if="phase.progress && phase.state === 'current'" class="lc-phase__progress mono">{{ phase.progress.done }}/{{ phase.progress.required }}</span>
          <span v-if="phase.state === 'complete' && phase.doneBy" class="muted lc-phase__done">— {{ phase.doneBy }}<template v-if="phase.doneAt">, {{ clock(phase.doneAt) }}</template></span>
        </div>
        <div v-if="phase.note" class="muted lc-phase__note">{{ phase.note }}</div>
        <div v-if="phase.state === 'current' && phase.mayAct && pageFlow" class="lc-phase__form">
          <WizardFlow
            :key="phaseKey"
            :flow="pageFlow"
            :target-id="model.contributionId"
            :initial-answers="resume?.answers"
            :initial-step="resume?.stepIndex"
            @close="emit('flow-close')"
          />
        </div>
        <div v-else-if="phase.state === 'current' && !phase.mayAct" class="muted lc-phase__wait">{{ phase.waitingOn }}</div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import WizardFlow from './WizardFlow.vue';
import type { WizardDraft } from './drafts';
import type { FlowDefinition } from './types';
import type { LifecycleModel } from './lifecycle';

const props = defineProps<{
  model: LifecycleModel;
  pageFlow: FlowDefinition | null;    // the current phase's form, attached by the page
  resume: WizardDraft | null;          // the page flow's draft (page reads it)
}>();
const emit = defineEmits<{ 'flow-close': [] }>();

// The embedded flow's key INCLUDES the phase id: a facts-driven phase change
// remounts cleanly (stale-initial insurance, slice #3 rule).
const phaseKey = computed(() => `${props.pageFlow?.id ?? 'none'}/${props.model.contributionId}`);

function clock(atMs: number): string {
  return new Date(atMs).toTimeString().slice(0, 5);
}
</script>

<style scoped>
.lc-wizard { border: 1px solid var(--line); border-radius: var(--radius); padding: var(--space-4); background: var(--glass); display: flex; flex-direction: column; gap: var(--space-2); }
.lc-wizard__head { display: flex; align-items: center; justify-content: space-between; gap: var(--space-3); }
.lc-pill { font-family: var(--font-mono); font-size: .75rem; font-weight: 700; text-transform: uppercase; letter-spacing: .03em; padding: .15rem var(--space-2); border-radius: 999px; }
.lc-pill--pending { color: var(--muted); border: 1px solid var(--line); }
.lc-pill--unknown { color: var(--muted); border: 1px solid var(--line); }
.lc-pill--accepted { color: var(--jade); border: 1px solid rgba(95, 208, 160, .5); }
.lc-pill--rejected { color: var(--danger); border: 1px solid rgba(226, 128, 126, .5); }
.lc-pill--appealed { color: var(--amber); border: 1px solid rgba(232, 168, 76, .5); }
.lc-wizard__phases { display: flex; flex-direction: column; gap: var(--space-2); }
.lc-phase { display: flex; flex-direction: column; gap: var(--space-1); border: 1px solid var(--line); border-radius: var(--radius); padding: var(--space-3); }
.lc-phase--locked { opacity: .6; }
.lc-phase--complete .lc-phase__dot { color: var(--jade); }
.lc-phase--current { border-color: var(--jade); }
.lc-phase__head { display: flex; align-items: baseline; gap: var(--space-2); }
.lc-phase__title { font-size: .9375rem; }
.lc-phase__progress { color: var(--jade); }
.lc-phase__wait { font-size: .8125rem; }
</style>
