import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {
  cleanSessions,
  dropSessionLines,
  listBackups,
  listTrash,
  parseLineRanges,
  readJsonl,
  replaceInSession,
  resolveSessionSelectors,
  restoreSessionBackup,
  restoreTrashBatch,
  scanSessions,
  sessionIsActive,
  updateSessionRecord,
} from "../src/core.js";

test("scanSessions reads Codex JSONL metadata", async () => {
  const { codexHome } = await fixture();

  const sessions = await scanSessions({ codexHome });

  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].id, "019dd36c-584b-79d2-9a73-db43acc986e0");
  assert.equal(sessions[0].cwd, "/work/project");
  assert.equal(sessions[0].lines, 4);
  assert.match(sessions[0].preview, /hello secret/);
});

test("resolveSessionSelectors supports latest, index, id prefix, and path", async () => {
  const { codexHome, sessionPath } = await fixture();
  const sessions = await scanSessions({ codexHome });

  assert.equal(resolveSessionSelectors(sessions, ["latest"])[0].file, sessionPath);
  assert.equal(resolveSessionSelectors(sessions, ["1"])[0].file, sessionPath);
  assert.equal(resolveSessionSelectors(sessions, ["019dd36c"])[0].file, sessionPath);
  assert.equal(resolveSessionSelectors(sessions, [sessionPath])[0].file, sessionPath);
});

test("replaceInSession edits scoped text and creates a backup", async () => {
  const { sessionPath, managerHome } = await fixture();

  const result = await replaceInSession(sessionPath, {
    from: "secret",
    to: "[REDACTED]",
    scope: "user",
    managerHome,
  });

  assert.equal(result.replacements, 1);
  assert.ok(result.backup.backupPath);

  const { raw } = await readJsonl(sessionPath);
  assert.match(raw, /\[REDACTED\]/);
  assert.doesNotMatch(raw, /hello secret/);
});

test("dropSessionLines removes selected 1-based records", async () => {
  const { sessionPath, managerHome } = await fixture();

  const result = await dropSessionLines(sessionPath, {
    lines: "3-4",
    managerHome,
  });

  assert.deepEqual(result.removedLines, [3, 4]);
  assert.equal(result.beforeLines, 4);
  assert.equal(result.afterLines, 2);

  const { records } = await readJsonl(sessionPath);
  assert.equal(records.length, 2);
  assert.equal(records[1].type, "turn_context");
});

test("updateSessionRecord replaces one JSONL record and creates a backup", async () => {
  const { sessionPath, managerHome } = await fixture();

  const result = await updateSessionRecord(
    sessionPath,
    3,
    {
      timestamp: "2026-04-28T17:29:48.000Z",
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "edited text" }],
      },
    },
    { managerHome },
  );

  assert.equal(result.line, 3);
  assert.ok(result.backup.backupPath);

  const { records } = await readJsonl(sessionPath);
  assert.equal(records[2].payload.content[0].text, "edited text");
  assert.equal(records[3].payload.content[0].text, "hello user");

  const backups = await listBackups({ managerHome, originalPath: sessionPath });
  assert.equal(backups.length, 1);
  assert.equal(backups[0].reason, "update line 3");

  const restoreResult = await restoreSessionBackup(backups[0].id, {
    managerHome,
    originalPath: sessionPath,
  });
  assert.equal(restoreResult.restoredPath, sessionPath);
  assert.ok(restoreResult.backup.backupPath);

  const restored = await readJsonl(sessionPath);
  assert.equal(restored.records[2].payload.content[0].text, "hello secret");
});

test("cleanSessions moves sessions to trash and restoreTrashBatch restores them", async () => {
  const { codexHome, managerHome, sessionPath } = await fixture();
  const [session] = await scanSessions({ codexHome });

  const cleanResult = await cleanSessions([session], { codexHome, managerHome });
  assert.equal(cleanResult.count, 1);
  await assert.rejects(fs.access(sessionPath));

  const trashItems = await listTrash({ managerHome });
  assert.equal(trashItems.length, 1);
  assert.equal(trashItems[0].count, 1);

  const restoreResult = await restoreTrashBatch(trashItems[0].id, { managerHome });
  assert.equal(restoreResult.count, 1);
  await assert.doesNotReject(fs.access(sessionPath));
});

test("cleanSessions honors dashed dry-run option from CLI", async () => {
  const { codexHome, managerHome, sessionPath } = await fixture();
  const [session] = await scanSessions({ codexHome });

  const result = await cleanSessions([session], { codexHome, managerHome, "dry-run": true });

  assert.equal(result.dryRun, true);
  assert.equal(result.count, 1);
  await assert.doesNotReject(fs.access(sessionPath));
  await assert.rejects(fs.access(managerHome));
});

test("parseLineRanges supports comma, closed ranges, and open ended ranges", () => {
  assert.deepEqual([...parseLineRanges("1,3-4,8-", 10)].sort((a, b) => a - b), [1, 3, 4, 8, 9, 10]);
  assert.throws(() => parseLineRanges("4-20", 10), /outside/);
});

test("sessionIsActive checks updatedAt inside a minute window", () => {
  const now = Date.parse("2026-04-28T17:40:00.000Z");
  assert.equal(sessionIsActive({ updatedAt: "2026-04-28T17:35:01.000Z" }, 5, now), true);
  assert.equal(sessionIsActive({ updatedAt: "2026-04-28T17:34:59.000Z" }, 5, now), false);
});

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "coldxx-test-"));
  const codexHome = path.join(root, ".codex");
  const managerHome = path.join(root, ".manager");
  const sessionDir = path.join(codexHome, "sessions", "2026", "04", "28");
  const sessionPath = path.join(
    sessionDir,
    "rollout-2026-04-28T17-29-46-019dd36c-584b-79d2-9a73-db43acc986e0.jsonl",
  );
  const records = [
    {
      timestamp: "2026-04-28T17:29:46.000Z",
      type: "session_meta",
      payload: {
        id: "019dd36c-584b-79d2-9a73-db43acc986e0",
        timestamp: "2026-04-28T17:29:46.000Z",
        cwd: "/work/project",
        cli_version: "0.0.0-test",
        model: "gpt-test",
      },
    },
    {
      timestamp: "2026-04-28T17:29:47.000Z",
      type: "turn_context",
      payload: { cwd: "/work/project", model: "gpt-test" },
    },
    {
      timestamp: "2026-04-28T17:29:48.000Z",
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "hello secret" }],
      },
    },
    {
      timestamp: "2026-04-28T17:29:49.000Z",
      type: "response_item",
      payload: {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "hello user" }],
      },
    },
  ];

  await fs.mkdir(sessionDir, { recursive: true });
  await fs.writeFile(sessionPath, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);

  return { root, codexHome, managerHome, sessionPath };
}
