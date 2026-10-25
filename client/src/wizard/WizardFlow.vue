<template>
  <div :class="['wizard-flow', `wizard-flow--${flow.id}`]" :data-flow-id="flow.id" role="form" :aria-label="flow.title">
    <div class="wizard-flow__head">
      <span class="eyebrow">{{ flow.title }}</span>
      <button class="button button--secondary button--small wizard-flow__cancel" type="button" :disabled="ds.submitting" @click="cancel">Cancel</button>
    </div>

    <div class="wizard-flow__rail" aria-hidden="true">
      <span
        v-for="(s, i) in flow.steps"
        :key="i"
        :class="['wizard-flow__dot', i < stepIndex ? 'wizard-flow__dot--done' : i === stepIndex ? 'wizard-flow__dot--current' : 'wizard-flow__dot--todo']"
      >{{ stepTitle(s) }}</span>
    </div>

    <div class="wizard-flow__body">
      <fieldset v-if="current.kind === 'choice'" class="wizard-fieldset" :id="`wizard-${flow.id}-${current.id}`">
        <legend>{{ current.title }}</legend>
        <label v-for="opt in current.options" :key="opt.value" class="wizard-choice">
          <input type="radio" :class="`wizard-option wizard-option--${current.id}`" :name="`wizard-${flow.id}-${current.id}`" :value="opt.value" v-model="answers[currentStepId]" />
          <span>{{ opt.label }}<span v-if="opt.desc" class="muted"> — {{ opt.desc }}</span></span>
        </label>
      </fieldset>

      <div v-else-if="current.kind === 'text'" class="form-group">
        <textarea
          :class="['form-input', `wizard-field wizard-field--${current.id}`]"
          :id="`wizard-${flow.id}-${current.id}`"
          v-model="answers[currentStepId]"
          :placeholder="current.placeholder"
          :aria-label="current.title"
        />
      </div>

      <div v-else>
        <ul id="wizard-review" class="muted">
          <li v-for="line in flow.reviewSummary(committedAnswers)" :key="line">{{ line }}</li>
        </ul>
        <p v-if="error" class="wizard-flow__error" role="alert">{{ error }}</p>
      </div>
    </div>

    <div class="wizard-flow__actions proposal-form__actions">
      <button v-if="stepIndex > 0" class="button button--secondary button--small wizard-back" type="button" :disabled="ds.submitting" @click="back">← Back</button>
      <button v-if="current.kind !== 'review'" class="button button--primary button--small wizard-next" type="button" :disabled="!stepValid" @click="next">Next →</button>
      <button v-else class="button button--primary wizard-submit" type="button" :disabled="ds.submitting" @click="submitNow">Confirm &amp; submit</button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';
import { FlowAnswers, FlowDefinition, stepTitle, validateStep } from './types';
import { loadDraft, saveDraft, clearDraft } from './drafts';
import { useDaoStore } from '../stores/dao';

const props = defineProps<{
  flow: FlowDefinition;
  targetId: string;                 // draft key part; '' for flows with none
  initialAnswers?: FlowAnswers;     // from a resumed draft
  initialStep?: number;
}>();
const emit = defineEmits<{ close: [] }>();

const ds = useDaoStore();

const stepIndex = ref(Math.max(0, Math.min(props.initialStep ?? 0, props.flow.steps.length - 1)));
const initial: FlowAnswers = props.initialAnswers ? { ...props.initialAnswers } : {};
const answers = ref<FlowAnswers>(initial);
const error = ref<string | null>(null);

// The review step summarizes COMMITTED answers only — the placeholder answer
// slot for the review step itself must not appear in the summary. The 'review'
// key is simply never written into an answer; the answers object holds one
// key per real step.
const current = computed(() => props.flow.steps[stepIndex.value]);
const currentStepId = computed(() => (current.value.kind === 'review' ? 'review' : current.value.id));
const committedAnswers = computed(() => {
  const { ['review']: _ignored, ...rest } = answers.value;
  return rest;
});
const stepValid = computed(() => validateStep(current.value, answers.value) === null);
const isReview = computed(() => current.value.kind === 'review');

function persist(): void {
  if (ds.username) {
    saveDraft(window.localStorage, ds.username, props.flow.id, props.targetId, {
      answers: { ...committedAnswers.value },
      stepIndex: stepIndex.value,
      savedAt: Date.now(),
    });
  }
}

function next(): void {
  if (validateStep(current.value, answers.value) !== null) return;
  stepIndex.value += 1;
  persist(); // from the first committed step onward the draft lives
}

function back(): void {
  error.value = null;
  if (stepIndex.value > 0) stepIndex.value -= 1;
  persist();
}

function cancel(): void {
  if (ds.username) clearDraft(window.localStorage, ds.username, props.flow.id, props.targetId);
  emit('close');
}

async function submitNow(): Promise<void> {
  error.value = null;
  try {
    await props.flow.submit(committedAnswers.value);
    if (ds.username) clearDraft(window.localStorage, ds.username, props.flow.id, props.targetId);
    emit('close');
  } catch (err) {
    // Keep the draft: the user can correct and resubmit.
    error.value = err instanceof Error ? err.message : String(err);
  }
}
</script>

<style scoped>
.wizard-flow {
  border: 1px solid var(--line); border-radius: var(--radius);
  padding: var(--space-4); background: var(--glass);
  display: flex; flex-direction: column; gap: var(--space-3);
}
.wizard-flow__head { display: flex; align-items: center; justify-content: space-between; gap: var(--space-3); }
.wizard-flow__rail { display: flex; gap: var(--space-2); flex-wrap: wrap; }
.wizard-flow__dot { font-family: var(--font-mono); font-size: .72rem; padding: .2rem var(--space-2); border-radius: 999px; border: 1px solid var(--line); color: var(--muted); }
.wizard-flow__dot--done { color: var(--jade); border-color: rgba(95, 208, 160, .5); }
.wizard-flow__dot--current { color: var(--jade); border-color: var(--jade); background: rgba(95, 208, 160, .1); }
.wizard-flow__dot--todo { opacity: .6; }
.wizard-flow__body textarea { min-height: 4.5rem; resize: vertical; }
.wizard-flow__error { color: var(--danger); font-size: .8125rem; margin: 0; }
.wizard-choice { display: flex; align-items: center; gap: var(--space-2); font-size: .9375rem; cursor: pointer; }
.wizard-fieldset { border: 1px solid var(--line); border-radius: var(--radius); padding: var(--space-3) var(--space-4); margin: 0; display: flex; flex-direction: column; gap: var(--space-2); }
.wizard-fieldset legend { color: var(--muted); font-size: .8125rem; font-weight: 600; padding: 0 var(--space-1); }
.wizard-flow__actions { margin-top: var(--space-2); }
</style>
