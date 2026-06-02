import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { spawn } from "node:child_process";

const CODEX_CONFIG_SCHEMA_URL = "https://developers.openai.com/codex/config-schema.json";
const PROFILE_NAME_PATTERN = /^[A-Za-z0-9_-]+$/;
const DEFAULT_REWRITE_PROMPT =
  "请将这段文本改写得更清晰、准确、便于后续继续使用。保留原意，不添加原文没有的信息。只输出改写后的文本。";

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

export function validateProfileName(name) {
  if (!name || !PROFILE_NAME_PATTERN.test(name)) {
    throw new Error(`Invalid profile name: ${name}. Use letters, numbers, hyphens, or underscores.`);
  }
  return name;
}

export function codexProfilePath(codexHome, name) {
  validateProfileName(name);
  return path.join(resolveCodexHome(codexHome), `${name}.config.toml`);
}

export function codexBaseConfigPath(codexHome) {
  return path.join(resolveCodexHome(codexHome), "config.toml");
}

export function codexProfileActivation(name) {
  validateProfileName(name);
  return {
    command: `codex -p ${name}`,
    execCommand: `codex exec -p ${name} "..."`,
  };
}

function resolveCodexConfigPath(value, configFile) {
  const expanded = expandHome(String(value || ""));
  if (!expanded) {
    return "";
  }
  return path.isAbsolute(expanded) ? expanded : path.resolve(path.dirname(configFile), expanded);
}

export async function readCodexBaseConfig(options = {}) {
  const codexHome = resolveCodexHome(options.codexHome);
  const file = codexBaseConfigPath(codexHome);
  const exists = await pathExists(file);
  const raw = exists ? await fs.readFile(file, "utf8") : "";
  const stat = exists ? await fs.stat(file) : null;
  return {
    name: "default",
    label: "默认 config.toml",
    kind: "default",
    editable: false,
    deletable: false,
    file,
    exists,
    raw,
    fields: codexProfileFields(raw),
    modelInstructionsText: "",
    sizeBytes: stat?.size || 0,
    size: stat ? formatBytes(stat.size) : "",
    updatedAt: stat?.mtime?.toISOString?.() || "",
    command: "codex",
    execCommand: 'codex exec "..."',
  };
}

export async function listCodexProfiles(options = {}) {
  const codexHome = resolveCodexHome(options.codexHome);
  if (!(await pathExists(codexHome))) {
    return [];
  }

  const entries = await fs.readdir(codexHome, { withFileTypes: true });
  const profiles = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".config.toml")) {
      continue;
    }

    const name = entry.name.slice(0, -".config.toml".length);
    if (!PROFILE_NAME_PATTERN.test(name)) {
      continue;
    }

    const file = path.join(codexHome, entry.name);
    const stat = await fs.stat(file);
    profiles.push({
      name,
      label: name,
      kind: "profile",
      editable: true,
      deletable: true,
      file,
      sizeBytes: stat.size,
      size: formatBytes(stat.size),
      updatedAt: stat.mtime.toISOString(),
      ...codexProfileActivation(name),
    });
  }

  profiles.sort((a, b) => a.name.localeCompare(b.name));
  return profiles;
}

export async function listCodexConfigs(options = {}) {
  const base = await readCodexBaseConfig(options);
  return [base, ...(await listCodexProfiles(options))];
}

export async function readCodexProfile(name, options = {}) {
  validateProfileName(name);
  const codexHome = resolveCodexHome(options.codexHome);
  const file = codexProfilePath(codexHome, name);
  const exists = await pathExists(file);
  const raw = exists ? await fs.readFile(file, "utf8") : defaultCodexProfileToml();
  const fields = codexProfileFields(raw);
  const modelInstructionsPath = fields.model_instructions_file || "";
  let modelInstructionsText = "";
  const resolvedModelInstructionsPath = modelInstructionsPath ? resolveCodexConfigPath(modelInstructionsPath, file) : "";
  if (resolvedModelInstructionsPath && (await pathExists(resolvedModelInstructionsPath))) {
    modelInstructionsText = await fs.readFile(resolvedModelInstructionsPath, "utf8");
  }
  const stat = exists ? await fs.stat(file) : null;

  return {
    name,
    label: name,
    kind: "profile",
    editable: true,
    deletable: true,
    file,
    exists,
    raw,
    fields,
    modelInstructionsText,
    sizeBytes: stat?.size || 0,
    size: stat ? formatBytes(stat.size) : "",
    updatedAt: stat?.mtime?.toISOString?.() || "",
    ...codexProfileActivation(name),
  };
}

export async function writeCodexProfile(name, options = {}) {
  validateProfileName(name);
  const codexHome = resolveCodexHome(options.codexHome);
  const file = codexProfilePath(codexHome, name);
  let raw = typeof options.raw === "string" ? options.raw : defaultCodexProfileToml();
  raw = ensureCodexConfigSchemaHeader(raw);

  if (typeof options.instructions === "string") {
    raw = upsertTopLevelTomlString(raw, "instructions", options.instructions);
  }

  let modelInstructionsPath = extractTopLevelTomlString(raw, "model_instructions_file");
  if (typeof options.modelInstructionsText === "string") {
    modelInstructionsPath = path.join(codexHome, "prompts", `${name}-model-instructions.md`);
    await fs.mkdir(path.dirname(modelInstructionsPath), { recursive: true });
    await fs.writeFile(modelInstructionsPath, normalizeTextFile(options.modelInstructionsText), "utf8");
    raw = upsertTopLevelTomlString(raw, "model_instructions_file", modelInstructionsPath);
  }

  raw = normalizeTextFile(raw);
  const backup =
    (await pathExists(file)) && !options.skipBackup
      ? await createBackup(file, {
          managerHome: options.managerHome,
          reason: `update Codex profile ${name}`,
        })
      : null;

  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmpPath = `${file}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(tmpPath, raw, "utf8");
  await fs.rename(tmpPath, file);

  const stat = await fs.stat(file);
  return {
    name,
    label: name,
    kind: "profile",
    editable: true,
    deletable: true,
    file,
    raw,
    fields: codexProfileFields(raw),
    modelInstructionsPath,
    backup,
    sizeBytes: stat.size,
    size: formatBytes(stat.size),
    updatedAt: stat.mtime.toISOString(),
    ...codexProfileActivation(name),
  };
}

export async function deleteCodexProfile(name, options = {}) {
  validateProfileName(name);
  const file = codexProfilePath(options.codexHome, name);
  if (!(await pathExists(file))) {
    throw new Error(`Codex profile not found: ${name}`);
  }

  const backup = await createBackup(file, {
    managerHome: options.managerHome,
    reason: `delete Codex profile ${name}`,
  });
  await fs.unlink(file);
  return { name, file, backup, deleted: true };
}

export function codexProfileFields(raw) {
  return {
    model: extractTopLevelTomlString(raw, "model"),
    review_model: extractTopLevelTomlString(raw, "review_model"),
    model_provider: extractTopLevelTomlString(raw, "model_provider"),
    oss_provider: extractTopLevelTomlString(raw, "oss_provider"),
    model_reasoning_effort: extractTopLevelTomlString(raw, "model_reasoning_effort"),
    model_reasoning_summary: extractTopLevelTomlString(raw, "model_reasoning_summary"),
    model_verbosity: extractTopLevelTomlString(raw, "model_verbosity"),
    approval_policy: extractTopLevelTomlString(raw, "approval_policy") || extractTopLevelTomlValue(raw, "approval_policy"),
    sandbox_mode: extractTopLevelTomlString(raw, "sandbox_mode"),
    web_search: extractTopLevelTomlString(raw, "web_search"),
    personality: extractTopLevelTomlString(raw, "personality"),
    openai_base_url: extractTopLevelTomlString(raw, "openai_base_url"),
    instructions: extractTopLevelTomlString(raw, "instructions"),
    model_instructions_file: extractTopLevelTomlString(raw, "model_instructions_file"),
  };
}

export async function rewriteText(text, options = {}) {
  const sourceText = String(text || "");
  if (!sourceText.trim()) {
    throw new Error("Text to rewrite is required");
  }

  const rewritePrompt = options.prompt || DEFAULT_REWRITE_PROMPT;
  const input = buildTextRewritePrompt(sourceText, rewritePrompt, options);
  const llmProvider = normalizeRewriteLlmProvider(options.llmProvider || options.provider);
  const result =
    llmProvider === "openai"
      ? await runOpenAICompatibleRewrite(input, options)
      : llmProvider === "anthropic"
        ? await runAnthropicCompatibleRewrite(input, options)
        : await runCodexExec(input, {
            codexCommand: options.codexCommand,
            codexHome: options.codexHome,
            cwd: options.cwd,
            profile: options.profile,
            model: options.model,
            timeoutMs: options.timeoutMs,
          });

  return {
    profile: options.profile || "",
    model: options.model || "",
    provider: llmProvider,
    prompt: rewritePrompt,
    output: result.output,
    stdout: result.stdout,
    stderr: result.stderr,
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
    fileUpdatedAt: stat.mtime.toISOString(),
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
  validateStorageId(batchId, "trash batch id");
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
      reason: options.reason || `drop lines ${options.lines}`,
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
  const lineScope = Array.isArray(options.lines)
    ? new Set(
        options.lines
          .map((line) => Number.parseInt(String(line), 10))
          .filter((line) => Number.isInteger(line) && line > 0),
      )
    : null;
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

  const nextRecords = records.map((record, index) => {
    const line = index + 1;
    if (lineScope && !lineScope.has(line)) {
      return record;
    }
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
    scopedLines: lineScope ? lineScope.size : null,
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
  const turns = groupSessionTurns(records);
  const turnByLine = new Map();
  for (const turn of turns) {
    for (let line = turn.startLine; line <= turn.endLine; line += 1) {
      turnByLine.set(line, turn);
    }
  }

  return {
    summary,
    records: records.map((record, index) =>
      annotateRecordTurn(
        describeRecord(record, index, {
          includeJson,
          maxJsonBytes,
          raw: lines[index],
        }),
        turnByLine.get(index + 1),
        record,
      ),
    ),
    turns: turns.map(publicTurn),
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

export async function updateSessionRecords(filePath, updates, options = {}) {
  if (!Array.isArray(updates)) {
    throw new Error("Updates must be an array");
  }

  const dryRun = booleanOption(options, "dryRun", "dry-run");
  const { records } = await readJsonl(filePath);
  const nextRecords = records.slice();
  const seen = new Set();
  const normalized = [];

  for (const update of updates) {
    const line = Number.parseInt(String(update?.line), 10);
    if (!Number.isInteger(line) || line < 1 || line > records.length) {
      throw new Error(`Line ${line} is outside 1..${records.length}`);
    }
    if (seen.has(line)) {
      throw new Error(`Line ${line} was updated more than once`);
    }
    if (!isPlainObject(update.record)) {
      throw new Error("Session records must be JSON objects");
    }

    seen.add(line);
    normalized.push({ line, record: update.record });
    nextRecords[line - 1] = update.record;
  }

  normalized.sort((a, b) => a.line - b.line);
  const result = {
    file: filePath,
    dryRun,
    changedLines: normalized.map((update) => update.line),
    changedRecords: normalized.length,
    before: normalized.map((update) => describeRecord(records[update.line - 1], update.line - 1)),
    after: normalized.map((update) => describeRecord(update.record, update.line - 1)),
    backup: null,
  };

  if (!dryRun && normalized.length > 0) {
    result.backup = await createBackup(filePath, {
      managerHome: options.managerHome,
      reason: options.reason || `update ${normalized.length} record(s)`,
    });
    await writeJsonlAtomic(filePath, nextRecords);
  }

  return result;
}

export async function truncateSessionAfterTurn(filePath, turnId, options = {}) {
  const { records } = await readJsonl(filePath);
  const turn = findSessionTurn(records, turnId);
  if (!turn) {
    throw new Error(`Unknown turn: ${turnId}`);
  }
  if (turn.kind === "setup") {
    throw new Error("Setup records cannot be used as a rollback target");
  }

  const dryRun = booleanOption(options, "dryRun", "dry-run");
  if (turn.endLine >= records.length) {
    return {
      file: filePath,
      dryRun,
      turn: publicTurn(turn),
      removedLines: [],
      beforeLines: records.length,
      afterLines: records.length,
      backup: null,
    };
  }

  const result = await dropSessionLines(filePath, {
    lines: `${turn.endLine + 1}-`,
    managerHome: options.managerHome,
    dryRun,
    reason: `truncate after turn ${turn.index}`,
  });
  return { ...result, turn: publicTurn(turn) };
}

export function getSessionTurnEditPlan(records, turnId) {
  const turn = findSessionTurn(records, turnId);
  if (!turn) {
    throw new Error(`Unknown turn: ${turnId}`);
  }
  if (turn.kind === "setup") {
    return { turn: publicTurn(turn), groups: [] };
  }

  const groupsByKey = new Map();
  for (let line = turn.startLine; line <= turn.endLine; line += 1) {
    const record = records[line - 1];
    for (const target of editableMessageTargets(record, line)) {
      const key = `${target.side}\u0000${target.text}`;
      let group = groupsByKey.get(key);
      if (!group) {
        group = {
          id: "",
          side: target.side,
          text: target.text,
          lines: [],
          targetCount: 0,
          targets: [],
        };
        groupsByKey.set(key, group);
      }
      group.lines.push(line);
      group.targetCount += 1;
      group.targets.push({
        line,
        path: target.path,
        pathText: pathToString(target.path),
      });
    }
  }

  const groups = [...groupsByKey.values()].map((group) => {
    const lines = [...new Set(group.lines)].sort((a, b) => a - b);
    return {
      id: turnMessageGroupId(turn.id, group.side, group.text, lines[0] || turn.startLine),
      side: group.side,
      text: group.text,
      preview: oneLine(group.text, 180),
      lines,
      targetCount: group.targetCount,
      targets: group.targets,
    };
  });

  groups.sort((a, b) => a.lines[0] - b.lines[0] || a.side.localeCompare(b.side));
  return { turn: publicTurn(turn), groups };
}

export async function updateSessionTurnMessages(filePath, turnId, edits, options = {}) {
  if (!Array.isArray(edits)) {
    throw new Error("Turn edits must be an array");
  }

  const { records } = await readJsonl(filePath);
  const plan = getSessionTurnEditPlan(records, turnId);
  const editsById = new Map();
  for (const edit of edits) {
    if (!edit || typeof edit.id !== "string") {
      continue;
    }
    editsById.set(edit.id, typeof edit.text === "string" ? edit.text : "");
  }

  const nextByLine = new Map();
  let changedGroups = 0;
  let changedTargets = 0;

  for (const group of plan.groups) {
    if (!editsById.has(group.id)) {
      continue;
    }
    const nextText = editsById.get(group.id);
    if (nextText === group.text) {
      continue;
    }

    changedGroups += 1;
    for (const target of group.targets) {
      const line = target.line;
      const nextRecord = nextByLine.get(line) || cloneJson(records[line - 1]);
      if (setPathValue(nextRecord, target.path, nextText)) {
        changedTargets += 1;
      }
      nextByLine.set(line, nextRecord);
    }
  }

  const updates = [...nextByLine.entries()]
    .map(([line, record]) => ({ line, record }))
    .sort((a, b) => a.line - b.line);
  const result = await updateSessionRecords(filePath, updates, {
    managerHome: options.managerHome,
    dryRun: booleanOption(options, "dryRun", "dry-run"),
    reason: `edit turn ${plan.turn.index}`,
  });

  return {
    ...result,
    turn: plan.turn,
    changedGroups,
    changedTargets,
  };
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

export function groupSessionTurns(records) {
  if (!Array.isArray(records)) {
    return [];
  }

  const turns = [];
  let current = null;
  let conversationIndex = 0;

  function startTurn(line, record, kind) {
    if (kind === "setup") {
      current = {
        id: "setup",
        index: 0,
        kind: "setup",
        sourceTurnId: "",
        startLine: line,
        endLine: line,
        lineCount: 0,
        userText: "",
        assistantText: "",
        userTargetCount: 0,
        assistantTargetCount: 0,
        editableTargetCount: 0,
        hasUser: false,
        hasAssistant: false,
      };
    } else {
      conversationIndex += 1;
      current = {
        id: `turn-${conversationIndex}`,
        index: conversationIndex,
        kind: "conversation",
        sourceTurnId: recordTurnId(record),
        startLine: line,
        endLine: line,
        lineCount: 0,
        userText: "",
        assistantText: "",
        userTargetCount: 0,
        assistantTargetCount: 0,
        editableTargetCount: 0,
        hasUser: false,
        hasAssistant: false,
      };
    }
    turns.push(current);
  }

  for (let index = 0; index < records.length; index += 1) {
    const line = index + 1;
    const record = records[index];
    if (recordStartsTask(record)) {
      startTurn(line, record, "conversation");
    } else if (!current) {
      startTurn(line, record, recordStartsFallbackUserTurn(record) ? "conversation" : "setup");
    } else if (recordStartsFallbackUserTurn(record) && shouldStartFallbackTurn(current)) {
      startTurn(line, record, "conversation");
    }

    current.endLine = line;
    current.lineCount += 1;
    if (!current.sourceTurnId) {
      current.sourceTurnId = recordTurnId(record);
    }

    for (const target of editableMessageTargets(record, line)) {
      current.editableTargetCount += 1;
      if (target.side === "user") {
        current.userTargetCount += 1;
        current.hasUser = true;
        if (!current.userText && target.text.trim()) {
          current.userText = target.text;
        }
      } else if (target.side === "assistant") {
        current.assistantTargetCount += 1;
        current.hasAssistant = true;
        if (target.text.trim()) {
          current.assistantText = target.text;
        }
      }
    }
  }

  return turns;
}

function annotateRecordTurn(record, turn, sourceRecord) {
  if (!turn) {
    return record;
  }
  const messageSide = messageSideForRecord(sourceRecord);
  return {
    ...record,
    turnId: turn.id,
    turnIndex: turn.index,
    turnKind: turn.kind,
    turnLabel: turn.kind === "setup" ? "Setup" : `Turn ${turn.index}`,
    turnStartLine: turn.startLine,
    turnEndLine: turn.endLine,
    messageSide,
  };
}

function publicTurn(turn) {
  return {
    id: turn.id,
    index: turn.index,
    kind: turn.kind,
    label: turn.kind === "setup" ? "Setup" : `Turn ${turn.index}`,
    sourceTurnId: turn.sourceTurnId,
    startLine: turn.startLine,
    endLine: turn.endLine,
    lineCount: turn.lineCount,
    userText: oneLine(turn.userText, 180),
    assistantText: oneLine(turn.assistantText, 180),
    userTargetCount: turn.userTargetCount,
    assistantTargetCount: turn.assistantTargetCount,
    editableTargetCount: turn.editableTargetCount,
  };
}

function findSessionTurn(records, turnId) {
  return groupSessionTurns(records).find((turn) => turn.id === turnId || turn.sourceTurnId === turnId);
}

function recordStartsTask(record) {
  const payload = isPlainObject(record?.payload) ? record.payload : {};
  return textValue(record?.type) === "event_msg" && textValue(payload.type) === "task_started";
}

function recordStartsFallbackUserTurn(record) {
  return editableMessageTargets(record, 1).some((target) => target.side === "user");
}

function shouldStartFallbackTurn(current) {
  if (!current || current.kind === "setup") {
    return true;
  }
  return current.hasUser && current.hasAssistant;
}

function recordTurnId(record) {
  const payload = isPlainObject(record?.payload) ? record.payload : {};
  return textValue(payload.turn_id || record?.turn_id);
}

function editableMessageTargets(record, line) {
  const payload = isPlainObject(record?.payload) ? record.payload : {};
  const recordType = textValue(record?.type);
  const payloadType = textValue(payload.type);
  const targets = [];

  function add(side, pathParts, value) {
    if ((side !== "user" && side !== "assistant") || typeof value !== "string") {
      return;
    }
    targets.push({
      line,
      side,
      path: pathParts,
      text: value,
    });
  }

  if (recordType === "event_msg") {
    if (payloadType === "user_message") {
      add("user", ["payload", "message"], payload.message);
      add("user", ["payload", "text"], payload.text);
    } else if (payloadType === "agent_message") {
      add("assistant", ["payload", "message"], payload.message);
      add("assistant", ["payload", "text"], payload.text);
    } else if (payloadType === "task_complete") {
      add("assistant", ["payload", "last_agent_message"], payload.last_agent_message);
      add("assistant", ["payload", "message"], payload.message);
      add("assistant", ["payload", "text"], payload.text);
    }
  }

  if (recordType === "response_item" && payloadType === "message") {
    const role = textValue(payload.role || record?.role).toLowerCase();
    if (role === "user" || role === "assistant") {
      add(role, ["payload", "message"], payload.message);
      add(role, ["payload", "text"], payload.text);
      if (Array.isArray(payload.content)) {
        payload.content.forEach((item, index) => {
          if (isPlainObject(item)) {
            add(role, ["payload", "content", index, "text"], item.text);
          }
        });
      }
    }
  }

  return targets;
}

function messageSideForRecord(record) {
  const targets = editableMessageTargets(record, 1);
  if (targets.some((target) => target.side === "user")) {
    return "user";
  }
  if (targets.some((target) => target.side === "assistant")) {
    return "assistant";
  }
  return "";
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function setPathValue(target, pathParts, value) {
  let current = target;
  for (let index = 0; index < pathParts.length - 1; index += 1) {
    current = current?.[pathParts[index]];
    if (current === undefined || current === null) {
      return false;
    }
  }
  const key = pathParts[pathParts.length - 1];
  if (typeof current?.[key] !== "string") {
    return false;
  }
  current[key] = value;
  return true;
}

function turnMessageGroupId(turnId, side, text, firstLine) {
  return `${side}-${firstLine}-${shortHash(`${turnId}\u0000${side}\u0000${text}\u0000${firstLine}`)}`;
}

function pathToString(pathParts) {
  return pathParts
    .map((part) => (typeof part === "number" ? `[${part}]` : String(part)))
    .join(".");
}

export function sessionIsActive(session, windowMinutes = 10, now = Date.now()) {
  const updatedAt = Date.parse(session?.fileUpdatedAt || session?.updatedAt);
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

function defaultCodexProfileToml() {
  return `${schemaHeaderLine()}\n# Codex profile file. Activate it with: codex -p <profile>\n\n`;
}

function ensureCodexConfigSchemaHeader(raw) {
  const body = normalizeTextFile(raw);
  if (/^\s*#:schema\s+/m.test(body)) {
    return body;
  }
  return `${schemaHeaderLine()}\n${body}`;
}

function schemaHeaderLine() {
  return `#:schema ${CODEX_CONFIG_SCHEMA_URL}`;
}

function normalizeTextFile(input) {
  const text = String(input ?? "").replace(/\r\n?/g, "\n");
  return text.endsWith("\n") ? text : `${text}\n`;
}

function upsertTopLevelTomlString(raw, key, value) {
  const clean = removeTopLevelTomlKey(raw, key);
  const lines = clean.split("\n");
  const insertAt = lines[0]?.startsWith("#:schema ") ? 1 : 0;
  lines.splice(insertAt, 0, `${key} = ${tomlBasicString(value)}`);
  return normalizeTextFile(lines.join("\n").replace(/\n{3,}/g, "\n\n"));
}

function removeTopLevelTomlKey(raw, key) {
  const lines = normalizeTextFile(raw).split("\n");
  const out = [];
  const keyPattern = new RegExp(`^\\s*${escapeRegex(key)}\\s*=`);
  let inTable = false;
  let skipUntil = "";

  for (const line of lines) {
    if (skipUntil) {
      if (line.includes(skipUntil)) {
        skipUntil = "";
      }
      continue;
    }

    const trimmed = line.trim();
    if (!inTable && keyPattern.test(line)) {
      const valuePart = line.slice(line.indexOf("=") + 1).trimStart();
      if (valuePart.startsWith('"""') && !valuePart.slice(3).includes('"""')) {
        skipUntil = '"""';
      } else if (valuePart.startsWith("'''") && !valuePart.slice(3).includes("'''")) {
        skipUntil = "'''";
      }
      continue;
    }

    if (/^\s*\[/.test(trimmed)) {
      inTable = true;
    }
    out.push(line);
  }

  return normalizeTextFile(out.join("\n"));
}

function extractTopLevelTomlString(raw, key) {
  const value = extractTopLevelTomlValue(raw, key);
  if (!value) {
    return "";
  }

  if (value.startsWith('"""') || value.startsWith("'''")) {
    const marker = value.slice(0, 3);
    const end = value.lastIndexOf(marker);
    if (end > 2) {
      return value.slice(3, end);
    }
    return "";
  }

  if (value.startsWith('"')) {
    try {
      return JSON.parse(value);
    } catch {
      return value.slice(1).replace(/"$/, "");
    }
  }

  if (value.startsWith("'")) {
    return value.slice(1).replace(/'$/, "");
  }

  return "";
}

function extractTopLevelTomlValue(raw, key) {
  const lines = normalizeTextFile(raw).split("\n");
  const keyPattern = new RegExp(`^\\s*${escapeRegex(key)}\\s*=`);
  let inTable = false;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const trimmed = line.trim();
    if (/^\s*\[/.test(trimmed)) {
      inTable = true;
    }
    if (inTable || !keyPattern.test(line)) {
      continue;
    }

    const valuePart = line.slice(line.indexOf("=") + 1).trim();
    if (valuePart.startsWith('"""') && !valuePart.slice(3).includes('"""')) {
      return collectMultilineTomlValue(lines, index, '"""');
    }
    if (valuePart.startsWith("'''") && !valuePart.slice(3).includes("'''")) {
      return collectMultilineTomlValue(lines, index, "'''");
    }
    return stripTomlInlineComment(valuePart).trim();
  }

  return "";
}

function collectMultilineTomlValue(lines, startIndex, marker) {
  const chunks = [lines[startIndex].slice(lines[startIndex].indexOf("=") + 1).trimStart()];
  for (let index = startIndex + 1; index < lines.length; index += 1) {
    chunks.push(lines[index]);
    if (lines[index].includes(marker)) {
      break;
    }
  }
  return chunks.join("\n");
}

function stripTomlInlineComment(value) {
  let quote = "";
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if ((char === '"' || char === "'") && value[index - 1] !== "\\") {
      quote = quote === char ? "" : quote || char;
    }
    if (!quote && char === "#") {
      return value.slice(0, index);
    }
  }
  return value;
}

function tomlBasicString(value) {
  return JSON.stringify(String(value ?? ""));
}

function buildTextRewritePrompt(text, rewritePrompt, options = {}) {
  return [
    "你是一个文本转写助手。",
    "请根据用户给出的转写要求，改写下面这一段文本。",
    "要求：只输出转写后的文本；不要解释过程；不要添加原文没有的信息。",
    "",
    "<rewrite_prompt>",
    rewritePrompt,
    "</rewrite_prompt>",
    "",
    "<source>",
    options.side ? `side: ${options.side}` : "",
    text,
    "</source>",
  ]
    .filter((line) => line !== "")
    .join("\n");
}

function normalizeRewriteLlmProvider(value) {
  const provider = String(value || "codex").toLowerCase();
  if (provider === "openai-compatible") {
    return "openai";
  }
  if (provider === "anthropic-compatible") {
    return "anthropic";
  }
  if (provider === "openai" || provider === "anthropic" || provider === "codex") {
    return provider;
  }
  throw new Error(`Unsupported rewrite LLM provider: ${value}`);
}

async function runOpenAICompatibleRewrite(input, options = {}) {
  const model = String(options.model || "").trim();
  if (!model) {
    throw new Error("OpenAI-compatible rewrite model is required");
  }
  const url = compatibleEndpoint(options.baseUrl || "https://api.openai.com/v1", "/chat/completions");
  const body = {
    model,
    messages: [{ role: "user", content: input }],
  };
  const result = await postJson(url, body, {
    "content-type": "application/json",
    ...(options.apiKey ? { authorization: `Bearer ${options.apiKey}` } : {}),
  }, options);
  const output = textValue(result?.choices?.[0]?.message?.content) || textValue(result?.choices?.[0]?.text);
  if (!output) {
    throw new Error("OpenAI-compatible rewrite response did not include text output");
  }
  return { output: output.trim(), stdout: JSON.stringify(result), stderr: "", command: `POST ${url}` };
}

async function runAnthropicCompatibleRewrite(input, options = {}) {
  const model = String(options.model || "").trim();
  if (!model) {
    throw new Error("Anthropic-compatible rewrite model is required");
  }
  const url = compatibleEndpoint(options.baseUrl || "https://api.anthropic.com/v1", "/messages");
  const body = {
    model,
    max_tokens: Number.parseInt(String(options.maxTokens || "4096"), 10) || 4096,
    messages: [{ role: "user", content: input }],
  };
  const result = await postJson(url, body, {
    "content-type": "application/json",
    "anthropic-version": options.anthropicVersion || "2023-06-01",
    ...(options.apiKey ? { "x-api-key": options.apiKey } : {}),
  }, options);
  const output = Array.isArray(result?.content)
    ? result.content.map((item) => textValue(item?.text)).filter(Boolean).join("\n")
    : textValue(result?.completion);
  if (!output) {
    throw new Error("Anthropic-compatible rewrite response did not include text output");
  }
  return { output: output.trim(), stdout: JSON.stringify(result), stderr: "", command: `POST ${url}` };
}

function compatibleEndpoint(baseUrl, suffix) {
  const clean = String(baseUrl || "").trim().replace(/\/+$/, "");
  if (!clean) {
    throw new Error("Rewrite API base URL is required");
  }
  return clean.endsWith(suffix) ? clean : `${clean}${suffix}`;
}

async function postJson(url, body, headers, options = {}) {
  const fetchImpl = options.fetch || globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    throw new Error("fetch is not available in this Node.js runtime");
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs || 5 * 60 * 1000);
  try {
    const response = await fetchImpl(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await response.text();
    let parsed = {};
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = { text };
      }
    }
    if (!response.ok) {
      throw new Error(`Rewrite API request failed (${response.status}): ${text || response.statusText}`);
    }
    return parsed;
  } finally {
    clearTimeout(timeout);
  }
}

async function runCodexExec(input, options = {}) {
  const command = options.codexCommand || "codex";
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "coldxx-rewrite-"));
  const outputPath = path.join(tmpDir, "last-message.txt");
  const args = ["exec"];

  if (options.profile) {
    validateProfileName(options.profile);
    args.push("-p", options.profile);
  }
  if (options.model) {
    args.push("-m", String(options.model));
  }

  args.push(
    "--ephemeral",
    "--skip-git-repo-check",
    "--sandbox",
    "read-only",
    "--disable",
    "shell_tool",
    "-c",
    'approval_policy="never"',
    "-o",
    outputPath,
    "-",
  );

  try {
    const result = await runProcess(command, args, input, {
      cwd: options.cwd || process.cwd(),
      timeoutMs: options.timeoutMs || 5 * 60 * 1000,
      env: options.codexHome ? { ...process.env, CODEX_HOME: resolveCodexHome(options.codexHome) } : process.env,
    });
    const output = (await pathExists(outputPath)) ? await fs.readFile(outputPath, "utf8") : result.stdout;
    return { ...result, output: output.trim() };
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
}

async function runProcess(command, args, input, options = {}) {
  const maxOutputBytes = 1024 * 1024;
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`Command timed out after ${options.timeoutMs}ms: ${command}`));
    }, options.timeoutMs);
    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout = appendLimited(stdout, chunk, maxOutputBytes);
    });
    child.stderr.on("data", (chunk) => {
      stderr = appendLimited(stderr, chunk, maxOutputBytes);
    });
    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      if (code !== 0) {
        reject(new Error(`Command failed (${code}): ${command} ${args.join(" ")}\n${stderr || stdout}`.trim()));
        return;
      }
      resolve({ stdout, stderr, command: `${command} ${args.join(" ")}` });
    });
    child.stdin.end(input);
  });
}

function appendLimited(current, chunk, maxBytes) {
  const next = current + chunk.toString("utf8");
  if (Buffer.byteLength(next, "utf8") <= maxBytes) {
    return next;
  }
  return next.slice(-maxBytes);
}

function validateStorageId(value, label) {
  if (!value || !/^[A-Za-z0-9._-]+$/.test(value) || value === "." || value === "..") {
    throw new Error(`Invalid ${label}: ${value}`);
  }
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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
