<template>
  <li class="proposal-card">
    <div class="proposal-card__header">
      <h3 class="proposal-card__title">{{ proposal.title }}</h3>
      <Pill :kind="executed ? 'jade' : 'neutral'">{{ executed ? 'Executed' : 'Open' }}</Pill>
    </div>
    <p v-if="proposal.description" class="proposal-card__description">{{ proposal.description }}</p>
    <div class="proposal-card__id" title="Proposal ID">{{ proposal.proposalId }}</div>
    <div class="proposal-card__type">{{ pType === 'quadratic' ? 'Quadratic Vote' : 'Direct Vote' }}</div>
    <div class="proposal-card__timer">{{ executed ? 'Voting closed' : `Closes in ${Math.ceil(remainingMs / 1000)}s` }}</div>

    <div class="proposal-card__votes">
      <div v-for="(label, i) in options" :key="label" class="vote-stat">
        <span class="vote-stat__label">{{ label }}</span>
        <span class="vote-stat__value">{{ counts[i] ?? 0 }}</span>
      </div>
    </div>

    <div v-if="pType === 'quadratic'" class="proposal-card__tokens">
      Tokens used here: {{ tokensUsed }} | Next vote cost: {{ nextCumulativeCost }} | Your balance for this question: {{ voteBalance }}
    </div>

    <div class="proposal-card__actions">
      <button
        v-for="(label, i) in options"
        :key="label"
        type="button"
        class="button button--secondary vote-option"
        :disabled="actionsDisabled"
        @click="$emit('vote', proposal.proposalId, i)"
      >{{ label }}</button>
      <button type="button" class="button button--primary execute" :disabled="executed || ds.submitting" @click="$emit('execute', proposal.proposalId)">Execute</button>
    </div>
  </li>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import type { ProposalPayload } from '@shared/types';
import { useDaoStore } from '../../stores/dao';
import Pill from '../../design/components/Pill.vue';

const props = defineProps<{ proposal: ProposalPayload; executed: boolean }>();
defineEmits<{ vote: [proposalId: string, choice: number]; execute: [proposalId: string] }>();

const ds = useDaoStore();

const pType = computed(() => {
  void ds.tick;
  return ds.dao?.getProposalType(props.proposal.proposalId) ?? null;
});
const options = computed(() => props.proposal.options ?? ['Yes', 'No']);
const counts = computed(() => {
  void ds.tick;
  return ds.dao?.getProposalOptionVotes(props.proposal.proposalId) ?? [];
});
const remainingMs = computed(() => {
  void ds.tick;
  const expiresAt = ds.dao?.getProposalExpiry(props.proposal.proposalId) ?? 0;
  return Math.max(0, expiresAt - (ds.dao?.getNodeTimeMs() ?? 0));
});
const tokensUsed = computed(() => {
  void ds.tick;
  return ds.dao && ds.username ? ds.dao.getProposalTokenUsage(props.proposal.proposalId, ds.username) : 0;
});
const voteCount = computed(() => {
  void ds.tick;
  return ds.dao && ds.username ? ds.dao.getProposalVoteCount(props.proposal.proposalId, ds.username) : 0;
});
const nextCumulativeCost = computed(() => ((voteCount.value + 1) * (voteCount.value + 2) * (2 * voteCount.value + 3)) / 6);
const voteBalance = computed(() => {
  void ds.tick;
  return ds.dao && ds.username ? ds.dao.getVoteBalance(props.proposal.proposalId, ds.username) : 0;
});
const alreadyVoted = computed(() => ds.votedProposals.includes(props.proposal.proposalId));
const canVoteQuadratic = computed(() =>
  pType.value === 'quadratic' && voteBalance.value >= nextCumulativeCost.value && nextCumulativeCost.value > 0);
const actionsDisabled = computed(() =>
  props.executed || ds.submitting || (alreadyVoted.value && !canVoteQuadratic.value));
</script>

<style scoped>
.proposal-card {
  border: 1px solid var(--line);
  border-radius: var(--radius-lg);
  padding: 26px 22px;
  background: var(--card-bg);
  -webkit-backdrop-filter: blur(8px); backdrop-filter: blur(8px);
  transition: border-color .3s;
  list-style: none;
}
.proposal-card:hover { border-color: var(--line-strong); }
.proposal-card__header { display: flex; align-items: flex-start; justify-content: space-between; gap: var(--space-4); margin-bottom: var(--space-3); }
.proposal-card__title { font-size: 1.3rem; line-height: 1.3; }
.proposal-card__description { color: var(--ink-soft); margin: 0 0 var(--space-4); font-size: .95rem; }
.proposal-card__id { font-family: var(--font-mono); font-size: .75rem; color: var(--faint); margin-bottom: var(--space-4); word-break: break-all; }
.proposal-card__type { font-family: var(--font-mono); font-size: .78rem; color: var(--muted); }
.proposal-card__timer { font-family: var(--font-mono); font-size: .78rem; color: var(--amber); margin-top: 4px; }
.proposal-card__votes { display: flex; gap: var(--space-6); margin-top: var(--space-4); margin-bottom: var(--space-4); }
.vote-stat { display: flex; flex-direction: column; gap: var(--space-1); }
.vote-stat__label { font-size: .75rem; color: var(--faint); text-transform: uppercase; letter-spacing: .05em; }
.vote-stat__value { font-family: var(--font-mono); font-size: 1.25rem; font-weight: 500; color: var(--ink); }
.proposal-card__tokens { font-family: var(--font-mono); font-size: .78rem; color: var(--muted); margin-bottom: var(--space-4); }
.proposal-card__actions { display: flex; flex-wrap: wrap; gap: var(--space-3); }
</style>
