import { ref } from 'vue';
import { defineStore } from 'pinia';

export type StatusKind = 'neutral' | 'error' | 'success' | 'loading';

export const useStatusStore = defineStore('status', () => {
  const text = ref('');
  const kind = ref<StatusKind>('neutral');

  function set(t: string, k: StatusKind = 'neutral') {
    text.value = t;
    kind.value = k;
  }
  function clear() {
    set('');
  }

  return { text, kind, set, clear };
});
