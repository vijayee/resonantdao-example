<template>
  <RouterLink :to="linkTarget" class="event-row" :aria-label="event.summary">
    <span class="event-row__accent">✦</span>
    <span class="event-row__clock mono">{{ clock }}</span>
    <span class="event-row__text">{{ event.summary }}</span>
    <Pill kind="neutral" class="event-row__round">Round {{ event.round }}</Pill>
  </RouterLink>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { RouterLink } from 'vue-router';
import type { FeedEvent } from '@shared/feed';
import Pill from '../../design/components/Pill.vue';

const props = defineProps<{ event: FeedEvent }>();

const clock = computed(() => new Date(props.event.at).toTimeString().slice(0, 8));

const OWNERS: Record<string, string> = {
  proposal_created: '/proposals', proposal_executed: '/proposals',
  contribution_submitted: '/contribute', contribution_verified: '/contribute',
  contribution_settled: '/contribute', contribution_appealed: '/contribute',
  election_started: '/elections', election_finalized: '/elections',
  round_audited: '/round', round_reckoned: '/round', round_published: '/round',
};

const linkTarget = computed(() => OWNERS[props.event.type] ?? '/');
</script>

<style scoped>
.event-row {
  display: flex; align-items: baseline; gap: var(--space-3);
  padding: var(--space-3) var(--space-4);
  border: 1px solid var(--line); border-radius: var(--radius);
  background: var(--glass);
  font-size: .875rem; color: var(--ink-soft);
  transition: border-color .2s, color .2s;
}
.event-row:hover { border-color: var(--line-strong); color: var(--ink); }
.event-row__accent { color: var(--jade); flex: 0 0 auto; font-family: var(--font-mono); }
.event-row__clock { color: var(--faint); font-size: .78rem; flex: 0 0 auto; }
.event-row__text { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.event-row__round { flex: 0 0 auto; }
</style>