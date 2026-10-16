<template>
  <div class="verdict">
    <Panel variant="x" :kicker="xTitle">
      <ul class="verdict__list">
        <li v-for="item in xItems" :key="item"><span class="verdict__mk verdict__mk--x">✕</span><span v-html="item" /></li>
      </ul>
    </Panel>
    <Panel variant="ok" :kicker="okTitle">
      <ul class="verdict__list">
        <li v-for="item in okItems" :key="item"><span class="verdict__mk verdict__mk--ok">✓</span><span v-html="item" /></li>
      </ul>
    </Panel>
  </div>
</template>

<script setup lang="ts">
import Panel from './Panel.vue';
// xItems/okItems are rendered via v-html — static, page-local constants only (they carry <b> emphasis), never user input.
defineProps<{ xTitle: string; okTitle: string; xItems: string[]; okItems: string[] }>();
</script>

<style scoped>
.verdict { display: grid; grid-template-columns: 1fr; gap: 16px; }
@media (min-width: 720px) { .verdict { grid-template-columns: 1fr 1fr; } }
.verdict__list { list-style: none; margin-top: 16px; display: grid; gap: 10px; padding: 0; }
.verdict__list li { display: flex; gap: 10px; align-items: baseline; color: var(--ink-soft); font-size: .95rem; }
.verdict__mk { font-family: var(--font-mono); flex: 0 0 auto; }
.verdict__mk--x { color: var(--danger); }
.verdict__mk--ok { color: var(--jade); }
</style>
