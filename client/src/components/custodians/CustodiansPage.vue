<template>
  <SectionHeading number="05" eyebrow="Custodians" title="Keepers of the keys">
    <template #lede>Members of the DAO, the seated custodians, and custodian admin controls.</template>
  </SectionHeading>

  <div class="cols">
    <Panel number="01" kicker="Members">
      <ul id="members" class="member-list">
        <li class="member-item">
          <span class="member-item__name">{{ ds.username }}</span>
          <span v-if="youAreCustodian" class="member-item__badge">custodian</span>
          <span class="member-item__badge">you</span>
          <span class="member-item__tokens">🪙 {{ resBalance }} $RES</span>
          <span class="rct-badge" :data-member-rct="ds.username">{{ rctOf(ds.username) }} RCT</span>
        </li>
        <li v-for="m in otherMembers" :key="m" class="member-item">
          <span class="member-item__name">{{ m }}</span>
          <span v-if="isSeat(m)" class="member-item__badge">custodian</span>
          <span class="rct-badge" :data-member-rct="m">{{ rctOf(m) }} RCT</span>
        </li>
      </ul>
    </Panel>

    <Panel number="02" kicker="Custodian seats">
      <div id="custodians" class="custodian-list">
        <span v-for="(c, i) in seats" :key="c" class="member-item__badge">Seat {{ i + 1 }}: {{ c }}</span>
        <span v-if="seats.length === 0" class="muted">No custodians elected yet.</span>
      </div>
    </Panel>

    <Panel number="03" kicker="Custodian controls">
      <div id="remove-controls" class="remove-controls">
        <template v-if="ds.isCustodian">
          <div v-for="m in removable" :key="m" class="member-item">
            <span class="member-item__name">{{ m }}</span>
            <button type="button" class="button button--secondary remove-member" :disabled="ds.submitting" @click="ds.removeMember(m)">Remove</button>
          </div>
          <span v-if="removable.length === 0" class="muted">No other members to remove.</span>
        </template>
        <span v-else class="muted">Custodian-only controls.</span>
      </div>
    </Panel>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { useDaoStore } from '../../stores/dao';
import SectionHeading from '../../design/components/SectionHeading.vue';
import Panel from '../../design/components/Panel.vue';

const ds = useDaoStore();

const otherMembers = computed(() => ds.members.filter((m) => m !== ds.username));
const seats = computed(() => { void ds.tick; return ds.dao?.custodians ?? []; });
const youAreCustodian = computed(() => seats.value.includes(ds.username));
const removable = computed(() => otherMembers.value);
const resBalance = computed(() => { void ds.tick; return ds.dao && ds.username ? ds.dao.getResBalance(ds.username) : 0; });
function isSeat(m: string) { return seats.value.includes(m); }
function rctOf(m: string) { void ds.tick; return ds.dao?.getRctBalance(m) ?? 0; }
</script>

<style scoped>
.cols { display: grid; grid-template-columns: 1fr; gap: var(--space-6); }
@media (min-width: 900px) { .cols { grid-template-columns: 1fr 1fr; } .cols .panel:nth-child(3) { grid-column: 1 / -1; } }
.cols > :deep(.panel) { min-height: min-content; }
.member-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: var(--space-2); }
.member-item {
  display: flex; align-items: center; justify-content: space-between; gap: var(--space-3);
  padding: var(--space-3) var(--space-4); background: var(--glass);
  border: 1px solid var(--line); border-radius: var(--radius); font-size: .875rem;
}
.member-item__name { font-family: var(--font-mono); color: var(--ink); }
.member-item__badge {
  font-family: var(--font-mono); font-size: .7rem; letter-spacing: .08em;
  color: var(--jade); border: 1px solid rgba(95, 208, 160, .5);
  border-radius: 100px; padding: var(--space-1) var(--space-2);
}
.rct-badge {
  font-family: var(--font-mono); font-size: .72rem; font-weight: 500;
  color: var(--amber); border: 1px solid rgba(232, 168, 76, .5);
  border-radius: 100px; padding: .1rem var(--space-2);
}
.custodian-list { display: flex; flex-wrap: wrap; gap: var(--space-2); }
.remove-controls { display: flex; flex-direction: column; gap: var(--space-2); }
.member-item__tokens { font-family: var(--font-mono); font-size: .78rem; color: var(--amber); white-space: nowrap; }
</style>