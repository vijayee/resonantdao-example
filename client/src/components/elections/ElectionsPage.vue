<template>
  <SectionHeading number="02" eyebrow="Elections" title="Seat the custodians">
    <template #lede>Start a custodian election, cast a ballot (1–5 picks), and finalize once the window closes. A tie spawns a quadratic runoff.</template>
  </SectionHeading>

  <Panel number="01" kicker="Election control">
    <div class="election-start">
      <button id="start-election" class="button button--secondary" type="button" :disabled="ds.submitting" @click="onStartElection">Start election</button>
      <p class="muted">Candidates: every member, alphabetical.</p>
    </div>
  </Panel>

  <Panel number="02" kicker="Custodian seats">
    <div id="custodians" class="custodian-list">
      <span v-for="(c, i) in custodianSeats" :key="c" class="member-item__badge">Seat {{ i + 1 }}: {{ c }}</span>
      <span v-if="custodianSeats.length === 0" class="muted">No custodians elected yet.</span>
    </div>
  </Panel>

  <div id="election-area" class="elections">
    <ElectionCard v-for="e in elections" :key="e.electionId" :election-id="e.electionId" />
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { useDaoStore } from '../../stores/dao';
import SectionHeading from '../../design/components/SectionHeading.vue';
import Panel from '../../design/components/Panel.vue';
import ElectionCard from './ElectionCard.vue';

const ds = useDaoStore();
const custodianSeats = computed(() => { void ds.tick; return ds.dao?.custodians ?? []; });
const elections = computed(() => {
  void ds.tick;
  return [...(ds.dao?.getElections() ?? [])].reverse();
});

function onStartElection() {
  if (!ds.dao || !ds.username) return;
  const candidates = Array.from(new Set([...ds.members, ds.username])).sort();
  void ds.startElection(candidates);
}
</script>

<style scoped>
.election-start { display: flex; align-items: center; gap: var(--space-4); flex-wrap: wrap; }
.custodian-list { display: flex; flex-wrap: wrap; gap: var(--space-2); }
.member-item__badge { font-family: var(--font-mono); font-size: .78rem; color: var(--muted); border: 1px solid var(--line); border-radius: var(--radius); padding: var(--space-1) var(--space-2); }
.elections { display: flex; flex-direction: column; gap: var(--space-4); margin-top: var(--space-6); }
</style>
