<template>
  <section class="panel" :class="[`panel--${variant}`]">
    <div v-if="number || kicker" class="panel__tag">
      <span v-if="number" class="panel__no">{{ number }}</span>
      <span v-if="kicker" class="panel__kicker">{{ kicker }}</span>
      <slot name="tag" />
    </div>
    <slot />
  </section>
</template>

<script setup lang="ts">
withDefaults(defineProps<{ variant?: 'plain' | 'ok' | 'x'; number?: string; kicker?: string }>(), { variant: 'plain' });
</script>

<style scoped>
.panel {
  border: 1px solid var(--line);
  border-radius: var(--radius-lg);
  padding: 26px 22px;
  background: var(--card-bg);
  -webkit-backdrop-filter: blur(8px);
  backdrop-filter: blur(8px);
  transition: border-color .3s;
}
.panel:hover { border-color: var(--line-strong); }
.panel--x { border-color: rgba(226, 128, 126, .3); }
.panel--ok { border-color: rgba(95, 208, 160, .3); }
.panel__tag {
  font-family: var(--font-mono);
  font-size: .7rem;
  letter-spacing: .2em;
  text-transform: uppercase;
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 16px;
}
.panel__no { color: var(--amber); letter-spacing: .24em; }
.panel__kicker { color: var(--muted); }
</style>
