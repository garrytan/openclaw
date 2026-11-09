import { constants } from "node:buffer";
import { createHash, type Hash } from "node:crypto";
import { digestSessionEntrySnapshot } from "../../../packages/memory-host-sdk/src/host/session-entry-projection.js";
import { assembleSessionEntry } from "../../../packages/memory-host-sdk/src/host/session-entry-render.js";
import type { MemoryEntryProvenance } from "../../../packages/memory-host-sdk/src/host/types.js";
import { SqliteJsonlReadBudgetExceededError } from "../../infra/sqlite-jsonl-budget-error.js";
import { SESSION_MEMORY_EXPORT_ESCAPES } from "./session-accessor.sqlite-export-slices.js";
import type {
  SessionEntriesDelivery,
  SessionEntriesWorkerInput,
  SessionEntriesWorkerResult,
} from "./session-transcript-worker-read.types.js";

type StreamedEntry = {
  /** Newline joins of each chunk's lines, hashed as they arrive. */
  pieces: string[];
  chars: number;
  hash: Hash;
  lineMap: number[];
  messageTimestampsMs: number[];
  lineProvenance: MemoryEntryProvenance[];
};

/** Reassembles one export batch from the worker's acknowledged delivery frames. */
export function createSessionEntriesReceiver(entries: SessionEntriesWorkerInput["entries"]) {
  const prepared: SessionEntriesWorkerResult["entries"] = [];
  const streams = new Map<number, StreamedEntry>();
  let received = 0;
  return {
    prepared,
    get complete() {
      return received === entries.length;
    },
    receive(frame: unknown) {
      // SAFETY: The paired worker publishes delivery frames; their shape is checked below.
      const update = frame as SessionEntriesDelivery;
      if (
        update.kind !== "session-entries" ||
        !Number.isInteger(update.index) ||
        update.index < 0 ||
        update.index >= entries.length ||
        update.index in prepared
      ) {
        throw new Error("Invalid session export delivery");
      }
      const { index } = update;
      if ("value" in update || "reset" in update) {
        streams.delete(index);
        if ("value" in update) {
          prepared[index] = update.value;
          received++;
        }
        return;
      }
      const stream = streams.get(index) ?? {
        pieces: [],
        chars: 0,
        hash: createHash("sha256"),
        lineMap: [],
        messageTimestampsMs: [],
        lineProvenance: [],
      };
      streams.set(index, stream);
      if ("chunk" in update) {
        const { lines, lineMap, messageTimestampsMs, lineProvenance } = update.chunk;
        if (lines.length === 0) {
          return;
        }
        const piece = lines.join("\n");
        const separator = stream.pieces.length > 0 ? "\n" : "";
        stream.chars += separator.length + piece.length;
        if (stream.chars > constants.MAX_STRING_LENGTH) {
          throw new SqliteJsonlReadBudgetExceededError(
            `Session ${entries[index]!.options.sessionId} has more than ${constants.MAX_STRING_LENGTH} characters of memory export text, above the string limit; ${SESSION_MEMORY_EXPORT_ESCAPES}`,
          );
        }
        stream.hash.update(separator).update(piece);
        stream.pieces.push(piece);
        for (let line = 0; line < lines.length; line++) {
          stream.lineMap.push(lineMap[line]!);
          stream.messageTimestampsMs.push(messageTimestampsMs[line]!);
          stream.lineProvenance.push(lineProvenance[line]!);
        }
        return;
      }
      if (!("streamed" in update)) {
        throw new Error("Invalid session export delivery");
      }
      streams.delete(index);
      const { header, resetRecallCutoff } = update.streamed;
      const { lineMap, messageTimestampsMs, lineProvenance } = stream;
      const rendered = { lineMap, messageTimestampsMs, lineProvenance };
      const content = stream.pieces.join("\n");
      prepared[index] = {
        entry: assembleSessionEntry(
          header,
          content,
          rendered,
          digestSessionEntrySnapshot(stream.hash, { ...rendered, resetRecallCutoff }),
        ),
        resetRecallCutoff,
      };
      received++;
    },
  };
}
