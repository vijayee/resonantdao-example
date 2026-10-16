import { ref } from 'vue';

export type ThemeName = 'dark' | 'light';
const KEY = 'resonant-theme';

function initial(): ThemeName {
  if (typeof localStorage === 'undefined') return 'dark';
  const saved = localStorage.getItem(KEY);
  if (saved === 'dark' || saved === 'light') return saved;
  return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

const theme = ref<ThemeName>(initial());
document.documentElement.dataset.theme = theme.value;

export function useTheme() {
  return {
    theme,
    toggle() {
      theme.value = theme.value === 'dark' ? 'light' : 'dark';
      document.documentElement.dataset.theme = theme.value;
      try {
        localStorage.setItem(KEY, theme.value);
      } catch { /* storage may be blocked (privacy mode); theme still applies */ }
    },
  };
}
