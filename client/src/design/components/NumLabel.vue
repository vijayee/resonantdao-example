<template>
  <span class="num" :class="{ 'num--amber': amber }"><slot /></span>
</template>

<script setup lang="ts">
withDefaults(defineProps<{ amber?: boolean }>(), { amber: false });
</script>

<style scoped>
.num {
  font-family: var(--font-mono);
  font-size: 1.2rem;
  color: var(--jade);
  font-weight: 500;
  flex: 0 0 auto;
}
.num--amber { color: var(--amber); }
</style>