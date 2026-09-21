import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const map = JSON.parse(await readFile(path.join(root, 'rename-map.json'), 'utf8'));

let applied = 0;
for (const [file, entries] of Object.entries(map)) {
  const filePath = path.join(root, 'bpmn', file);
  let xml = await readFile(filePath, 'utf8');
  for (const [oldLabel, entry] of Object.entries(entries)) {
    const newLabel = typeof entry === 'string' ? entry : entry.new;
    const needle = `name="${oldLabel}"`;
    const pieces = xml.split(needle);
    if (pieces.length === 1) {
      console.error(`FAIL ${file}: old label not found: ${needle}`);
      process.exit(1);
    }
    xml = pieces.join(`name="${newLabel}"`);
    applied += pieces.length - 1;
  }
  await writeFile(filePath, xml);
}
console.log(`Applied ${applied} renames across ${Object.keys(map).length} files.`);