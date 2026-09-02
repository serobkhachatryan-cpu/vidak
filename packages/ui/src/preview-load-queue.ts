// eVault sources can throttle parallel frame extraction. Serialize card posters
// so a temporary upstream throttle remains a loading state instead of a failure.
const previewConcurrency = 1;
let activePreviewLoads = 0;
const previewWaiters: Array<() => void> = [];

function pumpPreviewQueue() {
  while (activePreviewLoads < previewConcurrency && previewWaiters.length > 0) {
    const next = previewWaiters.shift();
    next?.();
  }
}

/** Bounded in-flight preview fetches. Cancel by calling the returned function. */
export function enqueuePreviewLoad(task: () => Promise<void>): () => void {
  let cancelled = false;
  let started = false;

  const start = () => {
    if (cancelled || started) return;
    started = true;
    activePreviewLoads += 1;
    void task().finally(() => {
      activePreviewLoads -= 1;
      pumpPreviewQueue();
    });
  };

  if (activePreviewLoads < previewConcurrency) start();
  else previewWaiters.push(start);

  return () => {
    cancelled = true;
    const index = previewWaiters.indexOf(start);
    if (index >= 0) previewWaiters.splice(index, 1);
  };
}

export function resetPreviewLoadQueueForTests() {
  activePreviewLoads = 0;
  previewWaiters.length = 0;
}
