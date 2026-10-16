# Frontend Re-platform (Vue 3 + resonantos design system) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Re-platform the client presentation layer onto Vue 3 SFCs styled with the resonantos.com design system, replacing the monolithic `ui.ts` dashboard with routed feature pages, with CRABS devtools available in dev runs.

**Architecture:** Vue 3 (`<script setup>` SFCs) + `vue-router` + `pinia` built by the existing Vite config. All op/signing/state logic stays in the untouched wasm wrappers (`dao.ts`, `server-client.ts`, `storage.ts`, `eauth-wallet.ts`); three Pinia stores own session, the `BrowserDao` lifecycle + server message wiring, and the status bar. Each legacy dashboard section becomes its own route page. Design tokens and font loading live under `client/src/design/`.

**Tech Stack:** Vue 3, vue-router 4, pinia 2, vite (`@vitejs/plugin-vue`), vue-tsc, self-hosted woff2 fonts (Fraunces / Space Grotesk / IBM Plex Mono), CRABS wasm + `bindings/devtools`.

Spec: `docs/superpowers/specs/2026-10-16-frontend-replatform-design.md`

---

## Selector-parity contract

The Playwright e2e (`test-voting-browser.js`) drives the app by selector. The following ids/classes MUST exist with the same semantics after the port (grep this list in every feature page):

- Auth: `#register-username`, `#register-password`, `#register-password-confirm`, `#register-form` (submit button inside).
- Shell: `#dashboard` (has class `hidden` while logged out), `#status`, `#username`, `#token-balance`, `#logout`, header nav links with `href="/proposals"`, `/elections`, `/contribute`, `/round`, `/custodians`.
- Proposals: `#proposal-form`, `#proposal-type`, `#proposal-title`, `#proposal-description`, `#proposal-options`, `.salient-dim[value="1|2|18"]` checkboxes, `.proposal-card`, `.proposal-card__title`, `.proposal-card__id`, `.vote-stat__value`, `.vote-option`.
- Elections: `#start-election`, `#election-area`, `.ballot-option`, `.finalize-election`, `#custodians .member-item__badge`, `.remove-member`, `[data-member-rct="<user>"]` (element whose text is `N RCT`).
- Contribute: `#contribution-step-1` fieldset, `input[name="contrib-dim"][value="1|2"]`, `#contribution-summary`, `#contribution-evidence-text`, `#contribution-evidence-file`, `#contribution-form`, `.contribution-card`, `.contribution-pill` (text `pending|accepted|rejected|appealed`), `.contribution-step--current` (text includes `(d/r)`), `.verify-contribution` (title `Your checks: X (Y upheld)`, label `Verify…` / `Verify (2nd)`), `.settle-contribution`, `.appeal-contribution`, `.contribution-card__harm`, `#contributions-list`.
- Round: `.round-label` (starts `Round N`), `.round-step`, `#round-stepper`, `#audit-round-btn`, `#reckon-round-btn`, `#complete-round-btn` (gated by class `hidden`, always in DOM).

Status-bar strings are also load-bearing (the test greps `Vote error`, `key_stale`, `Failed to apply update`, `Election finalized.`, `removed from the DAO.`, `Not` nothing). Port every `setStatus` string verbatim.

Native `prompt()`/`confirm()` flows stay (verify harm-choice, settle/appeal/audit reasons) — the e2e arms dialog handlers keyed to their prompt texts:

- `confirm('Close the round as FAIR? OK = fair, Cancel = UNFAIR (records the round debt and skips aggregation).')`
- `prompt('Accept this contribution? Type: yes / yes-harm (reduced) / voided / no. (Cancel = nothing)')`
- `prompt('Written reason for your verification (recorded permanently):')`
- `prompt('Settlement note (recorded permanently):')`, `prompt('Appeal reason (recorded permanently):')`
- `prompt('Audit note (recorded permanently):')`, `prompt('Reckoning note (recorded permanently):')`

## Final file layout (all paths relative to repo root)

```
Created:
  scripts/fetch-fonts.sh
  client/public/fonts/{fraunces-var,fraunces-var-italic,space-grotesk-var,ibm-plex-mono-400,ibm-plex-mono-500}.woff2
  client/src/design/tokens.css
  client/src/design/base.css
  client/src/design/composables/use-theme.ts
  client/src/design/components/{Panel,SectionHeading,VerdictSplit,Pill,NumLabel}.vue
  client/src/app/App.vue
  client/src/app/router.ts
  client/src/stores/status.ts
  client/src/stores/dao.ts
  client/src/stores/auth.ts
  client/src/components/status/StatusBar.vue
  client/src/components/auth/AuthView.vue
  client/src/components/feed/FeedPlaceholder.vue
  client/src/components/account/AccountPlaceholder.vue
  client/src/components/proposals/ProposalsPage.vue
  client/src/components/proposals/ProposalCard.vue
  client/src/components/elections/ElectionsPage.vue
  client/src/components/contribute/ContributePage.vue
  client/src/components/contribute/ContributionCard.vue
  client/src/components/round/RoundPage.vue
  client/src/components/custodians/CustodiansPage.vue
Modified:
  package.json (deps + typecheck script)
  client/vite.config.ts (vue plugin)
  client/tsconfig.json (vue + vite/client types)
  client/src/types.d.ts (vue shim + window surface)
  client/index.html (Vue shell)
  client/src/main.ts (Vue boot)
  client/src/crabs-wasm-wrapper.ts (dev module preference)
  scripts/copy-wasm.sh (dev artifact set)
  .gitignore (fonts/dist artifacts)
  test-voting-browser.js (route navigation)
Deleted:
  client/src/ui.ts
  client/src/theme.css
```

Every task ends `cd`-independent: run all npm commands from the repo root.

---

## Task 1: Dependencies + self-hosted fonts

**Files:**
- Modify: `package.json`, `package-lock.json`
- Create: `scripts/fetch-fonts.sh`
- Create (generated, committed): `client/public/fonts/*.woff2` (5 files)
- Create: `.gitignore` entries

- [ ] **Step 1: install runtime + tooling deps**

```bash
npm install vue@^3.5.0 vue-router@^4.4.0 pinia@^2.2.6
npm install -D @vitejs/plugin-vue@^5.2.0 vue-tsc@^2.1.0
```

- [ ] **Step 2: add the client typecheck script** to `package.json` `"scripts"`:

```json
"typecheck:client": "vue-tsc --noEmit -p client/tsconfig.json"
```

- [ ] **Step 3: write `scripts/fetch-fonts.sh`** (downloads the latin subset woff2 files Google would otherwise serve via CDN; parses the v2 CSS API).

```bash
#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
DEST=client/public/fonts
mkdir -p "$DEST"
# Chrome UA so the CSS API answers with variable woff2.
UA='Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36'

python3 - <<'PY'
import re, os, sys, urllib.request

ua = os.environ.get('FONT_UA', 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36')
families = {
    # Fraunces variable (upright + italic at opsz 9..144)
    'fraunces-var': 'https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,300..400&display=swap',
    'fraunces-var-italic': 'https://fonts.googleapis.com/css2?family=Fraunces:ital,opsz,wght@1,9..144,300..400&display=swap',
    'space-grotesk-var': 'https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@300..700&display=swap',
    'ibm-plex-mono-400': 'https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400&display=swap',
    'ibm-plex-mono-500': 'https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@500&display=swap',
}

def fetch(url, binary=False):
    req = urllib.request.Request(url, headers={'User-Agent': ua})
    with urllib.request.urlopen(req, timeout=60) as r:
        return r.read() if binary else r.read().decode()

for name, css_url in families.items():
    css = fetch(css_url)
    # Google splits each family into unicode-range blocks; keep the latin one.
    blocks = re.findall(r'/\* ([a-z0-9-]+) \*/\s*@font-face \{(.*?)\}', css, re.S)
    latin = next((body for subset, body in blocks if subset == 'latin'), None)
    if not latin:
        m = re.search(r'url\((https://[^)]+\.woff2)\)', css)
        url = m.group(1)
    else:
        url = re.search(r'url\((https://[^)]+\.woff2)\)', latin).group(1)
    data = fetch(url, binary=True)
    out = f'client/public/fonts/{name}.woff2'
    with open(out, 'wb') as f:
        f.write(data)
    print(f'{out}: {len(data)} bytes')
PY
echo "fonts fetched to $DEST"
```

- [ ] **Step 4: run it**

Run: `bash scripts/fetch-fonts.sh`
Expected: five `client/public/fonts/*.woff2` lines, each ≥ 20 kB, exit 0. If the network refuses: report it, do NOT substitute CDN loading — retry before merge (spec fallback = system stacks only as last resort, documented in the PR).

- [ ] **Step 5: gitignore the dev wasm artifacts dir (created later in Task 13)**

Append to `.gitignore`:

```
client/dev-wasm/
```

- [ ] **Step 6: commit**

```bash
git add package.json package-lock.json scripts/fetch-fonts.sh client/public/fonts .gitignore
git commit -m "build: vue deps + fetch-fonts script + self-hosted woff2 fonts"
```

---

## Task 2: Design tokens + base layer

**Files:**
- Create: `client/src/design/tokens.css`, `client/src/design/base.css`

- [ ] **Step 1: write `client/src/design/tokens.css`** — both theme blocks ported from resonantos.com (source of truth; values verbatim).

```css
/* Design tokens ported from resonantos.com (2026-10-16).
   Dark is the application default; [data-theme="light"] overrides. */
:root {
  --font-display: "Fraunces", Georgia, serif;
  --font-body: "Space Grotesk", system-ui, sans-serif;
  --font-mono: "IBM Plex Mono", ui-monospace, SFMono-Regular, Menlo, monospace;

  --bg-a: #0c1f15;
  --bg-b: #0a1b12;
  --bg-c: #0c1f15;
  --ink: #e4efe4;
  --ink-soft: #c9dcc9;
  --muted: #8fae97;
  --faint: #5d7f6c;
  --jade: #5fd0a0;
  --jade-2: #8fe0b8;
  --amber: #e8a84c;
  --danger: #e2807e;
  --line: rgba(95, 208, 160, .16);
  --line-strong: rgba(95, 208, 160, .45);
  --panel: rgba(22, 46, 34, .72);
  --panel-solid: #162e22;
  --glass: rgba(10, 25, 17, .6);
  --card-bg: linear-gradient(160deg, rgba(95, 208, 160, .07), rgba(232, 168, 76, .04));
  --cta-ink: #0c1f15;
  --grid-line: rgba(95, 208, 160, .05);

  --radius: 12px;
  --radius-lg: 18px;
  --max-width: 1120px;
  --space-1: .25rem; --space-2: .5rem; --space-3: .75rem; --space-4: 1rem;
  --space-5: 1.25rem; --space-6: 1.5rem; --space-8: 2rem; --space-10: 2.5rem; --space-12: 3rem;
  --transition: .25s;
}

[data-theme="light"] {
  --bg-a: #f7f4ea;
  --bg-b: #fbfaf3;
  --bg-c: #f2eee0;
  --ink: #1c3a2c;
  --ink-soft: #3d5549;
  --muted: #5c6f63;
  --faint: #8a988e;
  --jade: #0f7a56;
  --jade-2: #129465;
  --amber: #a8690f;
  --danger: #b3403c;
  --line: rgba(12, 100, 70, .22);
  --line-strong: rgba(12, 100, 70, .5);
  --panel: rgba(255, 255, 255, .72);
  --panel-solid: #ffffff;
  --glass: rgba(255, 255, 255, .78);
  --card-bg: linear-gradient(160deg, rgba(15, 122, 86, .06), rgba(168, 105, 15, .05));
  --cta-ink: #f7f4ea;
  --grid-line: rgba(12, 100, 70, .06);
}
```

- [ ] **Step 2: write `client/src/design/base.css`** — resets, font faces, page background, shared utilities. The `--danger` token formalizes what the old palette had no warn color for; harm/amber usage is unchanged.

```css
@font-face {
  font-family: "Fraunces";
  src: url("/fonts/fraunces-var.woff2") format("woff2-variations");
  font-weight: 300 400;
  font-style: normal;
  font-display: swap;
}
@font-face {
  font-family: "Fraunces";
  src: url("/fonts/fraunces-var-italic.woff2") format("woff2-variations");
  font-weight: 300 400;
  font-style: italic;
  font-display: swap;
}
@font-face {
  font-family: "Space Grotesk";
  src: url("/fonts/space-grotesk-var.woff2") format("woff2-variations");
  font-weight: 300 700;
  font-style: normal;
  font-display: swap;
}
@font-face {
  font-family: "IBM Plex Mono";
  src: url("/fonts/ibm-plex-mono-400.woff2") format("woff2");
  font-weight: 400;
  font-style: normal;
  font-display: swap;
}
@font-face {
  font-family: "IBM Plex Mono";
  src: url("/fonts/ibm-plex-mono-500.woff2") format("woff2");
  font-weight: 500;
  font-style: normal;
  font-display: swap;
}

*, *::before, *::after { box-sizing: border-box; }
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: .01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: .01ms !important;
  }
}

html { scroll-behavior: smooth; }
html, body { margin: 0; padding: 0; }

body {
  font-family: var(--font-body);
  background:
    radial-gradient(ellipse 70% 55% at 85% -10%, rgba(95, 208, 160, .14), transparent 60%),
    radial-gradient(ellipse 60% 50% at -10% 105%, rgba(232, 168, 76, .09), transparent 60%),
    linear-gradient(180deg, var(--bg-a) 0%, var(--bg-b) 50%, var(--bg-c) 100%);
  background-attachment: fixed;
  color: var(--ink);
  line-height: 1.6;
  min-height: 100vh;
  -webkit-font-smoothing: antialiased;
}
[data-theme="light"] body {
  background:
    radial-gradient(ellipse 70% 55% at 85% -10%, rgba(15, 122, 86, .08), transparent 60%),
    radial-gradient(ellipse 60% 50% at -10% 105%, rgba(168, 105, 15, .06), transparent 60%),
    linear-gradient(180deg, var(--bg-a) 0%, var(--bg-b) 50%, var(--bg-c) 100%);
  background-attachment: fixed;
}
body::before {
  content: "";
  position: fixed; inset: 0; z-index: -1; pointer-events: none;
  background-image:
    linear-gradient(var(--grid-line) 1px, transparent 1px),
    linear-gradient(90deg, var(--grid-line) 1px, transparent 1px);
  background-size: 72px 72px;
  -webkit-mask-image: radial-gradient(ellipse 90% 65% at 50% 0%, black 25%, transparent 75%);
  mask-image: radial-gradient(ellipse 90% 65% at 50% 0%, black 25%, transparent 75%);
}

h1, h2, h3 { font-family: var(--font-display); font-weight: 300; letter-spacing: -.015em; line-height: 1.08; margin: 0; }
p { margin: 0; }
a { color: inherit; text-decoration: none; }

.wrap { max-width: var(--max-width); margin: 0 auto; padding: 0 22px; }
.app-main { flex: 1; width: 100%; max-width: var(--max-width); margin: 0 auto; padding: var(--space-10) var(--space-6); }

.mono { font-family: var(--font-mono); }
.jade { color: var(--jade); }
.amber { color: var(--amber); }
.muted { color: var(--muted); font-size: .8125rem; }
.glow { background: linear-gradient(100deg, var(--jade), var(--jade-2), var(--amber)); -webkit-background-clip: text; background-clip: text; -webkit-text-fill-color: transparent; }

.eyebrow { font-family: var(--font-mono); font-size: .72rem; letter-spacing: .24em; text-transform: uppercase; color: var(--jade); display: block; }

::selection { background: rgba(95, 208, 160, .25); }

.hidden { display: none !important; }
.sr-only {
  position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px;
  overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0;
}

.empty-state {
  color: var(--muted); font-size: .875rem; padding: var(--space-8) var(--space-4);
  text-align: center; border: 1px dashed var(--line); border-radius: var(--radius);
}

/* Shared form controls (legacy .form-input API, new skin). */
.form-input {
  background: var(--glass);
  border: 1px solid var(--line);
  border-radius: 100px;
  color: var(--ink);
  font-family: var(--font-body);
  font-size: .95rem;
  padding: var(--space-3) var(--space-4);
  transition: border-color var(--transition), box-shadow var(--transition);
  width: 100%;
}
.form-input:hover { border-color: var(--line-strong); }
.form-input:focus { outline: none; border-color: var(--jade); box-shadow: 0 0 0 2px rgba(95, 208, 160, .18); }
.form-input::placeholder { color: var(--faint); }
select.form-input { border-radius: var(--radius); }

/* Shared buttons (legacy variants, new skin). */
.button {
  display: inline-flex; align-items: center; justify-content: center; gap: 8px; min-height: 44px;
  padding: .7rem 1.4rem; border-radius: 100px; font-family: var(--font-mono); font-size: .85rem;
  letter-spacing: .04em; font-weight: 500; cursor: pointer;
  transition: all var(--transition); border: 1px solid transparent;
}
.button:disabled { opacity: .45; cursor: not-allowed; }
.button:focus-visible { outline: 2px solid var(--jade); outline-offset: 2px; }
.button--primary { background: linear-gradient(100deg, var(--jade), var(--jade-2)); color: var(--cta-ink); box-shadow: 0 0 24px rgba(95, 208, 160, .25); }
.button--primary:hover:not(:disabled) { box-shadow: 0 0 44px rgba(95, 208, 160, .5); transform: translateY(-1px); }
.button--secondary { border-color: var(--line); color: var(--ink-soft); background: var(--glass); }
.button--secondary:hover:not(:disabled) { border-color: var(--line-strong); color: var(--jade); }
.button--danger { border-color: rgba(226, 128, 126, .4); color: var(--danger); background: transparent; }
.button--danger:hover:not(:disabled) { border-color: var(--danger); }
.button--small { min-height: 36px; padding: .35rem 1rem; font-size: .78rem; }

.form-group { display: flex; flex-direction: column; gap: var(--space-1); }
.form-label { font-size: .85rem; font-weight: 500; color: var(--muted); }
.proposal-form { display: flex; flex-direction: column; gap: var(--space-4); }
.proposal-form__actions { display: flex; justify-content: flex-end; gap: var(--space-3); flex-wrap: wrap; }
```

- [ ] **Step 3: verify the build still passes (files are inert until imported)**

Run: `npm run build:client`
Expected: succeeds (unchanged legacy app; new files unreferenced).

- [ ] **Step 4: commit**

```bash
git add client/src/design/tokens.css client/src/design/base.css
git commit -m "feat(design): resonantos.com tokens + base layer (dual theme)"
```

---

## Task 3: Theme composable + design components

**Files:**
- Create: `client/src/design/composables/use-theme.ts`
- Create: `client/src/design/components/Panel.vue`, `SectionHeading.vue`, `VerdictSplit.vue`, `Pill.vue`, `NumLabel.vue`

- [ ] **Step 1: write `use-theme.ts`**

```ts
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
      localStorage.setItem(KEY, theme.value);
    },
  };
}
```

- [ ] **Step 2: write `Panel.vue`** — glass/gradient card with optional numbered kicker.

```vue
<template>
  <section class="panel" :class="[`panel--${variant}`]">
    <div v-if="number || kicker" class="panel__tag">
      <span v-if="number" class="panel__no">{{ number }}</span>
      <span v-if="kicker" class="panel__kicker">{{ kicker }}</span>
      <slot name="tag" />
    </div>
    <slot />
  </section>
</template>

<script setup lang="ts">
withDefaults(defineProps<{ variant?: 'plain' | 'ok' | 'x'; number?: string; kicker?: string }>(), { variant: 'plain' });
</script>

<style scoped>
.panel {
  border: 1px solid var(--line);
  border-radius: var(--radius-lg);
  padding: 26px 22px;
  background: var(--card-bg);
  -webkit-backdrop-filter: blur(8px);
  backdrop-filter: blur(8px);
  transition: border-color .3s;
}
.panel:hover { border-color: var(--line-strong); }
.panel--x { border-color: rgba(226, 128, 126, .3); }
.panel__tag {
  font-family: var(--font-mono);
  font-size: .7rem;
  letter-spacing: .2em;
  text-transform: uppercase;
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 16px;
}
.panel__no { color: var(--amber); letter-spacing: .24em; }
.panel__kicker { color: var(--muted); }
</style>
```

- [ ] **Step 3: write `SectionHeading.vue`**

```vue
<template>
  <div class="sec-head">
    <span class="eyebrow"><span v-if="number" class="sec-head__no">{{ number }}</span>{{ eyebrow }}</span>
    <h2 class="sec-head__title"><slot><em>{{ title }}</em></slot></h2>
    <p v-if="lede" class="sec-head__lede"><slot name="lede">{{ lede }}</slot></p>
  </div>
</template>

<script setup lang="ts">
defineProps<{ eyebrow: string; title?: string; lede?: string; number?: string }>();
</script>

<style scoped>
.sec-head { margin-bottom: var(--space-8); }
.sec-head__no { color: var(--amber); margin-right: 14px; letter-spacing: .24em; }
.sec-head__title { font-size: clamp(1.9rem, 3.8vw, 3rem); max-width: 24ch; }
.sec-head__title :deep(em) { font-style: italic; color: var(--ink); }
.sec-head__lede { margin-top: var(--space-4); max-width: 56ch; color: var(--ink-soft); font-size: 1.05rem; line-height: 1.65; }
</style>
```

- [ ] **Step 4: write `VerdictSplit.vue`**

```vue
<template>
  <div class="verdict">
    <Panel variant="x" :kicker="xTitle">
      <ul class="verdict__list">
        <li v-for="item in xItems" :key="item"><span class="verdict__mk verdict__mk--x">✕</span><span v-html="item" /></li>
      </ul>
    </Panel>
    <Panel variant="ok" :kicker="okTitle">
      <ul class="verdict__list">
        <li v-for="item in okItems" :key="item"><span class="verdict__mk verdict__mk--ok">✓</span><span v-html="item" /></li>
      </ul>
    </Panel>
  </div>
</template>

<script setup lang="ts">
import Panel from './Panel.vue';
defineProps<{ xTitle: string; okTitle: string; xItems: string[]; okItems: string[] }>();
</script>

<style scoped>
.verdict { display: grid; grid-template-columns: 1fr; gap: 16px; }
@media (min-width: 720px) { .verdict { grid-template-columns: 1fr 1fr; } }
.verdict__list { list-style: none; margin-top: 16px; display: grid; gap: 10px; padding: 0; }
.verdict__list li { display: flex; gap: 10px; align-items: baseline; color: var(--ink-soft); font-size: .95rem; }
.verdict__mk { font-family: var(--font-mono); flex: 0 0 auto; }
.verdict__mk--x { color: var(--danger); }
.verdict__mk--ok { color: var(--jade); }
</style>
```

Note: `v-html` renders `<b>` emphasis in items only from static page-local constants, never user input — keep it that way (XSS).

- [ ] **Step 5: write `Pill.vue`**

```vue
<template>
  <span class="pill" :class="`pill--${kind}`"><slot /></span>
</template>

<script setup lang="ts">
withDefaults(defineProps<{ kind?: 'neutral' | 'jade' | 'amber' | 'danger' }>(), { kind: 'neutral' });
</script>

<style scoped>
.pill {
  font-family: var(--font-mono);
  font-size: .75rem; font-weight: 500;
  letter-spacing: .06em;
  border-radius: 100px;
  padding: .25rem .8rem;
  white-space: nowrap;
}
.pill--neutral { color: var(--muted); border: 1px solid var(--line); background: var(--glass); }
.pill--jade { color: var(--jade); border: 1px solid rgba(95, 208, 160, .5); }
.pill--amber { color: var(--amber); border: 1px solid rgba(232, 168, 76, .5); }
.pill--danger { color: var(--danger); border: 1px solid rgba(226, 128, 126, .5); }
</style>
```

- [ ] **Step 6: write `NumLabel.vue`**

```vue
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
```

- [ ] **Step 7: typecheck**

Run: `npm run typecheck:client`
Expected: passes (vue-tsc compiles the new .vue files; unreferenced files still type-check).

- [ ] **Step 8: commit**

```bash
git add client/src/design
git commit -m "feat(design): useTheme composable + motif components (Panel, SectionHeading, VerdictSplit, Pill, NumLabel)"
```

---

## Task 4: Status store, dao store (server wiring + all op actions)

The dao store ports every `on*` handler body from `client/src/ui.ts` (the source of record for this task — open it alongside). Strings must be byte-identical.

**Files:**
- Create: `client/src/stores/status.ts`, `client/src/stores/dao.ts`
- Modify: `client/src/types.d.ts` (window surface for the devtools task)

- [ ] **Step 1: write `client/src/stores/status.ts`**

```ts
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
```

- [ ] **Step 2: append the window surface to `client/src/types.d.ts`** (devtools globals are typed now, created in Task 13; `*.vue` shim for vue-tsc):

Add at the end of `client/src/types.d.ts`:

```ts
declare module '*.vue' {
  import type { DefineComponent } from 'vue';
  const component: DefineComponent<Record<string, never>, Record<string, never>, unknown>;
  export default component;
}

interface Window {
  createCRABSModule?: () => Promise<unknown>;
  createCRABSModuleDev?: () => Promise<unknown>;
  CRABSDevtools?: { attach: (node: unknown, options?: { nodeId?: string; mount?: Element }) => unknown };
  CRABSDevtoolsApi?: unknown;
}
```

(If `client/src/types.d.ts` already carries content, keep it and append.)

- [ ] **Step 3: write `client/src/stores/dao.ts`** — ports ui.ts's server message wiring, demo clock, replay, and every op action verbatim.

```ts
import { ref, computed } from 'vue';
import { defineStore } from 'pinia';
import {
  ProposalPayload, VotePayload, ExecutePayload, StartElectionPayload, AppealVerdictPayload,
  SettleContributionPayload, VerifyContributionPayload,
  ServerMessage,
} from '@shared/types';
import {
  EvidenceRef, HarmVerdict, SCHEMA_VERSION,
} from '@shared/contribution';
import { RECIP_NAMES, RES_CONFIG } from '@shared/policies';
import { BrowserDao, ContributionMirrorEntry, bytesToBase64, base64ToBytes } from '../dao';
import { ServerClient } from '../server-client';
import { useStatusStore } from './status';

export const serverClient = new ServerClient();

// Uniform sha-256 for both evidence paths: stored files and text pointers.
async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as unknown as ArrayBuffer);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

export const useDaoStore = defineStore('dao', () => {
  const status = useStatusStore();

  const dao = ref<BrowserDao | null>(null);
  const username = ref('');
  const submitting = ref(false);
  const tick = ref(0);
  const members = ref<string[]>([]);

  const authed = computed(() => dao.value !== null);
  const custodians = computed(() => dao.value?.custodians ?? []);
  const isCustodian = computed(() => authed.value && custodians.value.includes(username.value));

  let clock: ReturnType<typeof setInterval> | null = null;

  function pulse() {
    dao.value?.setTime(Date.now());
    tick.value += 1;
  }
  function startClock() {
    stopClock();
    pulse();
    clock = setInterval(pulse, 1000);
  }
  function stopClock() {
    if (clock) {
      clearInterval(clock);
      clock = null;
    }
  }

  async function safeExecuteRemote(bytes: Uint8Array) {
    if (!dao.value) return;
    try {
      await dao.value.executeRemote(bytes);
    } catch (err) {
      if (
        err instanceof Error &&
        (
          err.message.includes('duplicate_operation') ||
          err.message.includes('already_executed') ||
          err.message.includes('unauthorized') ||
          err.message.includes('key_stale')
        )
      ) {
        return;
      }
      throw err;
    }
  }

  async function replayLog(target: BrowserDao) {
    const logMsg = await serverClient.getLog(0);
    if (logMsg.kind !== 'log') return;
    for (const stored of logMsg.operations) {
      try {
        await safeExecuteRemote(base64ToBytes(stored.bytes));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        status.set(`State sync failed: ${message}`, 'error');
        return;
      }
    }
  }

  // Owns the BrowserDao lifecycle. The devtools attach point (Task 13) hooks
  // here, after Node.create, guarded by import.meta.env.DEV.
  async function bootstrap(target: BrowserDao, user: string) {
    dao.value = target;
    username.value = user;
    startClock();
  }

  function teardown() {
    stopClock();
    dao.value?.destroy();
    dao.value = null;
    username.value = '';
    members.value = [];
    submitting.value = false;
    votedProposals.value = [];
  }

  async function handleServerMessage(msg: ServerMessage) {
    if (msg.kind === 'broadcast') {
      try {
        await safeExecuteRemote(base64ToBytes(msg.operation.bytes));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        status.set(`Failed to apply update: ${message}`, 'error');
      }
    } else if (msg.kind === 'members') {
      members.value = msg.users.map((user) => user.username);
      for (const user of msg.users) {
        if (user.username !== username.value && dao.value) {
          dao.value.registerMember(user.username, user.publicKeyHex, user.keyVersion);
        }
      }
    } else if (msg.kind === 'op_rejected') {
      status.set(`Rejected: ${msg.reason}`, 'error');
    } else if (msg.kind === 'error') {
      status.set(`Error: ${msg.message}`, 'error');
    }
  }
  serverClient.onMessage((msg) => void handleServerMessage(msg));

  // ---- proposal ops (ported verbatim from ui.ts) ----

  async function createProposal(payload: ProposalPayload) {
    if (!dao.value || submitting.value) return;
    submitting.value = true;
    try {
      const bytes = await dao.value.createProposal(username.value, payload);
      await serverClient.submitOp(bytesToBase64(bytes));
      await safeExecuteRemote(bytes);
      status.set('Proposal created.', 'success');
    } catch (err) {
      status.set(`Create proposal error: ${err instanceof Error ? err.message : String(err)}`, 'error');
      console.error(err);
    } finally {
      submitting.value = false;
    }
  }

  const votedProposals = ref<string[]>([]);

  async function vote(proposalId: string, choice: number) {
    if (!dao.value || submitting.value) return;
    const payload: VotePayload = { proposalId, choice };
    submitting.value = true;
    try {
      const bytes = await dao.value.vote(username.value, payload);
      await serverClient.submitOp(bytesToBase64(bytes));
      await safeExecuteRemote(bytes);
      if (dao.value.getProposalType(proposalId) === 'direct') {
        if (!votedProposals.value.includes(proposalId)) votedProposals.value.push(proposalId);
      }
      status.set(`Voted.`, 'success');
    } catch (err) {
      status.set(`Vote error: ${err instanceof Error ? err.message : String(err)}`, 'error');
      console.error(err);
    } finally {
      submitting.value = false;
    }
  }

  async function execute(proposalId: string) {
    if (!dao.value || submitting.value) return;
    submitting.value = true;
    try {
      const bytes = await dao.value.execute(username.value, { proposalId });
      await serverClient.submitOp(bytesToBase64(bytes));
      await safeExecuteRemote(bytes);
      status.set('Execution submitted.', 'success');
    } catch (err) {
      status.set(`Execute error: ${err instanceof Error ? err.message : String(err)}`, 'error');
      console.error(err);
    } finally {
      submitting.value = false;
    }
  }

  // ---- election ops ----

  async function startElection(candidates: string[]) {
    if (!dao.value || submitting.value) return;
    const payload: StartElectionPayload = {
      electionId: crypto.randomUUID(),
      candidates,
      expiresAt: dao.value.getNodeTimeMs() + 60 * 1000,
    };
    submitting.value = true;
    try {
      const bytes = await dao.value.startElection(username.value, payload);
      await serverClient.submitOp(bytesToBase64(bytes));
      await safeExecuteRemote(bytes);
      status.set('Election started.', 'success');
    } catch (err) {
      status.set(`Election error: ${err instanceof Error ? err.message : String(err)}`, 'error');
      console.error(err);
    } finally {
      submitting.value = false;
    }
  }

  async function castBallot(electionId: string, picks: string[]) {
    if (!dao.value || submitting.value) return;
    submitting.value = true;
    try {
      const bytes = await dao.value.castBallot(username.value, { electionId, picks });
      await serverClient.submitOp(bytesToBase64(bytes));
      await safeExecuteRemote(bytes);
      status.set('Ballot cast.', 'success');
    } catch (err) {
      status.set(`Ballot error: ${err instanceof Error ? err.message : String(err)}`, 'error');
      console.error(err);
    } finally {
      submitting.value = false;
    }
  }

  async function finalizeElection(electionId: string, candidates: string[]) {
    if (!dao.value || submitting.value) return;
    submitting.value = true;
    try {
      const bytes = await dao.value.finalizeElection(username.value, { electionId, candidates });
      await serverClient.submitOp(bytesToBase64(bytes));
      await safeExecuteRemote(bytes);
      status.set('Election finalized.', 'success');
    } catch (err) {
      status.set(`Finalize error: ${err instanceof Error ? err.message : String(err)}`, 'error');
      console.error(err);
    } finally {
      submitting.value = false;
    }
  }

  async function castRunoffVote(electionId: string, candidate: string) {
    if (!dao.value || submitting.value) return;
    submitting.value = true;
    try {
      const bytes = await dao.value.castRunoffVote(username.value, { electionId, candidate });
      await serverClient.submitOp(bytesToBase64(bytes));
      await safeExecuteRemote(bytes);
      status.set(`Runoff vote cast for ${candidate}.`, 'success');
    } catch (err) {
      status.set(`Runoff error: ${err instanceof Error ? err.message : String(err)}`, 'error');
      console.error(err);
    } finally {
      submitting.value = false;
    }
  }

  // ---- contribution ops ----

  async function submitContribution(payload: {
    contributionId: string;
    dims: Record<string, number>;
    summary: string;
    evidenceRef: EvidenceRef;
    schemaVersion: typeof SCHEMA_VERSION;
  }) {
    if (!dao.value || submitting.value) return;
    submitting.value = true;
    try {
      const bytes = await dao.value.submitContribution(username.value, payload);
      await serverClient.submitOp(bytesToBase64(bytes));
      await safeExecuteRemote(bytes);
      status.set('Contribution submitted — awaiting verification.', 'success');
    } catch (err) {
      status.set(`Contribution error: ${err instanceof Error ? err.message : String(err)}`, 'error');
      console.error(err);
    } finally {
      submitting.value = false;
    }
  }

  // Verify flow (ported): no-self verify, distinct-actor + reciprocity bars,
  // harm-choice prompt, mandatory written reason.
  async function verifyContribution(entry: ContributionMirrorEntry) {
    const d = dao.value;
    if (!d || submitting.value) return;
    if (entry.submitter === username.value) return;
    const prior = entry.verifiedBy ? [entry.verifiedBy] : [];
    if (prior.includes(username.value)) {
      status.set('You already verified this contribution.', 'error');
      return;
    }
    const verifier = username.value;
    if (
      d.node.setContains(RECIP_NAMES.verifiedBy(entry.submitter), verifier) ||
      d.node.setContains(RECIP_NAMES.verifiedBy(verifier), entry.submitter)
    ) {
      status.set('You already verified this submitter’s earlier work — reciprocity bars re-verification.', 'error');
      return;
    }
    const choice = prompt('Accept this contribution? Type: yes / yes-harm (reduced) / voided / no. (Cancel = nothing)');
    if (choice === null) return;
    const normalized = choice.trim().toLowerCase();
    let pass = false;
    let harm: HarmVerdict = 'none';
    if (normalized === 'yes' || normalized === 'y') { pass = true; }
    else if (normalized === 'yes-harm' || normalized === 'reduced') { pass = true; harm = 'reduced'; }
    else if (normalized === 'voided') { pass = true; harm = 'voided'; }
    else if (normalized === 'no' || normalized === 'n') { pass = false; }
    else {
      status.set('Answer with yes / yes-harm / voided / no.', 'error');
      return;
    }
    const reason = prompt('Written reason for your verification (recorded permanently):') ?? '';
    if (!reason.trim()) {
      status.set('A written reason is required for every verification.', 'error');
      return;
    }
    const payload: VerifyContributionPayload = {
      contributionId: entry.record.contributionId,
      submitter: entry.submitter,
      dims: entry.record.dims,
      stepId: 'verify',
      pass,
      reason,
      harm,
      priorVerifiers: prior,
      ...(entry.verifiedBy ? { priorHarm: entry.harm ?? ('none' as HarmVerdict) } : {}),
    };
    submitting.value = true;
    try {
      const bytes = await d.verifyContribution(username.value, payload);
      await serverClient.submitOp(bytesToBase64(bytes));
      await safeExecuteRemote(bytes);
      status.set(`Verification recorded (+${RES_CONFIG.verificationCheckCredit} $RES).`, 'success');
    } catch (err) {
      status.set(`Verify error: ${err instanceof Error ? err.message : String(err)}`, 'error');
      console.error(err);
    } finally {
      submitting.value = false;
    }
  }

  async function settleContribution(entry: ContributionMirrorEntry) {
    const d = dao.value;
    if (!d || submitting.value || entry.submitter !== username.value) return;
    const reason = prompt('Settlement note (recorded permanently):') ?? '';
    if (!reason.trim()) {
      status.set('A written reason is required to settle.', 'error');
      return;
    }
    submitting.value = true;
    try {
      const bytes = await d.settleContribution(username.value, {
        contributionId: entry.record.contributionId,
        submitter: entry.submitter,
        reason,
        verifiers: entry.verifiers ?? [],
      });
      await serverClient.submitOp(bytesToBase64(bytes));
      await safeExecuteRemote(bytes);
      status.set('Contribution settled.', 'success');
    } catch (err) {
      status.set(`Settle error: ${err instanceof Error ? err.message : String(err)}`, 'error');
      console.error(err);
    } finally {
      submitting.value = false;
    }
  }

  async function appealContribution(entry: ContributionMirrorEntry) {
    const d = dao.value;
    if (!d || submitting.value || entry.submitter !== username.value) return;
    const reason = prompt('Appeal reason (recorded permanently):') ?? '';
    if (!reason.trim()) {
      status.set('A written reason is required to appeal.', 'error');
      return;
    }
    submitting.value = true;
    try {
      const bytes = await d.appealVerdict(username.value, {
        contributionId: entry.record.contributionId,
        submitter: entry.submitter,
        reason,
      });
      await serverClient.submitOp(bytesToBase64(bytes));
      await safeExecuteRemote(bytes);
      status.set('Appeal recorded — awaiting re-verification.', 'success');
    } catch (err) {
      status.set(`Appeal error: ${err instanceof Error ? err.message : String(err)}`, 'error');
      console.error(err);
    } finally {
      submitting.value = false;
    }
  }

  // ---- round-spine ops ----

  async function auditRound() {
    const d = dao.value;
    if (!d || submitting.value) return;
    const fair = confirm('Close the round as FAIR? OK = fair, Cancel = UNFAIR (records the round debt and skips aggregation).');
    const note = prompt('Audit note (recorded permanently):') ?? '';
    if (!note.trim()) {
      status.set('An audit note is required.', 'error');
      return;
    }
    submitting.value = true;
    try {
      const bytes = await d.auditRound(username.value, {
        fair,
        note,
        calibrationVersion: 'v1',
      });
      await serverClient.submitOp(bytesToBase64(bytes));
      await safeExecuteRemote(bytes);
      status.set(fair ? 'Round audited as fair.' : 'Round closed with a debt record; next round begins.', fair ? 'success' : 'error');
    } catch (err) {
      status.set(`Audit error: ${err instanceof Error ? err.message : String(err)}`, 'error');
      console.error(err);
    } finally {
      submitting.value = false;
    }
  }

  async function reckonRound() {
    const d = dao.value;
    if (!d || submitting.value) return;
    const note = prompt('Reckoning note (recorded permanently):') ?? '';
    if (!note.trim()) {
      status.set('A reckoning note is required.', 'error');
      return;
    }
    submitting.value = true;
    try {
      const bytes = await d.reckonRound(username.value, { note });
      await serverClient.submitOp(bytesToBase64(bytes));
      await safeExecuteRemote(bytes);
      status.set('Round reckoned — ready to complete.', 'success');
    } catch (err) {
      status.set(`Reckon error: ${err instanceof Error ? err.message : String(err)}`, 'error');
      console.error(err);
    } finally {
      submitting.value = false;
    }
  }

  async function completeRound() {
    const d = dao.value;
    if (!d || submitting.value) return;
    submitting.value = true;
    try {
      const currentRound = d.getCurrentRound();
      const entries = d.getContributions()
        .filter((entry) => d.getContributionStatus(entry.record.contributionId) === 'accepted'
          && d.getContributionRound(entry.record.contributionId) === currentRound)
        .map((entry) => ({ contributionId: entry.record.contributionId, submitter: entry.submitter, dims: entry.record.dims, harm: entry.harm ?? ('none' as const) }));
      if (entries.length === 0) {
        status.set('Nothing settled to aggregate in this round.', 'error');
        return;
      }
      const bytes = await d.completeRound(username.value, { entries });
      await serverClient.submitOp(bytesToBase64(bytes));
      await safeExecuteRemote(bytes);
      status.set(`Round published — ${entries.length} contribution(s) aggregated.`, 'success');
    } catch (err) {
      status.set(`Complete error: ${err instanceof Error ? err.message : String(err)}`, 'error');
      console.error(err);
    } finally {
      submitting.value = false;
    }
  }

  async function setRctAlpha(raw: Record<string, number>, version: string) {
    const d = dao.value;
    if (!d || submitting.value) return;
    submitting.value = true;
    try {
      const bytes = await d.setRctAlpha(username.value, { weights: raw, version });
      await serverClient.submitOp(bytesToBase64(bytes));
      await safeExecuteRemote(bytes);
      status.set('RCT weights updated.', 'success');
    } catch (err) {
      status.set(`Weights error: ${err instanceof Error ? err.message : String(err)}`, 'error');
      console.error(err);
    } finally {
      submitting.value = false;
    }
  }

  async function setCalibrationVersion() {
    const d = dao.value;
    if (!d || submitting.value) return;
    submitting.value = true;
    try {
      const bytes = await d.setCalibrationVersion(username.value, { version: 'v1' });
      await serverClient.submitOp(bytesToBase64(bytes));
      await safeExecuteRemote(bytes);
      status.set('Calibration version set to v1.', 'success');
    } catch (err) {
      status.set(`Calibration error: ${err instanceof Error ? err.message : String(err)}`, 'error');
      console.error(err);
    } finally {
      submitting.value = false;
    }
  }

  async function removeMember(target: string) {
    const d = dao.value;
    if (!d || submitting.value || target === username.value) return;
    submitting.value = true;
    try {
      const bytes = await d.removeMember(username.value, { username: target });
      await serverClient.submitOp(bytesToBase64(bytes));
      await safeExecuteRemote(bytes);
      members.value = members.value.filter((m) => m !== target);
      status.set(`${target} removed from the DAO.`, 'success');
    } catch (err) {
      status.set(`Remove error: ${err instanceof Error ? err.message : String(err)}`, 'error');
      console.error(err);
    } finally {
      submitting.value = false;
    }
  }

  function evidenceSummary(ref: EvidenceRef): string {
    if (ref.uri.startsWith('content://')) return `stored evidence (${(ref.size / 1024).toFixed(1)} KB, ${ref.mediaType})`;
    return `pointer: ${ref.uri}`;
  }

  return {
    dao, username, submitting, tick, members, authed, custodians, isCustodian,
    votedProposals,
    bootstrap, teardown, replayLog,
    createProposal, vote, execute,
    startElection, castBallot, finalizeElection, castRunoffVote,
    submitContribution, verifyContribution, settleContribution, appealContribution,
    auditRound, reckonRound, completeRound, setRctAlpha, setCalibrationVersion,
    removeMember,
    evidenceSummary,
  };
});
```

The `replayLog` export is consumed by the auth store in Task 5.

- [ ] **Step 4: typecheck**

Run: `npm run typecheck:client`
Expected: passes.

- [ ] **Step 5: commit**

```bash
git add client/src/stores client/src/types.d.ts
git commit -m "feat(stores): status + dao stores — ported server wiring, demo clock, all op actions"
```

---

## Task 5: Auth store + AuthView (the auth screen port, including the username fix)

**Files:**
- Create: `client/src/stores/auth.ts`, `client/src/components/auth/AuthView.vue`

- [ ] **Step 1: write `client/src/stores/auth.ts`** — ports `onRegister`, `onLogin`, `onLogout` from ui.ts verbatim (strings byte-identical).

```ts
import { ref, computed } from 'vue';
import { defineStore } from 'pinia';
import type { PublicUser } from '@shared/types';
import { BrowserDao, bytesToHex } from '../dao';
import { registerWallet, loginWallet } from '../eauth-wallet';
import {
  saveLoginBundle, loadLoginBundle, saveWalletState, loadWalletState,
  importWalletState, WalletState,
} from '../storage';
import { loadCRABS } from '../wasm';
import { serverClient, useDaoStore } from './dao';
import { useStatusStore } from './status';

export const useAuthStore = defineStore('auth', () => {
  const status = useStatusStore();
  const wallet = ref<WalletState | null>(null);
  const authed = computed(() => useDaoStore().authed);

  async function register(
    usernameRaw: string,
    password: string,
    confirmPassword: string
  ): Promise<boolean> {
    const daoStore = useDaoStore();
    // Strip invisible characters (zero-width spaces/joiners, soft hyphen,
    // variation selectors) that ride in on pastes and defeat trim(). Without
    // this a username like "victor​" reads as "victor" to the user but
    // fails the CRABS id charset check.
    const username = usernameRaw
      .replace(/[\u{200B}-\u{200F}\u{2060}-\u{2064}\u{FEFF}\u{00AD}\u{180E}]/gu, '')
      .trim();
    if (!username || !password) {
      status.set('Username and password are required.', 'error');
      return false;
    }
    // CRABS user ids reject dots, spaces, and other punctuation.
    if (!/^[A-Za-z0-9_-]+$/.test(username)) {
      // Quote the value with invisible characters exposed so the exact
      // offender is visible (e.g. a stray non-breaking space from autofill).
      const shown = JSON.stringify(username);
      status.set(`Username ${shown} (length ${username.length}) — letters, numbers, underscores, dashes only.`, 'error');
      return false;
    }
    if (password.length < 8) {
      status.set('Password must be at least 8 characters.', 'error');
      return false;
    }
    if (password !== confirmPassword) {
      status.set('Passwords do not match.', 'error');
      return false;
    }
    try {
      status.set('Registering wallet...', 'loading');
      const bundle = await registerWallet(username, password);
      const crabs = await loadCRABS();
      const publicKeyHex = await crabs.KeyPair.derivePublicHex(bytesToHex(bundle.keys.signingSeed));

      status.set('Registering with server...', 'loading');
      const res = await serverClient.register(username, publicKeyHex);
      if (res.kind !== 'registered') {
        status.set('Registration failed.', 'error');
        return false;
      }

      const d = new BrowserDao();
      await d.init(username, bytesToHex(bundle.keys.signingSeed), res.keyVersion);
      d.setWalletUser(username);

      for (const member of res.members) {
        if (member.username !== username) {
          d.registerMember(member.username, member.publicKeyHex, member.keyVersion);
        }
      }
      daoStore.members = res.members.map((m) => m.username).filter((u) => u !== username);

      await saveLoginBundle({
        username,
        loginInfo: bundle.loginInfo,
        keyStore: bundle.keyStore,
      });

      const walletState: WalletState = {
        username,
        signingSeed: bundle.keys.signingSeed,
        encryptionKey: bundle.keys.encryptionKey,
        keyVersion: res.keyVersion,
      };
      const snapshot = await saveWalletState(walletState);
      await serverClient.putSnapshot(snapshot);

      wallet.value = walletState;
      await daoStore.bootstrap(d, username);
      await daoStore.replayLog();
      status.set('Registered and logged in.', 'success');
      return true;
    } catch (err) {
      status.set(`Registration error: ${err instanceof Error ? err.message : String(err)}`, 'error');
      console.error(err);
      return false;
    }
  }

  async function login(username: string, password: string): Promise<boolean> {
    const daoStore = useDaoStore();
    if (!username.trim() || !password) {
      status.set('Username and password are required.', 'error');
      return false;
    }
    try {
      status.set('Logging in...', 'loading');
      const loginRes = await serverClient.login(username.trim());
      if (loginRes.kind !== 'login_ok') {
        status.set('Login failed.', 'error');
        return false;
      }

      const bundle = await loadLoginBundle(username.trim());
      if (!bundle) {
        status.set('No wallet found for this browser.', 'error');
        return false;
      }

      status.set('Unlocking wallet...', 'loading');
      const keys = await loginWallet(username.trim(), password, bundle.loginInfo, bundle.keyStore);

      let state = await loadWalletState(username.trim(), keys.encryptionKey);
      if (!state) {
        status.set('Fetching wallet snapshot from server...', 'loading');
        const snapshotRes = await serverClient.getSnapshot(username.trim());
        if (snapshotRes.kind !== 'snapshot' || !snapshotRes.snapshot) {
          status.set('No wallet state found locally or on server.', 'error');
          return false;
        }
        const restored = await importWalletState(username.trim(), keys.encryptionKey, snapshotRes.snapshot);
        if (!restored) {
          status.set('Failed to restore wallet from server snapshot.', 'error');
          return false;
        }
        await saveWalletState(restored);
        state = restored;
      }

      const d = new BrowserDao();
      await d.init(username.trim(), bytesToHex(state.signingSeed), state.keyVersion);
      d.setWalletUser(username.trim());

      wallet.value = state;
      daoStore.members = loginRes.members
        .map((m: PublicUser) => m.username)
        .filter((u: string) => u !== username.trim());

      for (const member of loginRes.members) {
        if (member.username !== username.trim()) {
          d.registerMember(member.username, member.publicKeyHex, member.keyVersion);
        }
      }

      await daoStore.bootstrap(d, username.trim());
      await daoStore.replayLog();

      status.set('Logged in.', 'success');
      return true;
    } catch (err) {
      status.set(`Login error: ${err instanceof Error ? err.message : String(err)}`, 'error');
      console.error(err);
      return false;
    }
  }

  async function logout(): Promise<void> {
    const daoStore = useDaoStore();
    if (wallet.value) {
      try {
        const snapshot = await saveWalletState(wallet.value);
        await serverClient.putSnapshot(snapshot);
      } catch (err) {
        console.warn('Failed to upload snapshot on logout:', err);
      }
    }
    daoStore.teardown();
    wallet.value = null;
    status.set('');
  }

  return { wallet, authed, register, login, logout };
});
```

Note: `saveLoginBundle`'s members list must be assigned through direct assignment on the returned store state — `daoStore.members = ...` mutates the pinia setup-store's returned ref through the store proxy, which is valid.

- [ ] **Step 2: write `client/src/components/auth/AuthView.vue`** — ports the auth card markup + password-strength meter, restyled.

```vue
<template>
  <div class="auth-card" role="tabpanel" aria-label="Authentication">
    <div class="auth-brand">
      <h1 class="auth-brand__mark">Resonant<span class="glow">DAO</span></h1>
      <p class="auth-brand__sub">Contribution economy demo</p>
    </div>

    <div class="auth-tabs" role="tablist" aria-label="Register or login">
      <button
        :class="['auth-tab', { 'auth-tab--on': tab === 'register' }]"
        type="button"
        role="tab"
        :aria-selected="tab === 'register'"
        @click="tab = 'register'"
      >Register</button>
      <button
        :class="['auth-tab', { 'auth-tab--on': tab === 'login' }]"
        type="button"
        role="tab"
        :aria-selected="tab === 'login'"
        @click="tab = 'login'"
      >Login</button>
    </div>

    <form v-if="tab === 'register'" id="register-form" class="auth-form" @submit.prevent="onRegister">
      <div class="form-group">
        <label class="form-label" for="register-username">Username</label>
        <input id="register-username" v-model="username" class="form-input" type="text" autocomplete="username" required />
      </div>
      <div class="form-group">
        <label class="form-label" for="register-password">Password</label>
        <input id="register-password" v-model="password" class="form-input" type="password" autocomplete="new-password" required />
        <div class="password-strength" aria-live="polite" aria-atomic="true">
          <div class="password-strength__bar" aria-hidden="true"><div class="password-strength__fill" :style="{ width: strength.width, background: strength.color }" /></div>
          <span class="password-strength__label">{{ strength.label }}</span>
        </div>
      </div>
      <div class="form-group">
        <label class="form-label" for="register-password-confirm">Confirm password</label>
        <input id="register-password-confirm" v-model="confirmPassword" class="form-input" type="password" autocomplete="new-password" required />
      </div>
      <button class="button button--primary" type="submit">Create account</button>
    </form>
    <form v-else id="login-form" class="auth-form" @submit.prevent="onLogin">
      <div class="form-group">
        <label class="form-label" for="login-username">Username</label>
        <input id="login-username" v-model="username" class="form-input" type="text" autocomplete="username" required />
      </div>
      <div class="form-group">
        <label class="form-label" for="login-password">Password</label>
        <input id="login-password" v-model="password" class="form-input" type="password" autocomplete="current-password" required />
      </div>
      <button class="button button--primary" type="submit">Sign in</button>
    </form>
  </div>
</template>

<script setup lang="ts">
import { ref, computed } from 'vue';
import { useRouter } from 'vue-router';
import { useAuthStore } from '../../stores/auth';

const auth = useAuthStore();
const router = useRouter();

const tab = ref<'register' | 'login'>('register');
const username = ref('');
const password = ref('');
const confirmPassword = ref('');

const strength = computed(() => {
  const pw = password.value;
  let score = 0;
  if (pw.length >= 8) score += 1;
  if (/[A-Z]/.test(pw)) score += 1;
  if (/[0-9]/.test(pw)) score += 1;
  if (/[^A-Za-z0-9]/.test(pw)) score += 1;
  const labels = ['Too short', 'Weak', 'Fair', 'Good', 'Strong'];
  const widths = ['0%', '33%', '66%', '100%', '100%'];
  const colors = ['var(--danger)', 'var(--danger)', 'var(--amber)', 'var(--jade)', 'var(--jade)'];
  return { label: labels[score], width: widths[score], color: colors[score] };
});

async function onRegister() {
  const ok = await auth.register(username.value, password.value, confirmPassword.value);
  if (ok) void router.push('/proposals');
}

async function onLogin() {
  const ok = await auth.login(username.value, password.value);
  if (ok) void router.push('/proposals');
}
</script>

<style scoped>
.auth-card {
  width: 100%; max-width: 440px;
  border: 1px solid var(--line); border-radius: var(--radius-lg);
  padding: var(--space-10) var(--space-8);
  background: var(--card-bg);
  -webkit-backdrop-filter: blur(8px); backdrop-filter: blur(8px);
  display: flex; flex-direction: column; gap: var(--space-6);
}
.auth-brand { text-align: center; }
.auth-brand__mark { font-size: 2.2rem; }
.auth-brand__sub { color: var(--muted); margin-top: var(--space-2); font-size: .875rem; }
.auth-tabs { display: flex; gap: var(--space-2); padding: var(--space-1); border: 1px solid var(--line); border-radius: 100px; }
.auth-tab {
  flex: 1; background: transparent; border: none; border-radius: 100px;
  font-family: var(--font-mono); font-size: .78rem; letter-spacing: .06em;
  color: var(--muted); padding: var(--space-2) var(--space-3); cursor: pointer; transition: all .2s;
}
.auth-tab:hover { color: var(--ink); }
.auth-tab--on { background: rgba(95, 208, 160, .18); color: var(--jade); }
.auth-form { display: flex; flex-direction: column; gap: var(--space-4); }
.password-strength { display: flex; align-items: center; gap: var(--space-2); min-height: 1.25rem; font-size: .8125rem; color: var(--muted); }
.password-strength__bar { flex: 1; height: 4px; background: var(--line); border-radius: 2px; overflow: hidden; }
.password-strength__fill { height: 100%; transition: width .2s, background .2s; }
.password-strength__label { white-space: nowrap; }
</style>
```

- [ ] **Step 3: typecheck + commit**

Run: `npm run typecheck:client` → passes.

```bash
git add client/src/stores/auth.ts client/src/components/auth
git commit -m "feat(auth): Vue auth store + AuthView (ports username invisible-char fix)"
```

---

## Task 6: App shell, router, placeholders — the Vue app goes live

**Files:**
- Rewrite: `client/index.html`, `client/src/main.ts`
- Create: `client/src/app/App.vue`, `client/src/app/router.ts`
- Create: `client/src/components/status/StatusBar.vue`
- Create: `client/src/components/feed/FeedPlaceholder.vue`, `client/src/components/account/AccountPlaceholder.vue`
- Create: minimal stubs for the five feature routes (replaced in Tasks 7–11): `client/src/components/proposals/ProposalsPage.vue`, `client/src/components/elections/ElectionsPage.vue`, `client/src/components/contribute/ContributePage.vue`, `client/src/components/round/RoundPage.vue`, `client/src/components/custodians/CustodiansPage.vue`
- Modify: `client/vite.config.ts` (vue plugin), `client/tsconfig.json`

- [ ] **Step 1: add the vue plugin to `client/vite.config.ts`**

```ts
import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import path from 'path';

export default defineConfig({
  root: __dirname,
  publicDir: 'public',
  plugins: [vue()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: true,
  },
  resolve: {
    alias: {
      '@shared': path.resolve(__dirname, '../shared/src'),
      '/wasm/eauth/index.js': path.resolve(__dirname, '../node_modules/eauth-wasm/index.js'),
      '/wasm/crabs/index.js': path.resolve(__dirname, '../node_modules/crabs-wasm/index.js'),
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/ws': { target: 'ws://localhost:9000', ws: true },
      '/api': 'http://localhost:9000',
    },
  },
});
```

- [ ] **Step 2: update `client/tsconfig.json`**

```json
{
  "extends": "../tsconfig.json",
  "compilerOptions": {
    "module": "ESNext",
    "moduleResolution": "bundler",
    "jsx": "preserve",
    "types": ["vite/client"],
    "outDir": "./dist",
    "baseUrl": ".",
    "paths": {
      "@shared/*": ["../shared/src/*"],
      "/wasm/eauth/index.js": ["../node_modules/eauth-wasm/index.d.ts"],
      "/wasm/crabs/index.js": ["../node_modules/crabs-wasm/index.d.ts"]
    },
    "lib": ["ES2022", "DOM", "DOM.Iterable"]
  },
  "include": ["src/**/*", "../shared/src/**/*"]
}
```

- [ ] **Step 3: rewrite `client/index.html`** — Vue mount point, wasm loader scripts unchanged, `data-theme="dark"` for the no-JS default.

```html
<!DOCTYPE html>
<html lang="en" data-theme="dark">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>ResonantDAO Example</title>
</head>
<body>
  <div id="app"></div>
  <script src="/wasm/eauth/eauth.js"></script>
  <script src="/wasm/crabs/crabs.js"></script>
  <script type="module" src="/src/main.ts"></script>
</body>
</html>
```

- [ ] **Step 4: write `client/src/main.ts`** (plain — the devtools injection lands in Task 13)

```ts
import { createApp } from 'vue';
import { createPinia } from 'pinia';
import App from './app/App.vue';
import router from './app/router';
import './design/tokens.css';
import './design/base.css';

createApp(App).use(createPinia()).use(router).mount('#app');
```

- [ ] **Step 5: write `client/src/app/router.ts`**

```ts
import { createRouter, createWebHistory } from 'vue-router';
import { useAuthStore } from '../stores/auth';

const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', name: 'feed', component: () => import('../components/feed/FeedPlaceholder.vue') },
    { path: '/proposals', name: 'proposals', component: () => import('../components/proposals/ProposalsPage.vue') },
    { path: '/elections', name: 'elections', component: () => import('../components/elections/ElectionsPage.vue') },
    { path: '/contribute', name: 'contribute', component: () => import('../components/contribute/ContributePage.vue') },
    { path: '/round', name: 'round', component: () => import('../components/round/RoundPage.vue') },
    { path: '/custodians', name: 'custodians', component: () => import('../components/custodians/CustodiansPage.vue') },
    { path: '/account', name: 'account', component: () => import('../components/account/AccountPlaceholder.vue') },
    { path: '/:pathMatch(.*)*', redirect: '/' },
  ],
});

router.beforeEach((to) => {
  const auth = useAuthStore();
  if (!auth.authed && to.name !== 'feed') return { name: 'feed' };
  return true;
});

export default router;
```

- [ ] **Step 6: write `client/src/components/status/StatusBar.vue`**

```vue
<template>
  <div
    id="status"
    :class="['status-bar', `status-bar--${kind}`]"
    :role="kind === 'error' ? 'alert' : 'status'"
    aria-live="polite"
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
  bottom: var(--space-4);
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
```

- [ ] **Step 7: write `client/src/app/App.vue`**

```vue
<template>
  <main v-if="!auth.authed" id="auth" class="auth-stage">
    <AuthView />
  </main>
  <div v-else id="dashboard" class="app-shell">
    <header class="site-header">
      <div class="brand">
        <span class="brand__wordmark">Resonant<span class="glow">DAO</span></span>
        <span class="brand__dao">example</span>
      </div>
      <nav class="nav-links">
        <RouterLink v-for="item in NAV" :key="item.to" :to="item.to" :class="{ on: route.path === item.to }">{{ item.label }}</RouterLink>
      </nav>
      <div class="header-end">
        <button class="theme-toggle" type="button" aria-label="Toggle theme" @click="toggle">
          <span :class="['seg', { on: theme === 'light' }]">☀</span>
          <span :class="['seg', { on: theme === 'dark' }]">☾</span>
        </button>
        <span id="username" class="header-user mono">{{ ds.username }}</span>
        <span id="token-balance" class="token-balance mono">🪙 {{ resBalance }} $RES</span>
        <button id="logout" class="button button--secondary button--small" type="button" @click="onLogout">Logout</button>
      </div>
    </header>
    <main class="app-main">
      <RouterView />
    </main>
    <footer class="app-footer mono">ResonantDAO Example — browser-based DAO proof of concept</footer>
  </div>
  <StatusBar />
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { RouterView, RouterLink, useRouter, useRoute } from 'vue-router';
import { useAuthStore } from '../stores/auth';
import { useDaoStore } from '../stores/dao';
import { useTheme } from '../design/composables/use-theme';
import AuthView from '../components/auth/AuthView.vue';
import StatusBar from '../components/status/StatusBar.vue';

const auth = useAuthStore();
const ds = useDaoStore();
const router = useRouter();
const route = useRoute();
const { theme, toggle } = useTheme();

const NAV = [
  { to: '/', label: 'Feed' },
  { to: '/proposals', label: 'Proposals' },
  { to: '/elections', label: 'Elections' },
  { to: '/contribute', label: 'Contribute' },
  { to: '/round', label: 'Round' },
  { to: '/custodians', label: 'Custodians' },
  { to: '/account', label: 'Account' },
];

const resBalance = computed(() => {
  void ds.tick;
  return ds.dao && ds.username ? ds.dao.getResBalance(ds.username) : 0;
});

async function onLogout() {
  await auth.logout();
  void router.push('/');
}
</script>

<style scoped>
.app-shell { min-height: 100vh; display: flex; flex-direction: column; }
.auth-stage { min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: var(--space-6); }
.site-header {
  position: sticky; top: 0; z-index: 40;
  display: flex; align-items: center; justify-content: space-between; gap: 20px;
  min-height: 64px; border-bottom: 1px solid var(--line);
  background: var(--glass);
  -webkit-backdrop-filter: blur(16px); backdrop-filter: blur(16px);
  padding: 0 max(16px, calc((100% - var(--max-width)) / 2));
}
.brand { font-family: var(--font-mono); font-weight: 500; font-size: 1.06rem; display: flex; align-items: baseline; gap: 10px; white-space: nowrap; }
.brand__wordmark { font-weight: 600; letter-spacing: -.02em; }
.brand__dao { font-size: .6rem; font-style: italic; color: var(--faint); }
.nav-links { display: flex; align-items: center; gap: clamp(10px, 1.6vw, 22px); font-family: var(--font-mono); font-size: .8rem; letter-spacing: .03em; color: var(--muted); }
.nav-links a { transition: color .2s; }
.nav-links a:hover { color: var(--ink); }
.nav-links a.router-link-active.on, .nav-links a.on { color: var(--jade); }
.header-end { display: flex; align-items: center; gap: var(--space-4); color: var(--muted); font-size: .875rem; }
.token-balance { color: var(--amber); }
.theme-toggle {
  display: inline-flex; align-items: center; gap: 2px; border: 1px solid var(--line);
  border-radius: 100px; padding: 4px; cursor: pointer; background: transparent;
  font-family: var(--font-mono); font-size: .7rem; color: var(--muted); letter-spacing: .06em;
}
.theme-toggle .seg { display: inline-flex; align-items: center; justify-content: center; width: 26px; height: 26px; border-radius: 100px; color: var(--faint); transition: all .2s; }
.theme-toggle .seg.on { background: rgba(95, 208, 160, .18); color: var(--jade); }
[data-theme="light"] .theme-toggle .seg.on { background: rgba(15, 122, 86, .16); }
.app-footer { border-top: 1px solid var(--line); padding: var(--space-4) var(--space-6); color: var(--faint); font-size: .75rem; text-align: center; }
@media (max-width: 900px) {
  .site-header { flex-wrap: wrap; min-height: auto; padding: 10px 14px; }
  .nav-links { flex: 1 1 auto; justify-content: flex-end; gap: 10px; }
  .brand__dao { display: none; }
}
</style>
```

- [ ] **Step 8: write `FeedPlaceholder.vue`** — uses the motifs; slice #2 replaces this file.

```vue
<template>
  <SectionHeading number="00" eyebrow="The feed" title="The hub arrives in the next slice"
    lede="For now, this page informs and directs. Every feature has its own page — the forms live there, not here." />
  <VerdictSplit
    x-title="Today ✕"
    ok-title="What we add ✓"
    :x-items="[
      'One page <b>acted</b> for everything — proposals, elections, verification, settlements, round ops.',
      'Each new feature pushed the stack higher.',
    ]"
    :ok-items="[
      '<b>Feed</b> — informs and directs, decides nothing.',
      '<b>Wizards</b> — walk each feature one step at a time.',
      '<b>Account</b> — your tokens and contributions like a ledger.',
    ]"
  />
  <div class="dest">
    <Panel v-for="item in DESTS" :key="item.to" :number="item.no" :kicker="item.label">
      <RouterLink :to="item.to" class="dest__link">{{ item.blurb }} <span class="dest__arrow">→</span></RouterLink>
    </Panel>
  </div>
</template>

<script setup lang="ts">
import { RouterLink } from 'vue-router';
import SectionHeading from '../../design/components/SectionHeading.vue';
import VerdictSplit from '../../design/components/VerdictSplit.vue';
import Panel from '../../design/components/Panel.vue';

const DESTS = [
  { to: '/proposals', no: '01', label: 'Proposals', blurb: 'Create proposals and vote.' },
  { to: '/elections', no: '02', label: 'Elections', blurb: 'Custodian elections and runoff.' },
  { to: '/contribute', no: '03', label: 'Contribute', blurb: 'Submit and verify contributions.' },
  { to: '/round', no: '04', label: 'Round', blurb: 'The settlement spine.' },
  { to: '/custodians', no: '05', label: 'Custodians', blurb: 'Members and custodian admin.' },
  { to: '/account', no: '06', label: 'Account', blurb: 'Your tokens and tallies.' },
];
</script>

<style scoped>
.dest { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 16px; margin-top: var(--space-8); }
.dest :deep(.panel) { padding: 22px 20px; }
.dest__link { text-decoration: none; color: var(--ink-soft); font-family: var(--font-mono); font-size: .85rem; }
.dest__link:hover { color: var(--jade); }
.dest__arrow { margin-left: 6px; color: var(--jade); }
</style>
```

- [ ] **Step 9: write `AccountPlaceholder.vue`**

```vue
<template>
  <SectionHeading number="06" eyebrow="Account" title="Your ledger, step five">
    <template #lede>The financial-app breakdown — token balance up front, per-dimension
      contribution tallies, and a ledger history — arrives with the account slice. The
      substrate (routes, shell, design language) already exists here.</template>
  </SectionHeading>
  <div class="grid">
    <Panel number="01" kicker="Balance"><p class="muted">$RES balance, $RCT, and per-dimension tallies — rendered like a bank app in slice #5.</p></Panel>
    <Panel number="02" kicker="Ledger"><p class="muted">Every contribution, verification, settlement, and harm adjustment as line items.</p></Panel>
  </div>
</template>

<script setup lang="ts">
import SectionHeading from '../../design/components/SectionHeading.vue';
import Panel from '../../design/components/Panel.vue';
</script>

<style scoped>
.grid { display: grid; grid-template-columns: 1fr; gap: 16px; }
@media (min-width: 720px) { .grid { grid-template-columns: 1fr 1fr; } }
</style>
```

- [ ] **Step 10: write the five feature-page stubs** — identical pattern, one per route (each becomes its real page in the next tasks; the stub must already carry the page's stable id anchors where trivially possible):

Use this template five times, with these values:

| File | number | eyebrow | title |
| --- | --- | --- | --- |
| `client/src/components/proposals/ProposalsPage.vue` | 01 | Proposals | Proposals land here |
| `client/src/components/elections/ElectionsPage.vue` | 02 | Elections | Elections land here |
| `client/src/components/contribute/ContributePage.vue` | 03 | Contribute | Contributions land here |
| `client/src/components/round/RoundPage.vue` | 04 | Round | The round spine lands here |
| `client/src/components/custodians/CustodiansPage.vue` | 05 | Custodians | Members land here |

```vue
<template>
  <SectionHeading number="NN" eyebrow="XX" title="YY" />
  <Panel><p class="muted">Re-platformed in its own task — the route, nav entry, and design language already exist.</p></Panel>
</template>

<script setup lang="ts">
import SectionHeading from '../../design/components/SectionHeading.vue';
import Panel from '../../design/components/Panel.vue';
</script>
```

- [ ] **Step 11: typecheck + build + smoke**

Run: `npm run typecheck:client` → passes.
Run: `npm run build:client` → succeeds; `client/dist/index.html` contains `id="app"`; the built bundle contains the fonts asset links.

- [ ] **Step 12: delete legacy dashboard markup from the old `theme.css` link path**

`client/index.html` no longer references `theme.css`. Leave `client/src/ui.ts` and `client/src/theme.css` on disk — Task 12 deletes them (they remain the porting source of record).

- [ ] **Step 13: commit**

```bash
git add client/index.html client/src/main.ts client/src/app client/src/components client/vite.config.ts client/tsconfig.json
git commit -m "feat(shell): Vue app goes live — router, shell, status bar, feed/account placeholders"
```

---

## Task 7: Proposals page

**Files:**
- Rewrite: `client/src/components/proposals/ProposalsPage.vue`
- Create: `client/src/components/proposals/ProposalCard.vue`

Ports: `onCreateProposal` (form → payload, salient dims from the implemented-dimension checkboxes), `onVote` / `onExecute` (via store actions), `renderProposals`/`createProposalCard` (card), plus the quadratic token-info line.

- [ ] **Step 1: write `ProposalCard.vue`**

```vue
<template>
  <li class="proposal-card">
    <div class="proposal-card__header">
      <h3 class="proposal-card__title">{{ proposal.title }}</h3>
      <Pill :kind="executed ? 'jade' : 'neutral'">{{ executed ? 'Executed' : 'Open' }}</Pill>
    </div>
    <p v-if="proposal.description" class="proposal-card__description">{{ proposal.description }}</p>
    <div class="proposal-card__id" title="Proposal ID">{{ proposal.proposalId }}</div>
    <div class="proposal-card__type">{{ pType === 'quadratic' ? 'Quadratic Vote' : 'Direct Vote' }}</div>
    <div class="proposal-card__timer">{{ executed ? 'Voting closed' : `Closes in ${Math.ceil(remainingMs / 1000)}s` }}</div>

    <div class="proposal-card__votes">
      <div v-for="(label, i) in options" :key="label" class="vote-stat">
        <span class="vote-stat__label">{{ label }}</span>
        <span class="vote-stat__value">{{ counts[i] ?? 0 }}</span>
      </div>
    </div>

    <div v-if="pType === 'quadratic'" class="proposal-card__tokens">
      Tokens used here: {{ tokensUsed }} | Next vote cost: {{ nextCumulativeCost }} | Your balance for this question: {{ voteBalance }}
    </div>

    <div class="proposal-card__actions">
      <button
        v-for="(label, i) in options"
        :key="label"
        type="button"
        class="button button--secondary vote-option"
        :disabled="actionsDisabled"
        @click="$emit('vote', proposal.proposalId, i)"
      >{{ label }}</button>
      <button type="button" class="button button--primary execute" :disabled="executed || ds.submitting" @click="$emit('execute', proposal.proposalId)">Execute</button>
    </div>
  </li>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import type { ProposalPayload } from '@shared/types';
import { useDaoStore } from '../../stores/dao';
import Pill from '../../design/components/Pill.vue';

const props = defineProps<{ proposal: ProposalPayload; executed: boolean }>();
defineEmits<{ vote: [proposalId: string, choice: number]; execute: [proposalId: string] }>();

const ds = useDaoStore();

const pType = computed(() => {
  void ds.tick;
  return ds.dao?.getProposalType(props.proposal.proposalId) ?? null;
});
const options = computed(() => props.proposal.options ?? ['Yes', 'No']);
const counts = computed(() => {
  void ds.tick;
  return ds.dao?.getProposalOptionVotes(props.proposal.proposalId) ?? [];
});
const remainingMs = computed(() => {
  void ds.tick;
  const expiresAt = ds.dao?.getProposalExpiry(props.proposal.proposalId) ?? 0;
  return Math.max(0, expiresAt - (ds.dao?.getNodeTimeMs() ?? 0));
});
const tokensUsed = computed(() => {
  void ds.tick;
  return ds.dao && ds.username ? ds.dao.getProposalTokenUsage(props.proposal.proposalId, ds.username) : 0;
});
const voteCount = computed(() => {
  void ds.tick;
  return ds.dao && ds.username ? ds.dao.getProposalVoteCount(props.proposal.proposalId, ds.username) : 0;
});
const nextCumulativeCost = computed(() => ((voteCount.value + 1) * (voteCount.value + 2) * (2 * voteCount.value + 3)) / 6);
const voteBalance = computed(() => {
  void ds.tick;
  return ds.dao && ds.username ? ds.dao.getVoteBalance(props.proposal.proposalId, ds.username) : 0;
});
const alreadyVoted = computed(() => ds.votedProposals.includes(props.proposal.proposalId));
const canVoteQuadratic = computed(() =>
  pType.value === 'quadratic' && voteBalance.value >= nextCumulativeCost.value && nextCumulativeCost.value > 0);
const actionsDisabled = computed(() =>
  props.executed || ds.submitting || (alreadyVoted.value && !canVoteQuadratic.value));
</script>

<style scoped>
.proposal-card {
  border: 1px solid var(--line);
  border-radius: var(--radius-lg);
  padding: 26px 22px;
  background: var(--card-bg);
  -webkit-backdrop-filter: blur(8px); backdrop-filter: blur(8px);
  transition: border-color .3s;
  list-style: none;
}
.proposal-card:hover { border-color: var(--line-strong); }
.proposal-card__header { display: flex; align-items: flex-start; justify-content: space-between; gap: var(--space-4); margin-bottom: var(--space-3); }
.proposal-card__title { font-size: 1.3rem; line-height: 1.3; }
.proposal-card__description { color: var(--ink-soft); margin: 0 0 var(--space-4); font-size: .95rem; }
.proposal-card__id { font-family: var(--font-mono); font-size: .75rem; color: var(--faint); margin-bottom: var(--space-4); word-break: break-all; }
.proposal-card__type { font-family: var(--font-mono); font-size: .78rem; color: var(--muted); }
.proposal-card__timer { font-family: var(--font-mono); font-size: .78rem; color: var(--amber); margin-top: 4px; }
.proposal-card__votes { display: flex; gap: var(--space-6); margin-top: var(--space-4); margin-bottom: var(--space-4); }
.vote-stat { display: flex; flex-direction: column; gap: var(--space-1); }
.vote-stat__label { font-size: .75rem; color: var(--faint); text-transform: uppercase; letter-spacing: .05em; }
.vote-stat__value { font-family: var(--font-mono); font-size: 1.25rem; font-weight: 500; color: var(--ink); }
.proposal-card__tokens { font-family: var(--font-mono); font-size: .78rem; color: var(--muted); margin-bottom: var(--space-4); }
.proposal-card__actions { display: flex; flex-wrap: wrap; gap: var(--space-3); }
</style>
```

- [ ] **Step 2: rewrite `ProposalsPage.vue`**

```vue
<template>
  <SectionHeading number="01" eyebrow="Proposals" title="Decide, together">
    <template #lede>Create a proposal and vote. Quadratic votes draw their spend balance
      from the question's salient dimensions × your verified tallies.</template>
  </SectionHeading>

  <Panel number="NN" kicker="New proposal">
    <form id="proposal-form" class="proposal-form" @submit.prevent="onCreateProposal">
      <div class="form-group">
        <label class="form-label" for="proposal-title">Title</label>
        <input id="proposal-title" v-model="form.title" class="form-input" type="text" placeholder="What do you want to propose?" required />
      </div>
      <div class="form-group">
        <label class="form-label" for="proposal-description">Description</label>
        <input id="proposal-description" v-model="form.description" class="form-input" type="text" placeholder="Optional details" />
      </div>
      <div class="form-group">
        <label class="form-label" for="proposal-type">Voting type</label>
        <select id="proposal-type" v-model="form.type" class="form-input">
          <option value="direct">Direct Vote (one vote per user)</option>
          <option value="quadratic">Quadratic Vote (token-weighted, multiple votes)</option>
        </select>
      </div>
      <div class="form-group">
        <label class="form-label" for="proposal-options">Options (comma-separated, optional)</label>
        <input id="proposal-options" v-model="form.optionsRaw" class="form-input" type="text" placeholder="e.g. Alpha, Beta, Gamma — leave empty for Yes/No" />
      </div>
      <fieldset class="wizard-fieldset">
        <legend>Salient dimensions for quadratic votes (empty = base membership only)</legend>
        <label v-for="dim in implementedDims" :key="dim.index" class="wizard-choice">
          <input type="checkbox" class="salient-dim" :value="dim.index" v-model="form.salient" /> {{ dim.code }} {{ dim.cls }}
        </label>
      </fieldset>
      <div class="proposal-form__actions">
        <button class="button button--primary" type="submit" :disabled="ds.submitting">Create proposal</button>
      </div>
    </form>
  </Panel>

  <Panel number="NN" kicker="Open proposals">
    <ul id="proposals" class="proposal-list">
      <li v-if="proposals.length === 0" class="empty-state">No proposals yet. Create the first one above.</li>
      <ProposalCard
        v-for="p in proposals"
        :key="p.proposalId"
        :proposal="p"
        :executed="executedMap[p.proposalId] ?? false"
        @vote="ds.vote"
        @execute="ds.execute"
      />
    </ul>
  </Panel>
</template>

<script setup lang="ts">
import { ref, computed } from 'vue';
import { DIMENSIONS } from '@shared/contribution';
import type { ProposalPayload } from '@shared/types';
import { useDaoStore } from '../../stores/dao';
import { useStatusStore } from '../../stores/status';
import SectionHeading from '../../design/components/SectionHeading.vue';
import Panel from '../../design/components/Panel.vue';
import ProposalCard from './ProposalCard.vue';

const ds = useDaoStore();
const status = useStatusStore();

const implementedDims = computed(() => DIMENSIONS.filter((d) => d.implemented));
const form = ref({
  title: '',
  description: '',
  type: 'direct' as 'direct' | 'quadratic',
  optionsRaw: '',
  salient: [] as number[],
});

const proposals = computed(() => {
  void ds.tick;
  return ds.dao?.getProposals() ?? [];
});
const executedMap = computed(() => {
  void ds.tick;
  const map: Record<string, boolean> = {};
  for (const p of proposals.value) {
    map[p.proposalId] = ds.dao?.isProposalExecuted(p.proposalId) ?? false;
  }
  return map;
});

async function onCreateProposal() {
  const title = form.value.title;
  if (!ds.dao || !title) return;
  const parsed = form.value.optionsRaw.split(',').map((s) => s.trim()).filter((s) => s.length > 0);
  let options: string[];
  if (parsed.length === 0) {
    options = ['Yes', 'No'];
  } else if (parsed.length >= 2 && parsed.length <= 10 && new Set(parsed).size === parsed.length) {
    options = parsed;
  } else {
    status.set('Options must be 2-10 unique, non-empty comma-separated values.', 'error');
    return;
  }
  const salientDims = form.value.salient.filter((dim) => Number.isInteger(dim));
  const payload: ProposalPayload = {
    proposalId: crypto.randomUUID(),
    title,
    description: form.value.description,
    proposalType: form.value.type === 'quadratic' ? 'quadratic' : 'direct',
    options,
    expiresAt: ds.dao.getNodeTimeMs() + 60 * 1000,
  };
  if (salientDims.length > 0) payload.salientDims = salientDims;
  await ds.createProposal(payload);
  if (status.kind === 'success') form.value = { title: '', description: '', type: 'direct', optionsRaw: '', salient: [] };
}
</script>
```

Add the page's shared styles to its `<style scoped>`:

```css
.proposal-list { list-style: none; margin: var(--space-8) 0 0; padding: 0; display: flex; flex-direction: column; gap: var(--space-4); }
.wizard-fieldset {
  border: 1px solid var(--line); border-radius: var(--radius);
  padding: var(--space-3) var(--space-4); margin: 0;
  display: flex; flex-direction: column; gap: var(--space-2);
}
.wizard-fieldset legend { color: var(--muted); font-size: .8125rem; font-weight: 600; padding: 0 var(--space-1); }
.wizard-choice { display: flex; align-items: center; gap: var(--space-2); font-size: .9375rem; cursor: pointer; font-family: var(--font-mono); }
</style>
```

- [ ] **Step 3: typecheck**

Run: `npm run typecheck:client` → passes.

- [ ] **Step 4: commit**

```bash
git add client/src/components/proposals
git commit -m "feat(proposals): Vue proposals page + cards (parity with legacy handlers)"
```

---

## Task 8: Elections page

**Files:**
- Rewrite: `client/src/components/elections/ElectionsPage.vue`
- Create: `client/src/components/elections/ElectionCard.vue`

Ports `onStartElection`, `onCastBallot`, `onCastRunoffVote`, `onFinalizeElection`, `renderElections`, `renderCustodians`. Vue's per-card local state replaces the old checkbox snapshotting (the demo-clock re-render no longer wipes selections).

- [ ] **Step 1: write `ElectionsPage.vue`**

```vue
<template>
  <SectionHeading number="02" eyebrow="Elections" title="Seat the custodians">
    <template #lede>Start a custodian election, cast a ballot (1–5 picks), and finalize once the window closes. A tie spawns a quadratic runoff.</template>
  </SectionHeading>

  <Panel number="NN" kicker="Election control">
    <div class="election-start">
      <button id="start-election" class="button button--secondary" type="button" :disabled="ds.submitting" @click="onStartElection">Start election</button>
      <p class="muted">Candidates: every member, alphabetical.</p>
    </div>
  </Panel>

  <Panel number="NN" kicker="Custodian seats">
    <div id="custodians" class="custodian-list">
      <span v-for="(c, i) in custodianSeats" :key="c" class="member-item__badge">Seat {{ i + 1 }}: {{ c }}</span>
      <span v-if="custodianSeats.length === 0" class="muted">No custodians elected yet.</span>
    </div>
  </Panel>

  <div id="election-area" class="elections">
    <ElectionCard v-for="e in elections" :key="e.electionId" :election-id="e.electionId" />
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { useDaoStore } from '../../stores/dao';
import SectionHeading from '../../design/components/SectionHeading.vue';
import Panel from '../../design/components/Panel.vue';
import ElectionCard from './ElectionCard.vue';

const ds = useDaoStore();
const custodianSeats = computed(() => ds.dao?.custodians ?? []);
const elections = computed(() => {
  void ds.tick;
  return [...(ds.dao?.getElections() ?? [])].reverse();
});

function onStartElection() {
  if (!ds.dao || !ds.username) return;
  const candidates = Array.from(new Set([...ds.members, ds.username])).sort();
  void ds.startElection(candidates);
}
</script>
```

Create the sibling SFC `client/src/components/elections/ElectionCard.vue`. Its full code:

```vue
<template>
  <div class="proposal-card" :data-election-id="election.electionId">
    <div class="proposal-card__header">
      <h3 class="proposal-card__title">{{ election.isRunoff ? 'Custodian runoff (quadratic)' : 'Custodian election' }}</h3>
      <Pill :kind="state === 1 ? 'jade' : state === 2 ? 'amber' : 'neutral'">{{ state === 1 ? 'Finalized' : state === 2 ? 'Runoff pending' : 'Open' }}</Pill>
    </div>
    <div class="proposal-card__type">
      Closes in {{ Math.ceil(remainingMs / 1000) }}s<template v-if="ballots"> — you voted</template>
    </div>

    <div v-if="!election.isRunoff && state === 0 && !ballots" class="ballot-form">
      <label v-for="candidate in election.candidates" :key="candidate" class="wizard-choice">
        <input v-model="picks" type="checkbox" class="ballot-option" :value="candidate" /> {{ candidate }}
      </label>
      <button class="button button--primary" type="button" :disabled="ds.submitting" @click="castBallot">Submit ballot (1-5 picks)</button>
    </div>
    <div v-else class="tally">
      <div v-for="(count, candidate) in votes" :key="candidate" class="vote-stat">
        <span class="vote-stat__label">{{ candidate }}</span>
        <span class="vote-stat__value">{{ count }}</span>
      </div>
    </div>

    <div v-if="election.isRunoff && state === 0" class="runoff-form">
      <button
        v-for="candidate in election.candidates"
        :key="candidate"
        type="button"
        class="button button--secondary runoff-vote"
        :disabled="ds.submitting"
        @click="ds.castRunoffVote(election.electionId, candidate)"
      >Vote {{ candidate }}</button>
      <div class="proposal-card__tokens">Tokens used: {{ runoffUsage }} | Balance: {{ resBalance }}</div>
    </div>

    <button
      v-if="state === 0 && remainingMs <= 0"
      type="button"
      class="button button--primary finalize-election"
      :disabled="ds.submitting"
      @click="ds.finalizeElection(election.electionId, election.candidates)"
    >Finalize election</button>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';
import { useDaoStore } from '../../stores/dao';
import Pill from '../../design/components/Pill.vue';

const props = defineProps<{ electionId: string }>();
const ds = useDaoStore();

const election = computed(() => {
  void ds.tick;
  return ds.dao?.getElections().find((e) => e.electionId === props.electionId)!;
});
const state = computed(() => { void ds.tick; return ds.dao?.getElectionFinalized(props.electionId) ?? 0; });
const votes = computed(() => { void ds.tick; return ds.dao?.getElectionVotes(props.electionId) ?? {}; });
const ballots = computed(() => { void ds.tick; return ds.dao?.hasBallot(props.electionId) ?? false; });
const remainingMs = computed(() => { void ds.tick; const exp = ds.dao?.getElectionExpiry(props.electionId) ?? 0; return Math.max(0, exp - (ds.dao?.getNodeTimeMs() ?? 0)); });
const runoffUsage = computed(() => { void ds.tick; return ds.dao?.getRunoffUsage(props.electionId) ?? 0; });
const resBalance = computed(() => { void ds.tick; return ds.dao && ds.username ? ds.dao.getResBalance(ds.username) : 0; });

const picks = ref<string[]>([]);
function castBallot() {
  const selection = picks.value.filter((m) => m.length > 0);
  if (selection.length < 1 || selection.length > 5) {
    useStatus().set('Pick between 1 and 5 candidates.', 'error');
    return;
  }
  void ds.castBallot(props.electionId, selection);
}
</script>
```

with `import { useStatusStore as useStatus } from '../../stores/status';` at the top of the script.

- [ ] **Step 2: typecheck + commit**

Run: `npm run typecheck:client` → passes.

```bash
git add client/src/components/elections
git commit -m "feat(elections): Vue elections page (ballot, runoff, finalize parity)"
```

---

## Task 9: Contribute page (the heaviest port)

**Files:**
- Rewrite: `client/src/components/contribute/ContributePage.vue`
- Create: `client/src/components/contribute/ContributionCard.vue`

Ports `onSubmitContribution`, `onVerifyContribution`/`onSettleContribution`/`onAppealContribution` (now store actions ported in Task 4), `renderContributions`, `buildContributionCard` (wizard model, stepper chips, harm receipt, evidence loading), `renderContributionReview`, `evidenceSummary`, `loadEvidenceMedia`.

- [ ] **Step 1: write `ContributePage.vue`**

```vue
<template>
  <SectionHeading number="03" eyebrow="Contribute" title="Work, witnessed">
    <template #lede>Submit a contribution with evidence. Another member verifies it;
      accepted outcomes pay bounties and build your dimension tallies.</template>
  </SectionHeading>

  <Panel number="NN" kicker="Submit contribution">
    <form id="contribution-form" class="proposal-form" @submit.prevent="onSubmitContribution">
      <fieldset id="contribution-step-1" class="wizard-fieldset">
        <legend>1 — What kind of contribution?</legend>
        <label class="wizard-choice"><input v-model="dim" type="radio" name="contrib-dim" :value="2" /> C_2 Recording — durable, findable record (base credit 3 $RES)</label>
        <label class="wizard-choice"><input v-model="dim" type="radio" name="contrib-dim" :value="1" /> C_1 Building — built something real (bounty 12 $RES)</label>
      </fieldset>
      <fieldset class="wizard-fieldset">
        <legend>2 — Describe it and attach evidence</legend>
        <input id="contribution-summary" v-model="summary" class="form-input" placeholder="What did you make or record?" required />
        <input id="contribution-evidence-text" v-model="evidenceText" class="form-input" placeholder="Evidence pointer (URL, commit, record id)…" />
        <input id="contribution-evidence-file" class="form-input" type="file" @change="onFileChange" />
      </fieldset>
      <fieldset class="wizard-fieldset">
        <legend>3 — Review</legend>
        <div id="contribution-review" class="muted">
          <p><strong>{{ summary || '(no summary yet)' }}</strong></p>
          <p>{{ reviewLine }}</p>
        </div>
      </fieldset>
      <div class="proposal-form__actions">
        <button class="button button--primary" type="submit" :disabled="ds.submitting">Submit contribution</button>
      </div>
    </form>
  </Panel>

  <section id="contributions-list" aria-live="polite">
    <p v-if="entries.length === 0" class="muted">No contributions yet.</p>
    <ContributionCard v-for="entry in entries" :key="entry.record.contributionId" :entry="entry" />
  </section>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';
import { DIMENSIONS, CONTENT_LIMITS, SCHEMA_VERSION, EvidenceRef } from '@shared/contribution';
import { useDaoStore, serverClient } from '../../stores/dao';
import { useStatusStore } from '../../stores/status';
import SectionHeading from '../../design/components/SectionHeading.vue';
import Panel from '../../design/components/Panel.vue';
import ContributionCard from './ContributionCard.vue';

const ds = useDaoStore();
const status = useStatusStore();

const dim = ref<number>(2);
const summary = ref('');
const evidenceText = ref('');
let evidenceFile: File | null = null;

const entries = computed(() => {
  void ds.tick;
  return [...(ds.dao?.getContributions() ?? [])].reverse();
});

const reviewLine = computed(() => {
  const dims = Object.keys({ [dim.value]: 1 }).map((k) => `C_${k} ${DIMENSIONS[Number(k)].name}`).join(', ');
  return `${dims} — ${evidenceFile ? 'stored evidence (file)' : evidenceText.value ? `pointer: ${evidenceText.value}` : 'no evidence yet'}`;
});

function onFileChange(ev: Event) {
  evidenceFile = (ev.target as HTMLInputElement).files?.[0] ?? null;
}

async function onSubmitContribution() {
  if (!ds.dao || ds.submitting) return;
  if (!summary.value) {
    status.set('A summary is required.', 'error');
    return;
  }
  let evidenceRef: EvidenceRef;
  if (evidenceFile) {
    const bytes = new Uint8Array(await evidenceFile.arrayBuffer());
    if (bytes.length > CONTENT_LIMITS.maxObjectBytes) {
      status.set(`Evidence exceeds ${CONTENT_LIMITS.maxObjectBytes / (1024 * 1024)}MB — split it up.`, 'error');
      return;
    }
    const mediaType = evidenceFile.type || 'application/octet-stream';
    const hash = await serverClient.putContent(bytes, mediaType);
    evidenceRef = { hash, uri: `content://${hash}`, mediaType, size: bytes.length };
  } else if (evidenceText.value) {
    const bytes = new TextEncoder().encode(evidenceText.value);
    evidenceRef = { hash: await sha256Hex(bytes), uri: evidenceText.value, mediaType: 'text/uri-list', size: bytes.length };
  } else {
    status.set('Attach evidence or give a pointer — pay follows proven outcomes.', 'error');
    return;
  }

  await ds.submitContribution({
    contributionId: crypto.randomUUID(),
    dims: { [dim.value]: 1 },
    summary: summary.value,
    evidenceRef,
    schemaVersion: SCHEMA_VERSION,
  });
  if (status.kind === 'success') {
    summary.value = '';
    evidenceText.value = '';
    evidenceFile = null;
  }
}

// Uniform sha-256 for both evidence paths: stored files and text pointers.
async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as unknown as ArrayBuffer);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
}
</script>

<style scoped>
.wizard-fieldset {
  border: 1px solid var(--line); border-radius: var(--radius);
  padding: var(--space-3) var(--space-4); margin: 0;
  display: flex; flex-direction: column; gap: var(--space-2);
}
.wizard-fieldset legend { color: var(--muted); font-size: .8125rem; font-weight: 600; padding: 0 var(--space-1); }
.wizard-choice { display: flex; align-items: center; gap: var(--space-2); font-size: .9375rem; cursor: pointer; }
#contributions-list { display: flex; flex-direction: column; gap: var(--space-4); margin-top: var(--space-8); }
</style>
```

- [ ] **Step 2: write `ContributionCard.vue`** — full port of `buildContributionCard`.

```vue
<template>
  <div class="contribution-card" :data-contribution-id="entry.record.contributionId">
    <div class="contribution-card__header">
      <strong>{{ entry.record.summary }}</strong>
      <span :class="['contribution-pill', `contribution-pill--${appealed ? 'appealed' : model.outcome}`]">
        {{ appealed ? 'appealed' : model.outcome }}
      </span>
    </div>

    <div class="contribution-stepper">
      <span
        v-for="(step, i) in model.steps"
        :key="step.stepId"
        :class="['contribution-step', `contribution-step--${step.state}`]"
      >{{ step.state === 'current'
        ? `${i + 1}. ${step.title} (${step.progress.done}/${step.progress.required})`
        : `${i + 1}. ${step.title}` }}</span>
    </div>

    <div class="muted">by {{ entry.submitter }}</div>
    <div class="muted">{{ evidenceLabel }}</div>

    <button
      v-if="evidenceRef.uri.startsWith('content://') && !evidenceImgUrl && !evidenceDlUrl"
      type="button"
      class="button button--secondary contribution-card__evidence-load"
      :disabled="ds.submitting"
      @click="loadEvidence"
    >Load evidence</button>
    <img v-if="evidenceImgUrl" class="contribution-card__evidence-img" alt="contribution evidence" :src="evidenceImgUrl" />
    <a v-else-if="evidenceDlUrl" class="contribution-card__evidence-dl" :href="evidenceDlUrl" :download="`evidence-${entry.record.contributionId.slice(0, 8)}`">Download evidence ({{ evidenceRef.mediaType }})</a>

    <div v-if="model.outcome === 'rejected' && entry.verdictReason" class="contribution-card__verdict">
      Rejected by {{ entry.verifiedBy }}: {{ entry.verdictReason }}
    </div>

    <div v-if="appealed" class="muted">appealed — awaiting re-verification</div>
    <button
      v-else-if="model.outcome === 'rejected' && entry.submitter === ds.username && !contributionAppealed"
      type="button"
      class="button button--secondary appeal-contribution"
      :disabled="ds.submitting"
      @click="ds.appealContribution(entry)"
    >Appeal…</button>

    <div v-if="harmReceipt" :class="['contribution-card__harm', `contribution-card__harm--${entry.harm}`]">{{ harmReceipt }}</div>

    <div v-if="actions.length > 0" class="contribution-card__actions">
      <button
        v-for="action in actions"
        :key="action.label"
        type="button"
        :class="['button', `button--${action.variant}`, action.cls]"
        :title="action.title"
        :disabled="ds.submitting"
        @click="action.run()"
      >{{ action.label }}</button>
    </div>
  </div>
</template>
```

**Script**:

```ts
<script setup lang="ts">
import { computed, ref, onBeforeUnmount } from 'vue';
import { harmFactorFor, paymentFor, schemaForDims } from '@shared/contribution';
import { ContributionFacts, wizardModel } from '@shared/wizard';
import { serverClient, useDaoStore } from '../../stores/dao';
import type { ContributionMirrorEntry } from '../../dao';

const props = defineProps<{ entry: ContributionMirrorEntry }>();

const ds = useDaoStore();

const schema = computed(() => schemaForDims(props.entry.record.dims));
const statusOf = computed(() => {
  void ds.tick;
  return ds.dao?.getContributionStatus(props.entry.record.contributionId) ?? 'unknown';
});
const appealed = computed(() =>
  (ds.dao?.getContributionAppealed(props.entry.record.contributionId) ?? false) && statusOf.value === 'pending');
const contributionAppealed = computed(() => ds.dao?.getContributionAppealed(props.entry.record.contributionId) ?? false);

const model = computed(() => {
  void ds.tick;
  const d = ds.dao!;
  const status = statusOf.value;
  const facts: ContributionFacts = {
    status: status === 'unknown' ? -1 : status === 'accepted' ? 1 : status === 'rejected' ? 2 : 0,
    stepIndex: d.getContributionStepIndex(props.entry.record.contributionId),
    done: Object.fromEntries(schema.value.steps.map((s) => [
      s.stepId, d.getContributionStepDone(props.entry.record.contributionId, s.stepId),
    ])),
    submitter: props.entry.submitter,
  };
  return wizardModel(schema.value, facts, ds.username, (ds.custodians ?? []).includes(ds.username));
});

const evidenceRef = computed(() => props.entry.record.evidenceRef);

const harmReceipt = computed(() => {
  void ds.tick;
  const entry = props.entry;
  if (statusOf.value !== 'accepted' || !entry.harm || entry.harm === 'none') return null;
  if (entry.harm === 'voided') return 'accepted — outcome voided (harm)';
  const base = Object.entries(entry.record.dims)
    .reduce((sum, [dimKey, match]) => sum + paymentFor(Number(dimKey), match), 0);
  const factor = harmFactorFor(entry.harm);
  const label = Object.keys(entry.record.dims).includes('1') ? 'bounty' : 'credit';
  const fmt = (n: number) => String(Number(n.toFixed(6)));
  return `accepted — ${label} ${fmt(base)} → ${fmt(base * factor)} (harm reduced)`;
});

type CardAction = { label: string; variant: string; title?: string; run: () => void; cls?: string };
const actions = computed<CardAction[]>(() => {
  void ds.tick;
  const currentStep = model.value.steps[model.value.currentStepIndex];
  // No appealed gate here (approved amendment): ui.ts leaves verify/settle
  // actionable while the pill reads 'appealed' — the e2e appeal flow depends
  // on it. Action buttons also carry their e2e classes (cls field).
  if (!currentStep) return [];
  const out: CardAction[] = [];
  for (const actor of ['submitter', 'verifier', 'custodian', 'member'] as const) {
    const role = currentStep.roles[actor];
    if (!role || !role.mayAct) continue;
    if (role.op === 'verify_contribution' && actor === 'verifier') {
      const stats = ds.dao?.getVerifierStats(ds.username) ?? { total: 0, upheld: 0 };
      out.push({
        label: props.entry.verifiedBy ? 'Verify (2nd)' : 'Verify…',
        cls: 'verify-contribution',
        variant: 'secondary',
        title: `Your checks: ${stats.total} (${stats.upheld} upheld)`,
        run: () => void ds.verifyContribution(props.entry),
      });
    }
    if (role.op === 'settle_contribution' && actor === 'submitter') {
      out.push({ label: 'Settle…', variant: 'primary', cls: 'settle-contribution', run: () => void ds.settleContribution(props.entry) });
    }
  }
  return out;
});

// Click-triggered fetch of stored evidence bytes; errors degrade to a note.
const evidenceImgUrl = ref<string | null>(null);
const evidenceDlUrl = ref<string | null>(null);
const evidenceFailed = ref(false);
const evidenceLabel = computed(() => {
  if (evidenceFailed.value) return 'evidence unavailable';
  return evidenceRef.value.uri.startsWith('content://')
    ? `stored evidence (${(evidenceRef.value.size / 1024).toFixed(1)} KB, ${evidenceRef.value.mediaType})`
    : `pointer: ${evidenceRef.value.uri}`;
});
const ownedUrls: string[] = [];
onBeforeUnmount(() => { for (const url of ownedUrls) URL.revokeObjectURL(url); });

async function loadEvidence() {
  const r = evidenceRef.value;
  const hash = r.uri.slice('content://'.length);
  try {
    const content = await serverClient.getContent(hash);
    if (!content) throw new Error('evidence unavailable');
    const blob = new Blob([content.bytes as BlobPart], { type: content.mediaType });
    const url = URL.createObjectURL(blob);
    ownedUrls.push(url);
    if (content.mediaType.startsWith('image/')) {
      evidenceImgUrl.value = url;
    } else {
      evidenceDlUrl.value = url;
    }
  } catch (err) {
    void err;
    evidenceFailed.value = true;
  }
}
</script>
```

Assemble `ContributionCard.vue` as: the `<template>` block, then the `<script setup lang="ts">` block, then this `<style scoped>` block (the load-evidence button renders only when both evidence urls are unset, per the template above):

**Styles** (scoped):

```css
.contribution-card {
  border: 1px solid var(--line); border-radius: var(--radius); padding: var(--space-4);
  background: var(--glass); -webkit-backdrop-filter: blur(8px); backdrop-filter: blur(8px);
  display: flex; flex-direction: column; gap: var(--space-2);
}
.contribution-card__header { display: flex; align-items: center; justify-content: space-between; gap: var(--space-3); }
.contribution-pill { font-family: var(--font-mono); font-size: .75rem; font-weight: 700; text-transform: uppercase; letter-spacing: .03em; padding: .15rem var(--space-2); border-radius: 999px; flex-shrink: 0; }
.contribution-pill--pending { color: var(--muted); border: 1px solid var(--line); }
.contribution-pill--accepted { color: var(--jade); border: 1px solid rgba(95, 208, 160, .5); }
.contribution-pill--rejected { color: var(--danger); border: 1px solid rgba(226, 128, 126, .5); }
.contribution-pill--appealed { color: var(--amber); border: 1px solid rgba(232, 168, 76, .5); }
.contribution-stepper { display: flex; flex-wrap: wrap; gap: var(--space-2); }
.contribution-step { font-family: var(--font-mono); font-size: .72rem; font-weight: 500; padding: .2rem var(--space-2); border-radius: 999px; border: 1px solid var(--line); color: var(--muted); }
.contribution-step--complete { color: var(--jade); border-color: rgba(95, 208, 160, .5); }
.contribution-step--current { color: var(--jade); border-color: var(--jade); background: rgba(95, 208, 160, .1); }
.contribution-step--locked { opacity: .6; border-style: dashed; }
.contribution-card__verdict { color: var(--danger); font-size: .8125rem; }
.contribution-card__harm { color: var(--amber); font-size: .8125rem; }
.contribution-card__actions { display: flex; gap: var(--space-2); }
.contribution-card__evidence-img { max-width: 100%; border-radius: var(--radius); }
.contribution-card__evidence-dl { color: var(--jade); font-family: var(--font-mono); font-size: .8125rem; }
```

- [ ] **Step 3: typecheck + commit**

Run: `npm run typecheck:client` → passes.

```bash
git add client/src/components/contribute
git commit -m "feat(contribute): Vue contribute page + contribution cards (wizard model, harm receipts, evidence)"
```

---

## Task 10: Round page

**Files:**
- Rewrite: `client/src/components/round/RoundPage.vue`

Ports `renderRound`, `onSetAlpha`, `onSetCalibration`, plus the stage-gated buttons (`hidden` class semantics preserved for the e2e).

```vue
<template>
  <SectionHeading number="04" eyebrow="Round" title="The settlement spine">
    <template #lede>Close the cycle: audit (C_10), reckon (C_20), complete and publish (C_21). Any member may drive the spine; weights gate the aggregation.</template>
  </SectionHeading>

  <Panel number="NN" kicker="Round spine">
    <div id="round-stepper" class="round-stepper">
      <span class="round-label">Round {{ current }} — stage: {{ stageNames[stage] ?? 'unknown' }}</span>
      <span v-for="(name, i) in stageNames" :key="name" :class="['round-step', i < stage ? 'round-step--complete' : i === stage ? 'round-step--current' : 'round-step--locked']">{{ name }}</span>
    </div>
    <div id="round-explanations" class="muted">{{ explanations }}</div>
    <div class="proposal-form__actions">
      <button id="audit-round-btn" :class="['button', 'button--secondary', { hidden: stage !== STAGE_OPEN }]" type="button" :disabled="ds.submitting" @click="ds.auditRound">Audit round…</button>
      <button id="reckon-round-btn" :class="['button', 'button--secondary', { hidden: stage !== STAGE_AUDITED }]" type="button" :disabled="ds.submitting" @click="ds.reckonRound">Reckon round…</button>
      <button id="complete-round-btn" :class="['button', 'button--primary', { hidden: stage !== STAGE_RECKONED }]" type="button" :disabled="ds.submitting" @click="ds.completeRound">Complete round &amp; publish</button>
    </div>
  </Panel>

  <Panel number="NN" kicker="Weights (custodian)">
    <form class="proposal-form" :class="{ hidden: !ds.isCustodian }" @submit.prevent>
      <div class="form-group"><input id="alpha-c1" v-model="alpha.c1" class="form-input" type="text" placeholder="alpha C_1 (e.g. 2)" /></div>
      <div class="form-group"><input id="alpha-c2" v-model="alpha.c2" class="form-input" type="text" placeholder="alpha C_2 (e.g. 0.5)" /></div>
      <div class="form-group"><input id="alpha-version" v-model="alpha.version" class="form-input" type="text" placeholder="weights version label" /></div>
      <div class="proposal-form__actions">
        <button id="set-alpha-btn" class="button button--secondary" type="button" :disabled="ds.submitting" @click="onSetAlpha">Set weights</button>
        <button id="set-calibration-btn" class="button button--secondary" type="button" :disabled="ds.submitting" @click="ds.setCalibrationVersion">Set calibration v1</button>
      </div>
    </form>
    <p v-if="!ds.isCustodian" class="muted">Custodian-only controls.</p>
  </Panel>
</template>

<script setup lang="ts">
import { computed, reactive } from 'vue';
import { STAGE_AUDITED, STAGE_OPEN, STAGE_RECKONED } from '@shared/round';
import { useDaoStore } from '../../stores/dao';
import { useStatusStore } from '../../stores/status';
import SectionHeading from '../../design/components/SectionHeading.vue';
import Panel from '../../design/components/Panel.vue';

const ds = useDaoStore();
const status = useStatusStore();
const stageNames = ['Open', 'Audited', 'Reckoned', 'Published'];

const current = computed(() => { void ds.tick; return ds.dao?.getCurrentRound() ?? 1; });
const stage = computed(() => { void ds.tick; return ds.dao?.getRoundStage(current.value) ?? 0; });
const explanations = computed(() => {
  void ds.tick;
  const records = ds.dao?.getRoundRecords(current.value) ?? [];
  return records.map((r) => `${String(r.stepId)}: ${String(r.note ?? '')}`).join(' | ');
});

const alpha = reactive({ c1: '', c2: '', version: '' });

async function onSetAlpha() {
  const raw: Record<string, number> = {};
  const c1 = parseFloat(alpha.c1);
  const c2 = parseFloat(alpha.c2);
  if (Number.isFinite(c1) && c1 > 0) raw['1'] = c1;
  if (Number.isFinite(c2) && c2 > 0) raw['2'] = c2;
  const version = alpha.version;
  if (Object.keys(raw).length === 0 || !version.trim()) {
    status.set('At least one weight and a version label are required.', 'error');
    return;
  }
  await ds.setRctAlpha(raw, version.trim());
  if (status.kind === 'success') alpha.c1 = alpha.c2 = alpha.version = '';
}
</script>
```

Plus scoped styles:

```css
.round-stepper { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-2); }
.round-label { font-family: var(--font-mono); font-size: .85rem; font-weight: 500; color: var(--ink); }
.round-step { font-family: var(--font-mono); font-size: .72rem; font-weight: 500; padding: .2rem var(--space-2); border-radius: 999px; border: 1px solid var(--line); color: var(--muted); }
.round-step--complete { color: var(--jade); border-color: rgba(95, 208, 160, .5); }
.round-step--current { color: var(--jade); border-color: var(--jade); background: rgba(95, 208, 160, .1); }
.round-step--locked { opacity: .6; border-style: dashed; }
.round-stepper + #round-explanations { margin-top: var(--space-3); }
```

- [ ] **Step 2: typecheck + commit**

Run: `npm run typecheck:client` → passes.

```bash
git add client/src/components/round
git commit -m "feat(round): Vue round spine page (stage gates + weights parity)"
```

---

## Task 11: Custodians page

**Files:**
- Rewrite: `client/src/components/custodians/CustodiansPage.vue`

Ports `renderMembers`, `renderCustodians`, `renderCustodianControls`, `onRemoveMember` (store action).

```vue
<template>
  <SectionHeading number="05" eyebrow="Custodians" title="Keepers of the keys">
    <template #lede>Members of the DAO, the seated custodians, and custodian admin controls.</template>
  </SectionHeading>

  <div class="cols">
    <Panel number="NN" kicker="Members">
      <ul id="members" class="member-list">
        <li class="member-item">
          <span class="member-item__name">{{ ds.username }}</span>
          <span v-if="youAreCustodian" class="member-item__badge">custodian</span>
          <span class="member-item__badge">you</span>
          <span class="member-item__tokens">🪙 {{ resBalance }} $RES</span>
          <span class="rct-badge" :data-member-rct="ds.username">{{ rctOf(ds.username) }} RCT</span>
        </li>
        <li v-for="m in otherMembers" :key="m" class="member-item">
          <span class="member-item__name">{{ m }}</span>
          <span v-if="isSeat(m)" class="member-item__badge">custodian</span>
          <span class="rct-badge" :data-member-rct="m">{{ rctOf(m) }} RCT</span>
        </li>
      </ul>
    </Panel>

    <Panel number="NN" kicker="Custodian seats">
      <div id="custodians" class="custodian-list">
        <span v-for="(c, i) in seats" :key="c" class="member-item__badge">Seat {{ i + 1 }}: {{ c }}</span>
        <span v-if="seats.length === 0" class="muted">No custodians elected yet.</span>
      </div>
    </Panel>

    <Panel number="NN" kicker="Custodian controls">
      <div id="remove-controls" class="remove-controls">
        <template v-if="ds.isCustodian">
          <div v-for="m in removable" :key="m" class="member-item">
            <span class="member-item__name">{{ m }}</span>
            <button type="button" class="button button--secondary remove-member" :disabled="ds.submitting" @click="ds.removeMember(m)">Remove</button>
          </div>
          <span v-if="removable.length === 0" class="muted">No other members to remove.</span>
        </template>
        <span v-else class="muted">Custodian-only controls.</span>
      </div>
    </Panel>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { useDaoStore } from '../../stores/dao';
import SectionHeading from '../../design/components/SectionHeading.vue';
import Panel from '../../design/components/Panel.vue';

const ds = useDaoStore();

const otherMembers = computed(() => ds.members.filter((m) => m !== ds.username));
const seats = computed(() => ds.dao?.custodians ?? []);
const youAreCustodian = computed(() => seats.value.includes(ds.username));
const removable = computed(() => otherMembers.value);
const resBalance = computed(() => { void ds.tick; return ds.dao && ds.username ? ds.dao.getResBalance(ds.username) : 0; });
function isSeat(m: string) { return seats.value.includes(m); }
function rctOf(m: string) { void ds.tick; return ds.dao?.getRctBalance(m) ?? 0; }
</script>

<style scoped>
.cols { display: grid; grid-template-columns: 1fr; gap: var(--space-6); }
@media (min-width: 900px) { .cols { grid-template-columns: 1fr 1fr; } .cols .panel:nth-child(3) { grid-column: 1 / -1; } }
.cols > :deep(.panel) { min-height: min-content; }
.member-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: var(--space-2); }
.member-item {
  display: flex; align-items: center; justify-content: space-between; gap: var(--space-3);
  padding: var(--space-3) var(--space-4); background: var(--glass);
  border: 1px solid var(--line); border-radius: var(--radius); font-size: .875rem;
}
.member-item__name { font-family: var(--font-mono); color: var(--ink); }
.member-item__badge {
  font-family: var(--font-mono); font-size: .7rem; letter-spacing: .08em;
  color: var(--jade); border: 1px solid rgba(95, 208, 160, .5);
  border-radius: 100px; padding: var(--space-1) var(--space-2);
}
.rct-badge {
  font-family: var(--font-mono); font-size: .72rem; font-weight: 500;
  color: var(--amber); border: 1px solid rgba(232, 168, 76, .5);
  border-radius: 100px; padding: .1rem var(--space-2);
}
.custodian-list { display: flex; flex-wrap: wrap; gap: var(--space-2); }
.remove-controls { display: flex; flex-direction: column; gap: var(--space-2); }
.member-item__tokens { font-family: var(--font-mono); font-size: .78rem; color: var(--amber); white-space: nowrap; }
</style>
```

- [ ] **Step 2: typecheck + commit**

Run: `npm run typecheck:client` → passes.

```bash
git add client/src/components/custodians
git commit -m "feat(custodians): Vue custodians page (members, seats, removal parity)"
```

---

## Task 12: Retire the legacy presentation layer

**Files:**
- Delete: `client/src/ui.ts`, `client/src/theme.css`

- [ ] **Step 1: confirm nothing imports them**

Run: `grep -rn "from './ui'\|theme.css\|from './theme" client/src client/index.html || true`
Expected: no matches.

- [ ] **Step 2: delete**

```bash
git rm client/src/ui.ts client/src/theme.css
```

- [ ] **Step 3: typecheck + build**

Run: `npm run typecheck:client && npm run build:client` → both pass.

- [ ] **Step 4: commit**

```bash
git add -A client/src
git commit -m "refactor(client): retire legacy AppUI god-class and old theme"
```

---

## Task 13: CRABS devtools wiring (dev-only)

**Files:**
- Modify: `client/src/crabs-wasm-wrapper.ts` (module selection), `client/src/main.ts` (dev injection), `client/src/stores/dao.ts` (attach), `scripts/copy-wasm.sh` (dev artifact copy)

- [ ] **Step 1: extend `scripts/copy-wasm.sh`** — always copies the devtools artifact set next to the prod set, but into `client/dev-wasm/` (NOT `public/`), so `vite build` (publicDir copy) can never ship them:

```bash
#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$SCRIPT_DIR/.."
CRABS_WASM="$ROOT/../CRABS/bindings/wasm"
CRABS_DEVTOOLS="$ROOT/../CRABS/bindings/devtools"
EAUTH_WASM="$ROOT/../EAuth/bindings/wasm"
OUT="$ROOT/client/public/wasm"
DEV_OUT="$ROOT/client/dev-wasm"

mkdir -p "$OUT/crabs" "$OUT/eauth" "$DEV_OUT"

# Production artifacts ship to public/ (copied into dist/ by vite build).
cp "$CRABS_WASM/crabs.js" "$CRABS_WASM/crabs.wasm" "$OUT/crabs/"
cp "$EAUTH_WASM/eauth.js" "$EAUTH_WASM/eauth.wasm" "$OUT/eauth/"

# Devtools artifacts live OUTSIDE public/ so a production release cannot
# include them: the dev server serves client/dev-wasm/* at /dev-wasm/*.
cp "$CRABS_WASM/crabs.dev.js" "$CRABS_WASM/crabs.dev.wasm" "$DEV_OUT/"
cp "$CRABS_DEVTOOLS/devtools-api.js" "$CRABS_DEVTOOLS/crabs-devtools.js" "$DEV_OUT/"

echo "WASM artifacts copied to $OUT (prod) and $DEV_OUT (devtools)"
```

Run it: `npm run copy-wasm` → both directories filled.

- [ ] **Step 2: dev-module preference in `client/src/crabs-wasm-wrapper.ts`** — change the `getModule()` block to prefer the devtools-enabled module when the dev server injected it:

```ts
let _modulePromise = null;

export function getModule() {
  if (!_modulePromise) {
    if (typeof window !== 'undefined' && window.createCRABSModuleDev) {
      // Dev build (injected by main.ts only outside production): the devtools
      // panel attaches to nodes backed by this module; attaching to a prod
      // module throws 'not compiled with devtools support'.
      _modulePromise = window.createCRABSModuleDev();
    } else if (typeof window !== 'undefined' && window.createCRABSModule) {
      _modulePromise = window.createCRABSModule();
    } else {
      throw new Error('CRABS WASM module not loaded. Ensure /wasm/crabs/crabs.js is included before the app bundle.');
    }
  }
  return _modulePromise;
}
```

- [ ] **Step 3: dev script injection in `client/src/main.ts`**

```ts
import { createApp } from 'vue';
import { createPinia } from 'pinia';
import App from './app/App.vue';
import router from './app/router';
import './design/tokens.css';
import './design/base.css';

// Devtools-enabled CRABS build, only outside production releases
// (import.meta.env.DEV is false for `vite build`). Artifacts under
// client/dev-wasm are never copied into dist/.
async function injectDevtoolsScripts() {
  const sources = ['/dev-wasm/crabs.dev.js', '/dev-wasm/devtools-api.js', '/dev-wasm/crabs-devtools.js'];
  for (const src of sources) {
    await new Promise<void>((resolve, reject) => {
      const script = document.createElement('script');
      script.src = src;
      script.onload = () => resolve();
      script.onerror = () => reject(new Error(`devtools script not available: ${src}`));
      document.head.appendChild(script);
    });
  }
}

async function boot() {
  if (import.meta.env.DEV) {
    await injectDevtoolsScripts();
  }
  createApp(App).use(createPinia()).use(router).mount('#app');
}

void boot();
```

- [ ] **Step 4: attach in `client/src/stores/dao.ts`** — extend `bootstrap`:

```ts
async function bootstrap(target: BrowserDao, user: string) {
  dao.value = target;
  username.value = user;
  startClock();
  // Devtools panel (dev only): the inspector exposes plaintext CRDT state,
  // so attaching to a production build is forbidden — the prod wasm isn't
  // compiled with devtools support and the dev scripts are never shipped.
  if (import.meta.env.DEV && window.CRABSDevtools) {
    try {
      window.CRABSDevtools.attach(target.node, { nodeId: target.nodeId });
    } catch (err) {
      console.warn('CRABS devtools attach failed (non-fatal):', err);
    }
  }
}
```

- [ ] **Step 5: verify both directions**

- Dev: `npm run dev:client` with `npm run dev:server` → open the app, log in, the devtools launcher button should appear (right edge) and the panel opens showing the browser node's States/Timeline/CRDT/Config.
- Prod leak assert: `npm run build:client` then check
  `test ! -d client/dist/dev-wasm && test ! -f client/dist/wasm/crabs/crabs.dev.wasm && echo "no devtools artifacts in dist"` → prints.

- [ ] **Step 6: commit**

```bash
git add scripts/copy-wasm.sh client/src/crabs-wasm-wrapper.ts client/src/main.ts client/src/stores/dao.ts
git commit -m "feat(devtools): CRABS inspector in dev builds only (dev-wasm outside publicDir)"
```

---

## Task 14: Playwright e2e update + parity run

**Files:**
- Modify: `test-voting-browser.js`

The flows stay identical; add route navigation between phases (SPA navigation, never `page.goto` — a full reload would drop the in-memory wallet). Add a helper and insert navigation calls after login/between phases:

```js
// SPA navigation between feature routes — never page.goto: a reload would
// drop the in-memory wallet state the flows rely on.
const nav = (page, href) => page.click(`header nav a[href="${href}"]`);
```

Insert into the flow (each user navigates before their act):

| Where | Insert |
| --- | --- |
| after each `runUser` | nothing (post-login lands on `/proposals`) |
| before the wizard cycles | `await nav(alice.page, '/contribute');` (and equivalently for bob/carol/dave before their verify/settle clicks — add `await nav(bob.page, '/contribute');` etc. before the first act on that page) |
| before `runRoundSpineStep` (alice) | `await nav(alice.page, '/round');` |
| before the quadratic proposal | `await nav(alice.page, '/proposals');` |
| before each `#start-election` | `await nav(alice.page, '/elections');` |
| before ballot clicks/`.ballot-option` waits | `await nav(<page>, '/elections');` |
| after finalize (custodian removal) | `await nav(alice.page, '/custodians');` before locators `#custodians .member-item__badge` / `.remove-member` |
| before the RCT-badge assert | `await nav(alice.page, '/custodians');` (if not already there) |
| diagnostics in the catch block | keep `#status` read; wrap `.round-label`/`#proposals` reads in try/catch as today |

Also: the round-panel label assert (`.round-label` starts with `Round 2`) happens on `/round` — alice is already there after the spine; the salient-proposal section navigates her away and back as listed. `#token-balance` and status-bar ids are unchanged.

- [ ] **Step 1: apply the edits above to `test-voting-browser.js`**

- [ ] **Step 2: run the full parity suite**

```bash
WAVEDB_PATH=/tmp/dao-replatform-e2e npm run build:client
WAVEDB_PATH=/tmp/dao-replatform-e2e npm run dev:server &
SERVER_PID=$!
sleep 3
node test-voting-browser.js
kill $SERVER_PID
```

Expected: `Smoke test passed`. The suite self-cleans: it starts 4 browser contexts; ~2.5 min runtime (two 62 s election-expiry waits).

- [ ] **Step 3: commit**

```bash
git add test-voting-browser.js
git commit -m "test: route navigation in the e2e flow for the Vue app"
```

---

## Task 15: Final gates

- [ ] **Step 1: full test suite**

Run: `npm test`
Expected: 9 suites / 142 tests pass (server contract untouched).

- [ ] **Step 2: build gates**

Run: `npm run build && npm run typecheck:client`
Expected: all pass; prod bundle clean of devtools artifacts (re-run the Task 13 leak assert).

- [ ] **Step 3: both-theme walk**

Run: `npm run dev` → walk every route in dark and light at a ~700px-wide viewport: auth → propose → vote → election start → contribute → verify → round spine state chips → custodian list → account placeholder. Confirm tokens/motifs/fonts render in both themes; no console errors.

- [ ] **Step 4: commit any straggler fixes, then done**

```bash
git add -A
git commit -m "chore: frontend re-platform slice 1 complete"
```

---

## Self-review notes (executed)

- Spec coverage: tokens+motifs (Tasks 2–3), dual theme + toggle (Task 2/6), self-hosted fonts (Task 1), Vue/router/stores (Tasks 4–6), all seven routes (Tasks 6–11), big-bang legacy retirement (Task 12), devtools dev-only (Task 13), e2e parity (Task 14), gates (Task 15). Placeholder pages for `/` and `/account` are per spec.
- Naming consistency: `useDaoStore` exports `replayLog` (Task 4 return list) — consumed by the auth store (Task 5). Op actions live only in the dao store; page components pass them through.
- Naming consistency: `useDaoStore` exports `replayLog` (Task 4 note to add it to the return list — required by Task 5).