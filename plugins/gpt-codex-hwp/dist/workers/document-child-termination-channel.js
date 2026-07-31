import { channel } from "node:diagnostics_channel";
const RECEIPT_CHANNEL = channel("gpt-codex-hwp.document-child.termination");
export function publishDocumentChildTerminationReceipt(receipt) {
    try {
        RECEIPT_CHANNEL.publish(receipt);
    }
    catch {
        // Diagnostics must never alter document cleanup or result settlement.
    }
}
export function subscribeDocumentChildTerminationReceipts(observer) {
    const listener = (message) => {
        try {
            observer(message);
        }
        catch { }
    };
    RECEIPT_CHANNEL.subscribe(listener);
    let subscribed = true;
    return () => {
        if (!subscribed)
            return;
        subscribed = false;
        RECEIPT_CHANNEL.unsubscribe(listener);
    };
}
