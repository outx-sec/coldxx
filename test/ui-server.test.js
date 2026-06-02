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

  const unauthenticatedHtmlResponse = await fetch(origin);
  assert.equal(unauthenticatedHtmlResponse.status, 403);

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
  assert.match(html, /allowActiveToggle/);
  assert.match(html, /active-session-toggle/);
  assert.match(html, /coldxx-allow-active-v1/);
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
  assert.match(html, /data-edit-turn/);
  assert.match(html, /data-truncate-turn/);
  assert.match(html, /turn-edit-section/);
  assert.match(html, /settingsButton/);
  assert.match(html, /settings-tabs/);
  assert.match(html, /profileSelector/);
  assert.match(html, /rewriteSettingProvider/);
  assert.match(html, /本地 Codex（默认）/);
  assert.match(html, /OpenAI compatible/);
  assert.match(html, /Anthropic compatible/);
  assert.match(html, /rewriteSettingPrompt/);
  assert.match(html, /rewriteSettingCodexModel/);
  assert.match(html, /rewriteSettingModel/);
  assert.match(html, /rewriteSettingBaseUrl/);
  assert.match(html, /rewriteSettingApiKey/);
  assert.doesNotMatch(html, /rewriteSettingOss/);
  assert.doesNotMatch(html, /rewriteSettingLocalProvider/);
  assert.match(html, /rewritePromptPopover/);
  assert.match(html, /data-rewrite-group/);
  assert.match(html, /data-restore-rewrite-group/);
  assert.match(html, /turn-edit-row-head/);
  assert.match(html, /turn-edit-progress/);
  assert.match(html, /rewrite-running/);
  assert.match(html, /rewrite-replaced/);
  assert.match(html, /setTurnRewriteBusy/);
  assert.match(html, /改写进行中，完成后才能保存/);
  assert.match(html, /profileRawToml/);
  assert.match(html, /profileDeleteButton/);
  assert.match(html, /默认 config\.toml/);
  assert.match(html, /modalReplaceEnabled/);
  assert.match(html, /modalReplaceCaseSensitive/);
  assert.match(html, /modalFilterRegex/);

  const profilesResponse = await fetch(`${origin}/api/profiles`, { headers });
  assert.equal(profilesResponse.status, 200);
  const profilesBody = await profilesResponse.json();
  assert.equal(profilesBody.base.name, "default");
  assert.equal(profilesBody.profiles.length, 0);
  assert.equal(profilesBody.configs.length, 1);

  const defaultProfileSaveResponse = await fetch(`${origin}/api/profiles/default`, {
    method: "PUT",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({ raw: 'model = "should-not-write"\n' }),
  });
  assert.equal(defaultProfileSaveResponse.status, 400);

  const saveProfileResponse = await fetch(`${origin}/api/profiles/ctf`, {
    method: "PUT",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({
      raw: 'model = "gpt-5.5"\n',
      instructions: "profile prompt",
    }),
  });
  assert.equal(saveProfileResponse.status, 200);
  const saveProfileBody = await saveProfileResponse.json();
  assert.equal(saveProfileBody.profile.command, "codex -p ctf");
  assert.match(saveProfileBody.profile.raw, /instructions/);

  const profileResponse = await fetch(`${origin}/api/profiles/ctf`, { headers });
  assert.equal(profileResponse.status, 200);
  const profileBody = await profileResponse.json();
  assert.equal(profileBody.profile.fields.instructions, "profile prompt");

  const profilesAfterSaveResponse = await fetch(`${origin}/api/profiles`, { headers });
  assert.equal(profilesAfterSaveResponse.status, 200);
  const profilesAfterSaveBody = await profilesAfterSaveResponse.json();
  assert.equal(profilesAfterSaveBody.profiles.length, 1);
  assert.equal(profilesAfterSaveBody.configs.length, 2);

  const defaultProfileDeleteResponse = await fetch(`${origin}/api/profiles/default`, {
    method: "DELETE",
    headers,
  });
  assert.equal(defaultProfileDeleteResponse.status, 400);

  const deleteProfileResponse = await fetch(`${origin}/api/profiles/ctf`, {
    method: "DELETE",
    headers,
  });
  assert.equal(deleteProfileResponse.status, 200);
  const profilesAfterDeleteResponse = await fetch(`${origin}/api/profiles`, { headers });
  assert.equal(profilesAfterDeleteResponse.status, 200);
  const profilesAfterDeleteBody = await profilesAfterDeleteResponse.json();
  assert.equal(profilesAfterDeleteBody.profiles.length, 0);
  assert.equal(profilesAfterDeleteBody.configs.length, 1);

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
  assert.equal(recordsBody.turns.length, 2);
  assert.equal(recordsBody.turns[1].userTargetCount, 1);
  assert.equal(Object.hasOwn(recordsBody.records[0], "json"), true);

  const recordResponse = await fetch(`${origin}/api/sessions/${encodeURIComponent(session.id)}/records/3`, {
    headers,
  });
  assert.equal(recordResponse.status, 200);
  const recordBody = await recordResponse.json();
  assert.equal(recordBody.record.line, 3);
  assert.match(recordBody.record.json, /hello marker/);

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
  assert.equal(restored.records[2].payload.content[0].text, "hello marker");

  const turnPlanResponse = await fetch(
    `${origin}/api/sessions/${encodeURIComponent(session.id)}/turns/turn-1/edit`,
    { headers },
  );
  assert.equal(turnPlanResponse.status, 200);
  const turnPlan = await turnPlanResponse.json();
  assert.equal(turnPlan.groups.length, 2);

  const turnEditResponse = await fetch(
    `${origin}/api/sessions/${encodeURIComponent(session.id)}/turns/turn-1/edit`,
    {
      method: "PUT",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({
        allowActive: true,
        edits: turnPlan.groups.map((group) => ({
          id: group.id,
          text: group.side === "user" ? "turn user edited through ui" : "turn assistant edited through ui",
        })),
      }),
    },
  );
  assert.equal(turnEditResponse.status, 200);
  const turnEdited = await readJsonl(sessionPath);
  assert.equal(turnEdited.records[2].payload.content[0].text, "turn user edited through ui");
  assert.equal(turnEdited.records[3].payload.content[0].text, "turn assistant edited through ui");

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
  return { codexHome, managerHome, sessionPath };
}
