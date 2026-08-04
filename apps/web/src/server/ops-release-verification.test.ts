import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const scriptPath = resolve(repoRoot, 'scripts/verify-release.mjs');
const packageJsonPath = resolve(repoRoot, 'package.json');

describe('verify:release script', () => {
  it('covers lint, typecheck, tests, build, Storybook, and migration validation', () => {
    const source = readFileSync(scriptPath, 'utf8');

    for (const name of [
      'lint',
      'typecheck',
      'test',
      'build',
      'storybook:build',
      'migration validation',
    ]) {
      expect(source).toContain(`name: '${name}'`);
    }

    expect(source).toContain('migrations.test.ts');
    expect(source).toContain('no live W3DS');
    expect(source).not.toMatch(/W3DS_REGISTRY_BASE_URL\s*=/);
    expect(source).not.toMatch(/curl .*registry/i);

    // Step order: lint → typecheck → test → build → storybook → migrations
    const positions = [
      "name: 'lint'",
      "name: 'typecheck'",
      "name: 'test'",
      "name: 'build'",
      "name: 'storybook:build'",
      "name: 'migration validation'",
    ].map((needle) => source.indexOf(needle));
    expect(positions.every((index) => index >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });

  it('is wired as the root verify:release script', () => {
    const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as {
      scripts?: Record<string, string>;
    };
    expect(packageJson.scripts?.['verify:release']).toBe('node scripts/verify-release.mjs');
  });
});
