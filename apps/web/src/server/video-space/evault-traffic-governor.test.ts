import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import {
  acquireEVaultTrafficLease,
  beginInteractiveEVaultTrafficSession,
  isEVaultTrafficPreempted,
  resetEVaultTrafficGovernorForTests,
} from './evault-traffic-governor';

describe('eVault traffic governor', () => {
  afterEach(() => {
    resetEVaultTrafficGovernorForTests();
    vi.useRealTimers();
  });

  it('serializes and spaces resumable eVault requests across the platform lane', async () => {
    vi.useFakeTimers();
    const first = await acquireEVaultTrafficLease({ trafficClass: 'background' });
    expect(first).toBeDefined();

    let secondResolved = false;
    const secondPending = acquireEVaultTrafficLease({ trafficClass: 'background' }).then(
      (lease) => {
        secondResolved = true;
        return lease;
      },
    );
    await Promise.resolve();
    expect(secondResolved).toBe(false);

    first?.release();
    await vi.advanceTimersByTimeAsync(999);
    expect(secondResolved).toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    const second = await secondPending;
    expect(second).toBeDefined();
    second?.release();
  });

  it('lets interactive playback preempt active and queued background work', async () => {
    vi.useFakeTimers();
    const active = await acquireEVaultTrafficLease({ trafficClass: 'background' });
    const queued = acquireEVaultTrafficLease({ trafficClass: 'background' });
    const interactive = await acquireEVaultTrafficLease({ trafficClass: 'interactive' });

    expect(active?.signal.aborted).toBe(true);
    expect(isEVaultTrafficPreempted(active?.signal)).toBe(true);
    expect(await queued).toBeUndefined();
    expect(interactive?.signal.aborted).toBe(false);

    active?.release();
    interactive?.release();
  });

  it('holds background work for the full interactive playback transaction', async () => {
    vi.useFakeTimers();
    const active = await acquireEVaultTrafficLease({ trafficClass: 'background' });
    const session = beginInteractiveEVaultTrafficSession();
    expect(active?.signal.aborted).toBe(true);
    expect(isEVaultTrafficPreempted(active?.signal)).toBe(true);

    let backgroundStarted = false;
    const queued = acquireEVaultTrafficLease({ trafficClass: 'background' }).then((lease) => {
      backgroundStarted = true;
      return lease;
    });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(backgroundStarted).toBe(false);

    active?.release();
    await Promise.resolve();
    expect(backgroundStarted).toBe(false);

    session.release();
    const resumed = await queued;
    expect(resumed).toBeDefined();
    resumed?.release();
  });

  it('still spaces the next background request after an interactive preemption', async () => {
    vi.useFakeTimers();
    const first = await acquireEVaultTrafficLease({ trafficClass: 'background' });
    await acquireEVaultTrafficLease({ trafficClass: 'interactive' });
    first?.release();

    let resumed = false;
    const backgroundPending = acquireEVaultTrafficLease({ trafficClass: 'background' }).then(
      (lease) => {
        resumed = true;
        return lease;
      },
    );
    await vi.advanceTimersByTimeAsync(999);
    expect(resumed).toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    const background = await backgroundPending;
    expect(background).toBeDefined();
    background?.release();
  });

  it('drops a queued request when its resumable task is cancelled', async () => {
    vi.useFakeTimers();
    const active = await acquireEVaultTrafficLease({ trafficClass: 'background' });
    const controller = new AbortController();
    const queued = acquireEVaultTrafficLease({
      trafficClass: 'background',
      signal: controller.signal,
    });

    controller.abort();
    expect(await queued).toBeUndefined();
    active?.release();
  });
});
