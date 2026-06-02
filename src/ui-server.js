import http from "node:http";
import crypto from "node:crypto";
import {
  cleanSessions,
  dropSessionLines,
  emptyTrash,
  formatBytes,
  getSessionTurnEditPlan,
  deleteCodexProfile,
  listCodexConfigs,
  listBackups,
  listTrash,
  readCodexBaseConfig,
  readCodexProfile,
  readJsonl,
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
  rewriteText,
  truncateSessionAfterTurn,
  updateSessionRecord,
  updateSessionTurnMessages,
  writeCodexProfile,
} from "./core.js";

const DEFAULT_ACTIVE_WINDOW_MINUTES = 10;
const MAX_BODY_BYTES = 25 * 1024 * 1024;
const MAX_INLINE_RECORD_JSON_BYTES = 256 * 1024;
const LOGO_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 96" role="img" aria-label="coldxx logo">
  <defs>
    <linearGradient id="coldxx-bg" x1="14" y1="12" x2="82" y2="86" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#10242b"/>
      <stop offset="1" stop-color="#0d6b60"/>
    </linearGradient>
    <linearGradient id="coldxx-line" x1="20" y1="18" x2="76" y2="78" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#f7fffb"/>
      <stop offset="1" stop-color="#9fd6ca"/>
    </linearGradient>
  </defs>
  <rect x="8" y="8" width="80" height="80" rx="20" fill="url(#coldxx-bg)"/>
  <path d="M34 31 20 48l14 17" fill="none" stroke="url(#coldxx-line)" stroke-width="7" stroke-linecap="round" stroke-linejoin="round"/>
  <path d="M60 33 76 63M76 33 60 63" fill="none" stroke="#d8f4eb" stroke-width="7" stroke-linecap="round"/>
  <path d="M43 67h15" fill="none" stroke="#75bfb2" stroke-width="6" stroke-linecap="round"/>
  <circle cx="48" cy="48" r="5" fill="#ffffff"/>
</svg>`;

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
    if (!isAuthorized(req, url, state.token)) {
      sendJson(res, 403, { error: "Invalid UI token" });
      return;
    }
    sendHtml(res, html(state));
    return;
  }

  if (req.method === "GET" && url.pathname === "/assets/coldxx-logo.svg") {
    sendSvg(res, LOGO_SVG);
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

  if (req.method === "GET" && url.pathname === "/api/profiles") {
    const configs = await listCodexConfigs({ codexHome: state.codexHome });
    const [base, ...profiles] = configs;
    sendJson(res, 200, {
      base,
      profiles,
      configs,
      codexHome: state.codexHome,
    });
    return;
  }

  const profileMatch = /^\/api\/profiles\/([^/]+)$/.exec(url.pathname);
  if (profileMatch) {
    const name = decodeURIComponent(profileMatch[1]);
    if (req.method === "GET") {
      const profile =
        name === "default"
          ? await readCodexBaseConfig({ codexHome: state.codexHome })
          : await readCodexProfile(name, { codexHome: state.codexHome });
      sendJson(res, 200, { profile });
      return;
    }

    if (req.method === "PUT") {
      if (name === "default") {
        sendJson(res, 400, { error: "Default config.toml is read-only in coldxx" });
        return;
      }
      const body = await readJsonBody(req);
      const result = await writeCodexProfile(name, {
        codexHome: state.codexHome,
        managerHome: state.managerHome,
        raw: typeof body.raw === "string" ? body.raw : "",
        instructions: typeof body.instructions === "string" ? body.instructions : undefined,
        modelInstructionsText:
          typeof body.modelInstructionsText === "string" ? body.modelInstructionsText : undefined,
      });
      sendJson(res, 200, { profile: result });
      return;
    }

    if (req.method === "DELETE") {
      if (name === "default") {
        sendJson(res, 400, { error: "Default config.toml cannot be deleted from coldxx" });
        return;
      }
      const result = await deleteCodexProfile(name, {
        codexHome: state.codexHome,
        managerHome: state.managerHome,
      });
      sendJson(res, 200, result);
      return;
    }

    sendJson(res, 405, { error: "Method not allowed" });
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

  const turnMatch = /^\/api\/sessions\/([^/]+)\/turns\/([^/]+)\/(edit|truncate|rewrite-text)$/.exec(url.pathname);
  if (turnMatch) {
    const session = await resolveSession(decodeURIComponent(turnMatch[1]), state);
    const turnId = decodeURIComponent(turnMatch[2]);
    const action = turnMatch[3];

    if (req.method === "GET" && action === "edit") {
      const { records } = await readJsonl(session.file);
      sendJson(res, 200, getSessionTurnEditPlan(records, turnId));
      return;
    }

    if (req.method === "PUT" && action === "edit") {
      const body = await readJsonBody(req);
      guardActiveSession(session, state, body.allowActive, "edit this conversation turn");
      const result = await updateSessionTurnMessages(session.file, turnId, Array.isArray(body.edits) ? body.edits : [], {
        managerHome: state.managerHome,
      });
      sendJson(res, 200, result);
      return;
    }

    if (req.method === "POST" && action === "truncate") {
      const body = await readJsonBody(req);
      guardActiveSession(session, state, body.allowActive, "truncate this session");
      const result = await truncateSessionAfterTurn(session.file, turnId, {
        managerHome: state.managerHome,
      });
      sendJson(res, 200, result);
      return;
    }

    if (req.method === "POST" && action === "rewrite-text") {
      const body = await readJsonBody(req);
      const result = await rewriteText(String(body.text || ""), {
        llmProvider: String(body.llmProvider || ""),
        codexHome: state.codexHome,
        cwd: session.cwd || undefined,
        prompt: String(body.prompt || ""),
        profile: String(body.profile || ""),
        model: String(body.model || ""),
        baseUrl: String(body.baseUrl || ""),
        apiKey: String(body.apiKey || ""),
        side: String(body.side || ""),
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
      turns: sessionForEditing.turns,
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
      lines: Array.isArray(body.lines) ? body.lines : undefined,
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
    fileUpdatedAt: session.fileUpdatedAt,
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

function sendSvg(res, body) {
  res.writeHead(200, {
    "content-type": "image/svg+xml; charset=utf-8",
    "cache-control": "public, max-age=86400",
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

    button.icon.compact {
      width: 30px;
      padding: 0;
    }

    button.ghost {
      background: transparent;
    }

    button.active {
      color: var(--accent);
      border-color: rgba(13, 107, 96, 0.35);
      background: var(--accent-soft);
    }

    button.is-rewriting {
      opacity: 1;
    }

    button.is-rewriting::before {
      content: "";
      width: 12px;
      height: 12px;
      border: 2px solid rgba(255, 255, 255, 0.45);
      border-top-color: #fff;
      border-radius: 999px;
      animation: rewrite-spin 720ms linear infinite;
    }

    button:disabled {
      cursor: not-allowed;
      opacity: 0.55;
    }

    button.is-rewriting:disabled {
      opacity: 1;
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
      grid-template-rows: 64px 1fr;
    }

    .topbar {
      display: grid;
      grid-template-columns: minmax(160px, 240px) minmax(220px, 1fr);
      align-items: center;
      gap: 12px;
      border-bottom: 1px solid var(--line);
      background: rgba(252, 253, 251, 0.92);
      backdrop-filter: blur(12px);
      padding: 7px 16px;
      box-shadow: 0 1px 0 rgba(255, 255, 255, 0.75) inset;
    }

    .brand-stack {
      min-width: 0;
      display: grid;
      align-content: center;
      gap: 5px;
    }

    .top-actions {
      display: flex;
      justify-content: flex-end;
      align-items: center;
      gap: 8px;
      flex-wrap: wrap;
    }

    .brand {
      font-weight: 700;
      letter-spacing: 0;
      display: flex;
      align-items: center;
      gap: 9px;
      line-height: 1;
    }

    .brand-mark {
      width: 25px;
      height: 25px;
      border-radius: 7px;
      overflow: hidden;
      box-shadow: 0 1px 2px rgba(15, 31, 37, 0.16);
      flex: 0 0 auto;
    }

    .brand-mark img {
      display: block;
      width: 100%;
      height: 100%;
    }

    .pathline {
      color: var(--muted);
      font-size: 12px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      line-height: 1.25;
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

    .section-title-row {
      min-width: 0;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      width: 100%;
    }

    .session-title-tools {
      display: flex;
      align-items: center;
      justify-content: flex-end;
      gap: 6px;
      flex: 0 0 auto;
    }

    .session-head-main {
      min-width: 0;
      width: 100%;
      display: grid;
      gap: 5px;
    }

    .session-search-row {
      display: flex;
      gap: 6px;
      align-items: center;
      min-width: 0;
    }

    .session-search-row[hidden] {
      display: none;
    }

    .session-search-row input {
      width: 100%;
      min-width: 0;
      height: 30px;
      font-size: 12px;
    }

    .help-icon {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 18px;
      height: 18px;
      border-radius: 999px;
      border: 1px solid var(--line-strong);
      background: #fff;
      color: var(--muted);
      font-size: 11px;
      font-weight: 700;
      cursor: help;
      flex: 0 0 auto;
    }

    .help-icon:hover,
    .help-icon:focus-visible {
      color: var(--accent);
      border-color: var(--accent);
      outline: none;
    }

    .button-icon {
      display: block;
      width: 16px;
      height: 16px;
      fill: none;
      stroke: currentColor;
      stroke-width: 2;
      stroke-linecap: round;
      stroke-linejoin: round;
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

    .turn-list {
      flex: 1 1 auto;
      min-height: 150px;
      overflow: auto;
      padding: 8px 10px;
      display: grid;
      align-content: start;
      gap: 8px;
      background: #fbfcfc;
      border-bottom: 1px solid var(--line);
      scrollbar-width: thin;
      scrollbar-color: #a9b9bc transparent;
    }

    .turn-item {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 10px;
      align-items: center;
      min-height: 86px;
      border: 1px solid var(--line);
      border-left: 3px solid var(--accent);
      border-radius: 7px;
      padding: 9px 10px;
      background: #fff;
      cursor: pointer;
      transition: background 120ms ease, border-color 120ms ease, box-shadow 120ms ease;
    }

    .turn-item:hover {
      background: #f8faf9;
      border-color: #c5d1d3;
    }

    .turn-item.active {
      background: var(--accent-soft);
      border-color: #a9cbc4;
      box-shadow: inset 0 1px 0 rgba(255,255,255,0.72);
    }

    .turn-item-main {
      min-width: 0;
      display: grid;
      gap: 5px;
    }

    .turn-item-head {
      min-width: 0;
      display: flex;
      align-items: center;
      gap: 8px;
    }

    .turn-item-title {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      color: #24343b;
      font-weight: 650;
      font-size: 12px;
    }

    .turn-line-meta {
      flex: 0 0 auto;
      color: var(--muted);
      font-size: 11px;
    }

    .turn-messages {
      display: grid;
      gap: 4px;
      min-width: 0;
    }

    .turn-message {
      min-width: 0;
      display: grid;
      grid-template-columns: 42px minmax(0, 1fr);
      gap: 7px;
      color: #3b4a51;
      font-size: 12px;
      line-height: 1.35;
    }

    .turn-message b {
      color: #66747b;
      font-weight: 650;
    }

    .turn-message span {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .turn-item-actions {
      display: flex;
      align-items: center;
      justify-content: flex-end;
      flex-wrap: wrap;
      gap: 6px;
    }

    .turn-action-mark {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 14px;
      height: 14px;
      font-size: 14px;
      line-height: 1;
    }

    .record-detail {
      flex: 0 0 auto;
      min-height: 38px;
      max-height: 38px;
      display: flex;
      flex-direction: column;
      background: #f7faf9;
      border-bottom: 1px solid var(--line);
      overflow: hidden;
      transition: max-height 180ms ease, flex-basis 180ms ease;
    }

    .record-detail.open {
      flex: 0 0 38%;
      min-height: 180px;
      max-height: 48%;
    }

    .record-detail.open .history-caret {
      transform: rotate(225deg);
    }

    .record-detail:not(.open) .line-tools,
    .record-detail:not(.open) .record-list {
      display: none;
    }

    .record-detail-head {
      width: 100%;
      height: 38px;
      min-height: 38px;
      border: 0;
      border-radius: 0;
      padding: 0 12px;
      background: linear-gradient(180deg, #fff, #f7faf9);
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 10px;
      text-align: left;
    }

    .record-detail-title {
      display: block;
      color: #405058;
      font-size: 12px;
      font-weight: 650;
      line-height: 1.2;
    }

    .record-detail-meta {
      display: block;
      min-width: 0;
      margin-top: 1px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      color: var(--muted);
      font-size: 11px;
      line-height: 1.2;
    }

    .line-tools {
      min-height: 40px;
      padding: 6px 10px;
      display: flex;
      align-items: center;
      gap: 6px;
      flex-wrap: wrap;
      border-top: 1px solid var(--line);
      border-bottom: 1px solid var(--line);
      background: #fbfcfc;
    }

    .line-tools input[type="text"] {
      width: 88px;
      min-width: 72px;
      flex: 0 0 88px;
      height: 30px;
      padding: 0 8px;
      font-size: 12px;
    }

    .session-actions {
      width: 100%;
      align-self: stretch;
      display: flex;
      gap: 6px;
      align-items: center;
      justify-content: flex-start;
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

    .active-session-toggle {
      position: relative;
      width: 30px;
      height: 30px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      border: 1px solid var(--line);
      border-radius: 6px;
      background: linear-gradient(180deg, #fff, #f7faf9);
      color: var(--muted);
      cursor: pointer;
      transition: background 140ms ease, border-color 140ms ease, color 140ms ease, box-shadow 140ms ease;
    }

    .active-session-toggle:hover {
      border-color: #9fb0b4;
      background: linear-gradient(180deg, #fff, #f1f6f5);
      color: var(--ink);
    }

    .active-session-toggle.active {
      color: #fff;
      border-color: var(--warn);
      background: linear-gradient(180deg, #b57422, var(--warn));
      box-shadow: 0 1px 2px rgba(154, 97, 18, 0.2);
    }

    .active-session-toggle input {
      position: absolute;
      width: 1px;
      height: 1px;
      opacity: 0;
      pointer-events: none;
    }

    .active-session-toggle input:focus-visible + .active-session-icon {
      outline: 2px solid rgba(13, 107, 96, 0.45);
      outline-offset: 4px;
      border-radius: 5px;
    }

    .active-session-icon {
      width: 17px;
      height: 17px;
      display: inline-grid;
      place-items: center;
    }

    .active-session-icon svg {
      grid-area: 1 / 1;
      width: 17px;
      height: 17px;
      fill: none;
      stroke: currentColor;
      stroke-width: 2;
      stroke-linecap: round;
      stroke-linejoin: round;
    }

    .active-session-toggle .icon-unlocked {
      display: none;
    }

    .active-session-toggle.active .icon-locked {
      display: none;
    }

    .active-session-toggle.active .icon-unlocked {
      display: block;
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

    tr.record-row.turn-shade-1 td {
      background: #fcfbf6;
    }

    tr.record-row.turn-shade-1:hover td,
    tr.record-row:hover td {
      background: #f7faf9;
    }

    tr.record-row.side-user td.line-col {
      box-shadow: inset 3px 0 0 rgba(13, 107, 96, 0.42);
    }

    tr.record-row.side-assistant td.line-col {
      box-shadow: inset 3px 0 0 rgba(55, 95, 148, 0.42);
    }

    tr.selected td {
      background: #e7f0f5;
      box-shadow: inset 3px 0 0 var(--accent-2);
    }

    tr.focused-line td {
      background: #fff7e6;
    }

    tr.focused-line td.line-col {
      box-shadow: inset 3px 0 0 var(--warn);
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
      z-index: 60;
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

    .modal-layer.wide .modal {
      width: min(860px, calc(100vw - 36px));
      max-height: min(86vh, 820px);
    }

    .modal-layer.wide .modal-body {
      padding: 16px 18px;
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
    .modal-field select,
    .modal-field textarea {
      width: 100%;
      font-size: 13px;
    }

    .modal-field textarea {
      min-height: 112px;
      max-height: 260px;
      resize: vertical;
      line-height: 1.45;
      padding: 8px 9px;
      font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }

    .modal-field textarea.raw-config {
      min-height: 220px;
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      font-size: 12px;
    }

    .modal-layer.wide .modal-field textarea {
      min-height: 156px;
      max-height: 360px;
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

    .settings-shell {
      display: grid;
      gap: 10px;
    }

    .settings-tabs {
      display: flex;
      gap: 6px;
      border-bottom: 1px solid var(--line);
      padding-bottom: 8px;
    }

    .settings-tab {
      height: 30px;
      padding: 0 10px;
      font-size: 12px;
    }

    .settings-panel[hidden] {
      display: none;
    }

    .settings-subpanel[hidden] {
      display: none;
    }

    .rewrite-popover {
      position: fixed;
      display: grid;
      gap: 9px;
      padding: 10px;
      border: 1px solid var(--line);
      border-radius: 7px;
      background: #fff;
      box-shadow: var(--shadow);
      z-index: 30;
    }

    .rewrite-popover textarea {
      min-height: 112px;
      max-height: 220px;
      resize: vertical;
      font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }

    .turn-edit-section {
      display: grid;
      gap: 8px;
      margin-top: 12px;
    }

    .turn-edit-section-title {
      color: #405058;
      font-size: 12px;
      font-weight: 650;
    }

    .turn-edit-target {
      color: var(--muted);
      font-weight: 400;
    }

    .turn-edit-row-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
    }

    .turn-edit-row-head label {
      min-width: 0;
    }

    .turn-edit-actions {
      flex: 0 0 auto;
      gap: 6px;
    }

    .turn-edit-row {
      position: relative;
    }

    .turn-edit-row textarea {
      transition: border-color 160ms ease, box-shadow 160ms ease, background 160ms ease;
    }

    .turn-edit-row.is-rewriting textarea {
      border-color: rgba(13, 107, 96, 0.55);
      background: #f7fbfa;
      box-shadow: 0 0 0 3px rgba(13, 107, 96, 0.08);
    }

    .turn-edit-row textarea.rewrite-replaced {
      animation: rewrite-replace-flash 900ms ease;
    }

    .turn-edit-progress {
      display: none;
      align-items: center;
      gap: 8px;
      min-height: 18px;
      color: #405058;
      font-size: 12px;
      overflow: hidden;
    }

    .turn-edit-row.is-rewriting .turn-edit-progress {
      display: flex;
    }

    .turn-edit-progress-track {
      position: relative;
      flex: 1;
      height: 4px;
      border-radius: 999px;
      background: #e5eeee;
      overflow: hidden;
    }

    .turn-edit-progress-track::before {
      content: "";
      position: absolute;
      inset: 0;
      width: 36%;
      border-radius: inherit;
      background: linear-gradient(90deg, rgba(13, 107, 96, 0.18), rgba(13, 107, 96, 0.86), rgba(13, 107, 96, 0.18));
      animation: rewrite-progress 1.05s ease-in-out infinite;
    }

    .turn-edit-progress-text {
      flex: 0 0 auto;
      white-space: nowrap;
    }

    .modal-layer.rewrite-running .modal-foot,
    .modal-layer.rewrite-running .modal-head {
      opacity: 0.9;
    }

    @keyframes rewrite-spin {
      to {
        transform: rotate(360deg);
      }
    }

    @keyframes rewrite-progress {
      0% {
        transform: translateX(-110%);
      }
      100% {
        transform: translateX(285%);
      }
    }

    @keyframes rewrite-replace-flash {
      0% {
        background: #e9f8f4;
        border-color: rgba(13, 107, 96, 0.8);
        box-shadow: 0 0 0 4px rgba(13, 107, 96, 0.16);
      }
      68% {
        background: #f7fbfa;
        border-color: rgba(13, 107, 96, 0.55);
        box-shadow: 0 0 0 3px rgba(13, 107, 96, 0.08);
      }
      100% {
        background: #fff;
        box-shadow: none;
      }
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

      .turn-item {
        grid-template-columns: 1fr;
      }

      .turn-item-actions {
        justify-content: flex-start;
      }

      .record-detail.open {
        flex-basis: 46%;
        max-height: 52%;
      }
    }
  </style>
</head>
<body>
  <div class="app">
    <header class="topbar">
      <div class="brand-stack">
        <div class="brand"><span class="brand-mark"><img src="/assets/coldxx-logo.svg" alt=""></span><span>coldxx</span></div>
        <div class="pathline" id="pathline"></div>
      </div>
      <div class="top-actions">
        <button class="compact" id="settingsButton" title="系统设置">设置</button>
        <button class="compact" id="resetLayoutButton" title="恢复默认栏宽和 Trash 高度">重置布局</button>
        <label class="active-session-toggle" id="allowActiveToggle" title="禁止修改最近活跃 session。点击后允许写入最近 ${Number(state.activeWindowMinutes) || DEFAULT_ACTIVE_WINDOW_MINUTES} 分钟内更新的 session。">
          <input type="checkbox" id="allowActive" aria-label="允许修改活跃 session">
          <span class="active-session-icon" aria-hidden="true">
            <svg class="icon-locked" viewBox="0 0 24 24">
              <rect x="5" y="11" width="14" height="10" rx="2"></rect>
              <path d="M8 11V8a4 4 0 0 1 8 0v3"></path>
            </svg>
            <svg class="icon-unlocked" viewBox="0 0 24 24">
              <rect x="5" y="11" width="14" height="10" rx="2"></rect>
              <path d="M8 11V8a4 4 0 0 1 7.6-1.7"></path>
            </svg>
          </span>
        </label>
      </div>
    </header>
    <main class="workspace" id="workspace">
      <aside class="sessions">
        <div class="section-head">
          <div class="session-head-main">
            <div class="section-title-row">
              <div class="section-title">Sessions</div>
              <div class="session-title-tools">
                <button class="icon compact" id="toggleSessionSearchButton" title="搜索 session id、cwd、文件路径、预览文本和 model" aria-label="展开 session 搜索" aria-expanded="false">
                  <svg class="button-icon" viewBox="0 0 20 20" aria-hidden="true">
                    <circle cx="8.5" cy="8.5" r="5.5"></circle>
                    <path d="M12.5 12.5 17 17"></path>
                  </svg>
                </button>
                <button class="icon compact" id="refreshSessions" title="刷新 sessions" aria-label="刷新 sessions">
                  <svg class="button-icon" viewBox="0 0 20 20" aria-hidden="true">
                    <path d="M16 7.5A6.5 6.5 0 1 0 17 12"></path>
                    <path d="M16 3.5v4h-4"></path>
                  </svg>
                </button>
              </div>
            </div>
            <div class="meta" id="sessionCount">-</div>
            <div class="session-search-row" id="sessionSearchRow" hidden>
              <input id="sessionSearch" placeholder="id / cwd / path / preview / model" autocomplete="off">
            </div>
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
            <button class="compact" id="openFilterButton" disabled>筛选对话</button>
            <button class="compact" id="clearRecordFilterButton" disabled>清除筛选</button>
            <span class="help-icon" tabindex="0" title="筛选条件只改变 Turn 主视图；Lines 明细会跟随这个范围，底部 Lines 查找不会反向筛选 Turn。">i</span>
          </div>
        </div>
        <div class="turn-list" id="turnList"></div>
        <div class="record-detail" id="recordDetail">
          <button class="record-detail-head" id="toggleLineDetailsButton" type="button" aria-expanded="false">
            <span>
              <span class="record-detail-title">JSONL lines 明细</span>
              <span class="record-detail-meta" id="lineDetailMeta">完整记录表默认收起</span>
            </span>
            <span class="history-caret" aria-hidden="true"></span>
          </button>
          <div class="line-tools">
            <button class="compact" id="openReplaceButton" disabled>查找 / 替换 lines</button>
            <button class="compact" id="clearLineFilterButton" disabled>清除查找</button>
            <input id="dropLines" type="text" placeholder="3,5-8" aria-label="删除 JSONL 行范围">
            <button class="danger compact" id="dropLinesButton" disabled>删除 lines</button>
          </div>
          <div class="record-list" id="recordList"></div>
        </div>
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
    const REWRITE_SETTINGS_KEY = 'coldxx-rewrite-settings-v1';
    const ALLOW_ACTIVE_KEY = 'coldxx-allow-active-v1';
    const DEFAULT_REWRITE_PROMPT = '请将这段文本改写得更清晰、准确、便于继续工作。保留原意，不添加原文没有的信息。只输出改写后的文本。';
    const MAX_WRAPPED_JSON_CHARS = 250000;
    const MAX_JSON_AUTOLOAD_BYTES = 256 * 1024;
    const MAX_JSON_LIVE_VALIDATE_CHARS = 1000000;
    const state = {
      sessions: [],
      selectedSession: null,
      selectedSessionIds: new Set(),
      sessionSearchOpen: false,
      records: [],
      filteredRecords: [],
      turnFilteredRecords: [],
      lineScopeRecords: [],
      turns: [],
      selectedTurnId: null,
      focusedLine: null,
      lineDetailsOpen: false,
      operationHistory: [],
      historyOpen: false,
      turnFilter: blankRecordFilter(),
      lineFilter: blankRecordFilter(),
      selectedRecord: null,
      wrapJson: true,
      dirty: false,
      toastTimer: null,
      pending: 0,
      modalResolver: null,
      modalCollect: null,
      lastModalFocus: null,
      turnRewriteBusy: '',
      profiles: [],
      profileConfigs: [],
      activeSettingsTab: 'profiles',
      rewriteSettings: loadRewriteSettings(),
      trashItems: []
    };

    const els = {
      workspace: document.getElementById('workspace'),
      sessionsPane: document.querySelector('.sessions'),
      editorPane: document.querySelector('.editor'),
      pathline: document.getElementById('pathline'),
      sessionSearch: document.getElementById('sessionSearch'),
      sessionSearchRow: document.getElementById('sessionSearchRow'),
      toggleSessionSearchButton: document.getElementById('toggleSessionSearchButton'),
      refreshSessions: document.getElementById('refreshSessions'),
      settingsButton: document.getElementById('settingsButton'),
      resetLayoutButton: document.getElementById('resetLayoutButton'),
      allowActive: document.getElementById('allowActive'),
      allowActiveToggle: document.getElementById('allowActiveToggle'),
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
      clearLineFilterButton: document.getElementById('clearLineFilterButton'),
      dropLines: document.getElementById('dropLines'),
      dropLinesButton: document.getElementById('dropLinesButton'),
      turnList: document.getElementById('turnList'),
      recordDetail: document.getElementById('recordDetail'),
      toggleLineDetailsButton: document.getElementById('toggleLineDetailsButton'),
      lineDetailMeta: document.getElementById('lineDetailMeta'),
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

    async function loadProfiles() {
      const data = await api('/api/profiles');
      state.profiles = data.profiles || [];
      state.profileConfigs = data.configs || [];
      return state.profileConfigs;
    }

    async function openSystemSettingsModal() {
      const configs = await loadProfiles();
      const initial = configs[0] ? await api('/api/profiles/' + encodeURIComponent(configs[0].name)) : { profile: defaultConfigView() };
      state.activeSettingsTab = state.activeSettingsTab || 'profiles';
      const result = await openModal({
        kicker: 'Settings',
        title: '系统设置',
        body: systemSettingsModalBody(configs, initial.profile),
        size: 'wide',
        confirmText: '保存当前 profile',
        cancelText: '关闭',
        afterOpen: setupSystemSettingsModal,
        collect: collectSystemSettingsModal
      });
      if (!result) {
        return;
      }
      if (result.type === 'profile') {
        await saveProfile(result.profile);
      } else if (result.type === 'rewrite') {
        saveRewriteSettings(result.settings);
        showToast('改写 AI 设置已保存', 'ok');
      }
    }

    async function saveProfile(profile) {
      setStatus('Saving Codex profile...');
      const response = await api('/api/profiles/' + encodeURIComponent(profile.name), {
        method: 'PUT',
        body: JSON.stringify({
          raw: profile.raw,
          instructions: profile.useInstructions ? profile.instructions : undefined,
          modelInstructionsText: profile.useModelInstructions ? profile.modelInstructionsText : undefined
        })
      });
      const saved = response.profile;
      await loadProfiles();
      const message = '已保存 ' + saved.file + ' · 使用：' + saved.command;
      setStatus(message, 'ok', true);
      showToast(message, 'ok');
    }

    function setupSystemSettingsModal() {
      for (const button of document.querySelectorAll('[data-settings-tab]')) {
        button.addEventListener('click', () => switchSettingsTab(button.dataset.settingsTab));
      }
      setupProfileModal();
      setupRewriteSettingsForm();
      switchSettingsTab(state.activeSettingsTab || 'profiles');
    }

    function switchSettingsTab(tab) {
      state.activeSettingsTab = tab || 'profiles';
      for (const button of document.querySelectorAll('[data-settings-tab]')) {
        button.classList.toggle('active', button.dataset.settingsTab === state.activeSettingsTab);
      }
      for (const panel of document.querySelectorAll('[data-settings-panel]')) {
        panel.hidden = panel.dataset.settingsPanel !== state.activeSettingsTab;
      }
      if (state.activeSettingsTab === 'profiles') {
        els.modalConfirmButton.textContent = '保存当前 profile';
        els.modalConfirmButton.className = 'primary compact';
        updateProfileFormState();
      } else if (state.activeSettingsTab === 'rewrite') {
        els.modalConfirmButton.disabled = false;
        els.modalConfirmButton.textContent = '保存改写设置';
        els.modalConfirmButton.className = 'primary compact';
      }
    }

    function collectSystemSettingsModal() {
      if (state.activeSettingsTab === 'profiles') {
        const profile = collectProfileModal();
        return profile ? { type: 'profile', profile } : false;
      }
      if (state.activeSettingsTab === 'rewrite') {
        return { type: 'rewrite', settings: collectRewriteSettingsForm() };
      }
      return false;
    }

    function setupProfileModal() {
      const selector = document.getElementById('profileSelector');
      if (selector) {
        selector.addEventListener('change', () => {
          if (selector.value) {
            loadProfileIntoModal(selector.value).catch(handleError);
          } else {
            startNewProfile();
          }
        });
      }
      const nameInput = document.getElementById('profileNameInput');
      if (nameInput) {
        nameInput.addEventListener('input', updateProfileActivationHint);
      }
      document.getElementById('profileNewButton').addEventListener('click', startNewProfile);
      document.getElementById('profileDeleteButton').addEventListener('click', () => {
        deleteSelectedProfile().catch(handleError);
      });
      updateProfileActivationHint();
      updateProfileFormState();
    }

    function startNewProfile() {
      fillProfileModal({
        name: '',
        kind: 'profile',
        editable: true,
        deletable: false,
        raw: defaultProfileRaw(),
        fields: {},
        modelInstructionsText: ''
      });
      setProfileSelectorValue('');
      document.getElementById('profileNameInput').focus();
    }

    async function loadProfileIntoModal(name) {
      const data = await api('/api/profiles/' + encodeURIComponent(name));
      fillProfileModal(data.profile);
    }

    function fillProfileModal(profile) {
      document.getElementById('profileKind').value = profile.kind || 'profile';
      document.getElementById('profileEditable').value = profile.editable ? '1' : '0';
      document.getElementById('profileDeletable').value = profile.deletable ? '1' : '0';
      document.getElementById('profileNameInput').value = profile.name || '';
      document.getElementById('profileRawToml').value = profile.raw || '';
      document.getElementById('profileInstructions').value =
        (profile.fields && profile.fields.instructions) || '';
      document.getElementById('profileUseInstructions').checked =
        Boolean(profile.fields && profile.fields.instructions);
      document.getElementById('profileModelInstructions').value = profile.modelInstructionsText || '';
      document.getElementById('profileUseModelInstructions').checked =
        Boolean(profile.fields && profile.fields.model_instructions_file);
      updateProfileActivationHint();
      setProfileSelectorValue(profile.name || '');
      updateProfileFormState();
    }

    function collectProfileModal() {
      if (document.getElementById('profileEditable').value !== '1') {
        return false;
      }
      const name = document.getElementById('profileNameInput').value.trim();
      const error = document.getElementById('profileModalError');
      if (!/^[A-Za-z0-9_-]+$/.test(name)) {
        error.textContent = 'Profile 名只能包含字母、数字、连字符和下划线。';
        error.classList.add('show');
        return false;
      }
      error.classList.remove('show');
      return {
        name,
        raw: document.getElementById('profileRawToml').value,
        useInstructions: document.getElementById('profileUseInstructions').checked,
        instructions: document.getElementById('profileInstructions').value,
        useModelInstructions: document.getElementById('profileUseModelInstructions').checked,
        modelInstructionsText: document.getElementById('profileModelInstructions').value
      };
    }

    async function deleteSelectedProfile() {
      const name = document.getElementById('profileNameInput').value.trim();
      if (document.getElementById('profileDeletable').value !== '1' || !name) {
        return;
      }
      if (!window.confirm('删除 Codex profile ' + name + '？删除前会自动备份。')) {
        return;
      }
      const result = await api('/api/profiles/' + encodeURIComponent(name), { method: 'DELETE' });
      const configs = await loadProfiles();
      const selector = document.getElementById('profileSelector');
      if (selector) {
        selector.innerHTML = profileSelectorOptions(configs, 'default');
      }
      fillProfileModal(configs[0] || defaultConfigView());
      showToast('已删除 ' + result.file + '，备份：' + (result.backup ? result.backup.backupPath : '-'), 'ok');
    }

    function updateProfileFormState() {
      const editable = document.getElementById('profileEditable').value === '1';
      const deletable = document.getElementById('profileDeletable').value === '1';
      const inputs = [
        document.getElementById('profileNameInput'),
        document.getElementById('profileRawToml'),
        document.getElementById('profileInstructions'),
        document.getElementById('profileModelInstructions'),
        document.getElementById('profileUseInstructions'),
        document.getElementById('profileUseModelInstructions')
      ];
      for (const input of inputs) {
        input.disabled = !editable;
      }
      document.getElementById('profileDeleteButton').disabled = !deletable;
      if (state.activeSettingsTab === 'profiles') {
        els.modalConfirmButton.disabled = !editable;
        els.modalConfirmButton.textContent = editable ? '保存当前 profile' : '默认配置只读';
      }
    }

    function updateProfileActivationHint() {
      const input = document.getElementById('profileNameInput');
      const hint = document.getElementById('profileActivationHint');
      if (!input || !hint) {
        return;
      }
      if (document.getElementById('profileKind').value === 'default') {
        hint.textContent = '默认配置通过 codex 直接使用；coldxx 只展示，不保存或删除 config.toml。';
        return;
      }
      const name = input.value.trim() || '<profile>';
      hint.textContent = '保存后使用：codex -p ' + name + '，非交互：codex exec -p ' + name + ' "..."';
    }

    function setProfileSelectorValue(name) {
      const selector = document.getElementById('profileSelector');
      if (!selector) {
        return;
      }
      selector.value = Array.from(selector.options).some((option) => option.value === name) ? name : '';
    }

    function defaultConfigView() {
      return {
        name: 'default',
        kind: 'default',
        editable: false,
        deletable: false,
        raw: '',
        fields: {},
        modelInstructionsText: '',
        command: 'codex'
      };
    }

    function defaultProfileRaw() {
      return '#:schema https://developers.openai.com/codex/config-schema.json\\n# Activate with: codex -p <profile>\\n\\nmodel = "gpt-5.5"\\napproval_policy = "on-request"\\nsandbox_mode = "workspace-write"\\n';
    }

    function defaultRewriteSettings() {
      return {
        llmProvider: 'codex',
        profile: '',
        codexModel: '',
        compatibleModel: '',
        baseUrl: '',
        apiKey: '',
        prompt: DEFAULT_REWRITE_PROMPT
      };
    }

    function normalizeRewriteSettings(value) {
      const fallback = defaultRewriteSettings();
      const settings = value && typeof value === 'object' ? value : {};
      const provider = ['codex', 'openai', 'anthropic'].includes(String(settings.llmProvider || settings.provider || '').toLowerCase())
        ? String(settings.llmProvider || settings.provider).toLowerCase()
        : fallback.llmProvider;
      return {
        llmProvider: provider,
        profile: typeof settings.profile === 'string' ? settings.profile : fallback.profile,
        codexModel:
          typeof settings.codexModel === 'string'
            ? settings.codexModel
            : provider === 'codex' && typeof settings.model === 'string'
              ? settings.model
              : fallback.codexModel,
        compatibleModel:
          typeof settings.compatibleModel === 'string'
            ? settings.compatibleModel
            : provider !== 'codex' && typeof settings.model === 'string'
              ? settings.model
              : fallback.compatibleModel,
        baseUrl: typeof settings.baseUrl === 'string' ? settings.baseUrl : fallback.baseUrl,
        apiKey: typeof settings.apiKey === 'string' ? settings.apiKey : fallback.apiKey,
        prompt: typeof settings.prompt === 'string' && settings.prompt.trim() ? settings.prompt : fallback.prompt
      };
    }

    function loadRewriteSettings() {
      try {
        return normalizeRewriteSettings(JSON.parse(localStorage.getItem(REWRITE_SETTINGS_KEY) || 'null'));
      } catch {
        return defaultRewriteSettings();
      }
    }

    function saveRewriteSettings(settings) {
      state.rewriteSettings = normalizeRewriteSettings(settings);
      try {
        localStorage.setItem(REWRITE_SETTINGS_KEY, JSON.stringify(state.rewriteSettings));
      } catch {
        // Ignore storage failures; the current page still uses the updated settings.
      }
    }

    function collectRewriteSettingsForm() {
      const llmProvider = document.getElementById('rewriteSettingProvider').value;
      return normalizeRewriteSettings({
        llmProvider,
        profile: document.getElementById('rewriteSettingProfile').value,
        codexModel: document.getElementById('rewriteSettingCodexModel').value.trim(),
        compatibleModel: document.getElementById('rewriteSettingModel').value.trim(),
        baseUrl: document.getElementById('rewriteSettingBaseUrl').value.trim(),
        apiKey: document.getElementById('rewriteSettingApiKey').value,
        prompt: document.getElementById('rewriteSettingPrompt').value
      });
    }

    function setupRewriteSettingsForm() {
      const provider = document.getElementById('rewriteSettingProvider');
      if (provider) {
        provider.addEventListener('change', updateRewriteProviderFields);
        updateRewriteProviderFields();
      }
    }

    function updateRewriteProviderFields() {
      const provider = document.getElementById('rewriteSettingProvider');
      if (!provider) {
        return;
      }
      const value = provider.value || 'codex';
      const codexPanel = document.querySelector('[data-rewrite-settings-panel="codex"]');
      const compatiblePanel = document.querySelector('[data-rewrite-settings-panel="compatible"]');
      if (codexPanel) {
        codexPanel.hidden = value !== 'codex';
      }
      if (compatiblePanel) {
        compatiblePanel.hidden = value === 'codex';
      }
      const baseUrl = document.getElementById('rewriteSettingBaseUrl');
      if (baseUrl) {
        baseUrl.placeholder = value === 'anthropic' ? 'https://api.anthropic.com/v1' : 'https://api.openai.com/v1';
      }
    }

    function setSessionSearchOpen(open) {
      state.sessionSearchOpen = Boolean(open);
      els.sessionSearchRow.hidden = !state.sessionSearchOpen;
      els.toggleSessionSearchButton.setAttribute('aria-expanded', state.sessionSearchOpen ? 'true' : 'false');
      els.toggleSessionSearchButton.classList.toggle('active', state.sessionSearchOpen || Boolean(els.sessionSearch.value.trim()));
      if (state.sessionSearchOpen) {
        setTimeout(() => els.sessionSearch.focus(), 0);
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
      state.selectedTurnId = null;
      state.focusedLine = null;
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
      state.turnFilteredRecords = data.records;
      state.lineScopeRecords = data.records;
      state.turns = data.turns || [];
      state.selectedRecord = null;
      state.selectedTurnId = firstConversationTurnId();
      state.focusedLine = null;
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
      const turnResult = recordsMatchingFilter(state.records, state.turnFilter);
      if (turnResult.error) {
        state.turnFilteredRecords = [];
        state.lineScopeRecords = [];
        state.filteredRecords = [];
        setStatus('Invalid turn regex: ' + turnResult.error.message, 'error');
        renderTurns();
        renderRecords();
        return;
      }

      state.turnFilteredRecords = turnResult.records;
      state.lineScopeRecords = hasTurnFilter() ? recordsInMatchedTurns(state.turnFilteredRecords) : state.records;
      const lineResult = recordsMatchingFilter(state.lineScopeRecords, state.lineFilter);
      if (lineResult.error) {
        state.filteredRecords = [];
        setStatus('Invalid line regex: ' + lineResult.error.message, 'error');
        renderTurns();
        renderRecords();
        return;
      }

      state.filteredRecords = lineResult.records;
      els.clearRecordFilterButton.disabled = !hasTurnFilter();
      els.openFilterButton.textContent = hasTurnFilter() ? '筛选中' : '筛选对话';
      els.clearLineFilterButton.disabled = !hasLineFilter();
      els.openReplaceButton.textContent = hasLineFilter() ? '查找中' : '查找 / 替换 lines';
      if (state.selectedSession) {
        updateRecordHeader(state.records.length);
      }
      renderTurns();
      renderRecords();
    }

    function recordsMatchingFilter(records, filter) {
      const matcher = buildRecordFilterMatcher(filter);
      const roles = Array.isArray(filter.roles) ? filter.roles : [];
      const types = Array.isArray(filter.types) ? filter.types : [];
      const scope = filter.scope || 'all';
      if (matcher && matcher.error) {
        return { records: [], error: matcher.error };
      }
      return {
        records: records.filter((record) => {
          if (roles.length > 0 && !roles.includes(record.role || '')) {
            return false;
          }
          if (types.length > 0 && !types.includes(record.type || '')) {
            return false;
          }
          if (!recordMatchesFindScope(record, scope)) {
            return false;
          }
          if (!matcher) {
            return true;
          }
          return matcher.test(recordSearchText(record));
        })
      };
    }

    function recordsInMatchedTurns(records) {
      const conversationTurnIds = new Set(state.turns.filter((turn) => turn.kind !== 'setup').map((turn) => turn.id));
      const turnIds = new Set(records.map((record) => record.turnId).filter((turnId) => conversationTurnIds.has(turnId)));
      if (turnIds.size === 0) {
        return [];
      }
      return state.records.filter((record) => record.turnId && turnIds.has(record.turnId));
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

    function renderTurns() {
      if (!state.selectedSession) {
        els.turnList.innerHTML = '<div class="empty">Select a session</div>';
        return;
      }

      const hasFilter = hasTurnFilter();
      const filteredCounts = new Map();
      for (const record of state.turnFilteredRecords) {
        if (!record.turnId) {
          continue;
        }
        filteredCounts.set(record.turnId, (filteredCounts.get(record.turnId) || 0) + 1);
      }

      const turns = state.turns.filter((turn) => {
        if (turn.kind === 'setup') {
          return false;
        }
        return !hasFilter || filteredCounts.has(turn.id);
      });

      if (turns.length === 0) {
        state.selectedTurnId = null;
        els.turnList.innerHTML = '<div class="empty">' + (hasFilter ? '没有匹配的对话轮' : 'No conversation turns') + '</div>';
        return;
      }

      if (!state.selectedTurnId || !turns.some((turn) => turn.id === state.selectedTurnId)) {
        state.selectedTurnId = turns[0].id;
        state.focusedLine = null;
      }

      els.turnList.innerHTML = turns.map((turn) => turnItemHtml(turn, filteredCounts.get(turn.id) || 0, hasFilter)).join('');
    }

    function turnItemHtml(turn, matchedLines, hasFilter) {
      const active = state.selectedTurnId === turn.id ? ' active' : '';
      const canTruncate = turn.endLine < state.records.length;
      const source = turn.sourceTurnId ? ' · ' + shortenText(turn.sourceTurnId, 10) : '';
      const lineMeta = 'lines ' + turn.startLine + '-' + turn.endLine + ' · ' + turn.lineCount + ' records' +
        (hasFilter ? ' · match ' + matchedLines : '');
      const user = turn.userText || '无用户文本摘要';
      const assistant = turn.assistantText || '无助手文本摘要';
      return '<div class="turn-item' + active + '" data-select-turn="' + escapeAttr(turn.id) + '" role="button" tabindex="0">' +
        '<div class="turn-item-main">' +
        '<div class="turn-item-head">' +
        '<span class="turn-item-title">' + escapeHtml(turn.label + source) + '</span>' +
        '<span class="turn-line-meta">' + escapeHtml(lineMeta) + '</span>' +
        '</div>' +
        '<div class="turn-messages">' +
        '<div class="turn-message"><b>用户</b><span title="' + escapeAttr(user) + '">' + escapeHtml(user) + '</span></div>' +
        '<div class="turn-message"><b>助手</b><span title="' + escapeAttr(assistant) + '">' + escapeHtml(assistant) + '</span></div>' +
        '</div>' +
        '</div>' +
        '<div class="turn-item-actions">' +
        '<button class="icon compact" data-edit-turn="' + escapeAttr(turn.id) + '" title="修改这轮对话" aria-label="修改这轮对话"' + (turn.editableTargetCount ? '' : ' disabled') + '><span class="turn-action-mark" aria-hidden="true">✎</span></button>' +
        '<button class="icon danger compact" data-truncate-turn="' + escapeAttr(turn.id) + '" title="回退到此处" aria-label="回退到此处"' + (canTruncate ? '' : ' disabled') + '><span class="turn-action-mark" aria-hidden="true">↩</span></button>' +
        '</div>' +
        '</div>';
    }

    function lineDetailRecords() {
      const records = state.filteredRecords.slice();
      if (!state.selectedTurnId) {
        return records;
      }
      const turn = state.turns.find((item) => item.id === state.selectedTurnId);
      if (!turn) {
        return records;
      }
      if (state.focusedLine !== turn.startLine) {
        return records;
      }
      const startRecord = state.records.find((record) => record.line === turn.startLine);
      if (startRecord && !records.some((record) => record.line === startRecord.line)) {
        records.push(startRecord);
        records.sort((a, b) => a.line - b.line);
      }
      return records;
    }

    function renderRecords() {
      els.recordDetail.classList.toggle('open', state.lineDetailsOpen);
      els.toggleLineDetailsButton.setAttribute('aria-expanded', state.lineDetailsOpen ? 'true' : 'false');
      const filtered = state.filteredRecords.length;
      const total = state.records.length;
      const turnScopedTotal = hasTurnFilter() ? state.lineScopeRecords.length : total;
      const detailHint = state.lineDetailsOpen ? '已展开完整 JSONL 行' : '展开查看完整 JSONL 行';
      const countText = hasLineFilter()
        ? filtered + ' / ' + turnScopedTotal + ' lines'
        : (hasTurnFilter() ? turnScopedTotal + ' / ' + total + ' lines' : total + ' lines');
      const filterHint = [
        hasTurnFilter() ? 'Turn 筛选范围' : '',
        hasLineFilter() ? 'Lines 查找' : ''
      ].filter(Boolean).join(' + ');
      els.lineDetailMeta.textContent = state.selectedSession
        ? countText + ' · ' + (filterHint ? filterHint + ' · ' : '') + detailHint
        : '完整记录表默认收起';

      if (!state.selectedSession) {
        els.recordList.innerHTML = '<div class="empty">Select a session</div>';
        return;
      }
      if (!state.lineDetailsOpen) {
        els.recordList.innerHTML = '';
        return;
      }
      const detailRecords = lineDetailRecords();
      if (detailRecords.length === 0) {
        els.recordList.innerHTML = '<div class="empty">No records</div>';
        return;
      }

      const rows = [];
      for (const record of detailRecords) {
        const classes = ['record-row', 'turn-shade-' + (record.turnIndex % 2 === 0 ? '0' : '1')];
        if (record.messageSide) {
          classes.push('side-' + record.messageSide);
        }
        if (state.selectedRecord && state.selectedRecord.line === record.line) {
          classes.push('selected');
        }
        if (state.focusedLine === record.line) {
          classes.push('focused-line');
        }
        const kind = record.payloadType ? record.type + ':' + record.payloadType : record.type;
        rows.push('<tr class="' + classes.join(' ') + '" data-line="' + record.line + '">' +
          '<td class="line-col">' + record.line + '</td>' +
          '<td class="type-col clip"><span class="record-kind">' + escapeHtml(kind) + '</span></td>' +
          '<td class="role-col clip"><span class="role-badge">' + escapeHtml(record.role || '-') + '</span></td>' +
          '<td class="clip">' + escapeHtml(record.text || '') + '</td>' +
          '</tr>');
      }
      els.recordList.innerHTML =
        '<table><thead><tr>' +
        recordHeader('line-col', 'Line', 'line') +
        recordHeader('type-col', 'Type', 'type') +
        recordHeader('role-col', 'Role', 'role') +
        '<th class="text-col">Text</th>' +
        '</tr></thead><tbody>' + rows.join('') + '</tbody></table>';
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
      state.selectedTurnId = record.turnId || state.selectedTurnId;
      state.focusedLine = null;
      state.dirty = false;
      renderTurns();
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
      const turnFilteredIndex = state.turnFilteredRecords.findIndex((item) => item.line === line);
      if (turnFilteredIndex !== -1) {
        state.turnFilteredRecords[turnFilteredIndex] = nextRecord;
      }
      const lineScopeIndex = state.lineScopeRecords.findIndex((item) => item.line === line);
      if (lineScopeIndex !== -1) {
        state.lineScopeRecords[lineScopeIndex] = nextRecord;
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
      const scopedLines = hasTurnFilter() ? state.lineScopeRecords.map((record) => record.line) : null;
      const result = await api(sessionApiPath(state.selectedSession, '/replace'), {
        method: 'POST',
        body: JSON.stringify({
          from: options.from,
          to: options.to,
          scope: options.scope,
          regex: options.regex,
          caseSensitive: options.caseSensitive,
          lines: scopedLines,
          allowActive: els.allowActive.checked
        })
      });
      const suffix = scopedLines ? ' in current Turn filter' : '';
      setStatus('Replaced ' + result.replacements + ' occurrence(s)' + suffix + '. Backup: ' + (result.backup ? result.backup.backupPath : '-'), 'ok', true);
      await loadRecords();
    }

    function findLines(options) {
      if (!state.selectedSession || !options || !options.from) {
        return;
      }
      state.lineFilter = {
        query: options.from,
        roles: [],
        types: [],
        scope: options.scope || 'all',
        regex: Boolean(options.regex),
        caseSensitive: Boolean(options.caseSensitive)
      };
      state.lineDetailsOpen = true;
      filterRecords();
      const found = state.filteredRecords.length;
      const suffix = hasTurnFilter() ? ' in current Turn filter.' : '.';
      setStatus('Found ' + found + ' JSONL line(s)' + suffix, found > 0 ? 'ok' : '', true);
    }

    async function openTurnEditModal(turnId) {
      if (!state.selectedSession) {
        return;
      }
      await loadProfiles();
      const data = await api(sessionApiPath(state.selectedSession, '/turns/' + encodeURIComponent(turnId) + '/edit'));
      const groups = data.groups || [];
      if (groups.length === 0) {
        showToast('这一轮没有可快速修改的用户/助手消息', 'error');
        return;
      }
      const result = await openModal({
        kicker: 'Edit conversation',
        title: (data.turn ? data.turn.label : 'Turn') + ' · 快速修改',
        body: turnEditModalBody(data),
        size: 'wide',
        confirmText: '保存修改',
        cancelText: '取消',
        afterOpen: () => setupTurnEditRewriteControls(turnId),
        collect: () => ({
          edits: Array.from(document.querySelectorAll('[data-turn-edit-group]')).map((textarea) => ({
            id: textarea.dataset.turnEditGroup,
            text: textarea.value
          }))
        }),
      });
      if (!result) {
        return;
      }
      await saveTurnMessages(turnId, result.edits);
    }

    function setupTurnEditRewriteControls(turnId) {
      for (const textarea of document.querySelectorAll('[data-turn-edit-group]')) {
        textarea.addEventListener('input', () => updateTurnRestoreButton(textarea.dataset.turnEditGroup));
      }
      for (const button of document.querySelectorAll('[data-rewrite-group]')) {
        button.addEventListener('click', () => openRewritePromptPopover(turnId, button));
      }
      for (const button of document.querySelectorAll('[data-restore-rewrite-group]')) {
        button.addEventListener('click', () => {
          if (state.turnRewriteBusy) {
            showToast('改写进行中，请等待完成', 'error');
            return;
          }
          const id = button.dataset.restoreRewriteGroup;
          const input = document.querySelector('[data-turn-edit-group="' + cssEscape(id) + '"]');
          if (input) {
            input.value = input.dataset.originalText || '';
            updateTurnRestoreButton(id);
          }
        });
      }
    }

    function updateTurnRestoreButton(id) {
      const input = document.querySelector('[data-turn-edit-group="' + cssEscape(id) + '"]');
      const restoreButton = document.querySelector('[data-restore-rewrite-group="' + cssEscape(id) + '"]');
      if (input && restoreButton) {
        restoreButton.disabled = Boolean(state.turnRewriteBusy) || input.value === (input.dataset.originalText || '');
      }
    }

    function openRewritePromptPopover(turnId, button) {
      closeRewritePromptPopover();
      const id = button.dataset.rewriteGroup;
      const input = document.querySelector('[data-turn-edit-group="' + cssEscape(id) + '"]');
      if (!input || !input.value.trim()) {
        showToast('没有可改写的文本', 'error');
        return;
      }
      const popover = document.createElement('div');
      popover.className = 'rewrite-popover';
      popover.id = 'rewritePromptPopover';
      popover.innerHTML =
        '<div class="modal-field">' +
        '<label for="rewritePromptInput">改写提示词</label>' +
        '<textarea id="rewritePromptInput">' + escapeHtml((state.rewriteSettings && state.rewriteSettings.prompt) || DEFAULT_REWRITE_PROMPT) + '</textarea>' +
        '</div>' +
        '<div class="modal-inline">' +
        '<button type="button" class="primary compact" id="rewritePromptRun">改写</button>' +
        '<button type="button" class="compact" id="rewritePromptCancel">取消</button>' +
        '</div>';
      document.body.appendChild(popover);
      const rect = button.getBoundingClientRect();
      const width = Math.min(380, window.innerWidth - 24);
      const left = Math.max(12, Math.min(rect.left, window.innerWidth - width - 12));
      const top = Math.max(12, Math.min(rect.bottom + 8, window.innerHeight - 260));
      popover.style.width = width + 'px';
      popover.style.left = left + 'px';
      popover.style.top = top + 'px';
      document.getElementById('rewritePromptCancel').addEventListener('click', closeRewritePromptPopover);
      document.getElementById('rewritePromptRun').addEventListener('click', () => {
        const prompt = document.getElementById('rewritePromptInput').value;
        closeRewritePromptPopover();
        rewriteTurnEditGroup(turnId, button, prompt).catch(handleError);
      });
      setTimeout(() => document.getElementById('rewritePromptInput').focus(), 0);
    }

    function closeRewritePromptPopover() {
      const popover = document.getElementById('rewritePromptPopover');
      if (popover) {
        popover.remove();
      }
    }

    async function rewriteTurnEditGroup(turnId, button, prompt) {
      const id = button.dataset.rewriteGroup;
      const input = document.querySelector('[data-turn-edit-group="' + cssEscape(id) + '"]');
      if (!input || !input.value.trim()) {
        showToast('没有可改写的文本', 'error');
        return;
      }
      setTurnRewriteBusy(id, true);
      setStatus('正在改写文本...', 'ok');
      try {
        const result = await api(sessionApiPath(state.selectedSession, '/turns/' + encodeURIComponent(turnId) + '/rewrite-text'), {
          method: 'POST',
          body: JSON.stringify(collectTurnRewriteOptions(input.value, button.dataset.rewriteSide, prompt))
        });
        input.value = result.output || input.value;
        updateTurnRestoreButton(id);
        animateTurnRewriteReplacement(input);
        setStatus('改写完成，保存弹窗后才会写回 session。', 'ok', true);
      } catch (error) {
        handleError(error);
      } finally {
        setTurnRewriteBusy(id, false);
      }
    }

    function setTurnRewriteBusy(id, busy) {
      state.turnRewriteBusy = busy ? id : '';
      els.modalLayer.classList.toggle('rewrite-running', busy);
      els.modalConfirmButton.disabled = busy;
      els.modalCancelButton.disabled = busy;
      els.modalCloseButton.disabled = busy;

      for (const textarea of document.querySelectorAll('[data-turn-edit-group]')) {
        textarea.disabled = busy;
      }
      for (const row of document.querySelectorAll('[data-turn-edit-row]')) {
        row.classList.toggle('is-rewriting', busy && row.dataset.turnEditRow === id);
      }
      for (const rewriteButton of document.querySelectorAll('[data-rewrite-group]')) {
        const isCurrent = rewriteButton.dataset.rewriteGroup === id;
        rewriteButton.disabled = busy;
        rewriteButton.classList.toggle('is-rewriting', busy && isCurrent);
        rewriteButton.textContent = busy && isCurrent ? '改写中' : '改写';
      }
      for (const restoreButton of document.querySelectorAll('[data-restore-rewrite-group]')) {
        restoreButton.disabled = busy || !isTurnEditGroupChanged(restoreButton.dataset.restoreRewriteGroup);
      }
    }

    function isTurnEditGroupChanged(id) {
      const input = document.querySelector('[data-turn-edit-group="' + cssEscape(id) + '"]');
      return Boolean(input && input.value !== (input.dataset.originalText || ''));
    }

    function animateTurnRewriteReplacement(input) {
      input.classList.remove('rewrite-replaced');
      void input.offsetWidth;
      input.classList.add('rewrite-replaced');
      window.setTimeout(() => input.classList.remove('rewrite-replaced'), 950);
    }

    function collectTurnRewriteOptions(text, side, prompt) {
      const settings = state.rewriteSettings || defaultRewriteSettings();
      return {
        text,
        side,
        llmProvider: settings.llmProvider,
        profile: settings.profile,
        model: settings.llmProvider === 'codex' ? settings.codexModel : settings.compatibleModel,
        prompt: String(prompt || '').trim() || settings.prompt || DEFAULT_REWRITE_PROMPT,
        baseUrl: settings.baseUrl,
        apiKey: settings.apiKey
      };
    }

    async function saveTurnMessages(turnId, edits) {
      if (!state.selectedSession) {
        return;
      }
      setStatus('Saving conversation turn...');
      const result = await api(sessionApiPath(state.selectedSession, '/turns/' + encodeURIComponent(turnId) + '/edit'), {
        method: 'PUT',
        body: JSON.stringify({
          edits,
          allowActive: els.allowActive.checked
        })
      });
      state.dirty = false;
      setStatus(
        'Updated ' + result.changedGroups + ' message group(s), ' + result.changedTargets + ' target(s). Backup: ' +
          (result.backup ? result.backup.backupPath : '-'),
        'ok',
        true
      );
      await loadRecords();
    }

    async function truncateAfterTurn(turnId) {
      if (!state.selectedSession) {
        return;
      }
      const turn = state.turns.find((item) => item.id === turnId);
      if (!turn) {
        return;
      }
      if (!(await confirmTruncateTurn(turn))) {
        return;
      }
      setStatus('Rolling back conversation...');
      const result = await api(sessionApiPath(state.selectedSession, '/turns/' + encodeURIComponent(turnId) + '/truncate'), {
        method: 'POST',
        body: JSON.stringify({
          allowActive: els.allowActive.checked
        })
      });
      state.dirty = false;
      setStatus('Deleted ' + result.removedLines.length + ' later line(s). Backup: ' + (result.backup ? result.backup.backupPath : '-'), 'ok', true);
      await loadRecords();
      await loadSessions();
    }

    async function openFilterModal() {
      if (!state.selectedSession) {
        return;
      }
      const result = await openModal({
        kicker: 'Filter conversations',
        title: '筛选对话',
        body: filterModalBody(),
        confirmText: '应用筛选',
        cancelText: '取消',
        collect: () => {
          const query = document.getElementById('modalFilterQuery').value.trim();
          const regex = document.getElementById('modalFilterRegex').checked;
          const error = document.getElementById('modalFilterError');
          if (query && !validateFindPattern(query, regex, error)) {
            return false;
          }
          return {
            query,
            roles: checkedValues('[data-filter-role]'),
            types: checkedValues('[data-filter-type]'),
            scope: document.getElementById('modalFilterScope').value,
            regex,
            caseSensitive: document.getElementById('modalFilterCaseSensitive').checked,
          };
        },
      });
      if (!result) {
        return;
      }
      state.turnFilter = result;
      filterRecords();
    }

    async function openReplaceModal() {
      if (!state.selectedSession) {
        return;
      }
      const result = await openModal({
        kicker: 'Find and replace lines',
        title: '查找 / 替换 JSONL lines',
        body: replaceModalBody(),
        confirmText: '查找',
        cancelText: '取消',
        afterOpen: setupFindReplaceModal,
        collect: () => {
          const from = document.getElementById('modalReplaceFrom').value;
          const regex = document.getElementById('modalReplaceRegex').checked;
          const error = document.getElementById('modalReplaceError');
          if (!validateFindPattern(from, regex, error)) {
            return false;
          }
          return {
            from,
            to: document.getElementById('modalReplaceTo').value,
            scope: document.getElementById('modalReplaceScope').value,
            regex,
            caseSensitive: document.getElementById('modalReplaceCaseSensitive').checked,
            replaceEnabled: document.getElementById('modalReplaceEnabled').checked,
          };
        },
      });
      if (result) {
        if (result.replaceEnabled) {
          await replaceText(result);
        } else {
          findLines(result);
        }
      }
    }

    function clearRecordFilter() {
      state.turnFilter = blankRecordFilter();
      filterRecords();
    }

    function clearLineFilter() {
      state.lineFilter = blankRecordFilter();
      filterRecords();
    }

    function firstConversationTurnId() {
      const turn = state.turns.find((item) => item.kind !== 'setup');
      return turn ? turn.id : null;
    }

    function selectTurn(turnId, options = {}) {
      const turn = state.turns.find((item) => item.id === turnId);
      if (!turn) {
        return;
      }
      state.selectedTurnId = turn.id;
      if (options.scrollLines) {
        state.lineDetailsOpen = true;
        state.focusedLine = turn.startLine;
      }
      renderTurns();
      renderRecords();
      if (options.scrollLines) {
        scrollRecordLineIntoView(turn.startLine);
      }
    }

    function scrollRecordLineIntoView(line) {
      window.requestAnimationFrame(() => {
        const row = els.recordList.querySelector('[data-line="' + line + '"]');
        if (row) {
          row.scrollIntoView({ block: 'center' });
        }
      });
    }

    function recordSearchText(record) {
      return [
        record.line,
        record.turnLabel,
        record.turnId,
        record.messageSide,
        record.type,
        record.payloadType,
        record.role,
        record.text,
        record.timestamp,
        record.json
      ].join(' ');
    }

    function buildRecordFilterMatcher(filter) {
      const query = String(filter.query || '').trim();
      if (!query) {
        return null;
      }
      if (filter.regex) {
        try {
          const regex = new RegExp(query, filter.caseSensitive ? '' : 'i');
          return {
            test(value) {
              regex.lastIndex = 0;
              return regex.test(value);
            }
          };
        } catch (error) {
          return { error };
        }
      }
      const needle = filter.caseSensitive ? query : query.toLowerCase();
      return {
        test(value) {
          const haystack = filter.caseSensitive ? String(value || '') : String(value || '').toLowerCase();
          return haystack.includes(needle);
        }
      };
    }

    function recordMatchesFindScope(record, scope) {
      if (!scope || scope === 'all') {
        return true;
      }
      const role = String(record.role || '').toLowerCase();
      const type = String(record.payloadType || record.type || '').toLowerCase();
      const recordType = String(record.type || '').toLowerCase();
      if (scope === 'messages') {
        return Boolean(role) || recordType === 'response_item' || recordType === 'event_msg';
      }
      if (scope === 'metadata') {
        return recordType === 'session_meta' || recordType === 'turn_context';
      }
      if (['user', 'assistant', 'system', 'tool'].includes(scope)) {
        return role === scope || type.includes(scope);
      }
      return true;
    }

    function validateFindPattern(pattern, regex, error) {
      if (error) {
        error.classList.remove('show');
      }
      if (!pattern) {
        if (error) {
          error.textContent = '请输入要查找的文本。';
          error.classList.add('show');
        }
        return false;
      }
      if (regex) {
        try {
          new RegExp(pattern);
        } catch (regexError) {
          if (error) {
            error.textContent = '正则无效: ' + regexError.message;
            error.classList.add('show');
          }
          return false;
        }
      }
      return true;
    }

    function setupFindReplaceModal() {
      const enabled = document.getElementById('modalReplaceEnabled');
      const replaceInput = document.getElementById('modalReplaceTo');
      if (!enabled || !replaceInput) {
        return;
      }
      const update = () => {
        replaceInput.disabled = !enabled.checked;
        els.modalConfirmButton.textContent = enabled.checked ? '执行替换' : '查找';
        els.modalConfirmButton.className = (enabled.checked ? 'danger' : 'primary') + ' compact';
      };
      enabled.addEventListener('change', update);
      update();
    }

    function blankRecordFilter() {
      return { query: '', roles: [], types: [], scope: 'all', regex: false, caseSensitive: false };
    }

    function hasTurnFilter() {
      return hasRecordFilter(state.turnFilter);
    }

    function hasLineFilter() {
      return hasRecordFilter(state.lineFilter);
    }

    function hasRecordFilter(filter) {
      return Boolean(
        filter.query ||
        (filter.scope && filter.scope !== 'all') ||
        (Array.isArray(filter.roles) && filter.roles.length > 0) ||
        (Array.isArray(filter.types) && filter.types.length > 0)
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
      state.turnFilteredRecords = [];
      state.lineScopeRecords = [];
      state.turns = [];
      state.selectedTurnId = null;
      state.focusedLine = null;
      state.operationHistory = [];
      state.selectedRecord = null;
      state.turnFilter = blankRecordFilter();
      state.lineFilter = blankRecordFilter();
      state.dirty = false;
      state.lineDetailsOpen = false;
      renderOperationHistory();
      clearEditor();
      els.reloadRecords.disabled = true;
      els.dropLinesButton.disabled = true;
      els.openFilterButton.disabled = true;
      els.openReplaceButton.disabled = true;
      els.clearRecordFilterButton.disabled = true;
      els.clearLineFilterButton.disabled = true;
      els.recordTitle.textContent = 'Records';
      els.recordMeta.textContent = 'Select a session';
      els.recordPath.textContent = '';
      els.recordPathRow.hidden = true;
      els.copyRecordPathButton.disabled = true;
      delete els.copyRecordPathButton.dataset.copyPath;
      els.turnList.innerHTML = '<div class="empty">Select a session</div>';
      els.recordDetail.classList.remove('open');
      els.toggleLineDetailsButton.setAttribute('aria-expanded', 'false');
      els.lineDetailMeta.textContent = '完整记录表默认收起';
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
      els.modalConfirmButton.disabled = false;
      els.modalCancelButton.disabled = false;
      els.modalCloseButton.disabled = false;
      state.turnRewriteBusy = '';
      state.modalCollect = options.collect || null;
      els.modalLayer.classList.toggle('wide', options.size === 'wide');
      els.modalLayer.classList.remove('rewrite-running');
      els.modalLayer.classList.add('open');
      els.modalLayer.setAttribute('aria-hidden', 'false');
      if (typeof options.afterOpen === 'function') {
        options.afterOpen();
      }
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
      closeRewritePromptPopover();
      els.modalLayer.classList.remove('open');
      els.modalLayer.classList.remove('wide');
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
      if (state.turnRewriteBusy) {
        showToast('改写进行中，完成后才能保存', 'error');
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

    function confirmTruncateTurn(turn) {
      const removeCount = Math.max(0, state.records.length - turn.endLine);
      if (removeCount === 0) {
        showToast('这一轮后面没有可删除的记录', 'error');
        return false;
      }
      return openModal({
        kicker: 'Rollback conversation',
        title: '回退到 ' + turn.label + '？',
        body: '<p>这会删除当前 session 中该轮之后的所有 JSONL 行，并在写入前自动创建备份。</p>' +
          '<div class="modal-note">保留 lines 1-' + escapeHtml(String(turn.endLine)) +
          '，删除 lines ' + escapeHtml(String(turn.endLine + 1)) + '-' + escapeHtml(String(state.records.length)) +
          '（共 ' + escapeHtml(String(removeCount)) + ' 行）。</div>',
        confirmText: '删除后续记录',
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

    function systemSettingsModalBody(configs, profile) {
      return '<div class="settings-shell">' +
        '<div class="settings-tabs" role="tablist">' +
        '<button type="button" class="settings-tab" data-settings-tab="profiles">Profiles</button>' +
        '<button type="button" class="settings-tab" data-settings-tab="rewrite">改写 AI</button>' +
        '</div>' +
        '<div class="settings-panel" data-settings-panel="profiles">' +
        profileModalBody(configs, profile) +
        '</div>' +
        '<div class="settings-panel" data-settings-panel="rewrite" hidden>' +
        rewriteSettingsPanel() +
        '</div>' +
        '</div>';
    }

    function profileModalBody(configs, profile) {
      const fields = profile.fields || {};
      const instructionText = fields.instructions || '';
      return '<div class="modal-grid">' +
        '<p>Profile 文件会保存为 <code>~/.codex/&lt;name&gt;.config.toml</code>，不会修改默认 <code>config.toml</code>。</p>' +
        '<div class="modal-field">' +
        '<label for="profileSelector">当前配置</label>' +
        '<select id="profileSelector">' + profileSelectorOptions(configs, profile.name || 'default') + '</select>' +
        '</div>' +
        '<div class="modal-inline">' +
        '<button type="button" class="compact" id="profileNewButton">新建 profile</button>' +
        '<button type="button" class="danger compact" id="profileDeleteButton">删除当前 profile</button>' +
        '</div>' +
        '<input type="hidden" id="profileKind" value="' + escapeAttr(profile.kind || 'profile') + '">' +
        '<input type="hidden" id="profileEditable" value="' + (profile.editable ? '1' : '0') + '">' +
        '<input type="hidden" id="profileDeletable" value="' + (profile.deletable ? '1' : '0') + '">' +
        '<div class="modal-field">' +
        '<label for="profileNameInput">Profile 名称</label>' +
        '<input id="profileNameInput" value="' + escapeAttr(profile.name || '') + '" placeholder="ctf / deep-review">' +
        '<div class="modal-error" id="profileModalError">Profile 名无效。</div>' +
        '<div class="meta" id="profileActivationHint"></div>' +
        '</div>' +
        '<div class="modal-inline">' +
        checkboxHtml('instructions', '同步到 instructions', 'id="profileUseInstructions"', instructionText ? ['instructions'] : []) +
        checkboxHtml('model', '写入 model_instructions_file（高级）', 'id="profileUseModelInstructions"', fields.model_instructions_file ? ['model'] : []) +
        '</div>' +
        '<div class="modal-field">' +
        '<label for="profileInstructions">默认提示词（instructions）</label>' +
        '<textarea id="profileInstructions" placeholder="额外注入到会话中的默认指令">' + escapeHtml(instructionText) + '</textarea>' +
        '</div>' +
        '<div class="modal-field">' +
        '<label for="profileModelInstructions">覆盖内置 model instructions（高级）</label>' +
        '<textarea id="profileModelInstructions" placeholder="启用后会保存到 ~/.codex/prompts/<profile>-model-instructions.md，并写入 model_instructions_file">' + escapeHtml(profile.modelInstructionsText || '') + '</textarea>' +
        '<div class="modal-note">官方不建议随意覆盖内置 model instructions；一般默认提示词优先使用 instructions。</div>' +
        '</div>' +
        '<div class="modal-field">' +
        '<label for="profileRawToml">Raw TOML</label>' +
        '<textarea class="raw-config" id="profileRawToml" spellcheck="false">' + escapeHtml(profile.raw || defaultProfileRaw()) + '</textarea>' +
        '</div>' +
        '</div>';
    }

    function profileSelectorOptions(configs, selectedName) {
      return '<option value="">新建 profile...</option>' + configs.map((item) => {
        const title = item.kind === 'default' ? '默认 config.toml' : item.name;
        const suffix = item.kind === 'default' ? ('只读 · ' + (item.exists ? '已存在' : '未创建')) : (item.size || 'profile');
        return optionHtml(item.name, title + ' · ' + suffix, selectedName);
      }).join('');
    }

    function rewriteSettingsPanel() {
      const settings = state.rewriteSettings || defaultRewriteSettings();
      let profileOptions = optionHtml('', '默认 config.toml', settings.profile);
      if (settings.profile && !state.profiles.some((profile) => profile.name === settings.profile)) {
        profileOptions += optionHtml(settings.profile, settings.profile + '（未找到）', settings.profile);
      }
      profileOptions += state.profiles.map((profile) => optionHtml(profile.name, profile.name, settings.profile)).join('');
      return '<div class="modal-grid">' +
        '<div class="modal-field">' +
        '<label for="rewriteSettingProvider">LLM 后端</label>' +
        '<select id="rewriteSettingProvider">' +
        optionHtml('codex', '本地 Codex（默认）', settings.llmProvider) +
        optionHtml('openai', 'OpenAI compatible', settings.llmProvider) +
        optionHtml('anthropic', 'Anthropic compatible', settings.llmProvider) +
        '</select>' +
        '</div>' +
        '<div class="modal-grid settings-subpanel" data-rewrite-settings-panel="codex">' +
        '<div class="modal-note">默认使用本地 <code>codex exec --ephemeral</code> 完成改写；这里可以选择叠加哪个 Codex profile。</div>' +
        '<div class="modal-inline">' +
        '<div class="modal-field" style="min-width: 180px; flex: 1">' +
        '<label for="rewriteSettingProfile">Codex profile</label>' +
        '<select id="rewriteSettingProfile">' + profileOptions + '</select>' +
        '</div>' +
        '<div class="modal-field" style="min-width: 180px; flex: 1">' +
        '<label for="rewriteSettingCodexModel">临时 model 覆盖</label>' +
        '<input id="rewriteSettingCodexModel" value="' + escapeAttr(settings.codexModel) + '" placeholder="留空则使用所选配置">' +
        '</div>' +
        '</div>' +
        '</div>' +
        '<div class="modal-grid settings-subpanel" data-rewrite-settings-panel="compatible" hidden>' +
        '<div class="modal-inline">' +
        '<div class="modal-field" style="min-width: 180px; flex: 1">' +
        '<label for="rewriteSettingBaseUrl">Base URL</label>' +
        '<input id="rewriteSettingBaseUrl" value="' + escapeAttr(settings.baseUrl) + '" placeholder="https://api.openai.com/v1">' +
        '</div>' +
        '<div class="modal-field" style="min-width: 180px; flex: 1">' +
        '<label for="rewriteSettingApiKey">API key</label>' +
        '<input id="rewriteSettingApiKey" type="password" value="' + escapeAttr(settings.apiKey) + '" placeholder="本地兼容服务可留空">' +
        '</div>' +
        '</div>' +
        '<div class="modal-field">' +
        '<label for="rewriteSettingModel">Model</label>' +
        '<input id="rewriteSettingModel" value="' + escapeAttr(settings.compatibleModel) + '" placeholder="gpt-4.1 / claude-sonnet-4-5">' +
        '</div>' +
        '</div>' +
        '<div class="modal-field">' +
        '<label for="rewriteSettingPrompt">默认改写提示词</label>' +
        '<textarea id="rewriteSettingPrompt">' + escapeHtml(settings.prompt || DEFAULT_REWRITE_PROMPT) + '</textarea>' +
        '</div>' +
        '</div>';
    }

    function turnEditModalBody(data) {
      const turn = data.turn || {};
      const groups = data.groups || [];
      return '<p>' + escapeHtml([
        'lines ' + turn.startLine + '-' + turn.endLine,
        (turn.userTargetCount || 0) + ' user target(s)',
        (turn.assistantTargetCount || 0) + ' assistant target(s)'
      ].join(' · ')) + ' ' +
        helpIcon('相同文本的重复表示会合并在一个输入框里，保存时同步写回对应的 event_msg / response_item / task_complete 记录。') +
        '</p>' +
        turnEditSection('用户输入', groups.filter((group) => group.side === 'user')) +
        turnEditSection('助手输出', groups.filter((group) => group.side === 'assistant'));
    }

    function turnEditSection(title, groups) {
      const rows = groups.map((group, index) => {
        const lineLabel = 'lines ' + group.lines.join(', ') + ' · ' + group.targetCount + ' target(s)';
        const side = group.side || (title === '用户输入' ? 'user' : 'assistant');
        const text = group.text || '';
        return '<div class="modal-field turn-edit-row" data-turn-edit-row="' + escapeAttr(group.id) + '">' +
          '<div class="turn-edit-row-head">' +
          '<label>' + escapeHtml(title + ' ' + (index + 1)) +
          ' <span class="turn-edit-target">' + escapeHtml(lineLabel) + '</span></label>' +
          '<div class="modal-inline turn-edit-actions">' +
          '<button type="button" class="primary compact" data-rewrite-group="' + escapeAttr(group.id) +
          '" data-rewrite-side="' + escapeAttr(side) + '">改写</button>' +
          '<button type="button" class="compact" data-restore-rewrite-group="' + escapeAttr(group.id) + '" disabled>恢复</button>' +
          '</div>' +
          '</div>' +
          '<textarea data-turn-edit-group="' + escapeAttr(group.id) + '" data-original-text="' + escapeAttr(text) + '">' + escapeHtml(text) + '</textarea>' +
          '<div class="turn-edit-progress" data-rewrite-progress="' + escapeAttr(group.id) + '">' +
          '<span class="turn-edit-progress-track" aria-hidden="true"></span>' +
          '<span class="turn-edit-progress-text">正在改写</span>' +
          '</div>' +
          '</div>';
      }).join('');
      return '<div class="turn-edit-section">' +
        '<div class="turn-edit-section-title">' + escapeHtml(title) + '</div>' +
        (rows || '<div class="empty">没有可修改的' + escapeHtml(title) + '</div>') +
        '</div>';
    }

    function filterModalBody() {
      const roles = Array.isArray(state.turnFilter.roles) ? state.turnFilter.roles : [];
      const types = Array.isArray(state.turnFilter.types) ? state.turnFilter.types : [];
      return '<div class="modal-grid">' +
        '<div class="modal-field">' +
        '<label for="modalFilterQuery">查找文本 ' +
        helpIcon('筛选条件作用在 Turn 主视图上；Lines 明细会跟随这个上层范围，但 Lines 查找不会反向改变 Turn 列表。') +
        '</label>' +
        '<input id="modalFilterQuery" value="' + escapeAttr(state.turnFilter.query) + '" placeholder="搜索 JSONL line / 预览 / 类型 / 时间">' +
        '<div class="modal-error" id="modalFilterError">请输入有效的查找文本。</div>' +
        '</div>' +
        '<div class="modal-inline">' +
        checkboxHtml('case', '区分大小写', 'id="modalFilterCaseSensitive" data-filter-option', state.turnFilter.caseSensitive ? ['case'] : []) +
        checkboxHtml('regex', '正则', 'id="modalFilterRegex" data-filter-option', state.turnFilter.regex ? ['regex'] : []) +
        '</div>' +
        '<div class="modal-field">' +
        '<label for="modalFilterScope">查找范围</label>' +
        '<select id="modalFilterScope">' +
        optionHtml('all', 'all JSONL lines', state.turnFilter.scope || 'all') +
        optionHtml('messages', 'messages', state.turnFilter.scope || 'all') +
        optionHtml('user', 'user', state.turnFilter.scope || 'all') +
        optionHtml('assistant', 'assistant', state.turnFilter.scope || 'all') +
        optionHtml('system', 'system', state.turnFilter.scope || 'all') +
        optionHtml('tool', 'tool', state.turnFilter.scope || 'all') +
        optionHtml('metadata', 'metadata', state.turnFilter.scope || 'all') +
        '</select>' +
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
        '</div>';
    }

    function replaceModalBody() {
      const lineFilter = state.lineFilter || blankRecordFilter();
      const selectedScope = hasLineFilter() ? (lineFilter.scope || 'messages') : 'messages';
      return '<div class="modal-grid">' +
        '<div class="modal-field">' +
        '<label for="modalReplaceFrom">查找 ' +
        helpIcon('默认只查找并筛选底部 Lines，不写文件，也不会改变 Turn 列表；如上方有 Turn 筛选，查找和替换都只在该范围内执行。') +
        '</label>' +
        '<input id="modalReplaceFrom" value="' + escapeAttr(lineFilter.query) + '" placeholder="Find">' +
        '<div class="modal-error" id="modalReplaceError">请输入要查找的文本。</div>' +
        '</div>' +
        '<div class="modal-inline">' +
        checkboxHtml('case', '区分大小写', 'id="modalReplaceCaseSensitive" data-find-replace-option', lineFilter.caseSensitive ? ['case'] : []) +
        checkboxHtml('regex', '正则', 'id="modalReplaceRegex" data-find-replace-option', lineFilter.regex ? ['regex'] : []) +
        '<label class="switch"><input type="checkbox" id="modalReplaceEnabled"><span>启用替换</span></label>' +
        '</div>' +
        '<div class="modal-field">' +
        '<label for="modalReplaceScope">查找范围</label>' +
        '<select id="modalReplaceScope">' +
        optionHtml('messages', 'messages', selectedScope) +
        optionHtml('user', 'user', selectedScope) +
        optionHtml('assistant', 'assistant', selectedScope) +
        optionHtml('system', 'system', selectedScope) +
        optionHtml('tool', 'tool', selectedScope) +
        optionHtml('metadata', 'metadata', selectedScope) +
        optionHtml('all', 'all JSONL lines', selectedScope) +
        '</select>' +
        '</div>' +
        '<div class="modal-field">' +
        '<label for="modalReplaceTo">替换为</label>' +
        '<input id="modalReplaceTo" placeholder="Replace" disabled>' +
        '</div>' +
        '</div>';
    }

    function helpIcon(text) {
      return '<span class="help-icon" tabindex="0" title="' + escapeAttr(text) + '">i</span>';
    }

    function recordTypeChoices() {
      const types = Array.isArray(state.turnFilter.types) ? state.turnFilter.types : [];
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

    function restoreAllowActive() {
      let enabled = false;
      try {
        enabled = localStorage.getItem(ALLOW_ACTIVE_KEY) === 'true';
      } catch {
        enabled = false;
      }
      setAllowActive(enabled, { persist: false });
    }

    function setAllowActive(enabled, options = {}) {
      els.allowActive.checked = Boolean(enabled);
      if (options.persist !== false) {
        try {
          localStorage.setItem(ALLOW_ACTIVE_KEY, String(els.allowActive.checked));
        } catch {
          // Ignore storage failures; the current page still uses the updated switch state.
        }
      }
      applyAllowActive();
    }

    function applyAllowActive() {
      const enabled = els.allowActive.checked;
      const title = enabled
        ? '已允许修改活跃 session。仅在确认 Codex 不再写入该文件时使用。'
        : '禁止修改最近活跃 session。点击后允许写入最近 ' + boot.activeWindowMinutes + ' 分钟内更新的 session。';
      els.allowActiveToggle.classList.toggle('active', enabled);
      els.allowActiveToggle.title = title;
      els.allowActiveToggle.setAttribute('aria-label', title);
      els.allowActive.setAttribute('aria-label', title);
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

    function shortenText(value, max) {
      const text = String(value || '');
      return text.length > max ? text.slice(0, Math.max(0, max - 1)) + '...' : text;
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

    function cssEscape(value) {
      if (window.CSS && typeof window.CSS.escape === 'function') {
        return window.CSS.escape(String(value));
      }
      return String(value).replace(/["\\\\]/g, '\\\\$&');
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
    els.toggleSessionSearchButton.addEventListener('click', () => setSessionSearchOpen(!state.sessionSearchOpen));
    els.settingsButton.addEventListener('click', () => openSystemSettingsModal().catch(handleError));
    els.allowActive.addEventListener('change', () => setAllowActive(els.allowActive.checked));
    els.sessionSearch.addEventListener('input', debounce(() => {
      els.toggleSessionSearchButton.classList.toggle('active', Boolean(els.sessionSearch.value.trim()));
      loadSessions().catch(handleError);
    }, 180));
    els.reloadRecords.addEventListener('click', () => loadRecords().catch(handleError));
    els.openFilterButton.addEventListener('click', () => openFilterModal().catch(handleError));
    els.clearRecordFilterButton.addEventListener('click', clearRecordFilter);
    els.clearLineFilterButton.addEventListener('click', clearLineFilter);
    els.toggleLineDetailsButton.addEventListener('click', () => {
      state.lineDetailsOpen = !state.lineDetailsOpen;
      renderRecords();
    });
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
        if (state.turnRewriteBusy) {
          showToast('改写进行中，请等待完成', 'error');
          return;
        }
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
    els.turnList.addEventListener('click', (event) => {
      const editTurnButton = event.target.closest('[data-edit-turn]');
      if (editTurnButton) {
        openTurnEditModal(editTurnButton.dataset.editTurn).catch(handleError);
        return;
      }
      const truncateTurnButton = event.target.closest('[data-truncate-turn]');
      if (truncateTurnButton) {
        truncateAfterTurn(truncateTurnButton.dataset.truncateTurn).catch(handleError);
        return;
      }
      const turn = event.target.closest('[data-select-turn]');
      if (turn) {
        selectTurn(turn.dataset.selectTurn, { scrollLines: true });
      }
    });
    els.turnList.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') {
        return;
      }
      const turn = event.target.closest('[data-select-turn]');
      if (!turn) {
        return;
      }
      event.preventDefault();
      selectTurn(turn.dataset.selectTurn, { scrollLines: true });
    });
    els.recordList.addEventListener('click', (event) => {
      const editTurnButton = event.target.closest('[data-edit-turn]');
      if (editTurnButton) {
        openTurnEditModal(editTurnButton.dataset.editTurn).catch(handleError);
        return;
      }
      const truncateTurnButton = event.target.closest('[data-truncate-turn]');
      if (truncateTurnButton) {
        truncateAfterTurn(truncateTurnButton.dataset.truncateTurn).catch(handleError);
        return;
      }
      const row = event.target.closest('[data-line]');
      if (row) {
        selectRecord(Number.parseInt(row.dataset.line, 10)).catch(handleError);
      }
    });
    window.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && state.modalResolver) {
        event.preventDefault();
        if (state.turnRewriteBusy) {
          showToast('改写进行中，请等待完成', 'error');
          return;
        }
        closeModal(false);
        return;
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
        event.preventDefault();
        saveCurrentRecord().catch(handleError);
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
    restoreAllowActive();
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
