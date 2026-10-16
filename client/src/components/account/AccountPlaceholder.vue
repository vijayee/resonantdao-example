<template>
  <SectionHeading number="06" eyebrow="Account" title="Your ledger, step five">
    <template #lede>The financial-app breakdown — token balance up front, per-dimension
      contribution tallies, and a ledger history — arrives with the account slice. The
      substrate (routes, shell, design language) already exists here.</template>
  </SectionHeading>
  <div class="grid">
    <Panel number="01" kicker="Balance"><p class="muted">$RES balance, $RCT, and per-dimension tallies — rendered like a bank app in slice #5.</p></Panel>
    <Panel number="02" kicker="Ledger"><p class="muted">Every contribution, verification, settlement, and harm adjustment as line items.</p></Panel>
  </div>
</template>

<script setup lang="ts">
import SectionHeading from '../../design/components/SectionHeading.vue';
import Panel from '../../design/components/Panel.vue';
</script>

<style scoped>
.grid { display: grid; grid-template-columns: 1fr; gap: 16px; }
@media (min-width: 720px) { .grid { grid-template-columns: 1fr 1fr; } }
</style>