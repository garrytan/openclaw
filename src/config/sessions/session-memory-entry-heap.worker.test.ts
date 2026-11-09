import path from "node:path";
import { expect, it, vi } from "vitest";
import {
  hashSessionEntrySnapshot,
  renderSessionExportLines,
} from "../../../packages/memory-host-sdk/src/host/session-entry-projection.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { replaceSessionEntrySync } from "./session-accessor.sqlite-entry.js";
import { replaceTranscriptEventsSync } from "./session-accessor.sqlite-transcript-write.test-support.js";
import { prepareSessionEntryInWorker } from "./session-transcript-read-worker-runtime.js";

// Production export workers cap their heap at 512 MiB; this one exports more text than its cap.
vi.mock("./session-transcript-read-pools.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./session-transcript-read-pools.js")>()),
  SESSION_TRANSCRIPT_WORKER_LIMITS: { maxOldGenerationSizeMb: 64, maxYoungGenerationSizeMb: 8 },
}));

const MESSAGES = 5_400;
const MESSAGE_CHARS = 15_000;

function largeSessionScope(sessionsDir: string, sessionId: string) {
  const scope = {
    agentId: "main",
    sessionId,
    sessionKey: `agent:main:chat:${sessionId}`,
    storePath: path.join(sessionsDir, "sessions.json"),
  };
  replaceSessionEntrySync(scope, { sessionId, updatedAt: 1 });
  return scope;
}

it.each([
  { label: "ASCII", word: "memory " },
  { label: "two-byte", word: "memory \u{1F99E} " },
])("exports about 80 MiB of $label message text from a 64 MiB worker", async ({ word }) => {
  await withOpenClawTestState({ label: "session-memory-entry-heap" }, async (state) => {
    const scope = largeSessionScope(state.sessionsDir(), "large-session");
    const body = word.repeat(Math.floor(MESSAGE_CHARS / word.length)).trim();
    const texts = Array.from({ length: MESSAGES }, (_, index) => `${index} ${body}`);
    expect(
      replaceTranscriptEventsSync(
        scope,
        texts.map((text, index) => ({
          type: "message",
          id: `answer-${index}`,
          message: { role: "assistant", content: text },
        })),
      ),
    ).toBe(true);

    const { entry, resetRecallCutoff } = await prepareSessionEntryInWorker(scope.sessionKey, scope);

    const lines = texts.flatMap((text) => renderSessionExportLines("Assistant", text));
    expect(entry?.lineMap).toHaveLength(lines.length);
    expect(entry?.content === lines.join("\n")).toBe(true);
    expect(entry?.hash).toBe(hashSessionEntrySnapshot({ ...entry!, resetRecallCutoff }));
  });
});

it("names the session and the indexing settings when one event exceeds the worker budget", async () => {
  await withOpenClawTestState({ label: "session-memory-entry-heap-event" }, async (state) => {
    const scope = largeSessionScope(state.sessionsDir(), "giant-event");
    expect(
      replaceTranscriptEventsSync(scope, [
        {
          type: "message",
          id: "giant",
          message: { role: "user", content: "x ".repeat(12_000_000) },
        },
      ]),
    ).toBe(true);
    await expect(prepareSessionEntryInWorker(scope.sessionKey, scope)).rejects.toThrow(
      /^Session giant-event has a \d+-byte transcript event, above its \d+-byte memory export budget; set agents\.defaults\.compaction\.postIndexSync="off" or memory\.search\.rememberAcrossConversations=false/,
    );
  });
});
