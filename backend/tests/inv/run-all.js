// Runs every *.test.js in this directory sequentially, each in its own node process.
// Usage: npm run test:inv
import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const dir = new URL('./', import.meta.url);
const files = readdirSync(dir).filter((name) => name.endsWith('.test.js')).sort();
const failed = [];
for (const name of files) {
  console.log(`\n# ${name}`);
  const { status } = spawnSync(process.execPath, [fileURLToPath(new URL(name, dir))], { stdio: 'inherit' });
  if (status !== 0) failed.push(name);
}
console.log(`\n${files.length - failed.length}/${files.length} inventory test files passed.`);
if (failed.length) { console.error(`Failed: ${failed.join(', ')}`); process.exit(1); }
if (!files.length) { console.error('No *.test.js files found.'); process.exit(1); }
