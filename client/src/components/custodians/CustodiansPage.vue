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

    <Panel number="04" kicker="Weights (custodian)">
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
  </div>
</template>

<script setup lang="ts">
import { computed, reactive } from 'vue';
import { useDaoStore } from '../../stores/dao';
import { useStatusStore } from '../../stores/status';
import SectionHeading from '../../design/components/SectionHeading.vue';
import Panel from '../../design/components/Panel.vue';

const ds = useDaoStore();
const status = useStatusStore();
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
@media (min-width: 900px) { .cols { grid-template-columns: 1fr 1fr; } .cols .panel:nth-child(n+3) { grid-column: 1 / -1; } }
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
