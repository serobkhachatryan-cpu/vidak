#!/usr/bin/env node
/**
 * Repeatable release verification gate.
 * Covers lint, typecheck, tests, build, Storybook build, and migration
 * validation without live W3DS Registry/eVault/ACL access.
 */

import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Ordered release-verification steps (exported for focused tests). */
export const RELEASE_VERIFICATION_STEPS = [
  {
    name: 'lint',
    command: 'pnpm',
    args: ['lint'],
  },
  {
    name: 'typecheck',
    command: 'pnpm',
    args: ['typecheck'],
  },
  {
    name: 'test',
    command: 'pnpm',
    args: ['test'],
  },
  {
    name: 'build',
    command: 'pnpm',
    args: ['build'],
  },
  {
    name: 'storybook:build',
    command: 'pnpm',
    args: ['storybook:build'],
  },
  {
    name: 'migration validation',
    command: 'pnpm',
    args: ['exec', 'vitest', 'run', 'apps/web/src/server/db/migrations.test.ts'],
  },
];

function runStep(step) {
  console.log(`\n==> verify:release — ${step.name}`);
  const result = spawnSync(step.command, step.args, {
    cwd: rootDir,
    stdio: 'inherit',
    env: {
      ...process.env,
      // Release verification must never require live W3DS protocol services.
      W3DS_RELEASE_VERIFY: '1',
    },
    shell: process.platform === 'win32',
  });
  if (result.error) {
    console.error(result.error.message);
    process.exit(1);
  }
  if (result.status !== 0) {
    console.error(`\nverify:release failed at step: ${step.name}`);
    process.exit(result.status ?? 1);
  }
}

function main() {
  console.log('verify:release — starting (no live W3DS access required)');
  for (const step of RELEASE_VERIFICATION_STEPS) {
    runStep(step);
  }
  console.log('\nverify:release — all checks passed');
}

const isDirectRun = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) {
  main();
}
