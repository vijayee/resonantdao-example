<template>
  <SectionHeading number="00" eyebrow="The feed" title="The hub arrives in the next slice"
    lede="For now, this page informs and directs. Every feature has its own page — the forms live there, not here." />
  <VerdictSplit
    x-title="Today ✕"
    ok-title="What we add ✓"
    :x-items="[
      'One page <b>acted</b> for everything — proposals, elections, verification, settlements, round ops.',
      'Each new feature pushed the stack higher.',
    ]"
    :ok-items="[
      '<b>Feed</b> — informs and directs, decides nothing.',
      '<b>Wizards</b> — walk each feature one step at a time.',
      '<b>Account</b> — your tokens and contributions like a ledger.',
    ]"
  />
  <div class="dest">
    <Panel v-for="item in DESTS" :key="item.to" :number="item.no" :kicker="item.label">
      <RouterLink :to="item.to" class="dest__link">{{ item.blurb }} <span class="dest__arrow">→</span></RouterLink>
    </Panel>
  </div>
</template>

<script setup lang="ts">
import { RouterLink } from 'vue-router';
import SectionHeading from '../../design/components/SectionHeading.vue';
import VerdictSplit from '../../design/components/VerdictSplit.vue';
import Panel from '../../design/components/Panel.vue';

const DESTS = [
  { to: '/proposals', no: '01', label: 'Proposals', blurb: 'Create proposals and vote.' },
  { to: '/elections', no: '02', label: 'Elections', blurb: 'Custodian elections and runoff.' },
  { to: '/contribute', no: '03', label: 'Contribute', blurb: 'Submit and verify contributions.' },
  { to: '/round', no: '04', label: 'Round', blurb: 'The settlement spine.' },
  { to: '/custodians', no: '05', label: 'Custodians', blurb: 'Members and custodian admin.' },
  { to: '/account', no: '06', label: 'Account', blurb: 'Your tokens and tallies.' },
];
</script>

<style scoped>
.dest { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 16px; margin-top: var(--space-8); }
.dest :deep(.panel) { padding: 22px 20px; }
.dest__link { text-decoration: none; color: var(--ink-soft); font-family: var(--font-mono); font-size: .85rem; }
.dest__link:hover { color: var(--jade); }
.dest__arrow { margin-left: 6px; color: var(--jade); }
</style>