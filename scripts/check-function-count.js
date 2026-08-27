// Build guard: fails if api/ has more deployable Serverless Functions than we allow.
//
// Vercel's Hobby plan caps a single deployment at 12 Serverless Functions. This project has hit
// that ceiling before (see api/program-manager.js / api/gemini-batch.js, both consolidated behind a
// mode/action param to claw back slots). MAX_FUNCTIONS is deliberately 10, not 12 — a 2-slot buffer
// so the next endpoint doesn't drop the project straight back onto the hard limit with no room.
//
// Wired into `npm run build` via the "prebuild" script in package.json, so every local build — and
// every build Claude Code runs before a commit — fails visibly here instead of only after a push,
// when Vercel rejects the deployment.
//
// Vercel deploys every file directly under api/ as its own function EXCEPT names starting with "_"
// (its documented convention for shared, non-endpoint helpers). This mirrors that rule, so a future
// `api/_lib.js` style helper wouldn't be miscounted.

import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const MAX_FUNCTIONS = 10;
const HOBBY_HARD_LIMIT = 12;

const apiDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'api');

let entries;
try {
  entries = readdirSync(apiDir, { withFileTypes: true });
} catch (err) {
  console.error(`[check-function-count] could not read ${apiDir}: ${err.message}`);
  process.exit(1);
}

const functionFiles = entries
  .filter((e) => e.isFile() && e.name.endsWith('.js') && !e.name.startsWith('_'))
  .map((e) => e.name)
  .sort();

const count = functionFiles.length;

if (count > MAX_FUNCTIONS) {
  console.error('');
  console.error(`  ✗ api/ has ${count} Serverless Functions — over the ${MAX_FUNCTIONS} guard.`);
  console.error(`    (Vercel Hobby hard limit is ${HOBBY_HARD_LIMIT}; the guard keeps a 2-slot buffer.)`);
  console.error('');
  functionFiles.forEach((f) => console.error(`      - api/${f}`));
  console.error('');
  console.error('    Consolidate related endpoints behind one file with a mode/action param');
  console.error('    (see api/program-manager.js, api/gemini-batch.js) before adding another.');
  console.error('');
  process.exit(1);
}

console.log(`[check-function-count] api/ has ${count}/${MAX_FUNCTIONS} Serverless Functions — ok`);
