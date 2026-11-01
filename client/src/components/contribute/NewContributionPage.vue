<template>
  <SectionHeading number="03" eyebrow="Contribute" title="New contribution">
    <template #lede>Walk the steps — the flow's later phases open here once the contribution
      is in.</template>
  </SectionHeading>

  <Panel number="01" kicker="Walk the steps">
    <WizardFlow
      :key="draftKey"
      :flow="flow"
      target-id="new"
      :initial-answers="resume?.answers"
      :initial-step="resume?.stepIndex"
      @close="onClosed"
    />
  </Panel>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { useDaoStore } from '../../stores/dao';
import { contributeNewFlow } from '../../wizard/flows/contribute-flows';
import { loadDraft, WizardDraft } from '../../wizard/drafts';
import WizardFlow from '../../wizard/WizardFlow.vue';
import SectionHeading from '../../design/components/SectionHeading.vue';
import Panel from '../../design/components/Panel.vue';

const ds = useDaoStore();
const router = useRouter();

// The browser profile IS the draft key. It is safe to read ds.username at
// mount: the router's auth guard only admits authed visitors, and the dao
// store's bootstrap sets username together with authed.
const resume = ref<WizardDraft | null>(null);
const draftKey = ref(0);

const flow = contributeNewFlow((id) => {
  // Submit succeeded: the shell already cleared the draft; land on the new
  // lifecycle page.
  void router.push(`/contribute/${id}`);
});

onMounted(() => {
  if (ds.username) resume.value = loadDraft(localStorage, ds.username, 'contribute-new', 'new');
});

function onClosed() {
  // Cancel: the shell cleared the draft; remount fresh. (A successful submit
  // also emits close, but its route push unmounts the page in the same tick.)
  draftKey.value += 1;
}
</script>