export const MAX_TOOL_PROGRESS = 1_000_000;
const STAGE_MESSAGES = Object.freeze({
    starting: "Starting document operation.",
    processing: "Processing document.",
    complete: "Document operation complete.",
});
export function createToolExecutionContext(extra) {
    const progressId = extra._meta?.progressToken;
    let lastProgress = -1;
    let lastTotal;
    let notificationQueue = Promise.resolve();
    const context = {
        signal: extra.signal,
        reportProgress(stage, progress, total) {
            if (progressId === undefined || extra.signal.aborted) {
                return notificationQueue;
            }
            const safeProgress = boundedInteger(progress);
            const safeTotal = total === undefined ? undefined : boundedInteger(total);
            const message = stageMessage(stage);
            if (safeProgress === undefined ||
                (total !== undefined && safeTotal === undefined) ||
                message === undefined) {
                return notificationQueue;
            }
            const boundedProgress = safeTotal === undefined
                ? safeProgress
                : Math.min(safeProgress, safeTotal);
            if (boundedProgress <= lastProgress ||
                (safeTotal !== undefined && lastTotal !== undefined &&
                    safeTotal < lastTotal)) {
                return notificationQueue;
            }
            lastProgress = boundedProgress;
            if (safeTotal !== undefined)
                lastTotal = safeTotal;
            notificationQueue = notificationQueue.then(async () => {
                if (extra.signal.aborted)
                    return;
                try {
                    await extra.sendNotification({
                        method: "notifications/progress",
                        params: {
                            progressToken: progressId,
                            progress: boundedProgress,
                            total: safeTotal,
                            message,
                        },
                    });
                }
                catch {
                    if (extra.signal.aborted)
                        throw requestCancelledError();
                    // Progress is advisory. The request signal remains the sole
                    // cancellation authority and is threaded to the isolated engine.
                }
            });
            return notificationQueue;
        },
    };
    return Object.freeze(context);
}
export async function runWithToolExecutionContext(extra, run) {
    const context = createToolExecutionContext(extra);
    await context.reportProgress("starting", 0);
    requireToolNotCancelled(context);
    try {
        return await run(context);
    }
    finally {
        await context.reportProgress("complete", MAX_TOOL_PROGRESS, MAX_TOOL_PROGRESS);
    }
}
export function toDocumentEngineExecutionContext(context) {
    if (context === undefined)
        return undefined;
    return {
        signal: context.signal,
        onProgress: (completed, total) => {
            void context.reportProgress("processing", completed, total);
        },
    };
}
export function requireToolNotCancelled(context) {
    if (context?.signal.aborted !== true)
        return;
    throw requestCancelledError();
}
function requestCancelledError() {
    return Object.assign(new Error("The request was cancelled."), {
        code: "REQUEST_CANCELLED",
    });
}
function boundedInteger(value) {
    if (typeof value !== "number" || !Number.isFinite(value))
        return undefined;
    return Math.min(MAX_TOOL_PROGRESS, Math.max(0, Math.trunc(value)));
}
function stageMessage(stage) {
    return Object.prototype.hasOwnProperty.call(STAGE_MESSAGES, stage)
        ? STAGE_MESSAGES[stage]
        : undefined;
}
