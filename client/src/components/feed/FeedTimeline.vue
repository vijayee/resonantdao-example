<template>
  <section :aria-label="'Recent activity'">
    <div class="timeline__head">
      <span class="eyebrow">Recent activity</span>
      <button
        v-if="!expanded && events.length > shownCount"
        class="timeline__show-older button button--secondary button--small"
        type="button"
        @click="expanded = true"
      >Show older ({{ events.length - shownCount }})</button>
    </div>
    <p v-if="events.length === 0" id="feed-timeline" class="empty-state">
      Nothing yet — the DAO has been quiet. Contributions, proposals, and round
      activity will appear here as it happens.
    </p>
    <TransitionGroup v-else tag="div" name="tl" class="timeline__rows">
      <FeedEventRow v-for="ev in visible" :key="ev.index" :event="ev" />
    </TransitionGroup>
  </section>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';
import type { FeedEvent } from '@shared/feed';
import FeedEventRow from './FeedEventRow.vue';

const props = defineProps<{ events: FeedEvent[] }>();
const expanded = ref(false);
// Rendered cap (D3): 50 newest unless expanded (then all mirrored events).
const shownCount = computed(() => (expanded.value ? props.events.length : 50));
const visible = computed(() => props.events.slice(0, shownCount.value));
</script>

<style scoped>
.timeline__head { display: flex; align-items: center; justify-content: space-between; gap: var(--space-4); margin-bottom: var(--space-4); }
.timeline__rows { display: flex; flex-direction: column; gap: var(--space-2); }
.tl-enter-active, .tl-leave-active { transition: opacity .3s, transform .3s; }
.tl-enter-from { opacity: 0; transform: translateY(-6px); }
.tl-leave-to { opacity: 0; }
</style>