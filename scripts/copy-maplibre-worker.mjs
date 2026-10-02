/**
 * Copies maplibre-gl's web worker into the apps that render maps on the web.
 *
 * maplibre-gl 6 starts its worker from a URL next to its own module file,
 * and neither Next.js nor Expo's web bundler copies that file along. The
 * map then fails with "Worker failed to load" and never draws. So the
 * worker (and the shared chunk it imports) is served from each app's
 * public/ folder, and the map code points at it with setWorkerUrl().
 *
 * Runs on `pnpm install` (postinstall), so it tracks the installed version.
 * The copies are gitignored.
 */

import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(join(root, 'apps/admin/package.json'));

let dist;
try {
  dist = join(dirname(require.resolve('maplibre-gl/package.json')), 'dist');
} catch {
  console.log('maplibre-gl not installed; skipping worker copy');
  process.exit(0);
}

const FILES = ['maplibre-gl-worker.mjs', 'maplibre-gl-shared.mjs'];
const TARGETS = ['apps/admin/public/maplibre', 'apps/rider/public/maplibre'];

for (const target of TARGETS) {
  const dir = join(root, target);
  if (!existsSync(join(dir, '..', '..', 'package.json'))) continue;
  mkdirSync(dir, { recursive: true });
  for (const file of FILES) copyFileSync(join(dist, file), join(dir, file));
}
console.log(`maplibre-gl worker copied to ${TARGETS.join(', ')}`);
