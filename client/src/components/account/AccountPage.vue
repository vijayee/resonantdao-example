<template>
  <SectionHeading number="06" eyebrow="Account" title="Your ledger">
    <template #lede>What the machine holds in your name: the balances, the dimension tallies your
      accepted work earned, and the money story of your settled contributions and
      verification checks.</template>
  </SectionHeading>

  <div class="grid">
    <Panel number="01" kicker="Balances">
      <div class="balance-row">
        <span class="balance mono" id="account-res">🪙 {{ res ?? '—' }} $RES</span>
        <span class="balance mono" id="account-rct">{{ rct ?? '—' }} RCT</span>
      </div>
      <p class="muted">$RES moves only through verified work. RCT is your aggregated weight in the settlement cycle's payouts.</p>
    </Panel>

    <Panel number="02" kicker="Dimension tallies">
      <div id="dim-tallies" class="tallies">
        <span v-for="t in visibleTallies" :key="t.code" class="tally mono">{{ t.code }} {{ t.cls }} — {{ t.value }}</span>
        <span v-if="hiddenCount > 0" class="muted tally__rest">{{ hiddenCount }} dimensions untouched</span>
      </div>
    </Panel>

    <Panel number="03" kicker="Ledger" class="grid-wild">
      <div id="ledger" class="ledger">
        <p v-if="lines.length === 0" class="muted">Nothing earned yet — settled work and verification checks appear here.</p>
        <div v-for="(line, i) in lines" :key="i" class="ledger-line">
          <span class="mono ledger-line__clock">{{ clock(line.at) }}</span>
          <span :class="['ledger-line__amount', `ledger-line__amount--${line.sign}`]">
            {{ line.amount !== undefined ? `${line.sign}${line.amount}` : line.sign }}
          </span>
          <span class="ledger-line__text">{{ line.label }}</span>
        </div>
      </div>
    </Panel>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { DIMENSIONS } from '@shared/contribution';
import { ledgerLines } from '../../wizard/ledger';
import { useDaoStore } from '../../stores/dao';
import SectionHeading from '../../design/components/SectionHeading.vue';
import Panel from '../../design/components/Panel.vue';

const ds = useDaoStore();

const res = computed(() => { void ds.tick; return ds.dao && ds.username ? ds.dao.getResBalance(ds.username) : undefined; });
const rct = computed(() => { void ds.tick; return ds.dao && ds.username ? ds.dao.getRctBalance(ds.username) : undefined; });

const visibleTallies = computed(() => {
  void ds.tick;
  if (!ds.dao || !ds.username) return [];
  return DIMENSIONS
    .map((d) => ({ code: `C_${d.index}`, cls: d.cls, value: ds.dao!.getDimensionBalance(ds.username, d.index) }))
    .filter((t) => t.value > 0)
    .sort((a, b) => b.value - a.value);
});
const hiddenCount = computed(() => DIMENSIONS.length - visibleTallies.value.length);

// The mirror's entries are structural: map record → LedgerContribution inside
// the lines computed so the projection stays pure (record {contributionId,
// dims, summary} + entry.harm — the structural inputs ledgerLines retells).
const entries = computed(() => {
  void ds.tick;
  return ds.dao?.getContributions() ?? [];
});
const lines = computed(() => {
  void ds.tick;
  return ledgerLines(ds.feedEvents(), entries.value.map((e) => ({
    contributionId: e.record.contributionId,
    dims: e.record.dims,
    harm: e.harm,
    summary: e.record.summary,
  })), ds.username);
});

function clock(atMs: number): string { return new Date(atMs).toTimeString().slice(0, 8); }
</script>

<style scoped>
.grid { display: grid; grid-template-columns: 1fr; gap: var(--space-4); }
@media (min-width: 900px) { .grid { grid-template-columns: 1fr 1fr; } .grid-wild { grid-column: 1 / -1; } }
.balance-row { display: flex; gap: var(--space-5); align-items: baseline; }
.balance { font-size: 1.35rem; color: var(--ink); }
.tallies { display: flex; flex-wrap: wrap; gap: var(--space-2); margin-top: var(--space-2); }
.tally { font-size: .78rem; border: 1px solid var(--line); border-radius: 999px; padding: .15rem var(--space-3); color: var(--jade); }
.tally__rest { border: none; padding: 0; color: var(--faint); }
.ledger { display: flex; flex-direction: column; gap: var(--space-2); }
.ledger-line { display: flex; align-items: baseline; gap: var(--space-3); border: 1px solid var(--line); border-radius: var(--radius); padding: var(--space-2) var(--space-3); background: var(--glass); }
.ledger-line__clock { color: var(--faint); font-size: .75rem; flex: 0 0 auto; }
.ledger-line__amount { flex: 0 0 auto; font-family: var(--font-mono); font-weight: 700; }
.ledger-line__amount--\+ { color: var(--jade); }
.ledger-line__amount--\− { color: var(--danger); }
.ledger-line__amount--\? { color: var(--muted); }
.ledger-line__text { flex: 1 1 auto; min-width: 0; font-size: .875rem; color: var(--ink-soft); }
</style>