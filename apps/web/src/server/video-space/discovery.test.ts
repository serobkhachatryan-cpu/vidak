import { describe, expect, it } from 'vitest';
import { completeInventory } from './completeness';
import { formatInventoryMetricsLog, inventoryDiscovery, parseInventoryScope } from './discovery';

describe('inventory discovery status', () => {
  it('never reports complete while a scan is still running', () => {
    expect(inventoryDiscovery({ scanning: true, completeness: completeInventory })).toBe(
      'refreshing',
    );
    expect(
      inventoryDiscovery({
        scanning: false,
        completeness: { ...completeInventory, complete: false, retryNeeded: true },
      }),
    ).toBe('partial');
    expect(inventoryDiscovery({ scanning: false, completeness: completeInventory })).toBe(
      'complete',
    );
  });

  it('parses tab scope and keeps metrics free of identifiers', () => {
    expect(parseInventoryScope('owned')).toBe('owned');
    expect(parseInventoryScope('shared')).toBe('shared');
    expect(parseInventoryScope('all')).toBe('all');
    const line = formatInventoryMetricsLog({
      discovery: 'partial',
      completeness: {
        ...completeInventory,
        retryRateLimited: 2,
        retryNeeded: true,
        complete: false,
      },
      metrics: {
        cache: 'miss',
        firstResultMs: 40,
        completionMs: 90,
        sourceCounts: { personalPages: 2, sharedSpaces: 1, failed: 1 },
      },
    });
    expect(line).toContain('cache=miss');
    expect(line).toContain('discovery=partial');
    expect(line).toContain('first_result_ms=40');
    expect(line).not.toMatch(/@|[a-f0-9-]{8,}|http|Bearer|cookie/i);
  });
});
