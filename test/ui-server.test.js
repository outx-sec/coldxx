import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { readJsonl } from "../src/core.js";
import { startUiServer } from "../src/ui-server.js";

test("ui server lists sessions and updates one record", async (t) => {
  const { codexHome, managerHome, sessionPath } = await fixture();
  let started;
  try {
    started = await startUiServer({
      codexHome,
      managerHome,
      port: 0,
      token: "test-token",
    });
  } catch (error) {
    if (error.code === "EPERM") {
      t.skip("local port listening is blocked by this sandbox");
      return;
    }
    throw error;
  }
  const { server, url } = started;
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const origin = new URL(url).origin;
  const headers = { "x-coldxx-token": "test-token" };

  const htmlResponse = await fetch(url);
  assert.equal(htmlResponse.status, 200);
  const html = await htmlResponse.text();
  for (const [, script] of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) {
    assert.doesNotThrow(() => new Function(script));
  }
  assert.match(html, /data-filter-role/);
  assert.match(html, /data-filter-type/);
  assert.match(html, /choice-grid/);
  assert.match(html, /coldxx-pane-layout-v1/);
  assert.match(html, /resetLayoutButton/);
  assert.match(html, /trashResizer/);
  assert.match(html, /coldxx-trash-height-v1/);
  assert.match(html, /history-caret/);
  assert.match(html, /record-copy-path/);
  assert.match(html, /copyRecordPathButton/);
  assert.match(html, /copyJsonButton/);
  assert.match(html, /wrapJsonToggle/);
  assert.match(html, /coldxx-json-wrap-v2/);
  assert.match(html, /wrap-lines/);
  assert.match(html, /large-json/);
  assert.match(html, /MAX_WRAPPED_JSON_CHARS/);
  assert.match(html, /MAX_JSON_AUTOLOAD_BYTES/);

  const sessionsResponse = await fetch(`${origin}/api/sessions`, { headers });
  assert.equal(sessionsResponse.status, 200);
  const sessionsBody = await sessionsResponse.json();
  assert.equal(sessionsBody.sessions.length, 1);

  const session = sessionsBody.sessions[0];
  const recordsResponse = await fetch(`${origin}/api/sessions/${encodeURIComponent(session.id)}/records`, {
    headers,
  });
  assert.equal(recordsResponse.status, 200);
  const recordsBody = await recordsResponse.json();
  assert.equal(recordsBody.records.length, 4);
  assert.equal(Object.hasOwn(recordsBody.records[0], "json"), true);

  const recordResponse = await fetch(`${origin}/api/sessions/${encodeURIComponent(session.id)}/records/3`, {
    headers,
  });
  assert.equal(recordResponse.status, 200);
  const recordBody = await recordResponse.json();
  assert.equal(recordBody.record.line, 3);
  assert.match(recordBody.record.json, /hello secret/);

  const updateResponse = await fetch(`${origin}/api/sessions/${encodeURIComponent(session.id)}/records/3`, {
    method: "PUT",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({
      allowActive: true,
      json: JSON.stringify({
        timestamp: "2026-04-28T17:29:48.000Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "edited through ui" }],
        },
      }),
    }),
  });
  assert.equal(updateResponse.status, 200);

  const { records } = await readJsonl(sessionPath);
  assert.equal(records[2].payload.content[0].text, "edited through ui");

  const historyResponse = await fetch(`${origin}/api/sessions/${encodeURIComponent(session.id)}/history`, {
    headers,
  });
  assert.equal(historyResponse.status, 200);
  const historyBody = await historyResponse.json();
  assert.equal(historyBody.items.length, 1);
  assert.equal(historyBody.items[0].reason, "update line 3");

  const rollbackResponse = await fetch(
    `${origin}/api/sessions/${encodeURIComponent(session.id)}/history/${encodeURIComponent(historyBody.items[0].id)}/restore`,
    {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ allowActive: true }),
    },
  );
  assert.equal(rollbackResponse.status, 200);
  const restored = await readJsonl(sessionPath);
  assert.equal(restored.records[2].payload.content[0].text, "hello secret");

  const cleanResponse = await fetch(`${origin}/api/sessions/clean`, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({ ids: [session.id], allowActive: true }),
  });
  assert.equal(cleanResponse.status, 200);
  const cleanBody = await cleanResponse.json();
  assert.equal(cleanBody.count, 1);
  await assert.rejects(fs.access(sessionPath));

  const trashResponse = await fetch(`${origin}/api/trash`, { headers });
  assert.equal(trashResponse.status, 200);
  const trashBody = await trashResponse.json();
  assert.equal(trashBody.items.length, 1);
  assert.equal(trashBody.items[0].count, 1);

  const restoreResponse = await fetch(`${origin}/api/trash/${trashBody.items[0].id}/restore`, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({ overwrite: false }),
  });
  assert.equal(restoreResponse.status, 200);
  await assert.doesNotReject(fs.access(sessionPath));
});

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "coldxx-ui-test-"));
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
  return { codexHome, managerHome, sessionPath };
}
