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

  it('paces all eVault control-request starts without holding a response semaphore', async () => {
    vi.useFakeTimers();
    const startedAt: number[] = [];

    const first = await acquireEVaultTrafficLease({ trafficClass: 'interactive' });
    const firstStartedAt = Date.now();
    startedAt.push(firstStartedAt);
    const secondPending = acquireEVaultTrafficLease({ trafficClass: 'interactive' }).then((lease) => {
      startedAt.push(Date.now());
      return lease;
    });

    await vi.advanceTimersByTimeAsync(249);
    expect(startedAt).toEqual([firstStartedAt]);
    await vi.advanceTimersByTimeAsync(1);
    const second = await secondPending;

    // The first source response has not released. The second lease is still
    // admitted at the next cadence slot so File -> metadata hedges work.
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    expect(startedAt).toEqual([firstStartedAt, firstStartedAt + 250]);
  });

  it('lets interactive playback preempt every active and queued background request', async () => {
    vi.useFakeTimers();
    const active = await acquireEVaultTrafficLease({ trafficClass: 'background' });
    const queued = acquireEVaultTrafficLease({ trafficClass: 'background' });
    const session = beginInteractiveEVaultTrafficSession();
    const interactive = await acquireEVaultTrafficLease({ trafficClass: 'interactive' });

    expect(active?.signal.aborted).toBe(true);
    expect(isEVaultTrafficPreempted(active?.signal)).toBe(true);
    expect(await queued).toBeUndefined();
    expect(interactive?.signal.aborted).toBe(false);

    active?.release();
    interactive?.release();
    session.release();
  });

  it('admits an exact foreground proof batch before applying its sustained cadence', async () => {
    vi.useFakeTimers();
    const session = beginInteractiveEVaultTrafficSession();
    const startedAt: number[] = [];
    const first = await acquireEVaultTrafficLease({ trafficClass: 'interactive' });
    const firstStartedAt = Date.now();
    startedAt.push(firstStartedAt);
    const second = acquireEVaultTrafficLease({ trafficClass: 'interactive' }).then((lease) => {
      startedAt.push(Date.now());
      return lease;
    });
    const third = acquireEVaultTrafficLease({ trafficClass: 'interactive' }).then((lease) => {
      startedAt.push(Date.now());
      return lease;
    });
    await Promise.resolve();

    expect(startedAt).toEqual([firstStartedAt, firstStartedAt, firstStartedAt]);
    expect(await second).toBeDefined();
    expect(await third).toBeDefined();

    const fourth = acquireEVaultTrafficLease({ trafficClass: 'interactive' });
    await vi.advanceTimersByTimeAsync(249);
    let fourthStarted = false;
    void fourth.then(() => {
      fourthStarted = true;
    });
    await Promise.resolve();
    expect(fourthStarted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await fourth).toBeDefined();
    first?.release();
    session.release();
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

  it('retains the conservative background cadence after an interactive preemption', async () => {
    vi.useFakeTimers();
    const first = await acquireEVaultTrafficLease({ trafficClass: 'background' });
    const interactivePending = acquireEVaultTrafficLease({ trafficClass: 'interactive' });
    first?.release();
    await vi.advanceTimersByTimeAsync(250);
    await interactivePending;

    let resumed = false;
    const backgroundPending = acquireEVaultTrafficLease({ trafficClass: 'background' }).then(
      (lease) => {
        resumed = true;
        return lease;
      },
    );
    await vi.advanceTimersByTimeAsync(749);
    expect(resumed).toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    const background = await backgroundPending;
    expect(background).toBeDefined();
    background?.release();
  });

  it('does not spend a future cadence slot on a cancelled queued request', async () => {
    vi.useFakeTimers();
    await acquireEVaultTrafficLease({ trafficClass: 'interactive' });
    const controller = new AbortController();
    const cancelled = acquireEVaultTrafficLease({
      trafficClass: 'interactive',
      signal: controller.signal,
    });
    controller.abort();
    expect(await cancelled).toBeUndefined();

    const next = acquireEVaultTrafficLease({ trafficClass: 'interactive' });
    await vi.advanceTimersByTimeAsync(249);
    let resolved = false;
    void next.then(() => {
      resolved = true;
    });
    await Promise.resolve();
    expect(resolved).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await next).toBeDefined();
  });

  it('keeps background work single-flight and drops it when its durable task is cancelled', async () => {
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
