import http from "node:http";
import crypto from "node:crypto";
import {
  cleanSessions,
  dropSessionLines,
  emptyTrash,
  formatBytes,
  listBackups,
  listTrash,
  readSessionForEditing,
  readSessionRecordForEditing,
  replaceInSession,
  resolveCodexHome,
  resolveManagerHome,
  resolveSessionSelectors,
  restoreSessionBackup,
  restoreTrashBatch,
  scanSessions,
  sessionIsActive,
  updateSessionRecord,
} from "./core.js";

const DEFAULT_ACTIVE_WINDOW_MINUTES = 10;
const MAX_BODY_BYTES = 25 * 1024 * 1024;
const MAX_INLINE_RECORD_JSON_BYTES = 256 * 1024;

export async function startUiServer(options = {}) {
  const codexHome = resolveCodexHome(options.codexHome);
  const managerHome = resolveManagerHome(options.managerHome);
  const host = options.host || "127.0.0.1";
  const port = options.port === undefined ? 4765 : Number.parseInt(String(options.port), 10);
  const token = options.token || crypto.randomBytes(24).toString("base64url");
  const activeWindowMinutes =
    Number.parseInt(options.activeWindowMinutes || String(DEFAULT_ACTIVE_WINDOW_MINUTES), 10) ||
    DEFAULT_ACTIVE_WINDOW_MINUTES;
  const server = createUiServer({ codexHome, managerHome, token, activeWindowMinutes });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address();
  const actualPort = typeof address === "object" && address ? address.port : port;
  const url = `http://${host}:${actualPort}/?token=${encodeURIComponent(token)}`;
  return { server, url, host, port: actualPort, codexHome, managerHome };
}

export function createUiServer(options) {
  const state = {
    codexHome: resolveCodexHome(options.codexHome),
    managerHome: resolveManagerHome(options.managerHome),
    token: options.token,
    activeWindowMinutes: options.activeWindowMinutes || DEFAULT_ACTIVE_WINDOW_MINUTES,
  };

  return http.createServer(async (req, res) => {
    try {
      await route(req, res, state);
    } catch (error) {
      sendJson(res, error.statusCode || 500, { error: error.message || "Internal server error" });
    }
  });
}

async function route(req, res, state) {
  const url = new URL(req.url || "/", "http://localhost");

  if (req.method === "GET" && url.pathname === "/") {
    sendHtml(res, html(state));
    return;
  }

  if (!url.pathname.startsWith("/api/")) {
    sendJson(res, 404, { error: "Not found" });
    return;
  }

  if (!isAuthorized(req, url, state.token)) {
    sendJson(res, 403, { error: "Invalid UI token" });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/sessions") {
    const sessions = await scanSessions({ codexHome: state.codexHome });
    const query = (url.searchParams.get("query") || "").trim().toLowerCase();
    const limit = Math.max(1, Number.parseInt(url.searchParams.get("limit") || "200", 10));
    const filtered = query
      ? sessions.filter((session) =>
          [session.id, session.file, session.cwd, session.preview, session.model]
            .filter(Boolean)
            .some((value) => String(value).toLowerCase().includes(query)),
        )
      : sessions;
    sendJson(res, 200, {
      sessions: filtered.slice(0, limit).map((session) => publicSession(session, state)),
      total: filtered.length,
      codexHome: state.codexHome,
      managerHome: state.managerHome,
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/sessions/clean") {
    const body = await readJsonBody(req);
    const ids = Array.isArray(body.ids) ? body.ids.map(String).filter(Boolean) : [];
    if (ids.length === 0) {
      sendJson(res, 400, { error: "No session ids were provided" });
      return;
    }
    const sessions = await scanSessions({ codexHome: state.codexHome });
    const targets = resolveSessionSelectors(sessions, ids, { allowMany: true });
    for (const target of targets) {
      guardActiveSession(target, state, body.allowActive, "clean selected sessions");
    }
    const result = await cleanSessions(targets, {
      codexHome: state.codexHome,
      managerHome: state.managerHome,
      permanent: Boolean(body.permanent),
    });
    sendJson(res, 200, result);
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/trash") {
    sendJson(res, 200, { items: await listTrash({ managerHome: state.managerHome }) });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/trash/empty") {
    const result = await emptyTrash({ managerHome: state.managerHome });
    sendJson(res, 200, result);
    return;
  }

  const trashMatch = /^\/api\/trash\/([^/]+)\/restore$/.exec(url.pathname);
  if (req.method === "POST" && trashMatch) {
    const body = await readJsonBody(req);
    const result = await restoreTrashBatch(decodeURIComponent(trashMatch[1]), {
      managerHome: state.managerHome,
      overwrite: Boolean(body.overwrite),
    });
    sendJson(res, 200, result);
    return;
  }

  const historyMatch = /^\/api\/sessions\/([^/]+)\/history(?:\/([^/]+)\/restore)?$/.exec(url.pathname);
  if (historyMatch) {
    const session = await resolveSession(decodeURIComponent(historyMatch[1]), state);
    const backupId = historyMatch[2] ? decodeURIComponent(historyMatch[2]) : "";

    if (req.method === "GET" && !backupId) {
      sendJson(res, 200, {
        items: await listBackups({
          managerHome: state.managerHome,
          originalPath: session.file,
        }),
      });
      return;
    }

    if (req.method === "POST" && backupId) {
      const body = await readJsonBody(req);
      guardActiveSession(session, state, body.allowActive, "rollback this session");
      const result = await restoreSessionBackup(backupId, {
        managerHome: state.managerHome,
        originalPath: session.file,
      });
      sendJson(res, 200, result);
      return;
    }

    sendJson(res, 405, { error: "Method not allowed" });
    return;
  }

  const match = /^\/api\/sessions\/([^/]+)(?:\/(records|replace|drop|clean)(?:\/(\d+))?)?$/.exec(url.pathname);
  if (!match) {
    sendJson(res, 404, { error: "Not found" });
    return;
  }

  const selector = decodeURIComponent(match[1]);
  const resource = match[2] || "summary";
  const line = match[3] ? Number.parseInt(match[3], 10) : null;
  const session = await resolveSession(selector, state);

  if (req.method === "GET" && resource === "summary") {
    sendJson(res, 200, { session: publicSession(session, state) });
    return;
  }

  if (req.method === "GET" && resource === "records" && line !== null) {
    const record = await readSessionRecordForEditing(session.file, line);
    sendJson(res, 200, { record });
    return;
  }

  if (req.method === "GET" && resource === "records") {
    const sessionForEditing = await readSessionForEditing(session.file, {
      codexHome: state.codexHome,
      includeJson: true,
      maxJsonBytes: MAX_INLINE_RECORD_JSON_BYTES,
    });
    sendJson(res, 200, {
      session: publicSession({ ...session, ...sessionForEditing.summary }, state),
      records: sessionForEditing.records,
    });
    return;
  }

  if (req.method === "PUT" && resource === "records" && line !== null) {
    const body = await readJsonBody(req);
    guardActiveSession(session, state, body.allowActive, "edit this session");
    const nextRecord = parseRecordJson(body.json);
    const result = await updateSessionRecord(session.file, line, nextRecord, {
      managerHome: state.managerHome,
    });
    sendJson(res, 200, result);
    return;
  }

  if (req.method === "POST" && resource === "replace") {
    const body = await readJsonBody(req);
    guardActiveSession(session, state, body.allowActive, "replace text in this session");
    const result = await replaceInSession(session.file, {
      from: String(body.from || ""),
      to: String(body.to || ""),
      scope: body.scope || "all",
      regex: Boolean(body.regex),
      flags: body.flags || "",
      caseSensitive: Boolean(body.caseSensitive),
      managerHome: state.managerHome,
    });
    sendJson(res, 200, result);
    return;
  }

  if (req.method === "POST" && resource === "drop") {
    const body = await readJsonBody(req);
    guardActiveSession(session, state, body.allowActive, "drop lines from this session");
    const result = await dropSessionLines(session.file, {
      lines: String(body.lines || ""),
      managerHome: state.managerHome,
    });
    sendJson(res, 200, result);
    return;
  }

  if (req.method === "POST" && resource === "clean") {
    const body = await readJsonBody(req);
    guardActiveSession(session, state, body.allowActive, "clean this session");
    const result = await cleanSessions([session], {
      codexHome: state.codexHome,
      managerHome: state.managerHome,
      permanent: Boolean(body.permanent),
    });
    sendJson(res, 200, result);
    return;
  }

  sendJson(res, 405, { error: "Method not allowed" });
}

async function resolveSession(selector, state) {
  const sessions = await scanSessions({ codexHome: state.codexHome });
  const [session] = resolveSessionSelectors(sessions, [selector], { allowMany: false });
  return session;
}

function guardActiveSession(session, state, allowActive, action) {
  if (allowActive || !sessionIsActive(session, state.activeWindowMinutes)) {
    return;
  }

  const error = new Error(
    `Refusing to ${action}: session was updated within the last ${state.activeWindowMinutes} minute(s).`,
  );
  error.statusCode = 409;
  throw error;
}

function parseRecordJson(input) {
  if (typeof input !== "string" || input.trim() === "") {
    throw new Error("Record JSON is required");
  }

  try {
    return JSON.parse(input);
  } catch (error) {
    const wrapped = new Error(`Invalid JSON: ${error.message}`);
    wrapped.statusCode = 400;
    throw wrapped;
  }
}

function publicSession(session, state) {
  return {
    id: session.id,
    parentSessionId: session.parentSessionId,
    shortId: session.shortId,
    file: session.file,
    relativePath: session.relativePath,
    startedAt: session.startedAt,
    updatedAt: session.updatedAt,
    sizeBytes: session.sizeBytes,
    size: formatBytes(session.sizeBytes || 0),
    lines: session.lines,
    cwd: session.cwd,
    model: session.model,
    cliVersion: session.cliVersion,
    preview: session.preview,
    valid: session.valid,
    error: session.error,
    active: sessionIsActive(session, state.activeWindowMinutes),
  };
}

async function readJsonBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      const error = new Error("Request body is too large");
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }

  if (chunks.length === 0) {
    return {};
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch (error) {
    const wrapped = new Error(`Invalid JSON body: ${error.message}`);
    wrapped.statusCode = 400;
    throw wrapped;
  }
}

function isAuthorized(req, url, token) {
  return req.headers["x-coldxx-token"] === token || url.searchParams.get("token") === token;
}

function sendJson(res, statusCode, body) {
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  res.end(`${JSON.stringify(body)}\n`);
}

function sendHtml(res, body) {
  res.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  res.end(body);
}

function html(state) {
  const boot = JSON.stringify({
    token: state.token,
    codexHome: state.codexHome,
    managerHome: state.managerHome,
    activeWindowMinutes: state.activeWindowMinutes,
  });

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>coldxx</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f3f5f4;
      --panel: #ffffff;
      --panel-soft: #f8faf9;
      --panel-2: #eef3f2;
      --ink: #172027;
      --muted: #65737b;
      --line: #d7dedf;
      --line-strong: #b8c5c7;
      --accent: #0d6b60;
      --accent-soft: #e3f1ee;
      --accent-2: #375f94;
      --danger: #b33b3b;
      --danger-soft: #f8e7e7;
      --warn: #9a6112;
      --ok: #146c43;
      --shadow: 0 1px 3px rgba(21, 31, 36, 0.08), 0 10px 28px rgba(21, 31, 36, 0.06);
      --sessions-width: clamp(220px, 16.667vw, 340px);
      --editor-width: clamp(320px, 33.333vw, 680px);
      --record-line-width: 58px;
      --record-type-width: 190px;
      --record-role-width: 88px;
      --trash-height: 220px;
      font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }

    * {
      box-sizing: border-box;
    }

    body {
      margin: 0;
      background:
        linear-gradient(180deg, rgba(255,255,255,0.75), rgba(255,255,255,0) 180px),
        var(--bg);
      color: var(--ink);
      min-width: 320px;
      overflow: hidden;
    }

    body.resizing {
      cursor: col-resize;
      user-select: none;
    }

    body.resizing-y {
      cursor: row-resize;
      user-select: none;
    }

    button,
    input,
    textarea,
    select {
      font: inherit;
    }

    button {
      border: 1px solid var(--line);
      background: linear-gradient(180deg, #fff, #f7faf9);
      color: var(--ink);
      border-radius: 6px;
      height: 34px;
      padding: 0 10px;
      cursor: pointer;
      white-space: nowrap;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 6px;
      transition: background 140ms ease, border-color 140ms ease, color 140ms ease, transform 80ms ease;
    }

    button:hover {
      border-color: #9fb0b4;
      background: linear-gradient(180deg, #fff, #f1f6f5);
    }

    button:active {
      transform: translateY(1px);
    }

    button.primary {
      background: linear-gradient(180deg, #127b6f, var(--accent));
      border-color: var(--accent);
      color: #fff;
      box-shadow: 0 1px 2px rgba(13, 107, 96, 0.2);
    }

    button.danger {
      color: var(--danger);
      background: linear-gradient(180deg, #fff8f8, var(--danger-soft));
      border-color: #e7b9b9;
    }

    button.danger:hover {
      color: #fff;
      background: linear-gradient(180deg, #c64a4a, var(--danger));
      border-color: var(--danger);
    }

    button.icon {
      width: 34px;
      padding: 0;
      font-weight: 700;
    }

    button.compact {
      height: 30px;
      padding: 0 9px;
      font-size: 12px;
    }

    button.ghost {
      background: transparent;
    }

    button:disabled {
      cursor: not-allowed;
      opacity: 0.55;
    }

    input,
    select,
    textarea {
      border: 1px solid var(--line);
      border-radius: 6px;
      background: #fff;
      color: var(--ink);
      transition: border-color 140ms ease, box-shadow 140ms ease;
    }

    input:focus,
    select:focus,
    textarea:focus {
      border-color: var(--accent);
      box-shadow: 0 0 0 3px rgba(13, 107, 96, 0.12);
      outline: none;
    }

    input,
    select {
      height: 34px;
      padding: 0 9px;
    }

    textarea {
      width: 100%;
      resize: none;
      padding: 10px;
      line-height: 1.45;
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      font-size: 12px;
      tab-size: 2;
    }

    .app {
      height: 100vh;
      display: grid;
      grid-template-rows: 52px 1fr;
    }

    .topbar {
      display: grid;
      grid-template-columns: minmax(160px, 240px) minmax(220px, 1fr) auto;
      align-items: center;
      gap: 12px;
      border-bottom: 1px solid var(--line);
      background: rgba(252, 253, 251, 0.92);
      backdrop-filter: blur(12px);
      padding: 0 16px;
      box-shadow: 0 1px 0 rgba(255, 255, 255, 0.75) inset;
    }

    .top-actions {
      display: flex;
      justify-content: flex-end;
      align-items: center;
      gap: 10px;
      flex-wrap: wrap;
    }

    .brand {
      font-weight: 700;
      letter-spacing: 0;
      display: flex;
      align-items: center;
      gap: 8px;
    }

    .brand-mark {
      width: 20px;
      height: 20px;
      border-radius: 6px;
      background: linear-gradient(135deg, var(--accent), var(--accent-2));
      box-shadow: inset 0 0 0 1px rgba(255,255,255,0.45);
    }

    .pathline {
      color: var(--muted);
      font-size: 12px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .searchbar {
      display: flex;
      gap: 8px;
      align-items: center;
      min-width: 0;
    }

    .searchbar input {
      width: min(420px, 100%);
      min-width: 120px;
      font-size: 13px;
    }

    .workspace {
      display: grid;
      grid-template-columns: minmax(220px, var(--sessions-width)) 8px minmax(500px, 3fr) 8px minmax(300px, var(--editor-width));
      min-height: 0;
      gap: 0;
      padding: 10px;
      overflow: hidden;
    }

    .sessions,
    .records,
    .editor {
      min-height: 0;
      display: flex;
      flex-direction: column;
      background: rgba(255, 255, 255, 0.94);
      border: 1px solid var(--line);
      box-shadow: var(--shadow);
      overflow: hidden;
    }

    .sessions {
      border-radius: 8px 0 0 8px;
    }

    .records {
      border-radius: 0;
    }

    .editor {
      border-radius: 0 8px 8px 0;
    }

    .editor .meta {
      overflow: visible;
      text-overflow: clip;
      white-space: normal;
      overflow-wrap: anywhere;
    }

    .resizer {
      position: relative;
      cursor: col-resize;
      background: transparent;
      touch-action: none;
    }

    .resizer::before {
      content: "";
      position: absolute;
      top: 12px;
      bottom: 12px;
      left: 3px;
      width: 2px;
      border-radius: 999px;
      background: transparent;
      transition: background 140ms ease, width 140ms ease, left 140ms ease;
    }

    .resizer:hover::before,
    .resizer.dragging::before {
      left: 2px;
      width: 4px;
      background: var(--accent);
    }

    .resizer:focus-visible {
      outline: 2px solid var(--accent);
      outline-offset: -2px;
    }

    .section-head {
      min-height: 56px;
      padding: 10px 12px;
      border-bottom: 1px solid var(--line);
      display: flex;
      gap: 10px;
      align-items: center;
      justify-content: space-between;
      background: linear-gradient(180deg, #fff, #fbfcfc);
    }

    .section-title {
      min-width: 0;
      font-weight: 650;
      font-size: 13px;
    }

    .meta {
      color: var(--muted);
      font-size: 12px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      margin-top: 2px;
    }

    .session-list,
    .record-list {
      overflow: auto;
      min-height: 0;
      scrollbar-width: thin;
      scrollbar-color: #a9b9bc transparent;
    }

    .session-list {
      flex: 1;
    }

    .record-list {
      flex: 1;
    }

    .session-actions {
      display: flex;
      gap: 6px;
      align-items: center;
      flex-wrap: wrap;
      padding: 8px 10px;
      border-bottom: 1px solid var(--line);
      background: #fbfcfc;
    }

    .session-item {
      width: 100%;
      min-width: 0;
      display: grid;
      grid-template-columns: auto minmax(0, 1fr) auto;
      gap: 7px;
      align-items: start;
      border: 0;
      border-bottom: 1px solid var(--line);
      border-radius: 0;
      text-align: left;
      height: auto;
      padding: 11px 12px;
      background: transparent;
      transition: background 120ms ease, box-shadow 120ms ease;
      cursor: pointer;
    }

    .session-check {
      width: 16px;
      height: 16px;
      margin: 2px 2px 0 0;
      accent-color: var(--accent);
    }

    .session-item:hover {
      background: var(--panel-soft);
    }

    .session-item.active {
      background: var(--accent-soft);
      border-left: 3px solid var(--accent);
      padding-left: 9px;
      box-shadow: inset 0 1px 0 rgba(255,255,255,0.7);
    }

    .session-main {
      min-width: 0;
      max-width: 100%;
      overflow: hidden;
      display: block;
    }

    .session-title {
      font-size: 13px;
      font-weight: 650;
      line-height: 1.28;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      display: block;
    }

    .session-preview {
      margin-top: 5px;
      color: #7a878d;
      font-size: 12px;
      height: 32px;
      line-height: 1.35;
      overflow: hidden;
      display: -webkit-box;
      -webkit-line-clamp: 2;
      -webkit-box-orient: vertical;
    }

    .session-path {
      display: block;
      min-width: 0;
      max-width: 100%;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .session-stats {
      display: flex;
      flex-wrap: wrap;
      gap: 5px;
      margin-top: 7px;
    }

    .session-side {
      display: flex;
      flex-direction: column;
      align-items: flex-end;
      gap: 6px;
    }

    .record-copy-path {
      width: 24px;
      height: 24px;
      padding: 0;
      color: var(--muted);
    }

    .record-copy-path:hover {
      color: var(--accent);
    }

    .copy-mark {
      position: relative;
      width: 12px;
      height: 12px;
      display: inline-block;
    }

    .copy-mark::before,
    .copy-mark::after {
      content: "";
      position: absolute;
      width: 8px;
      height: 8px;
      border: 1.4px solid currentColor;
      border-radius: 2px;
      background: #fff;
    }

    .copy-mark::before {
      left: 0;
      top: 3px;
    }

    .copy-mark::after {
      left: 4px;
      top: 0;
    }

    .trash-panel {
      border-top: 1px solid var(--line);
      background: #fbfcfc;
      flex: 0 0 var(--trash-height);
      display: grid;
      grid-template-rows: auto minmax(80px, 1fr);
      min-height: 126px;
    }

    .trash-resizer {
      flex: 0 0 8px;
      position: relative;
      cursor: row-resize;
      background: #fbfcfc;
      border-top: 1px solid var(--line);
      touch-action: none;
    }

    .trash-resizer::before {
      content: "";
      position: absolute;
      left: 14px;
      right: 14px;
      top: 3px;
      height: 2px;
      border-radius: 999px;
      background: transparent;
      transition: background 140ms ease, height 140ms ease, top 140ms ease;
    }

    .trash-resizer:hover::before,
    .trash-resizer.dragging::before {
      top: 2px;
      height: 4px;
      background: var(--accent);
    }

    .trash-head {
      min-height: 42px;
      padding: 7px 10px;
      border-bottom: 1px solid var(--line);
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
    }

    .trash-actions {
      display: flex;
      align-items: center;
      gap: 6px;
    }

    .trash-list {
      overflow: auto;
      min-height: 0;
    }

    .trash-item {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 8px;
      padding: 9px 10px;
      border-bottom: 1px solid var(--line);
      align-items: center;
      font-size: 12px;
    }

    .trash-title {
      font-weight: 650;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .pill {
      display: inline-flex;
      align-items: center;
      height: 22px;
      border-radius: 999px;
      padding: 0 8px;
      font-size: 11px;
      background: var(--panel-2);
      color: var(--muted);
      border: 1px solid var(--line);
    }

    .pill.ok {
      background: #e6f3ec;
      border-color: #b8dac8;
      color: var(--ok);
    }

    .pill.active {
      background: #fff1d6;
      border-color: #eccb8d;
      color: var(--warn);
    }

    .tools {
      min-height: 42px;
      padding: 6px 10px;
      display: flex;
      align-items: center;
      gap: 8px;
      border-bottom: 1px solid var(--line);
      background: #fbfcfc;
    }

    .tool-group {
      display: grid;
      gap: 6px;
    }

    .tool-label {
      color: #405058;
      font-size: 11px;
      font-weight: 650;
      text-transform: uppercase;
      letter-spacing: 0;
    }

    .tool-row {
      display: flex;
      align-items: center;
      gap: 6px;
      min-width: 0;
      flex-wrap: wrap;
    }

    .tool-row input[type="text"] {
      width: 88px;
      min-width: 72px;
      flex: 0 0 88px;
      height: 30px;
      padding: 0 8px;
      font-size: 12px;
    }

    .record-toolbar {
      width: 100%;
    }

    .toolbar-divider {
      width: 1px;
      height: 20px;
      background: var(--line);
      flex: 0 0 auto;
      margin: 0 2px;
    }

    .tools input,
    .tools select {
      height: 30px;
      font-size: 12px;
    }

    .checks {
      display: inline-flex;
      gap: 12px;
      align-items: center;
      color: var(--muted);
      font-size: 12px;
    }

    .switch {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      color: var(--muted);
      font-size: 12px;
      white-space: nowrap;
    }

    .switch input {
      width: 36px;
      height: 20px;
      appearance: none;
      border-radius: 999px;
      border: 1px solid var(--line-strong);
      background: #dfe7e8;
      position: relative;
      margin: 0;
      transition: background 140ms ease, border-color 140ms ease;
    }

    .switch input::before {
      content: "";
      position: absolute;
      top: 2px;
      left: 2px;
      width: 14px;
      height: 14px;
      border-radius: 50%;
      background: #fff;
      box-shadow: 0 1px 2px rgba(0,0,0,0.18);
      transition: transform 140ms ease;
    }

    .switch input:checked {
      background: var(--accent);
      border-color: var(--accent);
    }

    .switch input:checked::before {
      transform: translateX(16px);
    }

    .checks input {
      height: auto;
      margin: 0 5px 0 0;
      vertical-align: middle;
    }

    table {
      width: 100%;
      border-collapse: collapse;
      table-layout: fixed;
      font-size: 12px;
    }

    th,
    td {
      border-bottom: 1px solid var(--line);
      padding: 7px 8px;
      vertical-align: top;
      text-align: left;
    }

    th {
      position: sticky;
      top: 0;
      background: #eef4f3;
      color: #405058;
      font-weight: 650;
      z-index: 1;
      overflow: visible;
    }

    th.resizable-th {
      padding-right: 14px;
    }

    .column-handle {
      position: absolute;
      top: 0;
      right: -4px;
      width: 8px;
      height: 100%;
      cursor: col-resize;
      z-index: 2;
    }

    .column-handle::after {
      content: "";
      position: absolute;
      top: 7px;
      bottom: 7px;
      left: 3px;
      width: 2px;
      border-radius: 999px;
      background: transparent;
      transition: background 120ms ease, width 120ms ease;
    }

    .column-handle:hover::after,
    .column-handle.dragging::after {
      left: 2px;
      width: 4px;
      background: var(--accent-2);
    }

    tr {
      cursor: pointer;
    }

    tr:hover td {
      background: #f8faf9;
    }

    tr.selected td {
      background: #e7f0f5;
      box-shadow: inset 3px 0 0 var(--accent-2);
    }

    .record-kind {
      display: inline-flex;
      max-width: 100%;
      height: 22px;
      align-items: center;
      border-radius: 5px;
      padding: 0 6px;
      background: #edf2f7;
      color: #36506d;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .role-badge {
      display: inline-flex;
      height: 22px;
      align-items: center;
      border-radius: 5px;
      padding: 0 6px;
      background: #f0f3ed;
      color: #4f6145;
    }

    .line-col {
      width: var(--record-line-width);
      color: var(--muted);
      font-variant-numeric: tabular-nums;
    }

    .type-col {
      width: var(--record-type-width);
    }

    .role-col {
      width: var(--record-role-width);
    }

    .text-col {
      width: auto;
    }

    .clip {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .history-drawer {
      flex: 0 0 auto;
      border-top: 1px solid var(--line);
      background: #fbfcfc;
      max-height: 38px;
      overflow: hidden;
      transition: max-height 180ms ease;
    }

    .history-drawer.open {
      max-height: 260px;
    }

    .history-summary {
      width: 100%;
      height: 38px;
      border: 0;
      border-radius: 0;
      padding: 0 12px;
      background: linear-gradient(180deg, #fff, #f7faf9);
      display: grid;
      grid-template-columns: auto minmax(0, 1fr) auto;
      gap: 10px;
      text-align: left;
    }

    .history-title {
      font-weight: 650;
      font-size: 12px;
      color: #405058;
    }

    .history-summary-text {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      color: var(--muted);
      font-size: 12px;
    }

    .history-caret {
      width: 8px;
      height: 8px;
      border-right: 2px solid var(--muted);
      border-bottom: 2px solid var(--muted);
      transform: rotate(45deg);
      transition: transform 160ms ease, border-color 160ms ease;
    }

    .history-summary:hover .history-caret {
      border-color: var(--accent);
    }

    .history-drawer.open .history-caret {
      transform: rotate(225deg);
    }

    .history-body {
      max-height: 222px;
      overflow: auto;
      padding: 8px 10px 10px;
      display: grid;
      gap: 7px;
    }

    .history-item {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 10px;
      align-items: center;
      border: 1px solid var(--line);
      border-radius: 7px;
      padding: 8px 9px;
      background: #fff;
    }

    .history-item-title {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      color: var(--ink);
      font-size: 12px;
      font-weight: 650;
    }

    .records .section-head {
      align-items: start;
      min-height: 82px;
    }

    .record-heading {
      min-width: 0;
      display: grid;
      gap: 4px;
      flex: 1;
    }

    .record-title-row {
      min-width: 0;
      display: flex;
      align-items: center;
      gap: 8px;
    }

    .record-title-main {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .record-meta-line,
    .record-path {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      color: var(--muted);
      font-size: 12px;
      font-weight: 400;
    }

    .record-path-row {
      min-width: 0;
      display: flex;
      align-items: center;
      gap: 7px;
    }

    .record-path {
      color: #46565d;
    }

    .editor-body {
      padding: 12px;
      display: grid;
      grid-template-rows: auto minmax(220px, 1fr) auto;
      gap: 10px;
      min-height: 0;
      flex: 1;
      background: #fbfcfc;
    }

    .json-editor-shell {
      position: relative;
      min-height: 220px;
      height: 100%;
      overflow: hidden;
      border: 1px solid #cbd5d7;
      border-radius: 6px;
      background: #101820;
      box-shadow: inset 0 1px 3px rgba(0,0,0,0.25);
    }

    .json-copy-button {
      position: absolute;
      top: 8px;
      right: 8px;
      z-index: 3;
      width: 28px;
      height: 28px;
      padding: 0;
      border-color: rgba(158, 171, 177, 0.4);
      background: rgba(16, 24, 32, 0.72);
      color: #d9e4e8;
      opacity: 0.45;
      box-shadow: 0 1px 4px rgba(0,0,0,0.25);
    }

    .json-copy-button:hover,
    .json-copy-button:focus-visible {
      opacity: 1;
      background: rgba(25, 36, 45, 0.96);
      border-color: rgba(217, 228, 232, 0.5);
      color: #fff;
    }

    .json-copy-button:disabled {
      display: none;
    }

    .editor textarea {
      position: absolute;
      inset: 0;
      margin: 0;
      min-height: 220px;
      height: 100%;
      overflow: auto;
      padding: 10px;
      border: 0;
      background: transparent;
      color: #d9e4e8;
      -webkit-text-fill-color: #d9e4e8;
      caret-color: #9ed7cb;
      box-shadow: none;
      resize: none;
      line-height: 1.45;
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      font-size: 12px;
      tab-size: 2;
      white-space: pre;
      word-break: normal;
    }

    .json-editor-shell.wrap-lines textarea {
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      word-break: break-word;
      overflow-x: hidden;
    }

    .json-editor-shell.large-json.wrap-lines textarea {
      white-space: pre;
      overflow-wrap: normal;
      word-break: normal;
      overflow-x: auto;
    }

    .editor textarea::selection {
      background: rgba(121, 177, 210, 0.35);
      -webkit-text-fill-color: #ffffff;
    }

    .status {
      min-height: 24px;
      font-size: 12px;
      color: var(--muted);
      display: flex;
      align-items: center;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .status.error {
      color: var(--danger);
    }

    .status.ok {
      color: var(--ok);
    }

    .editor .status {
      align-items: flex-start;
      overflow: visible;
      text-overflow: clip;
      white-space: normal;
      overflow-wrap: anywhere;
    }

    .empty {
      padding: 18px 12px;
      color: var(--muted);
      font-size: 13px;
    }

    .toast {
      position: fixed;
      left: 50%;
      bottom: 18px;
      transform: translateX(-50%) translateY(20px);
      opacity: 0;
      pointer-events: none;
      min-width: min(560px, calc(100vw - 32px));
      max-width: calc(100vw - 32px);
      border: 1px solid var(--line);
      border-radius: 8px;
      background: rgba(23, 32, 39, 0.94);
      color: #fff;
      box-shadow: var(--shadow);
      padding: 10px 12px;
      font-size: 13px;
      transition: opacity 180ms ease, transform 180ms ease;
      z-index: 10;
    }

    .toast.show {
      opacity: 1;
      transform: translateX(-50%) translateY(0);
    }

    .toast.error {
      background: #7b2525;
    }

    .modal-layer {
      position: fixed;
      inset: 0;
      display: none;
      place-items: center;
      padding: 18px;
      z-index: 20;
    }

    .modal-layer.open {
      display: grid;
    }

    .modal-backdrop {
      position: absolute;
      inset: 0;
      background: rgba(15, 22, 27, 0.46);
      backdrop-filter: blur(6px);
    }

    .modal {
      position: relative;
      width: min(560px, calc(100vw - 36px));
      max-height: min(76vh, 680px);
      display: grid;
      grid-template-rows: auto minmax(80px, 1fr) auto;
      overflow: hidden;
      background: #fff;
      border: 1px solid rgba(255,255,255,0.75);
      border-radius: 10px;
      box-shadow: 0 24px 80px rgba(16, 24, 30, 0.28), 0 2px 10px rgba(16, 24, 30, 0.12);
    }

    .modal-head {
      display: flex;
      align-items: start;
      justify-content: space-between;
      gap: 14px;
      padding: 16px 16px 12px;
      border-bottom: 1px solid var(--line);
      background: linear-gradient(180deg, #fff, #fbfcfc);
    }

    .modal-title {
      margin: 0;
      font-size: 16px;
      line-height: 1.35;
      letter-spacing: 0;
    }

    .modal-kicker {
      min-height: 16px;
      margin-bottom: 4px;
      color: var(--muted);
      font-size: 11px;
      font-weight: 650;
      text-transform: uppercase;
      letter-spacing: 0;
    }

    .modal-body {
      overflow: auto;
      padding: 14px 16px;
      color: #2f3d44;
      font-size: 13px;
      line-height: 1.5;
    }

    .modal-body p {
      margin: 0 0 10px;
    }

    .modal-body p:last-child {
      margin-bottom: 0;
    }

    .modal-list {
      display: grid;
      gap: 7px;
      margin: 10px 0 0;
    }

    .modal-list-item {
      border: 1px solid var(--line);
      border-radius: 7px;
      padding: 8px 9px;
      background: #fbfcfc;
    }

    .modal-list-title {
      font-weight: 650;
      color: var(--ink);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .modal-note {
      border: 1px solid #f0d49a;
      border-radius: 7px;
      background: #fff8e8;
      color: #7a5212;
      padding: 8px 9px;
      margin-top: 10px;
    }

    .modal-grid {
      display: grid;
      gap: 10px;
    }

    .modal-field {
      display: grid;
      gap: 5px;
    }

    .modal-field label {
      color: #405058;
      font-size: 12px;
      font-weight: 650;
    }

    .modal-field input,
    .modal-field select {
      width: 100%;
      font-size: 13px;
    }

    .modal-field select[multiple] {
      height: auto;
      min-height: 118px;
      padding: 7px;
    }

    .choice-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
      gap: 7px;
    }

    .choice-option {
      display: flex;
      align-items: center;
      gap: 8px;
      min-height: 34px;
      border: 1px solid var(--line);
      border-radius: 6px;
      padding: 7px 9px;
      background: #fff;
      color: #2f3d44;
      cursor: pointer;
    }

    .choice-option:has(input:checked) {
      border-color: var(--accent);
      background: var(--accent-soft);
      color: var(--ink);
    }

    .choice-option input {
      width: 16px;
      height: 16px;
      margin: 0;
      accent-color: var(--accent);
      flex: 0 0 auto;
    }

    .modal-inline {
      display: flex;
      align-items: center;
      gap: 10px;
      flex-wrap: wrap;
    }

    .modal-error {
      display: none;
      color: var(--danger);
      font-size: 12px;
    }

    .modal-error.show {
      display: block;
    }

    .modal-foot {
      display: flex;
      justify-content: flex-end;
      gap: 8px;
      padding: 12px 16px;
      border-top: 1px solid var(--line);
      background: #fbfcfc;
    }

    .busy {
      cursor: wait;
    }

    @media (max-width: 1080px) {
      .workspace {
        grid-template-columns: minmax(230px, var(--sessions-width)) 8px minmax(320px, 1fr);
      }

      .editor {
        grid-column: 1 / -1;
        border-top: 1px solid var(--line);
        min-height: 38vh;
        border-radius: 0 0 8px 8px;
      }

      .editor-resizer {
        display: none;
      }
    }

    @media (max-width: 760px) {
      body {
        overflow: auto;
      }

      .app {
        height: auto;
        min-height: 100vh;
      }

      .topbar {
        grid-template-columns: 1fr;
        height: auto;
        padding: 10px;
      }

      .workspace {
        grid-template-columns: 1fr;
        padding: 8px;
        gap: 8px;
      }

      .resizer {
        display: none;
      }

      .trash-resizer {
        display: none;
      }

      .sessions,
      .records,
      .editor {
        border-right: 0;
        border-bottom: 1px solid var(--line);
        min-height: 360px;
        border-radius: 8px;
      }
    }
  </style>
</head>
<body>
  <div class="app">
    <header class="topbar">
      <div>
        <div class="brand"><span class="brand-mark"></span><span>coldxx</span></div>
        <div class="pathline" id="pathline"></div>
      </div>
      <div class="searchbar">
        <input id="sessionSearch" placeholder="Search sessions" autocomplete="off">
        <button class="icon" id="refreshSessions" title="刷新 sessions" aria-label="刷新 sessions">↻</button>
      </div>
      <div class="top-actions">
        <button class="compact" id="resetLayoutButton" title="恢复默认栏宽和 Trash 高度">重置布局</button>
        <label class="switch"><input type="checkbox" id="allowActive"><span>允许修改活跃 session</span></label>
      </div>
    </header>
    <main class="workspace" id="workspace">
      <aside class="sessions">
        <div class="section-head">
          <div>
            <div class="section-title">Sessions</div>
            <div class="meta" id="sessionCount">-</div>
          </div>
        </div>
        <div class="session-actions">
          <button class="compact" id="selectAllSessionsButton">全选</button>
          <button class="compact" id="clearSessionSelectionButton" disabled>清空</button>
          <button class="danger compact" id="cleanSelectedSessionsButton" disabled>清理选中</button>
        </div>
        <div class="session-list" id="sessionList"></div>
        <div class="trash-resizer" id="trashResizer" role="separator" aria-orientation="horizontal" tabindex="0" title="拖拽调整 Trash 高度"></div>
        <div class="trash-panel">
          <div class="trash-head">
            <div>
              <div class="section-title">Trash</div>
              <div class="meta" id="trashCount">-</div>
            </div>
            <div class="trash-actions">
              <button class="icon compact" id="reloadTrashButton" title="刷新 trash" aria-label="刷新 trash">↻</button>
              <button class="danger compact" id="emptyTrashButton" disabled>清空</button>
            </div>
          </div>
          <div class="trash-list" id="trashList"></div>
        </div>
      </aside>
      <div class="resizer sessions-resizer" data-resizer="sessions" role="separator" aria-orientation="vertical" tabindex="0" title="拖拽调整 session 列宽"></div>
      <section class="records">
        <div class="section-head">
          <div class="record-heading">
            <div class="record-title-row">
              <div class="section-title record-title-main" id="recordTitle">Records</div>
            </div>
            <div class="record-meta-line" id="recordMeta">Select a session</div>
            <div class="record-path-row" id="recordPathRow" hidden>
              <span class="record-path" id="recordPath"></span>
              <button class="icon compact record-copy-path" id="copyRecordPathButton" title="复制完整目录路径" aria-label="复制完整目录路径" disabled>
                <span class="copy-mark" aria-hidden="true"></span>
              </button>
            </div>
          </div>
          <button class="icon" id="reloadRecords" title="重载 records" aria-label="重载 records" disabled>↻</button>
        </div>
        <div class="tools">
          <div class="tool-row record-toolbar">
            <button class="compact" id="openFilterButton" disabled>筛选/查找</button>
            <button class="compact" id="clearRecordFilterButton" disabled>清除筛选</button>
            <span class="toolbar-divider" aria-hidden="true"></span>
            <button class="compact" id="openReplaceButton" disabled>查找替换</button>
            <input id="dropLines" type="text" placeholder="3,5-8" aria-label="删除行范围">
            <button class="danger compact" id="dropLinesButton" disabled>删除行</button>
          </div>
        </div>
        <div class="record-list" id="recordList"></div>
        <div class="history-drawer" id="historyDrawer">
          <button class="history-summary" id="toggleHistoryButton" type="button" aria-expanded="false">
            <span class="history-title">操作历史</span>
            <span class="history-summary-text" id="historySummary">暂无操作</span>
            <span class="history-caret" aria-hidden="true"></span>
          </button>
          <div class="history-body" id="historyBody"></div>
        </div>
      </section>
      <div class="resizer editor-resizer" data-resizer="editor" role="separator" aria-orientation="vertical" tabindex="0" title="拖拽调整编辑器宽度"></div>
      <section class="editor">
        <div class="section-head">
          <div>
            <div class="section-title" id="editorTitle">JSON Editor</div>
            <div class="meta" id="editorMeta">No record selected</div>
          </div>
          <div class="tool-row">
            <label class="switch"><input type="checkbox" id="wrapJsonToggle" checked><span>自动换行</span></label>
            <button class="compact" id="formatJson" disabled>格式化</button>
            <button class="primary compact" id="saveRecord" disabled>保存行</button>
          </div>
        </div>
        <div class="editor-body">
          <div class="status" id="status"></div>
          <div class="json-editor-shell" id="jsonEditorShell">
            <button class="icon compact json-copy-button" id="copyJsonButton" title="复制当前 JSON" aria-label="复制当前 JSON" disabled>
              <span class="copy-mark" aria-hidden="true"></span>
            </button>
            <textarea id="jsonEditor" spellcheck="false" disabled></textarea>
          </div>
          <div class="tool-row">
            <button class="danger compact" id="dropCurrentLine" disabled>删除当前行</button>
          </div>
        </div>
      </section>
    </main>
    <div class="toast" id="toast"></div>
    <div class="modal-layer" id="modalLayer" aria-hidden="true">
      <div class="modal-backdrop" data-modal-cancel></div>
      <section class="modal" role="dialog" aria-modal="true" aria-labelledby="modalTitle">
        <div class="modal-head">
          <div>
            <div class="modal-kicker" id="modalKicker"></div>
            <h2 class="modal-title" id="modalTitle"></h2>
          </div>
          <button class="icon compact" id="modalCloseButton" data-modal-cancel aria-label="关闭">×</button>
        </div>
        <div class="modal-body" id="modalBody"></div>
        <div class="modal-foot">
          <button class="compact" id="modalCancelButton">取消</button>
          <button class="primary compact" id="modalConfirmButton">确认</button>
        </div>
      </section>
    </div>
  </div>

  <script>
    window.__COLDXX_BOOT__ = ${escapeScriptJson(boot)};
  </script>
  <script>
    const boot = JSON.parse(window.__COLDXX_BOOT__);
    const PANE_LAYOUT_KEY = 'coldxx-pane-layout-v1';
    const JSON_WRAP_KEY = 'coldxx-json-wrap-v2';
    const TRASH_HEIGHT_KEY = 'coldxx-trash-height-v1';
    const MAX_WRAPPED_JSON_CHARS = 250000;
    const MAX_JSON_AUTOLOAD_BYTES = 256 * 1024;
    const MAX_JSON_LIVE_VALIDATE_CHARS = 1000000;
    const state = {
      sessions: [],
      selectedSession: null,
      selectedSessionIds: new Set(),
      records: [],
      filteredRecords: [],
      operationHistory: [],
      historyOpen: false,
      recordFilter: { query: '', roles: [], types: [] },
      selectedRecord: null,
      wrapJson: true,
      dirty: false,
      toastTimer: null,
      pending: 0,
      modalResolver: null,
      modalCollect: null,
      lastModalFocus: null,
      trashItems: []
    };

    const els = {
      workspace: document.getElementById('workspace'),
      sessionsPane: document.querySelector('.sessions'),
      editorPane: document.querySelector('.editor'),
      pathline: document.getElementById('pathline'),
      sessionSearch: document.getElementById('sessionSearch'),
      refreshSessions: document.getElementById('refreshSessions'),
      resetLayoutButton: document.getElementById('resetLayoutButton'),
      allowActive: document.getElementById('allowActive'),
      sessionCount: document.getElementById('sessionCount'),
      sessionList: document.getElementById('sessionList'),
      selectAllSessionsButton: document.getElementById('selectAllSessionsButton'),
      clearSessionSelectionButton: document.getElementById('clearSessionSelectionButton'),
      cleanSelectedSessionsButton: document.getElementById('cleanSelectedSessionsButton'),
      trashCount: document.getElementById('trashCount'),
      trashList: document.getElementById('trashList'),
      trashPanel: document.querySelector('.trash-panel'),
      trashResizer: document.getElementById('trashResizer'),
      reloadTrashButton: document.getElementById('reloadTrashButton'),
      emptyTrashButton: document.getElementById('emptyTrashButton'),
      reloadRecords: document.getElementById('reloadRecords'),
      recordTitle: document.getElementById('recordTitle'),
      recordMeta: document.getElementById('recordMeta'),
      recordPathRow: document.getElementById('recordPathRow'),
      recordPath: document.getElementById('recordPath'),
      copyRecordPathButton: document.getElementById('copyRecordPathButton'),
      openFilterButton: document.getElementById('openFilterButton'),
      clearRecordFilterButton: document.getElementById('clearRecordFilterButton'),
      openReplaceButton: document.getElementById('openReplaceButton'),
      dropLines: document.getElementById('dropLines'),
      dropLinesButton: document.getElementById('dropLinesButton'),
      recordList: document.getElementById('recordList'),
      historyDrawer: document.getElementById('historyDrawer'),
      toggleHistoryButton: document.getElementById('toggleHistoryButton'),
      historySummary: document.getElementById('historySummary'),
      historyBody: document.getElementById('historyBody'),
      editorTitle: document.getElementById('editorTitle'),
      editorMeta: document.getElementById('editorMeta'),
      wrapJsonToggle: document.getElementById('wrapJsonToggle'),
      copyJsonButton: document.getElementById('copyJsonButton'),
      formatJson: document.getElementById('formatJson'),
      saveRecord: document.getElementById('saveRecord'),
      jsonEditorShell: document.getElementById('jsonEditorShell'),
      jsonEditor: document.getElementById('jsonEditor'),
      dropCurrentLine: document.getElementById('dropCurrentLine'),
      status: document.getElementById('status'),
      toast: document.getElementById('toast'),
      modalLayer: document.getElementById('modalLayer'),
      modalKicker: document.getElementById('modalKicker'),
      modalTitle: document.getElementById('modalTitle'),
      modalBody: document.getElementById('modalBody'),
      modalCancelButton: document.getElementById('modalCancelButton'),
      modalConfirmButton: document.getElementById('modalConfirmButton'),
      modalCloseButton: document.getElementById('modalCloseButton'),
      resizers: Array.from(document.querySelectorAll('[data-resizer]'))
    };

    els.pathline.textContent = boot.codexHome;

    function api(path, options = {}) {
      state.pending += 1;
      document.body.classList.add('busy');
      return fetch(path, {
        ...options,
        headers: {
          'content-type': 'application/json',
          'x-coldxx-token': boot.token,
          ...(options.headers || {})
        }
      }).then(async (response) => {
        const body = await response.json().catch(() => ({}));
        if (!response.ok) {
          throw new Error(body.error || response.statusText);
        }
        return body;
      }).finally(() => {
        state.pending = Math.max(0, state.pending - 1);
        if (state.pending === 0) {
          document.body.classList.remove('busy');
        }
      });
    }

    function sessionApiPath(session, suffix = '') {
      return '/api/sessions/' + encodeURIComponent(session.id) + suffix;
    }

    async function loadSessions() {
      setStatus('Loading sessions...');
      const query = els.sessionSearch.value.trim();
      const data = await api('/api/sessions?limit=300&query=' + encodeURIComponent(query));
      state.sessions = data.sessions;
      pruneSelectedSessions();
      els.sessionCount.textContent = data.total + ' found';
      renderSessions();
      updateSessionSelectionControls();
      setStatus('');
      if (!state.selectedSession && state.sessions[0]) {
        await selectSession(state.sessions[0].id);
      }
    }

    function renderSessions() {
      if (state.sessions.length === 0) {
        els.sessionList.innerHTML = '<div class="empty">No sessions</div>';
        return;
      }

      els.sessionList.innerHTML = state.sessions.map((session) => {
        const activeClass = state.selectedSession && state.selectedSession.id === session.id ? ' active' : '';
        const activePill = session.active ? '<span class="pill active">active</span>' : '<span class="pill ok">idle</span>';
        const checked = state.selectedSessionIds.has(session.id) ? ' checked' : '';
        const sessionPath = session.cwd || session.relativePath || '';
        const sessionName = lastPathSegment(session.cwd || session.relativePath || session.file) || session.shortId;
        return '<div class="session-item' + activeClass + '" data-id="' + escapeAttr(session.id) + '" role="button" tabindex="0">' +
          '<input class="session-check" type="checkbox" data-check="' + escapeAttr(session.id) + '"' + checked + ' aria-label="选择 session">' +
          '<span class="session-main">' +
          '<span class="session-title" title="' + escapeAttr(sessionPath || session.file) + '">' + escapeHtml(sessionName) + '</span>' +
          '<span class="session-preview" title="' + escapeAttr(session.preview || session.file) + '">' + escapeHtml(session.preview || session.file) + '</span>' +
          '<span class="session-stats"><span class="pill">' + escapeHtml(session.size) + '</span><span class="pill">' + escapeHtml(String(session.lines || 0)) + ' lines</span></span>' +
          '</span>' +
          '<span class="session-side">' +
          activePill +
          '</span>' +
          '</div>';
      }).join('');
    }

    async function selectSession(id) {
      if (state.dirty && !(await confirmUnsavedChange())) {
        return;
      }
      const session = state.sessions.find((item) => item.id === id);
      if (!session) {
        return;
      }
      state.selectedSession = session;
      state.selectedRecord = null;
      state.historyOpen = false;
      state.dirty = false;
      renderSessions();
      await loadRecords();
    }

    async function loadRecords() {
      if (!state.selectedSession) {
        return;
      }
      setStatus('Loading records...');
      const data = await api(sessionApiPath(state.selectedSession, '/records'));
      state.selectedSession = data.session;
      state.records = data.records;
      state.filteredRecords = data.records;
      state.selectedRecord = null;
      state.dirty = false;
      els.reloadRecords.disabled = false;
      els.dropLinesButton.disabled = false;
      els.openFilterButton.disabled = false;
      els.openReplaceButton.disabled = false;
      updateRecordHeader(data.records.length);
      clearEditor();
      filterRecords();
      renderSessions();
      await loadOperationHistory();
      setStatus('');
    }

    function filterRecords() {
      const needle = state.recordFilter.query.trim().toLowerCase();
      const roles = Array.isArray(state.recordFilter.roles) ? state.recordFilter.roles : [];
      const types = Array.isArray(state.recordFilter.types) ? state.recordFilter.types : [];
      state.filteredRecords = state.records.filter((record) => {
        if (roles.length > 0 && !roles.includes(record.role || '')) {
          return false;
        }
        if (types.length > 0 && !types.includes(record.type || '')) {
          return false;
        }
        if (!needle) {
          return true;
        }
        return [record.line, record.type, record.payloadType, record.role, record.text, record.timestamp, record.json]
          .join(' ')
          .toLowerCase()
          .includes(needle);
      });
      els.clearRecordFilterButton.disabled = !hasRecordFilter();
      els.openFilterButton.textContent = hasRecordFilter() ? '筛选中' : '筛选/查找';
      if (state.selectedSession) {
        const filtered = state.filteredRecords.length;
        const total = state.records.length;
        updateRecordHeader(filtered === total ? total : filtered + ' / ' + total);
      }
      renderRecords();
    }

    function updateRecordHeader(recordCount) {
      if (!state.selectedSession) {
        els.recordTitle.textContent = 'Records';
        els.recordMeta.textContent = 'Select a session';
        els.recordPath.textContent = '';
        els.recordPathRow.hidden = true;
        els.copyRecordPathButton.disabled = true;
        delete els.copyRecordPathButton.dataset.copyPath;
        els.recordTitle.removeAttribute('title');
        els.recordMeta.removeAttribute('title');
        els.recordPath.removeAttribute('title');
        return;
      }

      const sessionName = lastPathSegment(state.selectedSession.cwd || state.selectedSession.relativePath || state.selectedSession.file) || state.selectedSession.shortId;
      const started = formatDate(state.selectedSession.startedAt);
      const cwd = state.selectedSession.cwd || '-';
      const fileName = lastPathSegment(state.selectedSession.file);
      const shortId = state.selectedSession.shortId || '';
      const size = state.selectedSession.size || '';
      const countLabel = typeof recordCount === 'number' ? recordCount + ' records' : recordCount + ' records';
      const model = state.selectedSession.model || 'unknown model';
      const copyPath = state.selectedSession.cwd || state.selectedSession.file || '';
      const copyTitle = state.selectedSession.cwd ? '复制完整目录路径' : '复制 session 文件路径';
      els.recordTitle.textContent = sessionName;
      els.recordTitle.title = state.selectedSession.id || '';
      els.recordMeta.textContent = [countLabel, model, size, started, shortId].filter(Boolean).join(' · ');
      els.recordMeta.title = [
        'records: ' + countLabel,
        'model: ' + model,
        'size: ' + (size || '-'),
        'started: ' + started,
        'session id: ' + (state.selectedSession.id || ''),
        'cwd: ' + cwd,
        'file: ' + state.selectedSession.file
      ].join('\\n');
      els.recordPathRow.hidden = false;
      els.recordPath.textContent = 'cwd: ' + compactPath(cwd) + ' · file: ' + fileName;
      els.recordPath.title = [
        'cwd: ' + cwd,
        'file: ' + state.selectedSession.file
      ].join('\\n');
      els.copyRecordPathButton.disabled = !copyPath;
      els.copyRecordPathButton.dataset.copyPath = copyPath;
      els.copyRecordPathButton.title = copyTitle;
      els.copyRecordPathButton.setAttribute('aria-label', copyTitle);
    }

    function renderRecords() {
      if (!state.selectedSession) {
        els.recordList.innerHTML = '<div class="empty">Select a session</div>';
        return;
      }
      if (state.filteredRecords.length === 0) {
        els.recordList.innerHTML = '<div class="empty">No records</div>';
        return;
      }

      const rows = state.filteredRecords.map((record) => {
        const selected = state.selectedRecord && state.selectedRecord.line === record.line ? ' class="selected"' : '';
        const kind = record.payloadType ? record.type + ':' + record.payloadType : record.type;
        return '<tr data-line="' + record.line + '"' + selected + '>' +
          '<td class="line-col">' + record.line + '</td>' +
          '<td class="type-col clip"><span class="record-kind">' + escapeHtml(kind) + '</span></td>' +
          '<td class="role-col clip"><span class="role-badge">' + escapeHtml(record.role || '-') + '</span></td>' +
          '<td class="clip">' + escapeHtml(record.text || '') + '</td>' +
          '</tr>';
      }).join('');
      els.recordList.innerHTML =
        '<table><thead><tr>' +
        recordHeader('line-col', 'Line', 'line') +
        recordHeader('type-col', 'Type', 'type') +
        recordHeader('role-col', 'Role', 'role') +
        '<th class="text-col">Text</th>' +
        '</tr></thead><tbody>' + rows + '</tbody></table>';
      setupColumnResizers();
    }

    async function loadOperationHistory() {
      if (!state.selectedSession) {
        state.operationHistory = [];
        renderOperationHistory();
        return;
      }
      const data = await api(sessionApiPath(state.selectedSession, '/history'));
      state.operationHistory = data.items || [];
      renderOperationHistory();
    }

    function renderOperationHistory() {
      const count = state.operationHistory.length;
      els.historyDrawer.classList.toggle('open', state.historyOpen);
      els.toggleHistoryButton.disabled = !state.selectedSession;
      els.toggleHistoryButton.setAttribute('aria-expanded', state.historyOpen ? 'true' : 'false');

      if (!state.selectedSession) {
        els.historySummary.textContent = 'Select a session';
        els.historyBody.innerHTML = '';
        return;
      }

      if (count === 0) {
        els.historySummary.textContent = '暂无可回滚操作';
        els.historyBody.innerHTML = '<div class="empty">暂无操作历史</div>';
        return;
      }

      const latest = state.operationHistory[0];
      els.historySummary.textContent = count + ' 条 · 最近 ' + formatDate(latest.createdAt) + ' · ' + (latest.reason || latest.id);
      els.historyBody.innerHTML = state.operationHistory.map((item) => {
        const disabled = item.available ? '' : ' disabled';
        return '<div class="history-item">' +
          '<div>' +
          '<div class="history-item-title" title="' + escapeAttr(item.reason || item.id) + '">' + escapeHtml(item.reason || item.id) + '</div>' +
          '<div class="meta" title="' + escapeAttr(item.backupPath || '') + '">' +
          escapeHtml(formatDate(item.createdAt)) + ' · ' + escapeHtml(item.size || '-') +
          '</div>' +
          '</div>' +
          '<button class="compact" data-rollback-backup="' + escapeAttr(item.id) + '"' + disabled + '>回滚</button>' +
          '</div>';
      }).join('');
    }

    async function rollbackBackup(id) {
      const item = state.operationHistory.find((backup) => backup.id === id);
      if (!state.selectedSession || !item || !item.available) {
        return;
      }
      if (!(await confirmRollbackBackup(item))) {
        return;
      }

      setStatus('Rolling back session...');
      const result = await api(sessionApiPath(state.selectedSession, '/history/' + encodeURIComponent(id) + '/restore'), {
        method: 'POST',
        body: JSON.stringify({ allowActive: els.allowActive.checked })
      });
      state.dirty = false;
      setStatus('Rolled back to ' + id + '. Backup: ' + (result.backup ? result.backup.backupPath : '-'), 'ok', true);
      await loadRecords();
      await loadSessions();
    }

    function recordHeader(className, label, key) {
      return '<th class="' + className + ' resizable-th">' +
        escapeHtml(label) +
        '<span class="column-handle" data-column="' + escapeAttr(key) + '" role="separator" aria-orientation="vertical" tabindex="0"></span>' +
        '</th>';
    }

    async function selectRecord(line) {
      if (state.dirty && !(await confirmUnsavedChange())) {
        return;
      }
      const record = state.records.find((item) => item.line === line);
      if (!record) {
        return;
      }
      state.selectedRecord = record;
      state.dirty = false;
      renderRecords();
      prepareEditorForRecord(record);
      if (record.json) {
        openRecordInEditor(record);
        return;
      }
      const loaded = await loadRecordJson(record.line, { confirmLarge: (record.bytes || 0) > MAX_JSON_AUTOLOAD_BYTES });
      if (!loaded) {
        showDeferredRecordPlaceholder(record);
      }
    }

    function prepareEditorForRecord(record) {
      els.editorTitle.textContent = 'Line ' + record.line;
      els.editorMeta.textContent =
        [record.type, record.payloadType, record.role, formatBytesClient(record.bytes)].filter(Boolean).join(' · ') ||
        'record';
      els.dropCurrentLine.disabled = false;
      els.dropLines.value = String(record.line);
      els.jsonEditor.value = record.json || '';
      els.jsonEditor.disabled = true;
      els.copyJsonButton.disabled = true;
      els.formatJson.disabled = true;
      els.saveRecord.disabled = true;
      updateJsonEditorMode();
    }

    function showDeferredRecordPlaceholder(record) {
      els.jsonEditor.value =
        '这个 record 约 ' +
        formatBytesClient(record.bytes) +
        '。\\n为避免大文本卡顿，未自动加载完整 JSON。\\n再次点击这一行可以重新选择加载。';
      els.jsonEditor.disabled = true;
      els.copyJsonButton.disabled = true;
      els.formatJson.disabled = true;
      els.saveRecord.disabled = true;
      updateJsonEditorMode();
      setStatus('Record 较大，已跳过自动加载', 'ok');
    }

    async function loadRecordJson(line, options = {}) {
      if (!state.selectedSession) {
        return;
      }
      const record = state.records.find((item) => item.line === line);
      if (!record) {
        return;
      }
      if (options.confirmLarge && (record.bytes || 0) > MAX_JSON_AUTOLOAD_BYTES && !(await confirmLoadLargeJson(record))) {
        return false;
      }
      setStatus('Loading JSON...');
      const data = await api(sessionApiPath(state.selectedSession, '/records/' + line));
      const nextRecord = { ...record, ...data.record };
      const index = state.records.findIndex((item) => item.line === line);
      if (index !== -1) {
        state.records[index] = nextRecord;
      }
      const filteredIndex = state.filteredRecords.findIndex((item) => item.line === line);
      if (filteredIndex !== -1) {
        state.filteredRecords[filteredIndex] = nextRecord;
      }
      if (!state.selectedRecord || state.selectedRecord.line !== line) {
        return false;
      }
      state.selectedRecord = nextRecord;
      openRecordInEditor(nextRecord);
      return true;
    }

    function openRecordInEditor(record) {
      const value = record.json || '';
      els.jsonEditor.value = value;
      els.jsonEditor.disabled = false;
      updateJsonEditorMode();
      els.copyJsonButton.disabled = false;
      els.formatJson.disabled = false;
      els.saveRecord.disabled = false;
      els.dropCurrentLine.disabled = false;
      els.dropLines.value = String(record.line);
      setStatus(value.length > MAX_WRAPPED_JSON_CHARS ? 'Record 已加载，JSON 较大，已暂停自动换行' : 'Valid JSON', 'ok');
    }

    function clearEditor() {
      state.selectedRecord = null;
      els.editorTitle.textContent = 'JSON Editor';
      els.editorMeta.textContent = 'No record selected';
      els.jsonEditor.value = '';
      updateJsonEditorMode();
      els.jsonEditor.disabled = true;
      els.copyJsonButton.disabled = true;
      els.formatJson.disabled = true;
      els.saveRecord.disabled = true;
      els.dropCurrentLine.disabled = true;
    }

    function validateEditor() {
      if (!state.selectedRecord) {
        els.saveRecord.disabled = true;
        updateJsonEditorMode();
        setStatus('');
        return false;
      }
      updateJsonEditorMode();
      if (els.jsonEditor.value.length > MAX_JSON_LIVE_VALIDATE_CHARS) {
        els.saveRecord.disabled = false;
        setStatus('JSON 较大，保存时校验', 'ok');
        return true;
      }
      try {
        JSON.parse(els.jsonEditor.value);
        els.saveRecord.disabled = false;
        setStatus('Valid JSON', 'ok');
        return true;
      } catch (error) {
        els.saveRecord.disabled = true;
        setStatus(error.message, 'error');
        return false;
      }
    }

    async function saveCurrentRecord() {
      if (!state.selectedSession || !state.selectedRecord || !validateEditor()) {
        return;
      }
      const line = state.selectedRecord.line;
      setStatus('Saving line ' + line + '...');
      const result = await api(sessionApiPath(state.selectedSession, '/records/' + line), {
        method: 'PUT',
        body: JSON.stringify({
          json: els.jsonEditor.value,
          allowActive: els.allowActive.checked
        })
      });
      state.dirty = false;
      setStatus('Saved. Backup: ' + (result.backup ? result.backup.backupPath : '-'), 'ok', true);
      await loadRecords();
      const next = state.records.find((record) => record.line === line);
      if (next) {
        await selectRecord(line);
      }
    }

    async function dropLines(lines) {
      if (!state.selectedSession || !lines.trim()) {
        return;
      }
      if (!(await confirmDropLines(lines))) {
        return;
      }
      setStatus('Deleting lines...');
      const result = await api(sessionApiPath(state.selectedSession, '/drop'), {
        method: 'POST',
        body: JSON.stringify({
          lines,
          allowActive: els.allowActive.checked
        })
      });
      setStatus('Deleted ' + result.removedLines.length + ' line(s). Backup: ' + (result.backup ? result.backup.backupPath : '-'), 'ok', true);
      await loadRecords();
    }

    async function replaceText(options) {
      if (!state.selectedSession || !options || !options.from) {
        return;
      }
      setStatus('Replacing...');
      const result = await api(sessionApiPath(state.selectedSession, '/replace'), {
        method: 'POST',
        body: JSON.stringify({
          from: options.from,
          to: options.to,
          scope: options.scope,
          regex: options.regex,
          allowActive: els.allowActive.checked
        })
      });
      setStatus('Replaced ' + result.replacements + ' occurrence(s). Backup: ' + (result.backup ? result.backup.backupPath : '-'), 'ok', true);
      await loadRecords();
    }

    async function openFilterModal() {
      if (!state.selectedSession) {
        return;
      }
      const result = await openModal({
        kicker: 'Filter records',
        title: '筛选 / 查找 records',
        body: filterModalBody(),
        confirmText: '应用筛选',
        cancelText: '取消',
        collect: () => ({
          query: document.getElementById('modalFilterQuery').value.trim(),
          roles: checkedValues('[data-filter-role]'),
          types: checkedValues('[data-filter-type]'),
        }),
      });
      if (!result) {
        return;
      }
      state.recordFilter = result;
      filterRecords();
    }

    async function openReplaceModal() {
      if (!state.selectedSession) {
        return;
      }
      const result = await openModal({
        kicker: 'Find and replace',
        title: '查找替换',
        body: replaceModalBody(),
        confirmText: '执行替换',
        cancelText: '取消',
        variant: 'danger',
        collect: () => {
          const from = document.getElementById('modalReplaceFrom').value;
          const error = document.getElementById('modalReplaceError');
          if (!from) {
            error.classList.add('show');
            document.getElementById('modalReplaceFrom').focus();
            return false;
          }
          return {
            from,
            to: document.getElementById('modalReplaceTo').value,
            scope: document.getElementById('modalReplaceScope').value,
            regex: document.getElementById('modalReplaceRegex').checked,
          };
        },
      });
      if (result) {
        await replaceText(result);
      }
    }

    function clearRecordFilter() {
      state.recordFilter = { query: '', roles: [], types: [] };
      filterRecords();
    }

    function hasRecordFilter() {
      return Boolean(
        state.recordFilter.query ||
        (Array.isArray(state.recordFilter.roles) && state.recordFilter.roles.length > 0) ||
        (Array.isArray(state.recordFilter.types) && state.recordFilter.types.length > 0)
      );
    }

    async function cleanSelectedSessions() {
      const ids = selectedSessionIds();
      if (ids.length === 0) {
        return;
      }
      if (!(await confirmCleanSessions(ids))) {
        return;
      }
      setStatus('Cleaning selected sessions...');
      const result = await api('/api/sessions/clean', {
        method: 'POST',
        body: JSON.stringify({
          ids,
          allowActive: els.allowActive.checked,
          permanent: false
        })
      });
      const cleaned = new Set(result.results.map((item) => item.id));
      if (state.selectedSession && cleaned.has(state.selectedSession.id)) {
        state.selectedSession = null;
      }
      state.selectedSessionIds.clear();
      state.records = [];
      state.filteredRecords = [];
      state.operationHistory = [];
      state.selectedRecord = null;
      state.dirty = false;
      renderOperationHistory();
      clearEditor();
      els.reloadRecords.disabled = true;
      els.dropLinesButton.disabled = true;
      els.openFilterButton.disabled = true;
      els.openReplaceButton.disabled = true;
      els.clearRecordFilterButton.disabled = true;
      els.recordTitle.textContent = 'Records';
      els.recordMeta.textContent = 'Select a session';
      els.recordPath.textContent = '';
      els.recordPathRow.hidden = true;
      els.copyRecordPathButton.disabled = true;
      delete els.copyRecordPathButton.dataset.copyPath;
      els.recordList.innerHTML = '<div class="empty">Select a session</div>';
      setStatus('Moved ' + result.count + ' session(s) to trash: ' + result.batchId, 'ok', true);
      await loadSessions();
      await loadTrash();
    }

    async function loadTrash() {
      const data = await api('/api/trash');
      renderTrash(data.items || []);
    }

    function renderTrash(items) {
      els.trashCount.textContent = items.length === 0 ? 'empty' : items.length + ' batch(es)';
      els.emptyTrashButton.disabled = items.length === 0;
      if (items.length === 0) {
        els.trashList.innerHTML = '<div class="empty">Trash is empty</div>';
        return;
      }

      els.trashList.innerHTML = items.map((item) => {
        return '<div class="trash-item">' +
          '<div>' +
          '<div class="trash-title">' + escapeHtml(item.id) + '</div>' +
          '<div class="meta">' + escapeHtml(formatDate(item.cleanedAt)) + ' · ' + escapeHtml(String(item.count || 0)) + ' session(s)</div>' +
          '</div>' +
          '<div class="trash-actions">' +
          '<button class="compact" data-view-trash="' + escapeAttr(item.id) + '">查看</button>' +
          '<button class="compact" data-restore-trash="' + escapeAttr(item.id) + '">恢复</button>' +
          '</div>' +
          '</div>';
      }).join('');
      state.trashItems = items;
    }

    async function restoreTrash(id) {
      if (!(await confirmRestoreTrash(id))) {
        return;
      }
      await restoreTrashBatchFromUi(id);
    }

    async function restoreTrashBatchFromUi(id) {
      setStatus('Restoring trash...');
      const result = await api('/api/trash/' + encodeURIComponent(id) + '/restore', {
        method: 'POST',
        body: JSON.stringify({ overwrite: false })
      });
      setStatus('Restored ' + result.count + ' session(s).', 'ok', true);
      await loadSessions();
      await loadTrash();
    }

    async function viewTrash(id) {
      const item = state.trashItems.find((trashItem) => trashItem.id === id);
      if (!item) {
        return;
      }
      const shouldRestore = await openModal({
        kicker: 'Trash batch',
        title: item.id,
        body: trashBatchBody(item),
        confirmText: '恢复 batch',
        cancelText: '关闭',
      });
      if (shouldRestore) {
        await restoreTrashBatchFromUi(id);
      }
    }

    async function emptyTrashFromUi() {
      if (!(await confirmEmptyTrash())) {
        return;
      }
      setStatus('Emptying trash...');
      const result = await api('/api/trash/empty', { method: 'POST', body: '{}' });
      setStatus('Removed ' + result.count + ' trash batch(es).', 'ok', true);
      await loadTrash();
    }

    function setStatus(message, kind = '', toast = false) {
      els.status.textContent = message || '';
      els.status.className = 'status' + (kind ? ' ' + kind : '');
      if (toast && message && (kind === 'ok' || kind === 'error')) {
        showToast(message, kind);
      }
    }

    function handleError(error) {
      setStatus(error.message || String(error), 'error', true);
    }

    function showToast(message, kind = '') {
      clearTimeout(state.toastTimer);
      els.toast.textContent = message;
      els.toast.className = 'toast show' + (kind === 'error' ? ' error' : '');
      state.toastTimer = setTimeout(() => {
        els.toast.className = 'toast';
      }, kind === 'error' ? 5200 : 3200);
    }

    async function copyText(value, label = '已复制') {
      if (!value) {
        showToast('没有可复制的路径', 'error');
        return;
      }
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          await navigator.clipboard.writeText(value);
        } else {
          const input = document.createElement('textarea');
          input.value = value;
          input.setAttribute('readonly', '');
          input.style.position = 'fixed';
          input.style.opacity = '0';
          document.body.appendChild(input);
          input.select();
          document.execCommand('copy');
          document.body.removeChild(input);
        }
        showToast(label, 'ok');
      } catch (error) {
        showToast('复制失败: ' + (error.message || String(error)), 'error');
      }
    }

    function openModal(options) {
      if (state.modalResolver) {
        closeModal(false);
      }

      state.lastModalFocus = document.activeElement;
      els.modalKicker.textContent = options.kicker || '';
      els.modalTitle.textContent = options.title || '';
      els.modalBody.innerHTML = options.body || '';
      els.modalCancelButton.textContent = options.cancelText || '取消';
      els.modalConfirmButton.textContent = options.confirmText || '确认';
      els.modalConfirmButton.className = (options.variant === 'danger' ? 'danger' : 'primary') + ' compact';
      state.modalCollect = options.collect || null;
      els.modalLayer.classList.add('open');
      els.modalLayer.setAttribute('aria-hidden', 'false');
      setTimeout(() => els.modalConfirmButton.focus(), 0);

      return new Promise((resolve) => {
        state.modalResolver = resolve;
      });
    }

    function closeModal(result) {
      if (!state.modalResolver) {
        return;
      }
      const resolve = state.modalResolver;
      state.modalResolver = null;
      state.modalCollect = null;
      els.modalLayer.classList.remove('open');
      els.modalLayer.setAttribute('aria-hidden', 'true');
      els.modalBody.innerHTML = '';
      resolve(result);
      if (state.lastModalFocus && typeof state.lastModalFocus.focus === 'function') {
        state.lastModalFocus.focus();
      }
    }

    function confirmModal() {
      if (!state.modalResolver) {
        return;
      }
      if (state.modalCollect) {
        const value = state.modalCollect();
        if (value === false) {
          return;
        }
        closeModal(value);
        return;
      }
      closeModal(true);
    }

    function confirmUnsavedChange() {
      return openModal({
        kicker: 'Unsaved JSON',
        title: '丢弃未保存的修改？',
        body: '<p>当前 record 的 JSON 还没有保存。继续切换会丢弃编辑器里的修改。</p>',
        confirmText: '继续切换',
        cancelText: '留在这里',
        variant: 'danger'
      });
    }

    function confirmLoadLargeJson(record) {
      return openModal({
        kicker: 'Large JSON',
        title: '加载这个大 record？',
        body: '<p>这个 record 约 ' + escapeHtml(formatBytesClient(record.bytes)) + '。打开超大文本可能需要一些时间。</p>',
        confirmText: '打开',
      });
    }

    function confirmDropLines(lines) {
      return openModal({
        kicker: 'Drop records',
        title: '删除 JSONL 行？',
        body: '<p>将从当前 session 中删除以下行范围，并在写入前自动创建备份。</p>' +
          '<div class="modal-note">' + escapeHtml(lines) + '</div>',
        confirmText: '删除行',
        variant: 'danger'
      });
    }

    function confirmCleanSessions(ids) {
      const sessions = ids.map((id) => state.sessions.find((session) => session.id === id)).filter(Boolean);
      const active = sessions.filter((session) => session.active).length;
      const list = sessions.slice(0, 8).map((session) => {
        return '<div class="modal-list-item">' +
          '<div class="modal-list-title">' + escapeHtml(formatDate(session.startedAt)) + ' · ' + escapeHtml(session.shortId) + '</div>' +
          '<div class="meta">' + escapeHtml(compactPath(session.cwd || session.file)) + '</div>' +
          '</div>';
      }).join('');
      return openModal({
        kicker: 'Move to trash',
        title: '清理选中的 ' + ids.length + ' 个 session？',
        body: '<p>这些 session 会被移动到 trash，后续可以从 Trash 面板恢复。</p>' +
          (active ? '<div class="modal-note">' + active + ' 个 session 仍被标记为 active；如需继续，请先确认顶部的活跃 session 开关。</div>' : '') +
          '<div class="modal-list">' + list + (sessions.length > 8 ? '<div class="meta">还有 ' + (sessions.length - 8) + ' 个未展示。</div>' : '') + '</div>',
        confirmText: '移入 trash',
        variant: 'danger'
      });
    }

    function confirmRestoreTrash(id) {
      return openModal({
        kicker: 'Restore trash',
        title: '恢复这个 trash batch？',
        body: '<p>恢复会把 batch 中的 session 文件移动回原始路径。如果目标路径已存在，本次恢复会被拒绝。</p>' +
          '<div class="modal-note">' + escapeHtml(id) + '</div>',
        confirmText: '恢复',
        variant: 'primary'
      });
    }

    function confirmRollbackBackup(item) {
      return openModal({
        kicker: 'Rollback session',
        title: '回滚到这次操作前？',
        body: '<p>当前 session 文件会被替换为这份备份。回滚前会先为当前状态再创建一份新备份，方便继续撤回。</p>' +
          '<div class="modal-list">' +
          '<div class="modal-list-item">' +
          '<div class="modal-list-title">' + escapeHtml(item.reason || item.id) + '</div>' +
          '<div class="meta">' + escapeHtml(formatDate(item.createdAt)) + ' · ' + escapeHtml(item.size || '-') + '</div>' +
          '<div class="meta">' + escapeHtml(compactPath(item.backupPath || '')) + '</div>' +
          '</div>' +
          '</div>',
        confirmText: '回滚',
        variant: 'danger'
      });
    }

    function confirmEmptyTrash() {
      return openModal({
        kicker: 'Empty trash',
        title: '清空 trash？',
        body: '<p>这会删除所有 trash batch。已清空的 session 无法通过本工具恢复。</p>',
        confirmText: '清空 trash',
        variant: 'danger'
      });
    }

    function trashBatchBody(item) {
      const sessions = item.manifest && Array.isArray(item.manifest.sessions) ? item.manifest.sessions : [];
      const rows = sessions.map((session) => {
        return '<div class="modal-list-item">' +
          '<div class="modal-list-title">' + escapeHtml(session.id || '-') + '</div>' +
          '<div class="meta">Original: ' + escapeHtml(compactPath(session.originalPath || '')) + '</div>' +
          '<div class="meta">Trash: ' + escapeHtml(compactPath(session.targetPath || '')) + '</div>' +
          '</div>';
      }).join('');
      return '<p>Cleaned at: ' + escapeHtml(formatDate(item.cleanedAt)) + '</p>' +
        '<p>Sessions: ' + escapeHtml(String(item.count || sessions.length || 0)) + '</p>' +
        '<div class="modal-list">' + (rows || '<div class="empty">No manifest sessions</div>') + '</div>';
    }

    function filterModalBody() {
      const roles = Array.isArray(state.recordFilter.roles) ? state.recordFilter.roles : [];
      const types = Array.isArray(state.recordFilter.types) ? state.recordFilter.types : [];
      return '<div class="modal-grid">' +
        '<div class="modal-field">' +
        '<label for="modalFilterQuery">查找文本</label>' +
        '<input id="modalFilterQuery" value="' + escapeAttr(state.recordFilter.query) + '" placeholder="搜索完整 JSON / 预览 / 类型 / 时间">' +
        '</div>' +
        '<div class="modal-field">' +
        '<label>Role 多选</label>' +
        '<div class="choice-grid">' +
        checkboxHtml('user', 'user', 'data-filter-role', roles) +
        checkboxHtml('assistant', 'assistant', 'data-filter-role', roles) +
        checkboxHtml('system', 'system', 'data-filter-role', roles) +
        checkboxHtml('tool', 'tool', 'data-filter-role', roles) +
        checkboxHtml('', 'no role', 'data-filter-role', roles) +
        '</div>' +
        '</div>' +
        '<div class="modal-field">' +
        '<label>Record type 多选</label>' +
        '<div class="choice-grid">' +
        recordTypeChoices() +
        '</div>' +
        '</div>' +
        '<div class="modal-note">Role 或 type 不选表示全部；多选会取并集后再和查找文本组合过滤。</div>' +
        '</div>';
    }

    function replaceModalBody() {
      return '<div class="modal-grid">' +
        '<div class="modal-field">' +
        '<label for="modalReplaceScope">替换范围</label>' +
        '<select id="modalReplaceScope">' +
        optionHtml('messages', 'messages', 'messages') +
        optionHtml('user', 'user', 'messages') +
        optionHtml('assistant', 'assistant', 'messages') +
        optionHtml('system', 'system', 'messages') +
        optionHtml('tool', 'tool', 'messages') +
        optionHtml('metadata', 'metadata', 'messages') +
        optionHtml('all', 'all', 'messages') +
        '</select>' +
        '</div>' +
        '<div class="modal-field">' +
        '<label for="modalReplaceFrom">查找</label>' +
        '<input id="modalReplaceFrom" placeholder="Find">' +
        '<div class="modal-error" id="modalReplaceError">请输入要查找的文本。</div>' +
        '</div>' +
        '<div class="modal-field">' +
        '<label for="modalReplaceTo">替换为</label>' +
        '<input id="modalReplaceTo" placeholder="Replace">' +
        '</div>' +
        '<label class="switch"><input type="checkbox" id="modalReplaceRegex"><span>regex</span></label>' +
        '<div class="modal-note">替换会在写入前自动创建备份。Role 筛选请使用“筛选/查找”。</div>' +
        '</div>';
    }

    function recordTypeChoices() {
      const types = Array.isArray(state.recordFilter.types) ? state.recordFilter.types : [];
      return Array.from(new Set(state.records.map((record) => record.type).filter(Boolean)))
        .sort()
        .map((type) => checkboxHtml(type, type, 'data-filter-type', types))
        .join('');
    }

    function checkboxHtml(value, label, attribute, selectedValues) {
      const checked = Array.isArray(selectedValues) && selectedValues.includes(value);
      return '<label class="choice-option">' +
        '<input type="checkbox" ' + attribute + ' value="' + escapeAttr(value) + '"' + (checked ? ' checked' : '') + '>' +
        '<span>' + escapeHtml(label) + '</span>' +
        '</label>';
    }

    function optionHtml(value, label, selectedValue) {
      const selected = Array.isArray(selectedValue) ? selectedValue.includes(value) : value === selectedValue;
      return '<option value="' + escapeAttr(value) + '"' + (selected ? ' selected' : '') + '>' +
        escapeHtml(label) +
        '</option>';
    }

    function checkedValues(selector) {
      return Array.from(document.querySelectorAll(selector + ':checked')).map((input) => input.value);
    }

    function updateJsonEditorMode() {
      els.jsonEditorShell.classList.toggle('large-json', (els.jsonEditor.value || '').length > MAX_WRAPPED_JSON_CHARS);
    }

    function restoreJsonWrap() {
      try {
        const saved = localStorage.getItem(JSON_WRAP_KEY);
        state.wrapJson = saved === null ? true : saved === 'true';
      } catch {
        state.wrapJson = true;
      }
      els.wrapJsonToggle.disabled = false;
      els.wrapJsonToggle.checked = state.wrapJson;
      applyJsonWrap();
    }

    function setJsonWrap(enabled) {
      state.wrapJson = Boolean(enabled);
      try {
        localStorage.setItem(JSON_WRAP_KEY, String(state.wrapJson));
      } catch {
        // Ignore storage failures; wrapping is still applied for the current page.
      }
      applyJsonWrap();
    }

    function applyJsonWrap() {
      els.jsonEditorShell.classList.toggle('wrap-lines', state.wrapJson);
      updateJsonEditorMode();
    }

    function formatDate(value) {
      return String(value || '').replace('T', ' ').replace(/\\.\\d{3}Z$/, 'Z').slice(0, 19);
    }

    function formatBytesClient(bytes) {
      if (!Number.isFinite(bytes) || bytes <= 0) {
        return '';
      }
      const units = ['B', 'KB', 'MB', 'GB'];
      let value = bytes;
      let unitIndex = 0;
      while (value >= 1024 && unitIndex < units.length - 1) {
        value /= 1024;
        unitIndex += 1;
      }
      return (unitIndex === 0 ? String(value) : value.toFixed(value >= 10 ? 1 : 2)) + ' ' + units[unitIndex];
    }

    function compactPath(value) {
      if (!value) return '-';
      const home = value.startsWith('/Users/') ? value.replace(/^\\/Users\\/[^/]+/, '~') : value;
      return home.length > 46 ? '...' + home.slice(-43) : home;
    }

    function lastPathSegment(value) {
      const text = String(value || '').replace(/\\/+$/, '');
      if (!text) return '';
      const parts = text.split('/');
      return parts[parts.length - 1] || text;
    }

    function escapeHtml(value) {
      return String(value ?? '').replace(/[&<>"']/g, (char) => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;'
      }[char]));
    }

    function escapeAttr(value) {
      return escapeHtml(value);
    }

    function selectedSessionIds() {
      const visible = new Set(state.sessions.map((session) => session.id));
      return Array.from(state.selectedSessionIds).filter((id) => visible.has(id));
    }

    function pruneSelectedSessions() {
      const visible = new Set(state.sessions.map((session) => session.id));
      for (const id of Array.from(state.selectedSessionIds)) {
        if (!visible.has(id)) {
          state.selectedSessionIds.delete(id);
        }
      }
    }

    function updateSessionSelectionControls() {
      const count = selectedSessionIds().length;
      els.cleanSelectedSessionsButton.disabled = count === 0;
      els.clearSessionSelectionButton.disabled = count === 0;
      els.cleanSelectedSessionsButton.textContent = count === 0 ? '清理选中' : '清理选中 ' + count;
    }

    function selectAllVisibleSessions() {
      for (const session of state.sessions) {
        state.selectedSessionIds.add(session.id);
      }
      renderSessions();
      updateSessionSelectionControls();
    }

    function clearSessionSelection() {
      state.selectedSessionIds.clear();
      renderSessions();
      updateSessionSelectionControls();
    }

    function restorePaneLayout() {
      try {
        const saved = JSON.parse(localStorage.getItem(PANE_LAYOUT_KEY) || '{}');
        if (Number.isFinite(saved.sessionsWidth)) {
          setPaneWidth('sessions', saved.sessionsWidth);
        }
        if (Number.isFinite(saved.editorWidth)) {
          setPaneWidth('editor', saved.editorWidth);
        }
      } catch {
        localStorage.removeItem(PANE_LAYOUT_KEY);
      }
    }

    function persistPaneLayout() {
      const payload = {
        sessionsWidth: Math.round(els.sessionsPane.getBoundingClientRect().width),
        editorWidth: Math.round(els.editorPane.getBoundingClientRect().width)
      };
      localStorage.setItem(PANE_LAYOUT_KEY, JSON.stringify(payload));
    }

    function resetPaneLayout() {
      els.workspace.style.removeProperty('--sessions-width');
      els.workspace.style.removeProperty('--editor-width');
      els.sessionsPane.style.removeProperty('--trash-height');
      localStorage.removeItem(PANE_LAYOUT_KEY);
      localStorage.removeItem(TRASH_HEIGHT_KEY);
      showToast('布局已重置');
    }

    function setPaneWidth(kind, width) {
      const viewport = Math.max(760, els.workspace.getBoundingClientRect().width || window.innerWidth);
      const gutterWidth = 16;
      const minCenter = 500;
      const minSessions = 220;
      const minEditor = 300;
      if (kind === 'sessions') {
        const maxSessions = Math.min(460, Math.max(minSessions, viewport - minCenter - minEditor - gutterWidth));
        const next = clamp(width, minSessions, maxSessions);
        els.workspace.style.setProperty('--sessions-width', next + 'px');
      } else {
        const maxEditor = Math.min(720, Math.max(minEditor, viewport - minCenter - minSessions - gutterWidth));
        const next = clamp(width, minEditor, maxEditor);
        els.workspace.style.setProperty('--editor-width', next + 'px');
      }
    }

    function setupResizers() {
      els.resizers.forEach((handle) => {
        handle.addEventListener('pointerdown', (event) => startResize(event, handle));
        handle.addEventListener('keydown', (event) => {
          if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') {
            return;
          }
          event.preventDefault();
          const kind = handle.dataset.resizer;
          const step = event.shiftKey ? 64 : 24;
          const current =
            kind === 'sessions'
              ? els.sessionsPane.getBoundingClientRect().width
              : els.editorPane.getBoundingClientRect().width;
          const direction = event.key === 'ArrowRight' ? 1 : -1;
          const delta = kind === 'sessions' ? direction * step : -direction * step;
          setPaneWidth(kind, current + delta);
          persistPaneLayout();
        });
      });
    }

    function restoreTrashHeight() {
      try {
        const saved = Number.parseFloat(localStorage.getItem(TRASH_HEIGHT_KEY) || '');
        if (Number.isFinite(saved)) {
          setTrashHeight(saved);
        }
      } catch {
        localStorage.removeItem(TRASH_HEIGHT_KEY);
      }
    }

    function persistTrashHeight() {
      localStorage.setItem(TRASH_HEIGHT_KEY, String(Math.round(els.trashPanel.getBoundingClientRect().height)));
    }

    function setTrashHeight(height) {
      const paneHeight = Math.max(360, els.sessionsPane.getBoundingClientRect().height || 0);
      const minHeight = 126;
      const maxHeight = Math.max(minHeight, Math.min(560, paneHeight - 218));
      const next = clamp(height, minHeight, maxHeight);
      els.sessionsPane.style.setProperty('--trash-height', next + 'px');
    }

    function setupTrashResizer() {
      els.trashResizer.addEventListener('pointerdown', startTrashResize);
      els.trashResizer.addEventListener('keydown', (event) => {
        if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') {
          return;
        }
        event.preventDefault();
        const step = event.shiftKey ? 48 : 20;
        const current = els.trashPanel.getBoundingClientRect().height;
        const direction = event.key === 'ArrowUp' ? 1 : -1;
        setTrashHeight(current + direction * step);
        persistTrashHeight();
      });
    }

    function startTrashResize(event) {
      if (window.matchMedia('(max-width: 760px)').matches) {
        return;
      }

      event.preventDefault();
      const startY = event.clientY;
      const startHeight = els.trashPanel.getBoundingClientRect().height;
      document.body.classList.add('resizing-y');
      els.trashResizer.classList.add('dragging');
      els.trashResizer.setPointerCapture(event.pointerId);

      function move(moveEvent) {
        setTrashHeight(startHeight - (moveEvent.clientY - startY));
      }

      function end() {
        document.body.classList.remove('resizing-y');
        els.trashResizer.classList.remove('dragging');
        persistTrashHeight();
        els.trashResizer.removeEventListener('pointermove', move);
        els.trashResizer.removeEventListener('pointerup', end);
        els.trashResizer.removeEventListener('pointercancel', end);
      }

      els.trashResizer.addEventListener('pointermove', move);
      els.trashResizer.addEventListener('pointerup', end);
      els.trashResizer.addEventListener('pointercancel', end);
    }

    function startResize(event, handle) {
      if (window.matchMedia('(max-width: 760px)').matches) {
        return;
      }

      event.preventDefault();
      const kind = handle.dataset.resizer;
      const startX = event.clientX;
      const startWidth =
        kind === 'sessions'
          ? els.sessionsPane.getBoundingClientRect().width
          : els.editorPane.getBoundingClientRect().width;

      document.body.classList.add('resizing');
      handle.classList.add('dragging');
      handle.setPointerCapture(event.pointerId);

      function move(moveEvent) {
        const dx = moveEvent.clientX - startX;
        const next = kind === 'sessions' ? startWidth + dx : startWidth - dx;
        setPaneWidth(kind, next);
      }

      function end() {
        document.body.classList.remove('resizing');
        handle.classList.remove('dragging');
        persistPaneLayout();
        handle.removeEventListener('pointermove', move);
        handle.removeEventListener('pointerup', end);
        handle.removeEventListener('pointercancel', end);
      }

      handle.addEventListener('pointermove', move);
      handle.addEventListener('pointerup', end);
      handle.addEventListener('pointercancel', end);
    }

    function clamp(value, min, max) {
      return Math.max(min, Math.min(max, value));
    }

    function restoreTableLayout() {
      try {
        const saved = JSON.parse(localStorage.getItem('coldxx-record-table-layout-v1') || '{}');
        for (const key of ['line', 'type', 'role']) {
          if (Number.isFinite(saved[key])) {
            setRecordColumnWidth(key, saved[key]);
          }
        }
      } catch {
        localStorage.removeItem('coldxx-record-table-layout-v1');
      }
    }

    function persistTableLayout() {
      const styles = getComputedStyle(document.documentElement);
      const payload = {
        line: parsePixels(styles.getPropertyValue('--record-line-width')),
        type: parsePixels(styles.getPropertyValue('--record-type-width')),
        role: parsePixels(styles.getPropertyValue('--record-role-width'))
      };
      localStorage.setItem('coldxx-record-table-layout-v1', JSON.stringify(payload));
    }

    function setRecordColumnWidth(key, width) {
      const config = {
        line: ['--record-line-width', 46, 140],
        type: ['--record-type-width', 110, 380],
        role: ['--record-role-width', 64, 220]
      }[key];
      if (!config) {
        return;
      }
      const next = clamp(width, config[1], config[2]);
      document.documentElement.style.setProperty(config[0], next + 'px');
    }

    function setupColumnResizers() {
      document.querySelectorAll('.column-handle').forEach((handle) => {
        handle.addEventListener('pointerdown', (event) => startColumnResize(event, handle));
        handle.addEventListener('keydown', (event) => {
          if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') {
            return;
          }
          event.preventDefault();
          const key = handle.dataset.column;
          const step = event.shiftKey ? 40 : 16;
          const current = currentColumnWidth(key);
          const direction = event.key === 'ArrowRight' ? 1 : -1;
          setRecordColumnWidth(key, current + direction * step);
          persistTableLayout();
        });
      });
    }

    function startColumnResize(event, handle) {
      event.preventDefault();
      event.stopPropagation();
      const key = handle.dataset.column;
      const startX = event.clientX;
      const startWidth = currentColumnWidth(key);
      document.body.classList.add('resizing');
      handle.classList.add('dragging');
      handle.setPointerCapture(event.pointerId);

      function move(moveEvent) {
        setRecordColumnWidth(key, startWidth + moveEvent.clientX - startX);
      }

      function end() {
        document.body.classList.remove('resizing');
        handle.classList.remove('dragging');
        persistTableLayout();
        handle.removeEventListener('pointermove', move);
        handle.removeEventListener('pointerup', end);
        handle.removeEventListener('pointercancel', end);
      }

      handle.addEventListener('pointermove', move);
      handle.addEventListener('pointerup', end);
      handle.addEventListener('pointercancel', end);
    }

    function currentColumnWidth(key) {
      const map = {
        line: '--record-line-width',
        type: '--record-type-width',
        role: '--record-role-width'
      };
      return parsePixels(getComputedStyle(document.documentElement).getPropertyValue(map[key]));
    }

    function parsePixels(value) {
      const parsed = Number.parseFloat(String(value || '').replace('px', ''));
      return Number.isFinite(parsed) ? parsed : 0;
    }

    els.refreshSessions.addEventListener('click', () => loadSessions().catch(handleError));
    els.resetLayoutButton.addEventListener('click', resetPaneLayout);
    els.sessionSearch.addEventListener('input', debounce(() => loadSessions().catch(handleError), 180));
    els.reloadRecords.addEventListener('click', () => loadRecords().catch(handleError));
    els.openFilterButton.addEventListener('click', () => openFilterModal().catch(handleError));
    els.clearRecordFilterButton.addEventListener('click', clearRecordFilter);
    els.copyRecordPathButton.addEventListener('click', () => {
      copyText(els.copyRecordPathButton.dataset.copyPath || '', '路径已复制').catch(handleError);
    });
    els.toggleHistoryButton.addEventListener('click', () => {
      state.historyOpen = !state.historyOpen;
      renderOperationHistory();
    });
    els.historyBody.addEventListener('click', (event) => {
      const button = event.target.closest('[data-rollback-backup]');
      if (button) {
        rollbackBackup(button.dataset.rollbackBackup).catch(handleError);
      }
    });
    els.jsonEditor.addEventListener('input', () => {
      state.dirty = true;
      els.copyJsonButton.disabled = els.jsonEditor.value.length === 0;
      validateEditor();
    });
    els.wrapJsonToggle.addEventListener('change', () => setJsonWrap(els.wrapJsonToggle.checked));
    els.copyJsonButton.addEventListener('click', () => {
      copyText(els.jsonEditor.value, 'JSON 已复制').catch(handleError);
    });
    els.formatJson.addEventListener('click', () => {
      try {
        els.jsonEditor.value = JSON.stringify(JSON.parse(els.jsonEditor.value), null, 2);
        state.dirty = true;
        els.copyJsonButton.disabled = els.jsonEditor.value.length === 0;
        validateEditor();
      } catch (error) {
        handleError(error);
      }
    });
    els.saveRecord.addEventListener('click', () => saveCurrentRecord().catch(handleError));
    els.selectAllSessionsButton.addEventListener('click', selectAllVisibleSessions);
    els.clearSessionSelectionButton.addEventListener('click', clearSessionSelection);
    els.cleanSelectedSessionsButton.addEventListener('click', () => cleanSelectedSessions().catch(handleError));
    els.reloadTrashButton.addEventListener('click', () => loadTrash().catch(handleError));
    els.emptyTrashButton.addEventListener('click', () => emptyTrashFromUi().catch(handleError));
    els.modalConfirmButton.addEventListener('click', confirmModal);
    els.modalCancelButton.addEventListener('click', () => closeModal(false));
    els.modalCloseButton.addEventListener('click', () => closeModal(false));
    els.modalLayer.addEventListener('click', (event) => {
      if (event.target.closest('[data-modal-cancel]')) {
        closeModal(false);
      }
    });
    els.dropLinesButton.addEventListener('click', () => dropLines(els.dropLines.value).catch(handleError));
    els.dropCurrentLine.addEventListener('click', () => {
      if (state.selectedRecord) {
        dropLines(String(state.selectedRecord.line)).catch(handleError);
      }
    });
    els.openReplaceButton.addEventListener('click', () => openReplaceModal().catch(handleError));
    els.sessionList.addEventListener('change', (event) => {
      const checkbox = event.target.closest('[data-check]');
      if (!checkbox) {
        return;
      }
      if (checkbox.checked) {
        state.selectedSessionIds.add(checkbox.dataset.check);
      } else {
        state.selectedSessionIds.delete(checkbox.dataset.check);
      }
      updateSessionSelectionControls();
      renderSessions();
    });
    els.sessionList.addEventListener('click', (event) => {
      if (event.target.closest('[data-check]')) {
        return;
      }
      const button = event.target.closest('[data-id]');
      if (button) {
        selectSession(button.dataset.id).catch(handleError);
      }
    });
    els.sessionList.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') {
        return;
      }
      if (event.target.closest('[data-check]')) {
        return;
      }
      const item = event.target.closest('[data-id]');
      if (!item) {
        return;
      }
      event.preventDefault();
      selectSession(item.dataset.id).catch(handleError);
    });
    els.trashList.addEventListener('click', (event) => {
      const viewButton = event.target.closest('[data-view-trash]');
      if (viewButton) {
        viewTrash(viewButton.dataset.viewTrash).catch(handleError);
        return;
      }
      const button = event.target.closest('[data-restore-trash]');
      if (button) {
        restoreTrash(button.dataset.restoreTrash).catch(handleError);
      }
    });
    els.recordList.addEventListener('click', (event) => {
      const row = event.target.closest('[data-line]');
      if (row) {
        selectRecord(Number.parseInt(row.dataset.line, 10)).catch(handleError);
      }
    });
    window.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && state.modalResolver) {
        event.preventDefault();
        closeModal(false);
        return;
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
        event.preventDefault();
        saveCurrentRecord().catch(handleError);
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'r') {
        event.preventDefault();
        loadRecords().catch(handleError);
      }
    });

    function debounce(fn, ms) {
      let timeout = null;
      return (...args) => {
        clearTimeout(timeout);
        timeout = setTimeout(() => fn(...args), ms);
      };
    }

    restorePaneLayout();
    restoreTableLayout();
    restoreJsonWrap();
    restoreTrashHeight();
    renderOperationHistory();
    setupResizers();
    setupTrashResizer();
    loadSessions().catch(handleError);
    loadTrash().catch(handleError);
  </script>
</body>
</html>`;
}

function escapeScriptJson(value) {
  return JSON.stringify(value).replace(/[<>&]/g, (char) => {
    if (char === "<") {
      return "\\u003c";
    }
    if (char === ">") {
      return "\\u003e";
    }
    return "\\u0026";
  });
}
