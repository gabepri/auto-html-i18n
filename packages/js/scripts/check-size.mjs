#!/usr/bin/env node
/**
 * Bundle size budget.
 *
 * Every kilobyte here is download, parse and compile time on the low-end phones this
 * library is most likely to be janking. The gate is on the gzipped ESM bundle, which is
 * what a consumer's bundler actually pulls in.
 *
 * `intl-messageformat` is deliberately external (see vite.config.ts), so it is NOT
 * counted here — consumers still pay for it separately. Making that dependency
 * pay-per-use is tracked work, not something this budget can see.
 *
 * When this fails, ship less code. Raise the limit only deliberately, with a reason.
 */
import { gzipSync } from 'node:zlib';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const BUDGETS = [
  // 20 -> 22KB with the externalTranslation feature (browser-translator detection
  // engine + graduated coexistence levels): +2.6KB in this unminified-with-comments
  // ESM, +1.4KB minified (see the CJS). Deliberate raise, not drift.
  { file: 'dist/auto-html-i18n.js', maxGzip: 22 * 1024 },
  { file: 'dist/auto-html-i18n.cjs', maxGzip: 13 * 1024 },
];

let failed = false;

for (const { file, maxGzip } of BUDGETS) {
  const path = resolve(pkgRoot, file);

  let contents;
  try {
    contents = readFileSync(path);
  } catch {
    console.error(`✗ ${file}: not found — run \`npm run build\` first`);
    failed = true;
    continue;
  }

  const gzip = gzipSync(contents, { level: 9 }).length;
  const pct = Math.round((gzip / maxGzip) * 100);
  const detail = `${(gzip / 1024).toFixed(1)}KB gzip / ${(maxGzip / 1024).toFixed(0)}KB budget (${pct}%)`;

  if (gzip > maxGzip) {
    console.error(`✗ ${file}: ${detail}`);
    failed = true;
  } else {
    console.log(`✓ ${file}: ${detail}`);
  }
}

process.exit(failed ? 1 : 0);
