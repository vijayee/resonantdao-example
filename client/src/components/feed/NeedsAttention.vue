<template>
  <section id="needs-attention" aria-label="Needs your attention">
    <span class="eyebrow">Needs your attention</span>
    <div v-if="items.length === 0" class="empty-state caught-up">You're all caught up.</div>
    <div class="attention__grid">
      <RouterLink
        v-for="item in items"
        :key="item.key"
        :to="item.to"
        class="attention__card"
      >
        <span class="attention__label mono">{{ item.kind }}</span>
        <span class="attention__text">{{ item.text }}</span>
        <span class="attention__arrow">→</span>
      </RouterLink>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { RouterLink } from 'vue-router';
import { wizardModel, type ContributionFacts } from '@shared/wizard';
import { schemaForDims } from '@shared/contribution';
import { STAGE_AUDITED, STAGE_OPEN } from '@shared/round';
import { useDaoStore } from '../../stores/dao';

const ds = useDaoStore();

type Item = { key: string; kind: string; text: string; to: string };

const items = computed<Item[]>(() => {
  void ds.tick;
  const d = ds.dao;
  const me = ds.username;
  if (!d || !me) return [];
  const now = d.getNodeTimeMs();
  const out: Item[] = [];

  for (const p of d.getProposals()) {
    const pType = d.getProposalType(p.proposalId);
    if (d.isProposalExecuted(p.proposalId)) continue;
    if (Math.max(0, d.getProposalExpiry(p.proposalId) - now) <= 0) continue;
    const voted = d.getProposalVoteCount(p.proposalId, me) > 0;
    const nextCost = ((d.getProposalVoteCount(p.proposalId, me) + 1) * (d.getProposalVoteCount(p.proposalId, me) + 2) * (2 * d.getProposalVoteCount(p.proposalId, me) + 3)) / 6;
    const canAgain = pType === 'quadratic' && d.getVoteBalance(p.proposalId, me) >= nextCost && nextCost > 0;
    if (voted && !canAgain) continue;
    out.push({ key: `p-${p.proposalId}`, kind: 'proposal', text: `"${p.title}" is open for voting`, to: '/proposals' });
  }

  for (const entry of d.getContributions()) {
    if (entry.submitter === me) continue;
    const status = d.getContributionStatus(entry.record.contributionId);
    if (status === 'unknown' || status === 'accepted' || status === 'rejected') continue;
    const schema = schemaForDims(entry.record.dims);
    const facts: ContributionFacts = {
      status: 0,
      stepIndex: d.getContributionStepIndex(entry.record.contributionId),
      done: Object.fromEntries(schema.steps.map((s) => [
        s.stepId, d.getContributionStepDone(entry.record.contributionId, s.stepId),
      ])),
      submitter: entry.submitter,
      // Targeted contributions light the verify band ONLY for named verifiers
      // (empty = untargeted legacy — the class rule stands).
      ...(d.getDefinedVerifiers(entry.record.contributionId).length > 0
        ? { verifiers: d.getDefinedVerifiers(entry.record.contributionId) }
        : {}),
    };
    const model = wizardModel(schema, facts, me, ds.custodians.includes(me));
    const step = model.steps[model.currentStepIndex];
    if (!step || !step.actors.some((actor) => actor === 'verifier' || actor === 'custodian' || actor === 'member')) continue;
    const roleInfo = step.roles.verifier ?? step.roles.custodian ?? step.roles.member;
    if (!roleInfo || !roleInfo.mayAct) continue;
    out.push({ key: `c-${entry.record.contributionId}`, kind: 'verify', text: `"${entry.record.summary}" awaits your verification`, to: '/contribute' });
  }

  for (const e of d.getElections()) {
    if (d.getElectionFinalized(e.electionId) !== 0) continue;
    if (Math.max(0, d.getElectionExpiry(e.electionId) - now) <= 0) continue;
    if (d.hasBallot(e.electionId)) continue;
    out.push({ key: `e-${e.electionId}`, kind: 'election', text: 'A custodian election is open for ballots', to: '/elections' });
  }

  const stage = d.getRoundStage(d.getCurrentRound());
  if (stage === STAGE_OPEN || stage === STAGE_AUDITED) {
    out.push({ key: 'round', kind: 'round', text: 'The settlement cycle is waiting for its next step', to: '/round' });
  }

  return out;
});
</script>

<style scoped>
.caught-up { margin-top: var(--space-4); }
.attention__grid { display: grid; grid-template-columns: 1fr; gap: var(--space-2); margin-top: var(--space-4); }
@media (min-width: 720px) { .attention__grid { grid-template-columns: 1fr 1fr; } }
.attention__card {
  display: flex; align-items: baseline; gap: var(--space-3);
  border: 1px solid rgba(95, 208, 160, .3); border-radius: var(--radius);
  padding: var(--space-3) var(--space-4); background: var(--glass);
  transition: border-color .2s, transform .2s;
}
.attention__card:hover { border-color: var(--line-strong); transform: translateY(-1px); }
.attention__label { font-size: .7rem; letter-spacing: .2em; text-transform: uppercase; color: var(--jade); flex: 0 0 auto; }
.attention__text { flex: 1 1 auto; font-size: .875rem; color: var(--ink-soft); min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.attention__arrow { color: var(--jade); flex: 0 0 auto; }
</style>
