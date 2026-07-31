import { channel } from "node:diagnostics_channel";

import type { ProcessTreeTerminationReceipt } from "./registered-process-supervisor.js";

const RECEIPT_CHANNEL = channel("gpt-codex-hwp.document-child.termination");

export function publishDocumentChildTerminationReceipt(
  receipt: ProcessTreeTerminationReceipt,
): void {
  try {
    RECEIPT_CHANNEL.publish(receipt);
  } catch {
    // Diagnostics must never alter document cleanup or result settlement.
  }
}

export function subscribeDocumentChildTerminationReceipts(
  observer: (message: unknown) => void,
): () => void {
  const listener = (message: unknown): void => {
    try { observer(message); } catch {}
  };
  RECEIPT_CHANNEL.subscribe(listener);
  let subscribed = true;
  return () => {
    if (!subscribed) return;
    subscribed = false;
    RECEIPT_CHANNEL.unsubscribe(listener);
  };
}
