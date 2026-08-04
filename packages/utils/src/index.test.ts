import { describe, expect, it } from 'vitest';
import { identity } from './index.js';

describe('identity', () => {
  it('returns its input unchanged', () => {
    expect(identity('w3ds')).toBe('w3ds');
  });
});
