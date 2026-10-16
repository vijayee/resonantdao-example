<template>
  <div class="proposal-card" :data-election-id="election.electionId">
    <div class="proposal-card__header">
      <h3 class="proposal-card__title">{{ election.isRunoff ? 'Custodian runoff (quadratic)' : 'Custodian election' }}</h3>
      <Pill :kind="state === 1 ? 'jade' : state === 2 ? 'amber' : 'neutral'">{{ state === 1 ? 'Finalized' : state === 2 ? 'Runoff pending' : 'Open' }}</Pill>
    </div>
    <div class="proposal-card__type">
      Closes in {{ Math.ceil(remainingMs / 1000) }}s<template v-if="ballots"> — you voted</template>
    </div>

    <div v-if="!election.isRunoff && state === 0 && !ballots" class="ballot-form">
      <label v-for="candidate in election.candidates" :key="candidate" class="wizard-choice">
        <input v-model="picks" type="checkbox" class="ballot-option" :value="candidate" /> {{ candidate }}
      </label>
      <button class="button button--primary" type="button" :disabled="ds.submitting" @click="castBallot">Submit ballot (1-5 picks)</button>
    </div>
    <div v-else class="tally">
      <div v-for="(count, candidate) in votes" :key="candidate" class="vote-stat">
        <span class="vote-stat__label">{{ candidate }}</span>
        <span class="vote-stat__value">{{ count }}</span>
      </div>
    </div>

    <div v-if="election.isRunoff && state === 0" class="runoff-form">
      <button
        v-for="candidate in election.candidates"
        :key="candidate"
        type="button"
        class="button button--secondary runoff-vote"
        :disabled="ds.submitting"
        @click="ds.castRunoffVote(election.electionId, candidate)"
      >Vote {{ candidate }}</button>
      <div class="proposal-card__tokens">Tokens used: {{ runoffUsage }} | Balance: {{ resBalance }}</div>
    </div>

    <button
      v-if="state === 0 && remainingMs <= 0"
      type="button"
      class="button button--primary finalize-election"
      :disabled="ds.submitting"
      @click="ds.finalizeElection(election.electionId, election.candidates)"
    >Finalize election</button>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';
import { useDaoStore } from '../../stores/dao';
import { useStatusStore as useStatus } from '../../stores/status';
import Pill from '../../design/components/Pill.vue';

const props = defineProps<{ electionId: string }>();
const ds = useDaoStore();

const election = computed(() => {
  void ds.tick;
  return ds.dao?.getElections().find((e) => e.electionId === props.electionId)
    ?? { electionId: props.electionId, candidates: [], isRunoff: false, seats: 0 };
});
const state = computed(() => { void ds.tick; return ds.dao?.getElectionFinalized(props.electionId) ?? 0; });
const votes = computed(() => { void ds.tick; return ds.dao?.getElectionVotes(props.electionId) ?? {}; });
const ballots = computed(() => { void ds.tick; return ds.dao?.hasBallot(props.electionId) ?? false; });
const remainingMs = computed(() => { void ds.tick; const exp = ds.dao?.getElectionExpiry(props.electionId) ?? 0; return Math.max(0, exp - (ds.dao?.getNodeTimeMs() ?? 0)); });
const runoffUsage = computed(() => { void ds.tick; return ds.dao?.getRunoffUsage(props.electionId) ?? 0; });
const resBalance = computed(() => { void ds.tick; return ds.dao && ds.username ? ds.dao.getResBalance(ds.username) : 0; });

const picks = ref<string[]>([]);
function castBallot() {
  const selection = picks.value.filter((m) => m.length > 0);
  if (selection.length < 1 || selection.length > 5) {
    useStatus().set('Pick between 1 and 5 candidates.', 'error');
    return;
  }
  void ds.castBallot(props.electionId, selection);
}
</script>

<style scoped>
.proposal-card {
  border: 1px solid var(--line);
  border-radius: var(--radius-lg);
  padding: 26px 22px;
  background: var(--card-bg);
  -webkit-backdrop-filter: blur(8px); backdrop-filter: blur(8px);
  transition: border-color .3s;
}
.proposal-card:hover { border-color: var(--line-strong); }
.proposal-card__header { display: flex; align-items: flex-start; justify-content: space-between; gap: var(--space-4); margin-bottom: var(--space-3); }
.proposal-card__title { font-size: 1.3rem; line-height: 1.3; }
.proposal-card__type { font-family: var(--font-mono); font-size: .78rem; color: var(--muted); }
.proposal-card__tokens { font-family: var(--font-mono); font-size: .78rem; color: var(--muted); margin-top: var(--space-2); }
.ballot-form, .runoff-form, .tally { display: flex; flex-direction: column; gap: var(--space-2); margin-top: var(--space-4); }
.tally { flex-direction: row; gap: var(--space-6); }
.wizard-choice { display: flex; align-items: center; gap: var(--space-2); font-size: .95rem; color: var(--ink-soft); }
.ballot-option { accent-color: var(--jade); }
.vote-stat { display: flex; flex-direction: column; gap: var(--space-1); }
.vote-stat__label { font-size: .75rem; color: var(--faint); text-transform: uppercase; letter-spacing: .05em; }
.vote-stat__value { font-family: var(--font-mono); font-size: 1.25rem; font-weight: 500; color: var(--ink); }
.finalize-election { margin-top: var(--space-4); }
</style>
