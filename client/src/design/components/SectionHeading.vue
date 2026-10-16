<template>
  <div class="sec-head">
    <span class="eyebrow"><span v-if="number" class="sec-head__no">{{ number }}</span>{{ eyebrow }}</span>
    <h2 class="sec-head__title"><slot><em>{{ title }}</em></slot></h2>
    <p v-if="lede" class="sec-head__lede"><slot name="lede">{{ lede }}</slot></p>
  </div>
</template>

<script setup lang="ts">
defineProps<{ eyebrow: string; title?: string; lede?: string; number?: string }>();
</script>

<style scoped>
.sec-head { margin-bottom: var(--space-8); }
.sec-head__no { color: var(--amber); margin-right: 14px; letter-spacing: .24em; }
.sec-head__title { font-size: clamp(1.9rem, 3.8vw, 3rem); max-width: 24ch; }
.sec-head__title :deep(em) { font-style: italic; color: var(--ink); }
.sec-head__lede { margin-top: var(--space-4); max-width: 56ch; color: var(--ink-soft); font-size: 1.05rem; line-height: 1.65; }
</style>