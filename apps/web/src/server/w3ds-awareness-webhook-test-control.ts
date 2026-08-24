import type { W3dsAwarenessReceiptStore } from './w3ds-awareness-receipts';

let testReceiptStore: W3dsAwarenessReceiptStore | undefined;

/** Test-only dependency override kept outside the Next.js route module. */
export function setAwarenessWebhookReceiptStoreForTests(
  store: W3dsAwarenessReceiptStore | undefined,
): void {
  testReceiptStore = store;
}

export function getAwarenessWebhookReceiptStoreForTests(): W3dsAwarenessReceiptStore | undefined {
  return testReceiptStore;
}
