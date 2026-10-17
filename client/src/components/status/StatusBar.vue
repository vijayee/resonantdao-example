<template>
  <div
    id="status"
    :class="['status-bar', `status-bar--${kind}`]"
    :role="kind === 'error' ? 'alert' : 'status'"
  >{{ text }}</div>
</template>

<script setup lang="ts">
import { useStatusStore } from '../../stores/status';
import { storeToRefs } from 'pinia';
const { text, kind } = storeToRefs(useStatusStore());
</script>

<style scoped>
.status-bar {
  position: fixed;
  bottom: var(--space-8);
  left: 50%;
  transform: translateX(-50%);
  max-width: min(640px, calc(100% - var(--space-8)));
  width: fit-content;
  padding: var(--space-3) var(--space-5);
  border-radius: 100px;
  font-family: var(--font-mono);
  font-size: .8125rem;
  letter-spacing: .02em;
  -webkit-backdrop-filter: blur(8px);
  backdrop-filter: blur(8px);
  border: 1px solid var(--line);
  z-index: 50;
  background: var(--glass);
  color: var(--ink);
}
.status-bar--error { color: var(--danger); border-color: rgba(226, 128, 126, .4); }
.status-bar--success { color: var(--jade); border-color: rgba(95, 208, 160, .4); }
.status-bar--loading { color: var(--muted); }
</style>
