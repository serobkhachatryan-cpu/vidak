import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  validate: vi.fn(),
  startPump: vi.fn(),
}));

vi.mock('./server/server-config', () => ({
  validateServerConfigAtStartup: mocks.validate,
}));

vi.mock('./server/video-space/inventory-pump', () => ({
  startInventoryJobPump: mocks.startPump,
}));

import { register } from './instrumentation';

const initialRuntime = process.env.NEXT_RUNTIME;
const initialPhase = process.env.NEXT_PHASE;

describe('server instrumentation', () => {
  beforeEach(() => {
    mocks.validate.mockReset();
    mocks.startPump.mockReset();
    mocks.validate.mockReturnValue({ w3ds: null });
    delete process.env.NEXT_PHASE;
  });

  afterEach(() => {
    if (initialRuntime === undefined) delete process.env.NEXT_RUNTIME;
    else process.env.NEXT_RUNTIME = initialRuntime;
    if (initialPhase === undefined) delete process.env.NEXT_PHASE;
    else process.env.NEXT_PHASE = initialPhase;
  });

  it('starts the inventory pump in a standalone Node server when NEXT_RUNTIME is absent', async () => {
    delete process.env.NEXT_RUNTIME;

    await register();

    expect(mocks.validate).toHaveBeenCalledTimes(1);
    expect(mocks.startPump).toHaveBeenCalledTimes(1);
  });

  it('does not run server instrumentation in an explicit Edge runtime', async () => {
    process.env.NEXT_RUNTIME = 'edge';

    await register();

    expect(mocks.validate).not.toHaveBeenCalled();
    expect(mocks.startPump).not.toHaveBeenCalled();
  });
});
