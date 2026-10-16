<template>
  <SectionHeading number="01" eyebrow="Proposals" title="Decide, together">
    <template #lede>Create a proposal and vote. Quadratic votes draw their spend balance
      from the question's salient dimensions × your verified tallies.</template>
  </SectionHeading>

  <Panel number="NN" kicker="New proposal">
    <form id="proposal-form" class="proposal-form" @submit.prevent="onCreateProposal">
      <div class="form-group">
        <label class="form-label" for="proposal-title">Title</label>
        <input id="proposal-title" v-model="form.title" class="form-input" type="text" placeholder="What do you want to propose?" required />
      </div>
      <div class="form-group">
        <label class="form-label" for="proposal-description">Description</label>
        <input id="proposal-description" v-model="form.description" class="form-input" type="text" placeholder="Optional details" />
      </div>
      <div class="form-group">
        <label class="form-label" for="proposal-type">Voting type</label>
        <select id="proposal-type" v-model="form.type" class="form-input">
          <option value="direct">Direct Vote (one vote per user)</option>
          <option value="quadratic">Quadratic Vote (token-weighted, multiple votes)</option>
        </select>
      </div>
      <div class="form-group">
        <label class="form-label" for="proposal-options">Options (comma-separated, optional)</label>
        <input id="proposal-options" v-model="form.optionsRaw" class="form-input" type="text" placeholder="e.g. Alpha, Beta, Gamma — leave empty for Yes/No" />
      </div>
      <fieldset class="wizard-fieldset">
        <legend>Salient dimensions for quadratic votes (empty = base membership only)</legend>
        <label v-for="dim in implementedDims" :key="dim.index" class="wizard-choice">
          <input type="checkbox" class="salient-dim" :value="dim.index" v-model="form.salient" /> {{ dim.code }} {{ dim.cls }}
        </label>
      </fieldset>
      <div class="proposal-form__actions">
        <button class="button button--primary" type="submit" :disabled="ds.submitting">Create proposal</button>
      </div>
    </form>
  </Panel>

  <Panel number="NN" kicker="Open proposals">
    <ul id="proposals" class="proposal-list">
      <li v-if="proposals.length === 0" class="empty-state">No proposals yet. Create the first one above.</li>
      <ProposalCard
        v-for="p in proposals"
        :key="p.proposalId"
        :proposal="p"
        :executed="executedMap[p.proposalId] ?? false"
        @vote="ds.vote"
        @execute="ds.execute"
      />
    </ul>
  </Panel>
</template>

<script setup lang="ts">
import { ref, computed } from 'vue';
import { DIMENSIONS } from '@shared/contribution';
import type { ProposalPayload } from '@shared/types';
import { useDaoStore } from '../../stores/dao';
import { useStatusStore } from '../../stores/status';
import SectionHeading from '../../design/components/SectionHeading.vue';
import Panel from '../../design/components/Panel.vue';
import ProposalCard from './ProposalCard.vue';

const ds = useDaoStore();
const status = useStatusStore();

const implementedDims = computed(() => DIMENSIONS.filter((d) => d.implemented));
const form = ref({
  title: '',
  description: '',
  type: 'direct' as 'direct' | 'quadratic',
  optionsRaw: '',
  salient: [] as number[],
});

const proposals = computed(() => {
  void ds.tick;
  return ds.dao?.getProposals() ?? [];
});
const executedMap = computed(() => {
  void ds.tick;
  const map: Record<string, boolean> = {};
  for (const p of proposals.value) {
    map[p.proposalId] = ds.dao?.isProposalExecuted(p.proposalId) ?? false;
  }
  return map;
});

async function onCreateProposal() {
  const title = form.value.title;
  if (!ds.dao || !title) return;
  const parsed = form.value.optionsRaw.split(',').map((s) => s.trim()).filter((s) => s.length > 0);
  let options: string[];
  if (parsed.length === 0) {
    options = ['Yes', 'No'];
  } else if (parsed.length >= 2 && parsed.length <= 10 && new Set(parsed).size === parsed.length) {
    options = parsed;
  } else {
    status.set('Options must be 2-10 unique, non-empty comma-separated values.', 'error');
    return;
  }
  const salientDims = form.value.salient.filter((dim) => Number.isInteger(dim));
  const payload: ProposalPayload = {
    proposalId: crypto.randomUUID(),
    title,
    description: form.value.description,
    proposalType: form.value.type === 'quadratic' ? 'quadratic' : 'direct',
    options,
    expiresAt: ds.dao.getNodeTimeMs() + 60 * 1000,
  };
  if (salientDims.length > 0) payload.salientDims = salientDims;
  await ds.createProposal(payload);
  if (status.kind === 'success') form.value = { title: '', description: '', type: 'direct', optionsRaw: '', salient: [] };
}
</script>

<style scoped>
.proposal-list { list-style: none; margin: var(--space-8) 0 0; padding: 0; display: flex; flex-direction: column; gap: var(--space-4); }
.wizard-fieldset {
  border: 1px solid var(--line); border-radius: var(--radius);
  padding: var(--space-3) var(--space-4); margin: 0;
  display: flex; flex-direction: column; gap: var(--space-2);
}
.wizard-fieldset legend { color: var(--muted); font-size: .8125rem; font-weight: 600; padding: 0 var(--space-1); }
.wizard-choice { display: flex; align-items: center; gap: var(--space-2); font-size: .9375rem; cursor: pointer; font-family: var(--font-mono); }
</style>