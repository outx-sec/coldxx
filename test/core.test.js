import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {
  cleanSessions,
  dropSessionLines,
  getSessionTurnEditPlan,
  groupSessionTurns,
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
  truncateSessionAfterTurn,
  updateSessionRecord,
  updateSessionTurnMessages,
} from "../src/core.js";

test("scanSessions reads Codex JSONL metadata", async () => {
  const { codexHome } = await fixture();

  const sessions = await scanSessions({ codexHome });

  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].id, "a1111111-2222-4333-8444-555555555555");
  assert.equal(sessions[0].cwd, "/work/project");
  assert.equal(sessions[0].lines, 4);
  assert.match(sessions[0].preview, /hello marker/);
});

test("scanSessions keeps fork session id separate from embedded parent metadata", async () => {
  const { codexHome, parentId, forkId, parentPath, forkPath } = await forkFixture();

  const sessions = await scanSessions({ codexHome });
  const parent = sessions.find((session) => session.file === parentPath);
  const fork = sessions.find((session) => session.file === forkPath);

  assert.equal(parent.id, parentId);
  assert.equal(fork.id, forkId);
  assert.equal(fork.parentSessionId, parentId);
  assert.equal(resolveSessionSelectors(sessions, [parentId], { allowMany: false })[0].file, parentPath);
  assert.equal(resolveSessionSelectors(sessions, [forkId], { allowMany: false })[0].file, forkPath);
});

test("resolveSessionSelectors supports latest, index, id prefix, and path", async () => {
  const { codexHome, sessionPath } = await fixture();
  const sessions = await scanSessions({ codexHome });

  assert.equal(resolveSessionSelectors(sessions, ["latest"])[0].file, sessionPath);
  assert.equal(resolveSessionSelectors(sessions, ["1"])[0].file, sessionPath);
  assert.equal(resolveSessionSelectors(sessions, ["a1111111"])[0].file, sessionPath);
  assert.equal(resolveSessionSelectors(sessions, [sessionPath])[0].file, sessionPath);
});

test("replaceInSession edits scoped text and creates a backup", async () => {
  const { sessionPath, managerHome } = await fixture();

  const result = await replaceInSession(sessionPath, {
    from: "marker",
    to: "[REDACTED]",
    scope: "user",
    managerHome,
  });

  assert.equal(result.replacements, 1);
  assert.ok(result.backup.backupPath);

  const { raw } = await readJsonl(sessionPath);
  assert.match(raw, /\[REDACTED\]/);
  assert.doesNotMatch(raw, /hello marker/);
});

test("replaceInSession honors case sensitivity and regex matching", async () => {
  const insensitive = await fixture();
  const caseResult = await replaceInSession(insensitive.sessionPath, {
    from: "HELLO MARKER",
    to: "case matched",
    scope: "user",
    caseSensitive: false,
    managerHome: insensitive.managerHome,
  });
  assert.equal(caseResult.replacements, 1);

  const strict = await fixture();
  const strictResult = await replaceInSession(strict.sessionPath, {
    from: "HELLO MARKER",
    to: "case matched",
    scope: "user",
    caseSensitive: true,
    managerHome: strict.managerHome,
  });
  assert.equal(strictResult.replacements, 0);

  const regex = await fixture();
  const regexResult = await replaceInSession(regex.sessionPath, {
    from: "hello\\s+mark[a-z]+",
    to: "regex matched",
    scope: "user",
    regex: true,
    caseSensitive: true,
    managerHome: regex.managerHome,
  });
  assert.equal(regexResult.replacements, 1);
  const { raw } = await readJsonl(regex.sessionPath);
  assert.match(raw, /regex matched/);
});

test("replaceInSession can limit replacements to selected lines", async () => {
  const { sessionPath, managerHome } = await fixture();

  const result = await replaceInSession(sessionPath, {
    from: "hello",
    to: "line scoped",
    scope: "all",
    lines: [4],
    managerHome,
  });

  assert.equal(result.replacements, 1);
  assert.equal(result.scopedLines, 1);

  const { records } = await readJsonl(sessionPath);
  assert.equal(records[2].payload.content[0].text, "hello marker");
  assert.equal(records[3].payload.content[0].text, "line scoped user");
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
  assert.equal(restored.records[2].payload.content[0].text, "hello marker");
});

test("groupSessionTurns and getSessionTurnEditPlan expose editable conversation groups", async () => {
  const { sessionPath } = await turnFixture();
  const { records } = await readJsonl(sessionPath);

  const turns = groupSessionTurns(records);
  assert.equal(turns.length, 3);
  assert.equal(turns[0].kind, "setup");
  assert.equal(turns[1].sourceTurnId, "turn-a");
  assert.equal(turns[1].startLine, 2);
  assert.equal(turns[1].endLine, 8);
  assert.equal(turns[1].userTargetCount, 2);
  assert.equal(turns[1].assistantTargetCount, 3);

  const plan = getSessionTurnEditPlan(records, "turn-1");
  assert.equal(plan.groups.length, 2);
  assert.equal(plan.groups.find((group) => group.side === "user").targetCount, 2);
  assert.equal(plan.groups.find((group) => group.side === "assistant").targetCount, 3);
});

test("updateSessionTurnMessages edits duplicate turn messages with one backup", async () => {
  const { sessionPath, managerHome } = await turnFixture();
  const { records } = await readJsonl(sessionPath);
  const plan = getSessionTurnEditPlan(records, "turn-1");

  const result = await updateSessionTurnMessages(
    sessionPath,
    "turn-1",
    plan.groups.map((group) => ({
      id: group.id,
      text: group.side === "user" ? "new user text" : "new assistant text",
    })),
    { managerHome },
  );

  assert.equal(result.changedGroups, 2);
  assert.equal(result.changedTargets, 5);
  assert.deepEqual(result.changedLines, [4, 5, 6, 7, 8]);

  const updated = await readJsonl(sessionPath);
  assert.equal(updated.records[3].payload.content[0].text, "new user text");
  assert.equal(updated.records[4].payload.message, "new user text");
  assert.equal(updated.records[5].payload.message, "new assistant text");
  assert.equal(updated.records[6].payload.content[0].text, "new assistant text");
  assert.equal(updated.records[7].payload.last_agent_message, "new assistant text");
  assert.equal(updated.records[9].payload.content[0].text, "later user");

  const backups = await listBackups({ managerHome, originalPath: sessionPath });
  assert.equal(backups.length, 1);
  assert.equal(backups[0].reason, "edit turn 1");
});

test("truncateSessionAfterTurn deletes records after the selected turn", async () => {
  const { sessionPath, managerHome } = await turnFixture();

  const result = await truncateSessionAfterTurn(sessionPath, "turn-1", { managerHome });

  assert.deepEqual(result.removedLines, [9, 10]);
  assert.equal(result.beforeLines, 10);
  assert.equal(result.afterLines, 8);

  const { records } = await readJsonl(sessionPath);
  assert.equal(records.length, 8);
  assert.equal(records.at(-1).payload.last_agent_message, "old assistant");
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
    "rollout-2026-04-28T17-29-46-a1111111-2222-4333-8444-555555555555.jsonl",
  );
  const records = [
    {
      timestamp: "2026-04-28T17:29:46.000Z",
      type: "session_meta",
      payload: {
        id: "a1111111-2222-4333-8444-555555555555",
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
        content: [{ type: "input_text", text: "hello marker" }],
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

async function turnFixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "coldxx-turn-test-"));
  const codexHome = path.join(root, ".codex");
  const managerHome = path.join(root, ".manager");
  const sessionDir = path.join(codexHome, "sessions", "2026", "04", "28");
  const sessionPath = path.join(
    sessionDir,
    "rollout-2026-04-28T17-29-46-a1111111-2222-4333-8444-555555555555.jsonl",
  );
  const records = [
    {
      timestamp: "2026-04-28T17:29:46.000Z",
      type: "session_meta",
      payload: {
        id: "a1111111-2222-4333-8444-555555555555",
        timestamp: "2026-04-28T17:29:46.000Z",
        cwd: "/work/project",
      },
    },
    {
      timestamp: "2026-04-28T17:29:47.000Z",
      type: "event_msg",
      payload: { type: "task_started", turn_id: "turn-a", started_at: "2026-04-28T17:29:47.000Z" },
    },
    {
      timestamp: "2026-04-28T17:29:47.500Z",
      type: "turn_context",
      payload: { turn_id: "turn-a", cwd: "/work/project", model: "gpt-test" },
    },
    {
      timestamp: "2026-04-28T17:29:48.000Z",
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "old user" }],
      },
    },
    {
      timestamp: "2026-04-28T17:29:48.100Z",
      type: "event_msg",
      payload: { type: "user_message", turn_id: "turn-a", message: "old user" },
    },
    {
      timestamp: "2026-04-28T17:29:49.000Z",
      type: "event_msg",
      payload: { type: "agent_message", turn_id: "turn-a", message: "old assistant" },
    },
    {
      timestamp: "2026-04-28T17:29:49.100Z",
      type: "response_item",
      payload: {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "old assistant" }],
      },
    },
    {
      timestamp: "2026-04-28T17:29:50.000Z",
      type: "event_msg",
      payload: {
        type: "task_complete",
        turn_id: "turn-a",
        last_agent_message: "old assistant",
      },
    },
    {
      timestamp: "2026-04-28T17:30:00.000Z",
      type: "event_msg",
      payload: { type: "task_started", turn_id: "turn-b", started_at: "2026-04-28T17:30:00.000Z" },
    },
    {
      timestamp: "2026-04-28T17:30:01.000Z",
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "later user" }],
      },
    },
  ];

  await fs.mkdir(sessionDir, { recursive: true });
  await fs.writeFile(sessionPath, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);

  return { root, codexHome, managerHome, sessionPath };
}

async function forkFixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "coldxx-fork-test-"));
  const codexHome = path.join(root, ".codex");
  const sessionDir = path.join(codexHome, "sessions", "2026", "04", "25");
  const parentId = "b2222222-3333-4444-8555-666666666666";
  const forkId = "c3333333-4444-4555-8666-777777777777";
  const parentPath = path.join(sessionDir, `rollout-2026-04-25T09-08-29-${parentId}.jsonl`);
  const forkPath = path.join(sessionDir, `rollout-2026-04-25T09-24-56-${forkId}.jsonl`);

  const parentRecords = [
    {
      timestamp: "2026-04-25T01:08:43.239Z",
      type: "session_meta",
      payload: {
        id: parentId,
        timestamp: "2026-04-25T01:08:29.061Z",
        cwd: "/work/project",
      },
    },
  ];
  const forkRecords = [
    {
      timestamp: "2026-04-25T01:24:56.763Z",
      type: "session_meta",
      payload: {
        id: forkId,
        forked_from_id: parentId,
        timestamp: "2026-04-25T01:24:56.706Z",
        cwd: "/work/project",
        source: {
          subagent: {
            thread_spawn: {
              parent_thread_id: parentId,
            },
          },
        },
      },
    },
    {
      timestamp: "2026-04-25T01:24:56.766Z",
      type: "session_meta",
      payload: {
        id: parentId,
        timestamp: "2026-04-25T01:08:29.061Z",
        cwd: "/work/project",
      },
    },
  ];

  await fs.mkdir(sessionDir, { recursive: true });
  await fs.writeFile(parentPath, `${parentRecords.map((record) => JSON.stringify(record)).join("\n")}\n`);
  await fs.writeFile(forkPath, `${forkRecords.map((record) => JSON.stringify(record)).join("\n")}\n`);

  return { root, codexHome, parentId, forkId, parentPath, forkPath };
}
