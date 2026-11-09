import {
  createWorkerNativeSectionState,
  createWorkerTaskControl,
} from "@openclaw/worker-runtime/worker";
import { expect } from "vitest";
import { createSessionEntriesReceiver } from "./session-memory-entry-delivery.js";
import { deliverSessionMemoryEntries } from "./session-memory-entry.worker.js";
import type {
  SessionEntriesDelivery,
  SessionEntriesWorkerInput,
  SessionEntriesWorkerResult,
} from "./session-transcript-worker-read.types.js";

type PreparedEntries = SessionEntriesWorkerResult["entries"];

/** Collect the production worker's acknowledged deliveries without starting another thread. */
export async function collectSessionMemoryEntries(
  entries: SessionEntriesWorkerInput["entries"],
  publish?: (index: number, value: PreparedEntries[number]) => Promise<void>,
  onFrame?: (frame: SessionEntriesDelivery) => void,
): Promise<PreparedEntries> {
  const receiver = createSessionEntriesReceiver(entries);
  const result = await deliverSessionMemoryEntries(
    entries,
    {
      consumeInput() {},
      notify() {},
      async request(value) {
        // SAFETY: This fixture is the receiving end of the production export worker's protocol.
        const frame = value as SessionEntriesDelivery;
        expect(frame.kind).toBe("session-entries");
        onFrame?.(frame);
        receiver.receive(frame);
        const delivered = receiver.prepared[frame.index];
        if (delivered && ("value" in frame || "streamed" in frame)) {
          await publish?.(frame.index, delivered);
        }
        return { input: undefined, consumed() {} };
      },
    },
    createWorkerTaskControl(createWorkerNativeSectionState(), () => true),
  );
  expect(result).toEqual({ entries: [] });
  return receiver.prepared;
}
