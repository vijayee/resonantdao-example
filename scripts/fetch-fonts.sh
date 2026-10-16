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