import { channel } from "node:diagnostics_channel";

const RECEIPT_CHANNEL = channel("gpt-codex-hwp.document-worker.termination");
const RECEIPT = Object.freeze({
  terminated: true,
  proof: "worker-thread-terminated",
});

export function publishDocumentWorkerTerminationReceipt(): void {
  try {
    RECEIPT_CHANNEL.publish(RECEIPT);
  } catch {
    // Diagnostics must never alter worker cleanup or result settlement.
  }
}

export function subscribeDocumentWorkerTerminationReceipts(
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
