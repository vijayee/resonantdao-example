<template>
  <SectionHeading number="00" eyebrow="The feed" title="What's happening, and where to act">
    <template #lede>This page informs and directs — it decides nothing. Every feature
      has its own page; each card below points at the one that can act.</template>
  </SectionHeading>
  <NeedsAttention />
  <FeedTimeline :events="ds.feedEvents()" />
</template>

<script setup lang="ts">
import { useDaoStore } from '../../stores/dao';
import SectionHeading from '../../design/components/SectionHeading.vue';
import NeedsAttention from './NeedsAttention.vue';
import FeedTimeline from './FeedTimeline.vue';

const ds = useDaoStore();
</script>
