import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";

export type SessionResetRecallCutoff =
  | { state: "absent" }
  | { state: "invalid" }
  | { cutoffLine: number; state: "valid" };

/** Resolves the first raw transcript line owned by the current reset generation. */
export function resolveSessionResetRecallCutoff(
  events: readonly unknown[],
): SessionResetRecallCutoff {
  const tracker = createSessionResetRecallCutoffTracker();
  for (const event of events) {
    tracker.add(event);
  }
  return tracker.resolve();
}

/** Tracks the reset cutoff across events seen in order, keeping one index per event id. */
export function createSessionResetRecallCutoffTracker() {
  const firstIndexById = new Map<string, number>();
  let reset: { index: number; firstKeptEntryId: unknown } | undefined;
  let count = 0;
  return {
    add(event: unknown) {
      const record = asOptionalRecord(event);
      if (record?.type === "reset") {
        reset = { index: count, firstKeptEntryId: record.firstKeptEntryId };
      }
      if (typeof record?.id === "string" && !firstIndexById.has(record.id)) {
        firstIndexById.set(record.id, count);
      }
      count++;
    },
    resolve(): SessionResetRecallCutoff {
      if (!reset) {
        return { state: "absent" };
      }
      if (reset.firstKeptEntryId === undefined) {
        return { state: "valid", cutoffLine: reset.index + 1 };
      }
      if (typeof reset.firstKeptEntryId !== "string" || !reset.firstKeptEntryId.trim()) {
        return { state: "invalid" };
      }
      const keptIndex = firstIndexById.get(reset.firstKeptEntryId);
      return keptIndex === undefined || keptIndex >= reset.index
        ? { state: "invalid" }
        : { state: "valid", cutoffLine: keptIndex + 1 };
    },
  };
}
