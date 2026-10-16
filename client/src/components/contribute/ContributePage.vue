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
        <input id="contribution-evidence-file" class="form-input" type="file" @change="onFileChange" />
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
    <ContributionCard v-for="entry in entries" :key="entry.record.contributionId" :entry="entry" />
  </section>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';
import { DIMENSIONS, CONTENT_LIMITS, SCHEMA_VERSION, EvidenceRef } from '@shared/contribution';
import { useDaoStore, serverClient } from '../../stores/dao';
import { useStatusStore } from '../../stores/status';
import SectionHeading from '../../design/components/SectionHeading.vue';
import Panel from '../../design/components/Panel.vue';
import ContributionCard from './ContributionCard.vue';

const ds = useDaoStore();
const status = useStatusStore();

const dim = ref<number>(2);
const summary = ref('');
const evidenceText = ref('');
let evidenceFile: File | null = null;

const entries = computed(() => {
  void ds.tick;
  return [...(ds.dao?.getContributions() ?? [])].reverse();
});

const reviewLine = computed(() => {
  const dims = Object.keys({ [dim.value]: 1 }).map((k) => `C_${k} ${DIMENSIONS[Number(k)].name}`).join(', ');
  return `${dims} — ${evidenceFile ? 'stored evidence (file)' : evidenceText.value ? `pointer: ${evidenceText.value}` : 'no evidence yet'}`;
});

function onFileChange(ev: Event) {
  evidenceFile = (ev.target as HTMLInputElement).files?.[0] ?? null;
}

async function onSubmitContribution() {
  if (!ds.dao || ds.submitting) return;
  if (!summary.value) {
    status.set('A summary is required.', 'error');
    return;
  }
  let evidenceRef: EvidenceRef;
  if (evidenceFile) {
    const bytes = new Uint8Array(await evidenceFile.arrayBuffer());
    if (bytes.length > CONTENT_LIMITS.maxObjectBytes) {
      status.set(`Evidence exceeds ${CONTENT_LIMITS.maxObjectBytes / (1024 * 1024)}MB — split it up.`, 'error');
      return;
    }
    const mediaType = evidenceFile.type || 'application/octet-stream';
    const hash = await serverClient.putContent(bytes, mediaType);
    evidenceRef = { hash, uri: `content://${hash}`, mediaType, size: bytes.length };
  } else if (evidenceText.value) {
    const bytes = new TextEncoder().encode(evidenceText.value);
    evidenceRef = { hash: await sha256Hex(bytes), uri: evidenceText.value, mediaType: 'text/uri-list', size: bytes.length };
  } else {
    status.set('Attach evidence or give a pointer — pay follows proven outcomes.', 'error');
    return;
  }

  await ds.submitContribution({
    contributionId: crypto.randomUUID(),
    dims: { [dim.value]: 1 },
    summary: summary.value,
    evidenceRef,
    schemaVersion: SCHEMA_VERSION,
  });
  if (status.kind === 'success') {
    summary.value = '';
    evidenceText.value = '';
    evidenceFile = null;
  }
}

// Uniform sha-256 for both evidence paths: stored files and text pointers.
async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as unknown as ArrayBuffer);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
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
#contributions-list { display: flex; flex-direction: column; gap: var(--space-4); margin-top: var(--space-8); }
</style>