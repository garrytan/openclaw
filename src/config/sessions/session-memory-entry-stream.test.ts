import { createHash } from "node:crypto";
import path from "node:path";
import { expect, it } from "vitest";
import {
  hashSessionEntrySnapshot,
  projectSessionEntryRecord,
} from "../../../packages/memory-host-sdk/src/host/session-entry-projection.js";
import {
  attachSessionEntryResetRecallCutoff,
  readSessionEntryResetRecallCutoff,
  renderSessionEntrySnapshot,
} from "../../../packages/memory-host-sdk/src/host/session-entry-render.js";
import {
  matchesSessionEntryPrefixHash,
  type SessionFileEntry,
} from "../../../packages/memory-host-sdk/src/host/session-files.js";
import { prepareAssistantTranscriptText } from "../../shared/chat-message-content.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { replaceSessionEntrySync } from "./session-accessor.sqlite-entry.js";
import { readTranscriptExportSnapshotReadOnlySync } from "./session-accessor.sqlite-read.js";
import { appendTranscriptMessageSync } from "./session-accessor.sqlite-transcript-write.kernel.js";
import { replaceTranscriptEventsSync } from "./session-accessor.sqlite-transcript-write.test-support.js";
import { collectSessionMemoryEntries } from "./session-memory-entry.worker.test-support.js";

const words = "the stored answer keeps every slice in order while memory export streams".split(" ");
const text = (seed: number, chars: number) => {
  let value = "";
  for (let index = seed; value.length < chars; index++) {
    value += `${words[index % words.length]}${index % 7 === 0 ? ". " : " "}`;
  }
  return value.slice(0, chars);
};
const at = (index: number) => new Date(Date.UTC(2026, 9, 1) + index * 60_000).toISOString();
function conversation(turns: number, chars: number) {
  return Array.from({ length: turns }, (_, turn) => [
    {
      type: "message",
      id: `user-${turn}`,
      timestamp: at(turn),
      message: { role: "user", content: text(turn, chars) },
    },
    {
      type: "message",
      id: `tool-${turn}`,
      timestamp: at(turn),
      message: {
        role: "toolResult",
        toolCallId: `call-${turn}`,
        content: [{ type: "text", text: text(turn, 4_000) }],
      },
    },
    {
      type: "message",
      id: `answer-${turn}`,
      timestamp: at(turn),
      message: {
        role: "assistant",
        content: [{ type: "text", text: text(turn + 3, chars) }],
        timestamp: Date.parse(at(turn)),
      },
    },
  ]).flat();
}
function scopeFor(storePath: string, sessionId: string) {
  return { agentId: "main", sessionId, sessionKey: `agent:main:chat:${sessionId}`, storePath };
}
// Entry hashes the pre-streaming renderer produced for these fixtures. Each one covers the
// content, line map, timestamps, provenance and reset cutoff, so stored hashes stay valid.
const PRE_STREAMING_HASHES: Record<string, string> = {
  sliced: "c41e827d79408304ccef53701906beb31bd68e1cfd424cc8de995f6d94feef51",
  single: "d591bf29f486eeacd8c4b6e0bc231f06e033728b108ef4acb744d56bad70880f",
  reset: "333c56cadcde7bdfef2b4a93254f2db8680bda80e93d1981e0adfff8f197750f",
  dreaming: "15a760f8bb79b976a59870cb6e5f74c2dedcff959dd1da0e589d49422e5be1e4",
};
const sha = (value: string) => createHash("sha256").update(value).digest("hex").slice(0, 16);
/** Field digests keep a mismatch readable without printing megabytes of content. */
function digest(entry: SessionFileEntry | null | undefined, resetRecallCutoff: unknown) {
  return {
    content: sha(entry?.content ?? ""),
    lines: entry?.lineMap.length,
    lineMap: sha(JSON.stringify(entry?.lineMap)),
    messageTimestampsMs: sha(JSON.stringify(entry?.messageTimestampsMs)),
    lineProvenance: sha(JSON.stringify(entry?.lineProvenance)),
    hash: entry?.hash,
    resetRecallCutoff,
    generatedByDreamingNarrative: entry?.generatedByDreamingNarrative,
    generatedByCronRun: entry?.generatedByCronRun,
    sessionKind: entry?.sessionKind,
  };
}
async function renderWhole(scope: ReturnType<typeof scopeFor>) {
  const snapshot = readTranscriptExportSnapshotReadOnlySync(scope, {
    projectEvent: (event) => projectSessionEntryRecord(event, prepareAssistantTranscriptText),
  });
  const entry = snapshot
    ? await renderSessionEntrySnapshot(scope.sessionKey, scope, snapshot)
    : null;
  return {
    entry,
    resetRecallCutoff: entry
      ? readSessionEntryResetRecallCutoff(entry)
      : ({ state: "absent" } as const),
  };
}

it("streams large transcripts byte-identically to the whole-snapshot renderer", async () => {
  await withOpenClawTestState({ label: "session-memory-entry-stream" }, async (state) => {
    const storePath = path.join(state.sessionsDir(), "sessions.json");
    const cases = {
      // Many slices, with one message larger than a whole slice.
      sliced: [
        ...conversation(240, 9_000),
        {
          type: "message",
          id: "huge",
          message: { role: "assistant", content: text(5, 2_600_000) },
        },
        ...conversation(20, 2_000),
      ],
      // One event larger than the deferral threshold is exactly one slice.
      single: [
        {
          type: "message",
          id: "only",
          timestamp: at(1),
          message: { role: "user", content: text(9, 4_500_000) },
        },
      ],
      // A late reset keeps lines from its first kept entry.
      reset: [
        ...conversation(300, 9_000),
        { type: "reset", id: "reset-1", firstKeptEntryId: "user-250" },
        ...conversation(5, 500),
      ],
      // A dreaming record after the first slice discards the lines already streamed.
      dreaming: [
        ...conversation(300, 9_000),
        {
          type: "custom",
          id: "dream",
          customType: "openclaw:bootstrap-context:full",
          data: { runId: "dreaming-narrative-1" },
        },
        ...conversation(5, 500),
      ],
    };
    const resets: Record<string, number> = {};
    for (const [sessionId, events] of Object.entries(cases)) {
      const scope = scopeFor(storePath, sessionId);
      replaceSessionEntrySync(scope, { sessionId, updatedAt: 1 });
      expect(replaceTranscriptEventsSync(scope, events)).toBe(true);
      resets[sessionId] = 0;
    }
    const requests = Object.keys(cases).map((sessionId) => {
      const options = scopeFor(storePath, sessionId);
      return { absPath: options.sessionKey, options };
    });
    const streamed = await collectSessionMemoryEntries(requests, undefined, (frame) => {
      if ("reset" in frame) {
        resets[requests[frame.index]!.options.sessionId]!++;
      }
    });

    for (const [index, { options }] of requests.entries()) {
      const actual = streamed[index]!;
      const expected = await renderWhole(options);
      if ("cold" in actual) {
        throw new Error("Expected a hot export");
      }
      expect(digest(actual.entry, actual.resetRecallCutoff)).toEqual(
        digest(expected.entry, expected.resetRecallCutoff),
      );
      expect(actual.entry?.hash).toBe(PRE_STREAMING_HASHES[options.sessionId]);
      // Production attaches the delivered cutoff before ingestion compares prefix hashes.
      const entry = attachSessionEntryResetRecallCutoff(actual.entry!, actual.resetRecallCutoff);
      const lines = expected.entry!.content ? expected.entry!.content.split("\n") : [];
      const counts = [0, 1, Math.floor(lines.length / 2), lines.length - 1, lines.length];
      for (const count of new Set(counts.filter((value) => value >= 0 && value <= lines.length))) {
        const prefix = lines.slice(0, count).join("\n");
        const expectedHash = hashSessionEntrySnapshot({
          content: prefix,
          lineMap: expected.entry!.lineMap.slice(0, count),
          messageTimestampsMs: expected.entry!.messageTimestampsMs.slice(0, count),
          lineProvenance: expected.entry!.lineProvenance.slice(0, count),
          resetRecallCutoff: expected.resetRecallCutoff,
        });
        expect(matchesSessionEntryPrefixHash(entry, count, expectedHash)).toBe(true);
      }
    }
    expect((streamed[2] as { resetRecallCutoff: unknown }).resetRecallCutoff).toEqual({
      state: "valid",
      cutoffLine: 751,
    });
    expect(streamed[3]).toMatchObject({
      entry: { content: "", generatedByDreamingNarrative: true },
    });
    expect(resets).toEqual({ sliced: 0, single: 0, reset: 0, dreaming: 1 });
  });
});

it("keeps streaming across appends and restarts when the transcript is rewritten", async () => {
  await withOpenClawTestState({ label: "session-memory-entry-stream-restart" }, async (state) => {
    const scope = scopeFor(path.join(state.sessionsDir(), "sessions.json"), "changing");
    replaceSessionEntrySync(scope, { sessionId: scope.sessionId, updatedAt: 1 });
    expect(replaceTranscriptEventsSync(scope, conversation(300, 9_000))).toBe(true);
    const exportWhile = async (change: () => void) => {
      const frames: string[] = [];
      const [actual] = await collectSessionMemoryEntries(
        [{ absPath: scope.sessionKey, options: scope }],
        undefined,
        (frame) => {
          frames.push(Object.keys(frame).find((key) => key !== "kind" && key !== "index")!);
          if (frames.length === 1) {
            change();
          }
        },
      );
      if (!actual || "cold" in actual) {
        throw new Error("Expected a hot export");
      }
      expect(frames.filter((frame) => frame === "chunk").length).toBeGreaterThan(3);
      expect(frames.at(-1)).toBe("streamed");
      return { digest: digest(actual.entry, actual.resetRecallCutoff), frames };
    };
    const before = await renderWhole(scope);
    // An append adds rows after the head, so the export completes as of its head.
    const appended = await exportWhile(() =>
      expect(
        appendTranscriptMessageSync(scope, {
          eventId: "late-answer",
          message: { role: "assistant", content: "Appended while the export streamed." },
        }),
      ).toMatchObject({ ok: true }),
    );
    expect(appended.frames).not.toContain("reset");
    expect(appended.digest).toEqual(digest(before.entry, before.resetRecallCutoff));
    // A rewrite discards the first chunk and streams the new transcript again from its head.
    const rewritten = await exportWhile(() =>
      expect(replaceTranscriptEventsSync(scope, conversation(280, 9_000))).toBe(true),
    );
    expect(rewritten.frames.slice(0, 2)).toEqual(["chunk", "reset"]);
    const after = await renderWhole(scope);
    expect(rewritten.digest).toEqual(digest(after.entry, after.resetRecallCutoff));
  });
});

it("reads a transcript that keeps changing whole once its bounded restarts run out", async () => {
  await withOpenClawTestState({ label: "session-memory-entry-stream-busy" }, async (state) => {
    const scope = scopeFor(path.join(state.sessionsDir(), "sessions.json"), "busy");
    replaceSessionEntrySync(scope, { sessionId: scope.sessionId, updatedAt: 1 });
    expect(replaceTranscriptEventsSync(scope, conversation(300, 9_000))).toBe(true);
    const frames: string[] = [];
    let rewrites = 0;
    const [actual] = await collectSessionMemoryEntries(
      [{ absPath: scope.sessionKey, options: scope }],
      undefined,
      (frame) => {
        frames.push(Object.keys(frame).find((key) => key !== "kind" && key !== "index")!);
        // Every attempt sees a rewrite after its first chunk.
        if (frames.at(-1) === "chunk" && frames.at(-2) !== "chunk") {
          rewrites++;
          expect(replaceTranscriptEventsSync(scope, conversation(300 - rewrites, 9_000))).toBe(
            true,
          );
        }
      },
    );
    const expected = await renderWhole(scope);
    if (!actual || "cold" in actual) {
      throw new Error("Expected a hot export");
    }
    expect(frames.filter((frame) => frame === "reset")).toHaveLength(4);
    expect(frames.at(-1)).toBe("value");
    expect(digest(actual.entry, actual.resetRecallCutoff)).toEqual(
      digest(expected.entry, expected.resetRecallCutoff),
    );
  });
});
