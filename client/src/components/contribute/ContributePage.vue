<template>
  <SectionHeading number="03" eyebrow="Contribute" title="Work, witnessed">
    <template #lede>Contributions are flows — open one to act on it, or start a new one below.</template>
  </SectionHeading>

  <Panel number="01" kicker="New contribution">
    <button id="new-contribution-btn" class="button button--primary" type="button" @click="router.push('/contribute/new')">Start a new contribution…</button>
  </Panel>

  <section id="contributions-list" aria-live="polite">
    <p v-if="visibleEntries.length === 0" class="muted">No contributions involve you yet — start one above.</p>
    <RouterLink
      v-for="entry in visibleEntries"
      :key="entry.record.contributionId"
      :to="`/contribute/${entry.record.contributionId}`"
      class="contribution-row"
    >
      <span class="contribution-row__title">{{ entry.record.summary }}</span>
      <span class="contribution-row__dim mono">{{ dimLabels(entry) }}</span>
      <span :class="['contribution-pill', `contribution-pill--${statusFor(entry)}`]">{{ statusFor(entry) }}</span>
      <span class="muted contribution-row__evidence">{{ evidenceLabel(entry) }}</span>
      <span class="contribution-row__arrow">→</span>
    </RouterLink>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted } from 'vue';
import { RouterLink, useRouter } from 'vue-router';
import { DIMENSIONS } from '@shared/contribution';
import { useDaoStore, contributionFacts } from '../../stores/dao';
import { isParticipant } from '../../wizard/lifecycle';
import { cleanStaleDrafts } from '../../wizard/drafts';
import type { ContributionMirrorEntry } from '../../dao';
import SectionHeading from '../../design/components/SectionHeading.vue';
import Panel from '../../design/components/Panel.vue';

const ds = useDaoStore();
const router = useRouter();

const entries = computed(() => {
  void ds.tick;
  return [...(ds.dao?.getContributions() ?? [])].reverse();
});

// Participants-only list (spec decision 4): the viewer's own submissions,
// contributions an actionable role reaches, and (as custodian) everything.
const visibleEntries = computed(() => {
  void ds.tick;
  const d = ds.dao;
  if (!d || !ds.username) return [];
  const isCust = (ds.custodians ?? []).includes(ds.username);
  return entries.value.filter((e) => {
    const { schema, facts } = contributionFacts(d, e);
    return isParticipant(e, ds.username, isCust, schema, facts);
  });
});

function statusFor(entry: ContributionMirrorEntry) { return ds.dao?.getContributionStatus(entry.record.contributionId) ?? 'unknown'; }
function dimLabels(entry: ContributionMirrorEntry) {
  return Object.keys(entry.record.dims).map((k) => `C_${k} ${DIMENSIONS[Number(k)]?.name ?? '?'}`).join(', ');
}
function evidenceLabel(entry: ContributionMirrorEntry) {
  const uri = entry.record.evidenceRef.uri;
  return uri.startsWith('content://') ? 'stored evidence' : `pointer: ${uri}`;
}

// Draft sweep: verify/settle/appeal drafts for vanished targets (kept from
// slice #3; the pages read their own drafts). NEVER against an empty mirror —
// replay may not have finished at mount; an empty sweep would nuke every draft.
const flowIds = ['verify', 'settle', 'appeal'] as const;
function sweepStaleDrafts() {
  void ds.tick;
  if (!ds.username || !ds.dao) return;
  const ids = new Set(ds.dao.getContributions().map((e) => e.record.contributionId));
  if (ids.size === 0) return;
  for (const fid of flowIds) cleanStaleDrafts(localStorage, ds.username, fid, ids);
}
onMounted(sweepStaleDrafts);
</script>

<style scoped>
.contribution-row {
  display: flex; align-items: baseline; gap: var(--space-3);
  border: 1px solid var(--line); border-radius: var(--radius);
  padding: var(--space-3) var(--space-4); background: var(--glass);
  transition: border-color .2s, transform .2s;
}
.contribution-row:hover { border-color: var(--line-strong); transform: translateY(-1px); }
.contribution-row__title { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: .9375rem; }
.contribution-row__dim { color: var(--faint); font-size: .75rem; flex: 0 0 auto; }
.contribution-row__evidence { font-size: .78rem; flex: 0 0 auto; max-width: 30%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.contribution-row__arrow { color: var(--jade); flex: 0 0 auto; }
.contribution-pill { font-family: var(--font-mono); font-size: .75rem; font-weight: 700; text-transform: uppercase; letter-spacing: .03em; padding: .15rem var(--space-2); border-radius: 999px; flex-shrink: 0; }
.contribution-pill--pending { color: var(--muted); border: 1px solid var(--line); }
.contribution-pill--accepted { color: var(--jade); border: 1px solid rgba(95, 208, 160, .5); }
.contribution-pill--rejected { color: var(--danger); border: 1px solid rgba(226, 128, 126, .5); }
.contribution-pill--appealed { color: var(--amber); border: 1px solid rgba(232, 168, 76, .5); }
#contributions-list { display: flex; flex-direction: column; gap: var(--space-2); }
</style>