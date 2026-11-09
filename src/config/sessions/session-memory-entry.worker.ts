import { channel as diagnosticsChannel } from "node:diagnostics_channel";
import { getHeapStatistics } from "node:v8";
import { resourceLimits } from "node:worker_threads";
import type { WorkerTaskControl } from "@openclaw/worker-runtime/worker";
import { projectSessionEntryRecord } from "../../../packages/memory-host-sdk/src/host/session-entry-projection.js";
import {
  createSessionEntryRenderer,
  renderSessionEntrySnapshot,
  readSessionEntryResetRecallCutoff,
  sqliteSessionFileState,
} from "../../../packages/memory-host-sdk/src/host/session-entry-render.js";
import { createSessionResetRecallCutoffTracker } from "../../../packages/memory-host-sdk/src/host/session-reset-recall.js";
import { LruCache } from "../../infra/lru-cache.js";
import { isPostgresSqlConnection } from "../../infra/sql-connection.js";
import { runSqliteReadSnapshotSync } from "../../infra/sqlite-transaction.js";
import type { WorkerTaskChannel } from "../../infra/worker-task-server.js";
import { prepareAssistantTranscriptText } from "../../shared/chat-message-content.js";
import { withOpenClawAgentDatabaseReadOnly } from "../../state/openclaw-agent-db-readonly.js";
import { streamTranscriptExportSlices } from "./session-accessor.sqlite-export-slices.js";
import { readTranscriptExportSnapshotsFromDatabase } from "./session-accessor.sqlite-read.js";
import {
  resolveSqliteTranscriptReadScope,
  toDatabaseOptions,
} from "./session-accessor.sqlite-scope.js";
import { readTranscriptStatsBatchFromDatabase } from "./session-accessor.sqlite-transcript-stats.js";
import { SessionTranscriptColdError } from "./session-transcript-cold-error.js";
import { runWithSessionTranscriptReadFence } from "./session-transcript-read-fence.js";
import type {
  SessionEntriesDelivery,
  SessionEntriesWorkerInput,
} from "./session-transcript-worker-read.types.js";
import type { SessionTranscriptWorkerValues } from "./session-transcript-worker.types.js";

type Snapshot = Exclude<
  ReturnType<typeof readTranscriptExportSnapshotsFromDatabase>[number],
  "cold"
>;
type ExportRequest = Parameters<typeof readTranscriptExportSnapshotsFromDatabase>[1][number];
type ExportDatabase = Parameters<typeof readTranscriptExportSnapshotsFromDatabase>[0];
type ExportTransaction = Parameters<typeof streamTranscriptExportSlices>[0]["transaction"];
type PreparedEntries = SessionTranscriptWorkerValues["session-entries"]["entries"];
const snapshots = new LruCache<Snapshot>(16, {
  maxBytes: 8 * 1024 * 1024,
  sizeOf: (snapshot) => snapshot.stats.sizeBytes,
});
diagnosticsChannel("openclaw.memory.critical").subscribe(() => snapshots.clear());
const MAX_SNAPSHOT_BYTES = 4 * 1024 * 1024;
// Decoding one event holds its payload, parsed and rendered copies; above this share it may not
// fit. A worker's own old-space limit is not reflected in its heap statistics.
const MAX_STREAMED_EVENT_BYTES = Math.floor(
  (resourceLimits.maxOldGenerationSizeMb
    ? resourceLimits.maxOldGenerationSizeMb * 1024 * 1024
    : getHeapStatistics().heap_size_limit) / 8,
);
// A rewrite during a sliced read restarts it; restarts are bounded, then the read is whole.
const MAX_STREAM_RESTARTS = 3;
type Deliver = (frame: SessionEntriesDelivery) => Promise<void>;

/** The export worker retains projected rows; transcript rewrite identity replaces the prefix. */
async function prepareSessionMemoryEntries(
  entries: SessionEntriesWorkerInput["entries"],
  deliver: Deliver,
): Promise<void> {
  const groups = new Map<
    string,
    { index: number; resolved: ReturnType<typeof resolveSqliteTranscriptReadScope> }[]
  >();
  for (const [index, { options }] of entries.entries()) {
    const resolved = resolveSqliteTranscriptReadScope(options);
    const key = JSON.stringify([resolved.databaseAgentId ?? resolved.agentId, resolved.path]);
    const group = groups.get(key) ?? [];
    group.push({ index, resolved });
    groups.set(key, group);
  }
  for (const group of groups.values()) {
    // Metadata estimates choose a working group, not an authority or freshness fence.
    // Each export below still captures its own current, admitted read snapshot.
    const sizing =
      group.length > 1
        ? withOpenClawAgentDatabaseReadOnly(
            (database) => ({
              sizes: readTranscriptStatsBatchFromDatabase(
                database,
                group.map(({ resolved }) => resolved.sessionId),
              ),
              // SQLite reads larger transcripts after the batch transaction, one at a time.
              deferAboveBytes: isPostgresSqlConnection(database.db)
                ? Number.POSITIVE_INFINITY
                : MAX_SNAPSHOT_BYTES,
            }),
            toDatabaseOptions(group[0]!.resolved),
          )
        : undefined;
    const batchBytes = (offset: number) => {
      if (!sizing?.found) {
        return 0;
      }
      const size = sizing.value.sizes[offset]!.sizeBytes;
      return size > sizing.value.deferAboveBytes ? 0 : size;
    };
    for (let start = 0; start < group.length;) {
      let end = start;
      let bytes = 0;
      while (
        end < group.length &&
        end - start < 32 &&
        (end === start || bytes + batchBytes(end) <= MAX_SNAPSHOT_BYTES)
      ) {
        bytes += batchBytes(end);
        end++;
      }
      const batch = group.slice(start, end);
      const requests = batch.map(({ index, resolved }): ExportRequest => {
        const request = entries[index]!;
        const previous = snapshots.peek(snapshotKey(request));
        return {
          resolved,
          scope: request.options,
          admission: request.admission,
          options: {
            projectEvent: (event: unknown) =>
              projectSessionEntryRecord(event, prepareAssistantTranscriptText),
            previous:
              previous?.generation != null && previous.throughSeq !== undefined
                ? {
                    events: previous.events,
                    generation: previous.generation,
                    throughSeq: previous.throughSeq,
                  }
                : null,
          },
        };
      });
      // Transcripts the retained-snapshot cache admits (at most MAX_SNAPSHOT_BYTES) are read
      // inside the batch transaction; on SQLite, larger ones, which the cache never retains,
      // are read in slices after it.
      const exported = withOpenClawAgentDatabaseReadOnly(
        (database) =>
          runSqliteReadSnapshotSync(
            database.db,
            () =>
              readTranscriptExportSnapshotsFromDatabase(database, requests, {
                deferAboveBytes: MAX_SNAPSHOT_BYTES,
              }),
            { operationLabel: "session transcript export batch" },
          ),
        toDatabaseOptions(group[0]!.resolved),
      );
      // Render and deliver serially. Count-only groups previously retained every
      // projected snapshot and every expanded entry in this 512 MiB isolate.
      for (const [offset, { index }] of batch.entries()) {
        const request = entries[index]!;
        const snapshot = exported.found ? exported.value.shift()! : null;
        let value: PreparedEntries[number];
        if (snapshot && snapshot !== "cold" && snapshot.deferred) {
          retainSnapshot(snapshotKey(request), null);
          const streamed = await streamDeferredEntry(
            index,
            request,
            requests[offset]!.options,
            snapshot,
            deliver,
          );
          if (!streamed) {
            continue;
          }
          value = streamed;
        } else if (snapshot === "cold") {
          value = { cold: true };
        } else {
          retainSnapshot(snapshotKey(request), snapshot);
          value = await renderSnapshotEntry(request, snapshot);
        }
        await deliver({ kind: "session-entries", index, value });
      }
      start = end;
    }
  }
}

/** Hands each prepared entry to the host and waits for it to accept that entry before the next. */
export async function deliverSessionMemoryEntries(
  entries: SessionEntriesWorkerInput["entries"],
  channel: WorkerTaskChannel | undefined,
  control: WorkerTaskControl,
): Promise<SessionTranscriptWorkerValues["session-entries"]> {
  if (!channel) {
    throw new Error("Session exports require their host delivery channel");
  }
  channel.consumeInput();
  await prepareSessionMemoryEntries(entries, async (frame) => {
    control.throwIfCancelled();
    const response = await channel.request(frame);
    response.consumed();
    control.throwIfCancelled();
  });
  return { entries: [] };
}

/**
 * Streams a transcript above the retention limit to the host in rendered chunks, one bounded
 * slice at a time, so no allocation here grows with the transcript. Returns the entry value the
 * caller still has to deliver, or undefined once the stream delivered its own end frame.
 */
async function streamDeferredEntry(
  index: number,
  request: SessionEntriesWorkerInput["entries"][number],
  options: ExportRequest["options"],
  batchHead: Snapshot,
  deliver: Deliver,
): Promise<PreparedEntries[number] | undefined> {
  const resolved = resolveSqliteTranscriptReadScope(request.options);
  const exportRequest = { resolved, scope: request.options, options };
  const readHead = (database: ExportDatabase, slicing?: { deferAboveBytes: number }) =>
    readTranscriptExportSnapshotsFromDatabase(database, [exportRequest], slicing)[0]!;
  const transaction: ExportTransaction = (read) =>
    withOpenClawAgentDatabaseReadOnly(
      (database) =>
        runSqliteReadSnapshotSync(database.db, () => read(database), {
          operationLabel: "session transcript export snapshot",
        }),
      toDatabaseOptions(resolved),
    );
  const slices = streamTranscriptExportSlices({
    sessionId: resolved.sessionId,
    batchHead,
    projectEvent: options.projectEvent,
    maxEventPayloadBytes: MAX_STREAMED_EVENT_BYTES,
    // The entry carries the head's stats, so rows appended later make the next sync export again.
    continueAfterAppends: true,
    transaction,
    readHead,
  });
  let state:
    | {
        renderer: ReturnType<typeof createSessionEntryRenderer>;
        cutoff: ReturnType<typeof createSessionResetRecallCutoffTracker>;
        line: number;
        delivered: boolean;
      }
    | undefined;
  let restarts = 0;
  const discard = async () => {
    if (state?.delivered) {
      await deliver({ kind: "session-entries", index, reset: true });
    }
  };
  try {
    for (;;) {
      const step = runWithSessionTranscriptReadFence(request.admission, () => slices.next());
      if (step.done) {
        if (!step.value || !state) {
          return { entry: null, resetRecallCutoff: { state: "absent" } };
        }
        const resetRecallCutoff = state.cutoff.resolve();
        await deliver({
          kind: "session-entries",
          index,
          streamed: { header: state.renderer.header(), resetRecallCutoff },
        });
        return undefined;
      }
      if ("restart" in step.value) {
        await discard();
        state = undefined;
        if (++restarts <= MAX_STREAM_RESTARTS) {
          continue;
        }
        // A transcript that keeps changing is read whole in one transaction, as before streaming,
        // when it fits the per-event budget; a larger one waits for the next sync.
        const whole = runWithSessionTranscriptReadFence(request.admission, () =>
          transaction((database) =>
            readHead(database, { deferAboveBytes: MAX_STREAMED_EVENT_BYTES }),
          ),
        );
        if (!whole.found) {
          return { entry: null, resetRecallCutoff: { state: "absent" } };
        }
        if (whole.value === "cold") {
          return { cold: true };
        }
        if (whole.value.deferred) {
          throw new Error(
            `Session ${request.options.sessionId} kept changing during its memory export`,
          );
        }
        return await renderSnapshotEntry(request, whole.value);
      }
      const events = "events" in step.value ? step.value.events : step.value.head.events;
      if ("head" in step.value) {
        const { head } = step.value;
        state = {
          renderer: createSessionEntryRenderer(request.absPath, request.options, {
            ...sqliteSessionFileState(
              request.absPath,
              request.options,
              head.stats,
              request.options.updatedAtMs,
            ),
            kind: "sqlite",
            sessionKey: head.sessionKey,
          }),
          cutoff: createSessionResetRecallCutoffTracker(),
          line: 0,
          delivered: false,
        };
      }
      const current = state!;
      for (const event of events) {
        current.cutoff.add(event);
        if (current.renderer.render(event, current.line++)) {
          await discard();
          current.delivered = false;
        }
      }
      const chunk = current.renderer.take();
      if (chunk.lines.length > 0) {
        await deliver({ kind: "session-entries", index, chunk });
        current.delivered = true;
      }
    }
  } catch (error) {
    if (!(error instanceof SessionTranscriptColdError)) {
      throw error;
    }
    return { cold: true };
  } finally {
    slices.return(false);
  }
}

async function renderSnapshotEntry(
  request: SessionEntriesWorkerInput["entries"][number],
  snapshot: Snapshot | null,
): Promise<PreparedEntries[number]> {
  const entry = snapshot
    ? await renderSessionEntrySnapshot(request.absPath, request.options, snapshot)
    : null;
  return {
    entry,
    resetRecallCutoff: entry ? readSessionEntryResetRecallCutoff(entry) : { state: "absent" },
  };
}

function snapshotKey({ options }: SessionEntriesWorkerInput["entries"][number]) {
  return JSON.stringify([options.storePath, options.agentId, options.sessionId]);
}

function retainSnapshot(key: string, snapshot: Snapshot | null) {
  snapshots.delete(key);
  if (snapshot && snapshot.stats.sizeBytes <= MAX_SNAPSHOT_BYTES) {
    snapshots.set(key, snapshot);
  }
}
