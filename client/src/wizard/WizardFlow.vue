<template>
  <div :class="['wizard-flow', `wizard-flow--${flow.id}`]" :data-flow-id="flow.id" role="form" :aria-label="flow.title">
    <div class="wizard-flow__head">
      <span class="eyebrow">{{ flow.title }}</span>
      <button class="button button--secondary button--small wizard-flow__cancel" type="button" :disabled="ds.submitting" @click="cancel">Cancel</button>
    </div>

    <div class="wizard-flow__rail" aria-hidden="true">
      <span
        v-for="(s, i) in allSteps"
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

      <div v-else-if="current.kind === 'evidence'" class="form-group">
        <span class="form-label">{{ current.title }} <span class="muted">— optional</span></span>
        <input
          :class="['form-input', `wizard-evidence-pointer wizard-evidence-pointer--${current.id}`]"
          :aria-label="current.title"
          :value="answers[currentStepId] ?? ''"
          :placeholder="current.pointerPlaceholder ?? 'Evidence pointer (URL, commit, record id)…'"
          @input="answers[currentStepId] = ($event.target as HTMLInputElement).value"
        />
        <input
          :class="['form-input', `wizard-evidence-file wizard-evidence-file--${current.id}`]"
          type="file"
          :aria-label="current.title + ' — file'"
          @change="onEvidenceFile(current.id, $event)"
        />
      </div>

      <!-- Slice #4c: the members picker. Options are the flow's screened
           eligible list; an empty list is the visible dead-end (the step
           stays invalid, so Next blocks until the factory offers names). -->
      <fieldset v-else-if="current.kind === 'members'" class="wizard-fieldset" :id="`wizard-${flow.id}-${current.id}`">
        <legend>{{ current.title }}</legend>
        <p v-if="current.options.length === 0" class="muted">No eligible verifiers right now.</p>
        <label v-for="opt in current.options" :key="opt" class="wizard-choice">
          <input
            type="checkbox"
            :class="`wizard-member wizard-member--${current.id}`"
            :value="opt"
            :checked="(answers[currentStepId] ?? '').split(',').includes(opt)"
            @change="toggleMember(current.id, opt, $event)"
          />
          <span>{{ opt }}</span>
        </label>
      </fieldset>

      <div v-else>
        <ul id="wizard-review" class="muted">
          <li v-for="line in flow.reviewSummary(committedAnswers, filesForReview)" :key="line">{{ line }}</li>
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
import { FlowAnswers, FlowDefinition, flowSteps, stepTitle, validateStep } from './types';
import { saveDraft, clearDraft } from './drafts';
import { useDaoStore } from '../stores/dao';

const props = defineProps<{
  flow: FlowDefinition;
  targetId: string;                 // draft key part; '' for flows with none
  initialAnswers?: FlowAnswers;     // from a resumed draft
  initialStep?: number;
}>();
const emit = defineEmits<{ close: [] }>();

const ds = useDaoStore();

// Evidence files ride OUTSIDE answers: Files never serialize into drafts.
const files = ref<Record<string, File | null>>({});

function onEvidenceFile(stepId: string, ev: Event): void {
  files.value = { ...files.value, [stepId]: (ev.target as HTMLInputElement).files?.[0] ?? null };
}

// The members answer serializes as a comma-joined string (answers stay
// strings): each checkbox toggles one name in the joined list.
function toggleMember(stepId: string, name: string, ev: Event): void {
  const picked = new Set((answers.value[stepId] ?? '').split(',').filter(Boolean));
  const on = (ev.target as HTMLInputElement).checked;
  if (on) picked.add(name); else picked.delete(name);
  answers.value = { ...answers.value, [stepId]: [...picked].join(',') };
}

// Review summary sees the file NAMES (for 'file attached' lines) but never
// receives the File objects.
const filesForReview = computed(() =>
  Object.fromEntries(Object.entries(files.value).map(([k, f]) => [k, f ? f.name : null])));

// The REAL File objects (unwrapped from ref for the submit handoff).
const pickedFiles = computed(() => files.value);

const initial: FlowAnswers = props.initialAnswers ? { ...props.initialAnswers } : {};
const answers = ref<FlowAnswers>(initial);

// The step list resolves from the ANSWERS (slice #6a): a fn-form flow varies
// its steps per chosen type, so the rail, the current step, and the draft's
// index all read THIS one resolved list — re-resolved as answers change.
const allSteps = computed(() => flowSteps(props.flow, answers.value));

// The draft's step index clamps against the RESOLVED list's length (a resumed
// dynamic flow may list fewer steps than the draft recorded).
const stepIndex = ref(Math.max(0, Math.min(props.initialStep ?? 0, allSteps.value.length - 1)));
const error = ref<string | null>(null);

// The review step summarizes COMMITTED answers only — the placeholder answer
// slot for the review step itself must not appear in the summary. The 'review'
// key is simply never written into an answer; the answers object holds one
// key per real step.
const current = computed(() => allSteps.value[stepIndex.value]);
const currentStepId = computed(() => (current.value.kind === 'review' ? 'review' : current.value.id));
const committedAnswers = computed(() => {
  const { ['review']: _ignored, ...rest } = answers.value;
  return rest;
});
const stepValid = computed(() => validateStep(current.value, answers.value) === null);

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
    await props.flow.submit(committedAnswers.value, pickedFiles.value);
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
