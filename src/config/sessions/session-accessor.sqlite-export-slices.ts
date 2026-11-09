import { iterateSqliteQuerySync } from "../../infra/kysely-sync.js";
import { SqliteJsonlReadBudgetExceededError } from "../../infra/sqlite-jsonl-budget-error.js";
import type { OpenClawAgentDatabaseReadOnlyResult } from "../../state/openclaw-agent-db-readonly-open.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import type { TranscriptEvent } from "./session-accessor.sqlite-contract.js";
import { getSessionKysely } from "./session-accessor.sqlite-scope-helpers.js";
import { readTranscriptContextVersionInTransaction } from "./session-accessor.sqlite-transcript-state.js";
import { readHotSessionTranscriptSnapshot } from "./session-cold-storage-state.js";
import { SessionTranscriptColdError } from "./session-transcript-cold-error.js";
import type { SessionTranscriptContextVersion } from "./session-transcript-context-version.types.js";
import {
  TRANSCRIPT_PAYLOAD_SLICE_BYTES,
  transcriptEventReadBytesSql,
} from "./session-transcript-read-bytes.js";
import { readTranscriptPayload } from "./transcript-payload.js";

type ExportDatabase = Pick<OpenClawAgentDatabase, "db" | "path">;

/** Names the settings that stop memory indexing from exporting a session it cannot hold. */
export const SESSION_MEMORY_EXPORT_ESCAPES =
  'set agents.defaults.compaction.postIndexSync="off" or memory.search.rememberAcrossConversations=false to stop indexing it';

/** Rows an export head left to a sliced read, and the context version it was read at. */
type DeferredTranscriptRows = {
  deferred?: { afterSeq?: number; throughSeq: number; version: SessionTranscriptContextVersion };
};

/** Payload text from one read transaction; `resumeAfterSeq` is set when the budget ended it. */
type TranscriptPayloadSlice = { payloads: Array<string | undefined>; resumeAfterSeq?: number };

type SliceReadParams<Snapshot extends DeferredTranscriptRows & { events: TranscriptEvent[] }> = {
  sessionId: string;
  /** Runs one short read transaction on a fresh database borrow. */
  transaction: <T>(read: (database: ExportDatabase) => T) => OpenClawAgentDatabaseReadOnlyResult<T>;
  /** The export snapshot in the caller's transaction; `deferAboveBytes: 0` leaves its rows unread. */
  readHead: (database: ExportDatabase, slicing?: { deferAboveBytes: number }) => Snapshot | "cold";
  /** A deferred head the caller's batch transaction already read. */
  batchHead?: Snapshot;
  projectEvent?: (event: TranscriptEvent) => TranscriptEvent;
  /** Rejects a single event whose payload exceeds this many bytes before decoding it. */
  maxEventPayloadBytes?: number;
  /** Keeps streaming across appends, which only add rows after the head's last one. */
  continueAfterAppends?: boolean;
};

/** One step of a sliced export: its head with any retained events, a slice of events, or a restart. */
export type TranscriptExportSliceStep<Snapshot> =
  | { head: Omit<Snapshot, "deferred"> }
  | { events: TranscriptEvent[] }
  | { restart: true };

/**
 * Reads one export snapshot: the head in the first slice's transaction (or the batch head while
 * the transcript context version still matches it), then its deferred rows in bounded slices,
 * one short read transaction each, parsed after that transaction closed. Every later slice first
 * compares the transcript context version, the token writers already validate loaded bytes
 * against; on a change the transcript is reread inside one transaction.
 */
export function readTranscriptExportInSlices<
  Snapshot extends DeferredTranscriptRows & { events: TranscriptEvent[] },
>(params: SliceReadParams<Snapshot> & { projection?: "reset-boundary" }) {
  const readWhole = () => {
    const whole = params.transaction((database) => hotSnapshot(params, params.readHead(database)));
    return whole.found ? whole.value : undefined;
  };
  // Reset navigation is a small native projection and stays in one transaction.
  if (params.projection === "reset-boundary") {
    return readWhole();
  }
  const slices = streamTranscriptExportSlices(params);
  let snapshot: Omit<Snapshot, "deferred"> | undefined;
  const events: TranscriptEvent[] = [];
  for (let step = slices.next(); ; step = slices.next()) {
    if (step.done) {
      return step.value && snapshot ? { ...snapshot, events } : undefined;
    }
    if ("restart" in step.value) {
      slices.return(false);
      return readWhole();
    }
    if ("head" in step.value) {
      snapshot = step.value.head;
    }
    for (const event of "head" in step.value ? step.value.head.events : step.value.events) {
      events.push(event);
    }
  }
}

/**
 * Yields one export snapshot as its head, then its deferred rows in bounded slices, one short read
 * transaction each, parsed after that transaction closed. When the transcript context version
 * changes between slices it yields `restart` and streams the transcript again from a new head,
 * unless `continueAfterAppends` is set and only appends changed it.
 * Returns false when the transcript database is gone.
 */
export function* streamTranscriptExportSlices<
  Snapshot extends DeferredTranscriptRows & { events: TranscriptEvent[] },
>(params: SliceReadParams<Snapshot>): Generator<TranscriptExportSliceStep<Snapshot>, boolean> {
  const { sessionId, transaction, projectEvent, maxEventPayloadBytes } = params;
  let batchHead = params.batchHead;
  for (;;) {
    const first = transaction((database) => {
      const snapshot =
        batchHead?.deferred &&
        isSameTranscriptContextVersion(
          readTranscriptContextVersionInTransaction(database, sessionId),
          batchHead.deferred.version,
        )
          ? batchHead
          : hotSnapshot(params, params.readHead(database, { deferAboveBytes: 0 }));
      const { deferred } = snapshot;
      return {
        snapshot,
        slice:
          deferred &&
          readTranscriptPayloadSlice(database, sessionId, deferred, deferred.afterSeq, {
            maxEventPayloadBytes,
          }),
      };
    });
    if (!first.found) {
      return false;
    }
    const { deferred, ...head } = first.value.snapshot;
    yield { head };
    if (!deferred) {
      return true;
    }
    let slice = first.value.slice;
    let seen = deferred.version;
    while (slice) {
      // Each captured payload is released as it is parsed.
      const { payloads } = slice;
      const events: TranscriptEvent[] = [];
      for (let index = 0; index < payloads.length; index++) {
        const event: TranscriptEvent = JSON.parse(payloads[index]!);
        payloads[index] = undefined;
        events.push(projectEvent ? projectEvent(event) : event);
      }
      yield { events };
      const afterSeq = slice.resumeAfterSeq;
      if (afterSeq === undefined) {
        return true;
      }
      const next = transaction((database) => {
        const current = readTranscriptContextVersionInTransaction(database, sessionId);
        if (
          !isSameTranscriptContextVersion(current, seen) &&
          !(params.continueAfterAppends && isAppendOnlyChange(seen, current))
        ) {
          return undefined;
        }
        seen = current;
        return readTranscriptPayloadSlice(database, sessionId, deferred, afterSeq, {
          maxEventPayloadBytes,
        });
      });
      if (!next.found) {
        return false;
      }
      slice = next.value;
    }
    yield { restart: true };
    batchHead = undefined;
  }
}

function hotSnapshot<Snapshot>(params: { sessionId: string }, snapshot: Snapshot | "cold") {
  if (snapshot === "cold") {
    throw new SessionTranscriptColdError(params.sessionId);
  }
  return snapshot;
}

/** Captures decoded payload text after `afterSeq` up to the slice budget. */
function readTranscriptPayloadSlice(
  database: Pick<OpenClawAgentDatabase, "db">,
  sessionId: string,
  { throughSeq }: { throughSeq: number },
  afterSeq: number | undefined,
  { maxEventPayloadBytes = Number.POSITIVE_INFINITY }: { maxEventPayloadBytes?: number } = {},
): TranscriptPayloadSlice {
  return readHotSessionTranscriptSnapshot(database, sessionId, "events", () => {
    const slice: TranscriptPayloadSlice = { payloads: [] };
    let bytes = 0;
    // Leaving the loop early or by a throw closes the iterator; no live cursor escapes a read.
    for (const row of iterateSqliteQuerySync(
      database.db,
      getSessionKysely(database.db)
        .selectFrom("transcript_events")
        .select(["seq", "event_json", "event_zstd", "event_utf8_bytes"])
        .select(transcriptEventReadBytesSql().as("payload_bytes"))
        .where("session_id", "=", sessionId)
        .where("seq", "<=", throughSeq)
        .$if(afterSeq !== undefined, (query) => query.where("seq", ">", afterSeq!))
        .orderBy("seq", "asc"),
    )) {
      if (row.payload_bytes > maxEventPayloadBytes) {
        throw new SqliteJsonlReadBudgetExceededError(
          `Session ${sessionId} has a ${row.payload_bytes}-byte transcript event, above its ${maxEventPayloadBytes}-byte memory export budget; ${SESSION_MEMORY_EXPORT_ESCAPES}`,
        );
      }
      slice.payloads.push(readTranscriptPayload(row));
      bytes += row.payload_bytes;
      if (bytes >= TRANSCRIPT_PAYLOAD_SLICE_BYTES) {
        slice.resumeAfterSeq = row.seq;
        break;
      }
    }
    return slice;
  });
}

/** Appends keep the generation and raise the raw sequence; an in-place rewrite does neither. */
function isAppendOnlyChange(
  seen: SessionTranscriptContextVersion,
  current: SessionTranscriptContextVersion,
): boolean {
  return (
    seen.generation !== null &&
    current.generation === seen.generation &&
    seen.rawSeq !== null &&
    current.rawSeq !== null &&
    current.rawSeq > seen.rawSeq
  );
}

function isSameTranscriptContextVersion(
  left: SessionTranscriptContextVersion,
  right: SessionTranscriptContextVersion,
): boolean {
  return (
    left.generation === right.generation &&
    left.rawSeq === right.rawSeq &&
    left.updatedAt === right.updatedAt
  );
}
