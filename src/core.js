import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";

export class JsonlParseError extends Error {
  constructor(filePath, lineNumber, cause) {
    super(`Invalid JSONL in ${filePath} at line ${lineNumber}: ${cause.message}`);
    this.name = "JsonlParseError";
    this.filePath = filePath;
    this.lineNumber = lineNumber;
    this.cause = cause;
  }
}

export function expandHome(input) {
  if (!input) {
    return input;
  }

  if (input === "~") {
    return os.homedir();
  }

  if (input.startsWith("~/")) {
    return path.join(os.homedir(), input.slice(2));
  }

  return input;
}

export function resolveCodexHome(input) {
  return path.resolve(expandHome(input || process.env.CODEX_HOME || "~/.codex"));
}

export function resolveManagerHome(input) {
  return path.resolve(expandHome(input || process.env.COLDXX_HOME || "~/.coldxx"));
}

export function sessionsRoot(codexHome) {
  return path.join(codexHome, "sessions");
}

export async function pathExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function collectJsonlFiles(root) {
  if (!(await pathExists(root))) {
    return [];
  }

  const out = [];

  async function walk(dir) {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
      } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        out.push(fullPath);
      }
    }
  }

  await walk(root);
  return out;
}

export async function readJsonl(filePath) {
  const raw = await fs.readFile(filePath, "utf8");
  const lines = raw.split(/\r?\n/);
  if (lines.at(-1) === "") {
    lines.pop();
  }

  const records = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trim() === "") {
      continue;
    }

    try {
      records.push(JSON.parse(line));
    } catch (error) {
      throw new JsonlParseError(filePath, index + 1, error);
    }
  }

  return { raw, lines, records };
}

export async function writeJsonlAtomic(filePath, records) {
  const stat = await fs.stat(filePath);
  const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  const body = `${records.map((record) => JSON.stringify(record)).join("\n")}\n`;

  await fs.writeFile(tmpPath, body, { mode: stat.mode });
  await fs.rename(tmpPath, filePath);
}

export async function createBackup(filePath, options = {}) {
  const managerHome = resolveManagerHome(options.managerHome);
  const createdAt = new Date().toISOString();
  const backupId = `${stampForPath()}-${shortHash(filePath)}-${crypto.randomBytes(3).toString("hex")}`;
  const backupDir = path.join(managerHome, "backups", backupId);
  const backupPath = path.join(backupDir, path.basename(filePath));
  const manifestPath = path.join(backupDir, "manifest.json");

  await fs.mkdir(backupDir, { recursive: true });
  await fs.copyFile(filePath, backupPath);
  await fs.writeFile(
    manifestPath,
    `${JSON.stringify(
      {
        id: backupId,
        createdAt,
        originalPath: filePath,
        backupPath,
        reason: options.reason || "manual edit",
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  return { id: backupId, createdAt, backupPath, manifestPath };
}

export async function listBackups(options = {}) {
  const managerHome = resolveManagerHome(options.managerHome);
  const backupRoot = path.join(managerHome, "backups");
  const originalPath = options.originalPath ? path.resolve(options.originalPath) : "";
  if (!(await pathExists(backupRoot))) {
    return [];
  }

  const entries = await fs.readdir(backupRoot, { withFileTypes: true });
  const items = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    const backupDir = path.join(backupRoot, entry.name);
    const manifestPath = path.join(backupDir, "manifest.json");
    if (!(await pathExists(manifestPath))) {
      continue;
    }

    let manifest;
    try {
      manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
    } catch {
      continue;
    }

    const manifestOriginalPath = manifest?.originalPath ? path.resolve(manifest.originalPath) : "";
    if (originalPath && manifestOriginalPath !== originalPath) {
      continue;
    }

    const backupPath = manifest?.backupPath || path.join(backupDir, path.basename(manifestOriginalPath || ""));
    const stat = (await pathExists(backupPath)) ? await fs.stat(backupPath) : null;
    items.push({
      id: manifest.id || entry.name,
      createdAt: manifest.createdAt || "",
      originalPath: manifest.originalPath || "",
      backupPath,
      manifestPath,
      reason: manifest.reason || "manual edit",
      sizeBytes: stat?.size || 0,
      size: stat ? formatBytes(stat.size) : "",
      available: Boolean(stat),
    });
  }

  items.sort((a, b) => {
    const byTime = String(b.createdAt || b.id).localeCompare(String(a.createdAt || a.id));
    return byTime || String(b.id).localeCompare(String(a.id));
  });
  return items;
}

export async function restoreSessionBackup(backupId, options = {}) {
  if (!backupId || /[/\\]/.test(backupId)) {
    throw new Error(`Invalid backup id: ${backupId}`);
  }

  const managerHome = resolveManagerHome(options.managerHome);
  const backupDir = path.join(managerHome, "backups", backupId);
  const manifestPath = path.join(backupDir, "manifest.json");
  if (!(await pathExists(manifestPath))) {
    throw new Error(`Backup manifest not found: ${manifestPath}`);
  }

  const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  const originalPath = path.resolve(options.originalPath || manifest.originalPath || "");
  const manifestOriginalPath = path.resolve(manifest.originalPath || "");
  if (!originalPath || !manifestOriginalPath) {
    throw new Error(`Backup manifest is missing originalPath: ${manifestPath}`);
  }
  if (options.originalPath && originalPath !== manifestOriginalPath) {
    throw new Error("Backup does not belong to this session");
  }

  const backupPath = manifest.backupPath;
  if (!(await pathExists(backupPath))) {
    throw new Error(`Backup file is missing: ${backupPath}`);
  }

  const rollbackBackup = (await pathExists(originalPath))
    ? await createBackup(originalPath, {
        managerHome,
        reason: `rollback to backup ${backupId}`,
      })
    : null;
  await fs.mkdir(path.dirname(originalPath), { recursive: true });
  const currentStat = (await pathExists(originalPath)) ? await fs.stat(originalPath) : null;
  const tmpPath = `${originalPath}.tmp-${process.pid}-${Date.now()}`;
  await fs.copyFile(backupPath, tmpPath);
  if (currentStat) {
    await fs.chmod(tmpPath, currentStat.mode);
  }
  await fs.rename(tmpPath, originalPath);

  return {
    backupId,
    restoredPath: originalPath,
    restoredFrom: backupPath,
    backup: rollbackBackup,
    manifest,
  };
}

export async function scanSessions(options = {}) {
  const codexHome = resolveCodexHome(options.codexHome);
  const root = sessionsRoot(codexHome);
  const files = await collectJsonlFiles(root);
  const sessions = [];

  for (const filePath of files) {
    sessions.push(await readSessionSummary(filePath, { codexHome }));
  }

  sessions.sort(compareSessionsDesc);
  return sessions;
}

export async function readSessionSummary(filePath, options = {}) {
  const codexHome = resolveCodexHome(options.codexHome);
  const root = sessionsRoot(codexHome);
  const stat = await fs.stat(filePath);
  const summary = {
    id: idFromFilename(filePath),
    parentSessionId: "",
    file: filePath,
    relativePath: safeRelative(root, filePath),
    startedAt: timestampFromFilename(filePath) || stat.birthtime.toISOString(),
    updatedAt: stat.mtime.toISOString(),
    sizeBytes: stat.size,
    lines: 0,
    types: {},
    roles: {},
    cwd: "",
    model: "",
    cliVersion: "",
    preview: "",
    valid: true,
  };

  try {
    const { records } = await readJsonl(filePath);
    summary.lines = records.length;
    let fallbackPreview = "";
    let primaryMetaSeen = false;

    for (const record of records) {
      const recordType = textValue(record?.type);
      const payload = isPlainObject(record?.payload) ? record.payload : {};
      const payloadType = textValue(payload.type);
      const role = textValue(payload.role);

      if (recordType) {
        summary.types[recordType] = (summary.types[recordType] || 0) + 1;
      }
      if (role) {
        summary.roles[role] = (summary.roles[role] || 0) + 1;
      }

      if (recordType === "session_meta" && isPlainObject(record.payload) && !primaryMetaSeen) {
        primaryMetaSeen = true;
        summary.id = textValue(record.payload.id) || summary.id;
        summary.parentSessionId =
          textValue(record.payload.forked_from_id) ||
          textValue(record.payload.source?.subagent?.thread_spawn?.parent_thread_id) ||
          summary.parentSessionId;
        summary.startedAt = textValue(record.payload.timestamp) || summary.startedAt;
        summary.cwd = textValue(record.payload.cwd) || summary.cwd;
        summary.model =
          textValue(record.payload.model) ||
          textValue(record.payload.model_slug) ||
          textValue(record.payload.model_provider) ||
          summary.model;
        summary.cliVersion = textValue(record.payload.cli_version) || summary.cliVersion;
      }

      if (recordType === "turn_context" && isPlainObject(record.payload)) {
        summary.cwd = textValue(record.payload.cwd) || summary.cwd;
        summary.model = textValue(record.payload.model) || summary.model;
      }

      if (record.timestamp) {
        summary.updatedAt = textValue(record.timestamp) || summary.updatedAt;
      }

      if (!summary.preview && recordType === "event_msg" && payloadType === "user_message") {
        const text = firstText(payload);
        if (text) {
          summary.preview = oneLine(text, 120);
        }
      }

      if (!fallbackPreview && looksLikeMessageRecord(record)) {
        const text = firstText(record.payload ?? record);
        if (text && !text.trim().startsWith("<environment_context>")) {
          fallbackPreview = oneLine(text, 120);
        }
      }
    }

    summary.preview = summary.preview || fallbackPreview;
  } catch (error) {
    summary.valid = false;
    summary.error = error.message;
  }

  summary.shortId = shortenId(summary.id);
  return summary;
}

export function compareSessionsDesc(a, b) {
  const left = Date.parse(a.startedAt || a.updatedAt || "") || 0;
  const right = Date.parse(b.startedAt || b.updatedAt || "") || 0;
  if (right !== left) {
    return right - left;
  }
  return b.file.localeCompare(a.file);
}

export function resolveSessionSelectors(sessions, selectors, options = {}) {
  const allowMany = options.allowMany !== false;
  const resolved = [];
  const seen = new Set();

  for (const selector of selectors) {
    const matches = resolveOneSelector(sessions, selector);

    if (matches.length === 0) {
      throw new Error(`No session matches selector: ${selector}`);
    }

    if (matches.length > 1 && !options.allowAmbiguous) {
      const hints = matches.slice(0, 5).map((session) => `${session.shortId} ${session.file}`);
      throw new Error(
        `Selector is ambiguous: ${selector}\nMatches:\n${hints.join("\n")}${
          matches.length > 5 ? "\n..." : ""
        }`,
      );
    }

    for (const session of matches) {
      if (!seen.has(session.file)) {
        seen.add(session.file);
        resolved.push(session);
      }
    }
  }

  if (!allowMany && resolved.length > 1) {
    throw new Error(`Expected one session, got ${resolved.length}`);
  }

  return resolved;
}

export function resolveOneSelector(sessions, selector) {
  if (!selector) {
    return [];
  }

  if (selector === "latest") {
    return sessions.slice(0, 1);
  }

  if (/^\d+$/.test(selector)) {
    const index = Number.parseInt(selector, 10) - 1;
    return sessions[index] ? [sessions[index]] : [];
  }

  const absoluteSelector = path.resolve(expandHome(selector));
  const byPath = sessions.filter((session) => path.resolve(session.file) === absoluteSelector);
  if (byPath.length > 0) {
    return byPath;
  }

  return sessions.filter((session) => {
    const base = path.basename(session.file);
    return (
      session.id === selector ||
      session.shortId === selector ||
      session.id.startsWith(selector) ||
      base === selector ||
      base.startsWith(selector) ||
      session.relativePath === selector ||
      session.relativePath.endsWith(selector)
    );
  });
}

export async function cleanSessions(sessions, options = {}) {
  const codexHome = resolveCodexHome(options.codexHome);
  const root = sessionsRoot(codexHome);
  const dryRun = booleanOption(options, "dryRun", "dry-run");
  const permanent = Boolean(options.permanent);
  const managerHome = resolveManagerHome(options.managerHome);
  const cleanedAt = new Date().toISOString();
  const batchId = `${stampForPath()}-${shortHash(sessions.map((session) => session.file).join("|"))}`;
  const batchDir = path.join(managerHome, "trash", batchId);
  const results = [];

  if (!dryRun && !permanent) {
    await fs.mkdir(batchDir, { recursive: true });
  }

  for (const session of sessions) {
    const originalPath = session.file;
    const relativePath = safeRelative(root, originalPath);

    if (dryRun) {
      results.push({
        id: session.id,
        originalPath,
        action: permanent ? "delete" : "trash",
        targetPath: permanent ? null : path.join(batchDir, relativePath),
      });
      continue;
    }

    if (permanent) {
      await fs.unlink(originalPath);
      await removeEmptyParents(path.dirname(originalPath), root);
      results.push({ id: session.id, originalPath, action: "delete", targetPath: null });
      continue;
    }

    const targetPath = path.join(batchDir, relativePath);
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    await moveFile(originalPath, targetPath);
    await removeEmptyParents(path.dirname(originalPath), root);
    results.push({ id: session.id, originalPath, action: "trash", targetPath });
  }

  if (!dryRun && !permanent) {
    await fs.writeFile(
      path.join(batchDir, "manifest.json"),
      `${JSON.stringify(
        {
          id: batchId,
          cleanedAt,
          permanent: false,
          sessions: results,
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
  }

  return { batchId, cleanedAt, permanent, dryRun, count: results.length, results };
}

export async function listTrash(options = {}) {
  const managerHome = resolveManagerHome(options.managerHome);
  const trashRoot = path.join(managerHome, "trash");
  if (!(await pathExists(trashRoot))) {
    return [];
  }

  const entries = await fs.readdir(trashRoot, { withFileTypes: true });
  const items = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    const dir = path.join(trashRoot, entry.name);
    const manifestPath = path.join(dir, "manifest.json");
    let manifest = null;
    if (await pathExists(manifestPath)) {
      manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
    }

    items.push({
      id: entry.name,
      dir,
      manifestPath,
      cleanedAt: manifest?.cleanedAt || "",
      count: manifest?.sessions?.length || 0,
      manifest,
    });
  }

  items.sort((a, b) => b.id.localeCompare(a.id));
  return items;
}

export async function restoreTrashBatch(batchId, options = {}) {
  const managerHome = resolveManagerHome(options.managerHome);
  const trashRoot = path.join(managerHome, "trash");
  const batchDir = path.join(trashRoot, batchId);
  const manifestPath = path.join(batchDir, "manifest.json");

  if (!(await pathExists(manifestPath))) {
    throw new Error(`Trash manifest not found: ${manifestPath}`);
  }

  const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  const restored = [];
  for (const item of manifest.sessions || []) {
    const sourcePath = item.targetPath;
    const destinationPath = item.originalPath;

    if (!(await pathExists(sourcePath))) {
      throw new Error(`Trashed file is missing: ${sourcePath}`);
    }

    if ((await pathExists(destinationPath)) && !options.overwrite) {
      throw new Error(`Refusing to overwrite existing session: ${destinationPath}`);
    }

    await fs.mkdir(path.dirname(destinationPath), { recursive: true });
    if (options.overwrite && (await pathExists(destinationPath))) {
      await fs.unlink(destinationPath);
    }
    await moveFile(sourcePath, destinationPath);
    restored.push({ sourcePath, destinationPath });
  }

  await removeEmptyParents(batchDir, trashRoot);
  return { batchId, count: restored.length, restored };
}

export async function emptyTrash(options = {}) {
  const managerHome = resolveManagerHome(options.managerHome);
  const trashRoot = path.join(managerHome, "trash");
  const dryRun = booleanOption(options, "dryRun", "dry-run");
  if (!(await pathExists(trashRoot))) {
    return { count: 0, trashRoot };
  }

  const entries = await fs.readdir(trashRoot);
  if (!dryRun) {
    await fs.rm(trashRoot, { recursive: true, force: true });
  }
  return { count: entries.length, trashRoot, dryRun };
}

export function parseLineRanges(spec, total) {
  if (!spec || typeof spec !== "string") {
    throw new Error("Line range is required");
  }

  const selected = new Set();
  for (const rawPart of spec.split(",")) {
    const part = rawPart.trim();
    if (!part) {
      continue;
    }

    const match = /^(\d+)(?:\s*(?:-|:|\.\.)\s*(\d*)?)?$/.exec(part);
    if (!match) {
      throw new Error(`Invalid line range: ${part}`);
    }

    const start = Number.parseInt(match[1], 10);
    const end = match[2] === undefined || match[2] === "" ? start : Number.parseInt(match[2], 10);
    const finalEnd = part.endsWith("-") || part.endsWith(":") || part.endsWith("..") ? total : end;

    if (start < 1 || finalEnd < start || finalEnd > total) {
      throw new Error(`Line range is outside 1..${total}: ${part}`);
    }

    for (let line = start; line <= finalEnd; line += 1) {
      selected.add(line);
    }
  }

  return selected;
}

export async function dropSessionLines(filePath, options = {}) {
  const { records } = await readJsonl(filePath);
  const selected = parseLineRanges(options.lines, records.length);
  const nextRecords = records.filter((_, index) => !selected.has(index + 1));
  const dryRun = booleanOption(options, "dryRun", "dry-run");
  const result = {
    file: filePath,
    dryRun,
    removedLines: [...selected].sort((a, b) => a - b),
    beforeLines: records.length,
    afterLines: nextRecords.length,
    backup: null,
  };

  if (!dryRun && selected.size > 0) {
    result.backup = await createBackup(filePath, {
      managerHome: options.managerHome,
      reason: `drop lines ${options.lines}`,
    });
    await writeJsonlAtomic(filePath, nextRecords);
  }

  return result;
}

export async function replaceInSession(filePath, options = {}) {
  if (typeof options.from !== "string" || options.from.length === 0) {
    throw new Error("--replace must be a non-empty string");
  }

  const replacement = typeof options.to === "string" ? options.to : "";
  const scope = options.scope || "all";
  const dryRun = booleanOption(options, "dryRun", "dry-run");
  const matcher = buildMatcher({
    from: options.from,
    replacement,
    regex: Boolean(options.regex),
    flags: options.flags || "",
    caseSensitive: Boolean(options.caseSensitive),
  });
  const { records } = await readJsonl(filePath);
  let replacements = 0;
  let changedRecords = 0;

  const nextRecords = records.map((record) => {
    if (!recordMatchesScope(record, scope)) {
      return record;
    }

    const { value, count } = replaceInValue(record, matcher);
    if (count > 0) {
      replacements += count;
      changedRecords += 1;
      return value;
    }
    return record;
  });

  const result = {
    file: filePath,
    dryRun,
    scope,
    replacements,
    changedRecords,
    totalRecords: records.length,
    backup: null,
  };

  if (!dryRun && replacements > 0) {
    result.backup = await createBackup(filePath, {
      managerHome: options.managerHome,
      reason: `replace text in scope ${scope}`,
    });
    await writeJsonlAtomic(filePath, nextRecords);
  }

  return result;
}

export async function readSessionForEditing(filePath, options = {}) {
  const codexHome = resolveCodexHome(options.codexHome);
  const summary = await readSessionSummary(filePath, { codexHome });
  const { lines, records } = await readJsonl(filePath);
  const includeJson = options.includeJson !== false;
  const maxJsonBytes = Number.isFinite(options.maxJsonBytes) ? options.maxJsonBytes : Infinity;
  return {
    summary,
    records: records.map((record, index) =>
      describeRecord(record, index, {
        includeJson,
        maxJsonBytes,
        raw: lines[index],
      }),
    ),
  };
}

export async function readSessionRecordForEditing(filePath, lineNumber) {
  if (!Number.isInteger(lineNumber) || lineNumber < 1) {
    throw new Error(`Invalid line number: ${lineNumber}`);
  }

  const raw = await readJsonlLine(filePath, lineNumber);
  if (raw === null) {
    throw new Error(`Line ${lineNumber} is outside the session`);
  }

  try {
    return describeRecord(JSON.parse(raw), lineNumber - 1, {
      includeJson: true,
      raw,
    });
  } catch (error) {
    throw new JsonlParseError(filePath, lineNumber, error);
  }
}

async function readJsonlLine(filePath, lineNumber) {
  const raw = await fs.readFile(filePath, "utf8");
  let currentLine = 1;
  let start = 0;
  for (let index = 0; index <= raw.length; index += 1) {
    if (index !== raw.length && raw[index] !== "\n") {
      continue;
    }
    const end = index > start && raw[index - 1] === "\r" ? index - 1 : index;
    if (currentLine === lineNumber) {
      const line = raw.slice(start, end);
      return line.trim() ? line : null;
    }
    currentLine += 1;
    start = index + 1;
  }
  return null;
}

export async function updateSessionRecord(filePath, lineNumber, nextRecord, options = {}) {
  if (!Number.isInteger(lineNumber) || lineNumber < 1) {
    throw new Error(`Invalid line number: ${lineNumber}`);
  }

  if (!isPlainObject(nextRecord)) {
    throw new Error("Session records must be JSON objects");
  }

  const dryRun = booleanOption(options, "dryRun", "dry-run");
  const { records } = await readJsonl(filePath);
  if (lineNumber > records.length) {
    throw new Error(`Line ${lineNumber} is outside 1..${records.length}`);
  }

  const before = records[lineNumber - 1];
  const nextRecords = records.slice();
  nextRecords[lineNumber - 1] = nextRecord;
  const result = {
    file: filePath,
    line: lineNumber,
    dryRun,
    before: describeRecord(before, lineNumber - 1),
    after: describeRecord(nextRecord, lineNumber - 1),
    backup: null,
  };

  if (!dryRun) {
    result.backup = await createBackup(filePath, {
      managerHome: options.managerHome,
      reason: `update line ${lineNumber}`,
    });
    await writeJsonlAtomic(filePath, nextRecords);
  }

  return result;
}

export function describeRecord(record, index = 0, options = {}) {
  const payload = isPlainObject(record?.payload) ? record.payload : {};
  const type = textValue(record?.type) || "record";
  const payloadType = textValue(payload.type);
  const role = textValue(payload.role || record?.role);
  const text = firstText(payload) || firstText(record) || payloadType || type;
  const raw = typeof options.raw === "string" ? options.raw : "";
  const bytes = raw ? Buffer.byteLength(raw, "utf8") : Buffer.byteLength(JSON.stringify(record), "utf8");
  const result = {
    line: index + 1,
    timestamp: textValue(record?.timestamp),
    type,
    payloadType,
    role,
    text: oneLine(text, 260),
    bytes,
  };

  if (options.includeJson !== false && bytes <= (options.maxJsonBytes ?? Infinity)) {
    result.json = JSON.stringify(record, null, 2);
  }

  return result;
}

export function sessionIsActive(session, windowMinutes = 10, now = Date.now()) {
  const updatedAt = Date.parse(session?.updatedAt);
  if (!Number.isFinite(updatedAt)) {
    return false;
  }
  return updatedAt >= now - windowMinutes * 60 * 1000;
}

export function buildMatcher(options) {
  if (options.regex) {
    const flags = normalizeRegexFlags(options.flags || "", options.caseSensitive);
    const regex = new RegExp(options.from, flags);
    return {
      replace(input) {
        const matches = input.match(regex);
        if (!matches) {
          return { value: input, count: 0 };
        }
        return { value: input.replace(regex, options.replacement), count: matches.length };
      },
    };
  }

  const needle = options.caseSensitive ? options.from : options.from.toLowerCase();
  return {
    replace(input) {
      const haystack = options.caseSensitive ? input : input.toLowerCase();
      let index = haystack.indexOf(needle);
      if (index === -1) {
        return { value: input, count: 0 };
      }

      let cursor = 0;
      let count = 0;
      let output = "";
      while (index !== -1) {
        output += input.slice(cursor, index);
        output += options.replacement;
        cursor = index + options.from.length;
        count += 1;
        index = haystack.indexOf(needle, cursor);
      }
      output += input.slice(cursor);
      return { value: output, count };
    },
  };
}

export function normalizeRegexFlags(flags, caseSensitive) {
  const unique = new Set(flags.split("").filter(Boolean));
  unique.add("g");
  if (!caseSensitive) {
    unique.add("i");
  }
  return [...unique].join("");
}

export function recordMatchesScope(record, scope) {
  if (scope === "all") {
    return true;
  }

  const payload = isPlainObject(record?.payload) ? record.payload : {};
  const role = textValue(payload.role || record?.role).toLowerCase();
  const type = textValue(payload.type || record?.type).toLowerCase();

  if (scope === "messages") {
    return Boolean(role) || ["response_item", "event_msg"].includes(textValue(record?.type));
  }

  if (scope === "metadata") {
    return ["session_meta", "turn_context"].includes(textValue(record?.type));
  }

  if (["user", "assistant", "system", "tool"].includes(scope)) {
    return role === scope || type.includes(scope);
  }

  throw new Error(`Unknown edit scope: ${scope}`);
}

export function replaceInValue(value, matcher) {
  if (typeof value === "string") {
    const result = matcher.replace(value);
    return { value: result.value, count: result.count };
  }

  if (Array.isArray(value)) {
    let count = 0;
    let changed = false;
    const next = value.map((item) => {
      const result = replaceInValue(item, matcher);
      count += result.count;
      if (result.count > 0) {
        changed = true;
        return result.value;
      }
      return item;
    });
    return { value: changed ? next : value, count };
  }

  if (isPlainObject(value)) {
    let count = 0;
    let changed = false;
    const next = {};
    for (const [key, item] of Object.entries(value)) {
      const result = replaceInValue(item, matcher);
      count += result.count;
      next[key] = result.value;
      changed = changed || result.count > 0;
    }
    return { value: changed ? next : value, count };
  }

  return { value, count: 0 };
}

export function idFromFilename(filePath) {
  const base = path.basename(filePath, ".jsonl");
  const match = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.exec(base);
  return match ? match[1] : base;
}

export function timestampFromFilename(filePath) {
  const base = path.basename(filePath);
  const match = /rollout-(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})/.exec(base);
  if (!match) {
    return "";
  }

  const [, year, month, day, hour, minute, second] = match;
  return `${year}-${month}-${day}T${hour}:${minute}:${second}`;
}

export function shortHash(input) {
  return crypto.createHash("sha256").update(input).digest("hex").slice(0, 8);
}

export function stampForPath(date = new Date()) {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

export function shortenId(id) {
  const text = textValue(id);
  return text.length > 12 ? text.slice(0, 12) : text;
}

export function formatBytes(bytes) {
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${unit === 0 ? value : value.toFixed(value >= 10 ? 0 : 1)}${units[unit]}`;
}

export function booleanOption(options, ...names) {
  return names.some((name) => Boolean(options?.[name]));
}

export function oneLine(input, max = 80) {
  const text = textValue(input).replace(/\s+/g, " ").trim();
  if (text.length <= max) {
    return text;
  }
  return `${text.slice(0, Math.max(0, max - 1))}...`;
}

export function textValue(value) {
  return typeof value === "string" ? value : "";
}

export function safeRelative(root, filePath) {
  const relative = path.relative(root, filePath);
  return relative.startsWith("..") ? filePath : relative;
}

export function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function looksLikeMessageRecord(record) {
  const payload = isPlainObject(record?.payload) ? record.payload : {};
  const role = textValue(payload.role).toLowerCase();
  if (role === "user") {
    return true;
  }
  return textValue(record?.type) === "event_msg" && textValue(payload.message);
}

function firstText(value, seen = new Set()) {
  if (typeof value === "string") {
    const text = value.trim();
    return text || "";
  }

  if (!value || typeof value !== "object" || seen.has(value)) {
    return "";
  }

  seen.add(value);

  if (Array.isArray(value)) {
    for (const item of value) {
      const text = firstText(item, seen);
      if (text) {
        return text;
      }
    }
    return "";
  }

  for (const key of ["text", "message", "input", "content", "transcript"]) {
    if (key in value) {
      const text = firstText(value[key], seen);
      if (text) {
        return text;
      }
    }
  }

  for (const item of Object.values(value)) {
    const text = firstText(item, seen);
    if (text) {
      return text;
    }
  }
  return "";
}

async function moveFile(sourcePath, destinationPath) {
  try {
    await fs.rename(sourcePath, destinationPath);
  } catch (error) {
    if (error.code !== "EXDEV") {
      throw error;
    }
    await fs.copyFile(sourcePath, destinationPath);
    await fs.unlink(sourcePath);
  }
}

async function removeEmptyParents(startDir, stopDir) {
  let current = startDir;
  const stop = path.resolve(stopDir);

  while (path.resolve(current).startsWith(stop) && path.resolve(current) !== stop) {
    try {
      await fs.rmdir(current);
    } catch {
      break;
    }
    current = path.dirname(current);
  }
}

export function ensureNoDanglingTmpFiles(filePath) {
  const dir = path.dirname(filePath);
  const base = path.basename(filePath);
  return fsSync.readdirSync(dir).filter((name) => name.startsWith(`${base}.tmp-`));
}
