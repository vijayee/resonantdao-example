<template>
  <span class="pill" :class="`pill--${kind}`"><slot /></span>
</template>

<script setup lang="ts">
withDefaults(defineProps<{ kind?: 'neutral' | 'jade' | 'amber' | 'danger' }>(), { kind: 'neutral' });
</script>

<style scoped>
.pill {
  font-family: var(--font-mono);
  font-size: .75rem; font-weight: 500;
  letter-spacing: .06em;
  border-radius: 100px;
  padding: .25rem .8rem;
  white-space: nowrap;
}
.pill--neutral { color: var(--muted); border: 1px solid var(--line); background: var(--glass); }
.pill--jade { color: var(--jade); border: 1px solid rgba(95, 208, 160, .5); }
.pill--amber { color: var(--amber); border: 1px solid rgba(232, 168, 76, .5); }
.pill--danger { color: var(--danger); border: 1px solid rgba(226, 128, 126, .5); }
</style>
