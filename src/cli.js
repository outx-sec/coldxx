#!/usr/bin/env node

import syncFs from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startUiServer } from "./ui-server.js";
import {
  cleanSessions,
  dropSessionLines,
  emptyTrash,
  formatBytes,
  listCodexProfiles,
  listTrash,
  readJsonl,
  readCodexProfile,
  readSessionSummary,
  replaceInSession,
  resolveCodexHome,
  resolveManagerHome,
  resolveSessionSelectors,
  restoreTrashBatch,
  scanSessions,
  sessionsRoot,
  oneLine,
  writeCodexProfile,
} from "./core.js";

const BOOLEAN_FLAGS = new Set([
  "all",
  "allow-active",
  "case-sensitive",
  "dry-run",
  "help",
  "json",
  "no-preview",
  "overwrite",
  "permanent",
  "raw",
  "regex",
  "version",
  "yes",
]);

const SHORT_FLAGS = new Map([
  ["a", "all"],
  ["h", "help"],
  ["j", "json"],
  ["n", "limit"],
  ["v", "version"],
  ["y", "yes"],
]);

export async function main(argv = process.argv.slice(2), io = process) {
  const parsed = parseArgs(argv);

  if (parsed.options.version) {
    io.stdout.write(await versionText());
    return 0;
  }

  if (!parsed.command || parsed.options.help) {
    io.stdout.write(helpText());
    return 0;
  }

  const options = parsed.options;
  const codexHome = resolveCodexHome(options["codex-home"]);
  const managerHome = resolveManagerHome(options["coldxx-home"] ?? options["manager-home"]);

  switch (parsed.command) {
    case "list":
    case "ls":
      return listCommand(parsed.positionals, { ...options, codexHome }, io);
    case "show":
      return showCommand(parsed.positionals, { ...options, codexHome }, io);
    case "clean":
    case "rm":
      return cleanCommand(parsed.positionals, { ...options, codexHome, managerHome }, io);
    case "clean-all":
      return cleanAllCommand(parsed.positionals, { ...options, codexHome, managerHome }, io);
    case "edit":
      return editCommand(parsed.positionals, { ...options, codexHome, managerHome }, io);
    case "drop":
      return dropCommand(parsed.positionals, { ...options, codexHome, managerHome }, io);
    case "trash":
      return trashCommand(parsed.positionals, { ...options, managerHome }, io);
    case "profiles":
    case "profile":
      return profilesCommand(parsed.positionals, { ...options, codexHome, managerHome }, io);
    case "ui":
    case "web":
      return uiCommand(parsed.positionals, { ...options, codexHome, managerHome }, io);
    case "doctor":
      return doctorCommand(parsed.positionals, { ...options, codexHome, managerHome }, io);
    default:
      throw new Error(`Unknown command: ${parsed.command}\n\n${briefHelp()}`);
  }
}

export function parseArgs(argv) {
  const options = {};
  const positionals = [];
  let command = null;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "--") {
      positionals.push(...argv.slice(index + 1));
      break;
    }

    if (arg.startsWith("--")) {
      const equalsIndex = arg.indexOf("=");
      const rawName = equalsIndex === -1 ? arg.slice(2) : arg.slice(2, equalsIndex);
      const name = normalizeOptionName(rawName);

      if (BOOLEAN_FLAGS.has(name)) {
        options[name] = equalsIndex === -1 ? true : parseBoolean(arg.slice(equalsIndex + 1));
        continue;
      }

      if (equalsIndex !== -1) {
        options[name] = arg.slice(equalsIndex + 1);
        continue;
      }

      if (index + 1 >= argv.length) {
        throw new Error(`Missing value for --${name}`);
      }
      options[name] = argv[index + 1];
      index += 1;
      continue;
    }

    if (arg.startsWith("-") && arg.length > 1) {
      const shortName = arg.slice(1);
      const name = SHORT_FLAGS.get(shortName);
      if (!name) {
        throw new Error(`Unknown short option: -${shortName}`);
      }

      if (BOOLEAN_FLAGS.has(name)) {
        options[name] = true;
      } else {
        if (index + 1 >= argv.length) {
          throw new Error(`Missing value for -${shortName}`);
        }
        options[name] = argv[index + 1];
        index += 1;
      }
      continue;
    }

    if (!command) {
      command = arg;
    } else {
      positionals.push(arg);
    }
  }

  return { command, positionals, options };
}

async function listCommand(_positionals, options, io) {
  const sessions = await filteredSessions(options);
  const limited = options.all ? sessions : sessions.slice(0, numberOption(options.limit, 30));

  if (options.json) {
    io.stdout.write(`${JSON.stringify(limited, null, 2)}\n`);
    return 0;
  }

  if (sessions.length === 0) {
    io.stdout.write(`No sessions found under ${sessionsRoot(options.codexHome)}\n`);
    return 0;
  }

  io.stdout.write(formatSessionTable(limited, { preview: !options["no-preview"] }));
  if (!options.all && sessions.length > limited.length) {
    io.stdout.write(`\nShowing ${limited.length} of ${sessions.length}. Use --all to show everything.\n`);
  }
  return 0;
}

async function showCommand(positionals, options, io) {
  const selector = positionals[0];
  if (!selector) {
    throw new Error("Usage: coldxx show <session>");
  }

  const sessions = await scanSessions({ codexHome: options.codexHome });
  const [session] = resolveSessionSelectors(sessions, [selector], { allowMany: false });

  if (options.raw) {
    io.stdout.write(await fs.readFile(session.file, "utf8"));
    return 0;
  }

  const summary = await readSessionSummary(session.file, { codexHome: options.codexHome });
  const { records } = await readJsonl(session.file);

  if (options.json) {
    io.stdout.write(`${JSON.stringify({ summary, records }, null, 2)}\n`);
    return 0;
  }

  io.stdout.write(formatSessionDetails(summary, records, numberOption(options.limit, 20)));
  return 0;
}

async function cleanCommand(positionals, options, io) {
  if (positionals.length === 0) {
    throw new Error("Usage: coldxx clean <session...> [--yes] [--permanent] [--dry-run]");
  }

  const sessions = await scanSessions({ codexHome: options.codexHome });
  const targets = resolveSessionSelectors(sessions, positionals, { allowMany: true });
  requireYesUnlessDryRun(options, `clean ${targets.length} session(s)`);
  guardActiveSessions(targets, options, "clean");

  const result = await cleanSessions(targets, options);
  io.stdout.write(formatCleanResult(result));
  return 0;
}

async function cleanAllCommand(positionals, options, io) {
  if (positionals.length > 0) {
    throw new Error("Usage: coldxx clean-all [--yes] [--permanent] [--dry-run]");
  }

  const targets = await scanSessions({ codexHome: options.codexHome });
  requireYesUnlessDryRun(options, `clean all ${targets.length} session(s)`);
  guardActiveSessions(targets, options, "clean all");

  const result = await cleanSessions(targets, options);
  io.stdout.write(formatCleanResult(result));
  return 0;
}

async function editCommand(positionals, options, io) {
  const selector = positionals[0];
  if (!selector || typeof options.replace !== "string") {
    throw new Error(
      "Usage: coldxx edit <session> --replace <text> --with <text> [--scope all|messages|user|assistant|system|tool|metadata] [--yes] [--dry-run]",
    );
  }

  requireYesUnlessDryRun(options, "edit session history");
  const sessions = await scanSessions({ codexHome: options.codexHome });
  const [session] = resolveSessionSelectors(sessions, [selector], { allowMany: false });
  guardActiveSessions([session], options, "edit");
  const result = await replaceInSession(session.file, {
    from: options.replace,
    to: options.with ?? "",
    scope: options.scope || "all",
    regex: Boolean(options.regex),
    flags: options.flags || "",
    caseSensitive: Boolean(options["case-sensitive"]),
    dryRun: Boolean(options["dry-run"]),
    managerHome: options.managerHome,
  });

  io.stdout.write(formatEditResult(result));
  return 0;
}

async function dropCommand(positionals, options, io) {
  const selector = positionals[0];
  if (!selector || typeof options.lines !== "string") {
    throw new Error("Usage: coldxx drop <session> --lines <range> [--yes] [--dry-run]");
  }

  requireYesUnlessDryRun(options, "drop lines from session history");
  const sessions = await scanSessions({ codexHome: options.codexHome });
  const [session] = resolveSessionSelectors(sessions, [selector], { allowMany: false });
  guardActiveSessions([session], options, "drop lines from");
  const result = await dropSessionLines(session.file, {
    lines: options.lines,
    dryRun: Boolean(options["dry-run"]),
    managerHome: options.managerHome,
  });

  io.stdout.write(formatDropResult(result));
  return 0;
}

async function trashCommand(positionals, options, io) {
  const subcommand = positionals[0] || "list";

  if (subcommand === "list") {
    const items = await listTrash(options);
    if (options.json) {
      io.stdout.write(`${JSON.stringify(items, null, 2)}\n`);
    } else {
      io.stdout.write(formatTrashList(items));
    }
    return 0;
  }

  if (subcommand === "restore") {
    const batchId = positionals[1];
    if (!batchId) {
      throw new Error("Usage: coldxx trash restore <trash-id> [--overwrite]");
    }
    const result = await restoreTrashBatch(batchId, options);
    io.stdout.write(`Restored ${result.count} session(s) from ${batchId}\n`);
    return 0;
  }

  if (subcommand === "empty") {
    requireYesUnlessDryRun(options, "empty trash");
    const result = await emptyTrash(options);
    io.stdout.write(
      `${result.dryRun ? "Would remove" : "Removed"} ${result.count} trash batch(es) from ${result.trashRoot}\n`,
    );
    return 0;
  }

  throw new Error("Usage: coldxx trash [list|restore|empty]");
}

async function profilesCommand(positionals, options, io) {
  const subcommand = positionals[0] || "list";

  if (subcommand === "list" || subcommand === "ls") {
    const profiles = await listCodexProfiles(options);
    if (options.json) {
      io.stdout.write(`${JSON.stringify(profiles, null, 2)}\n`);
    } else {
      io.stdout.write(formatProfilesList(profiles));
    }
    return 0;
  }

  if (subcommand === "show") {
    const name = positionals[1];
    if (!name) {
      throw new Error("Usage: coldxx profiles show <name>");
    }
    const profile = await readCodexProfile(name, options);
    if (options.json) {
      io.stdout.write(`${JSON.stringify(profile, null, 2)}\n`);
    } else {
      io.stdout.write(profile.raw);
    }
    return 0;
  }

  if (subcommand === "save") {
    const name = positionals[1];
    if (!name || !options.file) {
      throw new Error("Usage: coldxx profiles save <name> --file <config.toml> --yes");
    }
    requireYesUnlessDryRun(options, "save Codex profile config");
    const raw = await fs.readFile(path.resolve(options.file), "utf8");
    if (options["dry-run"]) {
      io.stdout.write(`Would save Codex profile ${name} from ${path.resolve(options.file)}\n`);
      return 0;
    }
    const result = await writeCodexProfile(name, { ...options, raw });
    io.stdout.write(formatProfileSaveResult(result));
    return 0;
  }

  throw new Error("Usage: coldxx profiles [list|show <name>|save <name> --file <config.toml> --yes]");
}

async function doctorCommand(_positionals, options, io) {
  const root = sessionsRoot(options.codexHome);
  const sessions = await scanSessions({ codexHome: options.codexHome });
  const trash = await listTrash({ managerHome: options.managerHome });
  const lines = [
    `Codex home:    ${options.codexHome}`,
    `Sessions root: ${root}`,
    `coldxx home:   ${options.managerHome}`,
    `Sessions:      ${sessions.length}`,
    `Trash batches: ${trash.length}`,
  ];
  io.stdout.write(`${lines.join("\n")}\n`);
  return 0;
}

async function uiCommand(positionals, options, io) {
  if (positionals.length > 0) {
    throw new Error("Usage: coldxx ui [--host 127.0.0.1] [--port 4765]");
  }

  const result = await startUiServer({
    codexHome: options.codexHome,
    managerHome: options.managerHome,
    host: options.host,
    port: options.port,
    activeWindowMinutes: options["active-window-minutes"],
  });
  io.stdout.write(`coldxx UI: ${result.url}\n`);
  io.stdout.write("Listening on localhost. Press Ctrl-C to stop.\n");
  return 0;
}

async function filteredSessions(options) {
  let sessions = await scanSessions({ codexHome: options.codexHome });

  if (options.query) {
    const needle = String(options.query).toLowerCase();
    sessions = sessions.filter((session) =>
      [session.id, session.file, session.cwd, session.preview, session.model]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase().includes(needle)),
    );
  }

  if (options.since) {
    const since = Date.parse(options.since);
    if (Number.isNaN(since)) {
      throw new Error(`Invalid --since date: ${options.since}`);
    }
    sessions = sessions.filter((session) => (Date.parse(session.startedAt) || 0) >= since);
  }

  if (options.until) {
    const until = Date.parse(options.until);
    if (Number.isNaN(until)) {
      throw new Error(`Invalid --until date: ${options.until}`);
    }
    sessions = sessions.filter((session) => (Date.parse(session.startedAt) || 0) <= until);
  }

  return sessions;
}

function formatSessionTable(sessions, options = {}) {
  const rows = sessions.map((session, index) => ({
    "#": String(index + 1),
    started: formatDate(session.startedAt),
    id: session.shortId,
    lines: String(session.lines),
    size: formatBytes(session.sizeBytes),
    cwd: compactPath(session.cwd || path.dirname(session.relativePath), 34),
    preview: options.preview ? oneLine(session.preview, 58) : "",
  }));

  const columns = options.preview
    ? ["#", "started", "id", "lines", "size", "cwd", "preview"]
    : ["#", "started", "id", "lines", "size", "cwd"];
  return `${table(rows, columns)}\n`;
}

function formatSessionDetails(summary, records, limit) {
  const lines = [
    `id:          ${summary.id}`,
    `parent id:   ${summary.parentSessionId || "-"}`,
    `file:        ${summary.file}`,
    `started:     ${summary.startedAt}`,
    `updated:     ${summary.updatedAt}`,
    `cwd:         ${summary.cwd || "-"}`,
    `model:       ${summary.model || "-"}`,
    `cli version: ${summary.cliVersion || "-"}`,
    `size:        ${formatBytes(summary.sizeBytes)}`,
    `records:     ${summary.lines}`,
    "",
    `First ${Math.min(limit, records.length)} record(s):`,
  ];

  for (const [index, record] of records.slice(0, limit).entries()) {
    const payload = record.payload && typeof record.payload === "object" ? record.payload : {};
    const role = payload.role ? ` ${payload.role}` : "";
    const type = record.type || payload.type || "record";
    lines.push(`${String(index + 1).padStart(4, " ")} ${type}${role} ${oneLine(firstDisplayText(record), 100)}`);
  }

  return `${lines.join("\n")}\n`;
}

function formatCleanResult(result) {
  const verb = result.dryRun ? "Would process" : result.permanent ? "Deleted" : "Moved to trash";
  const lines = [`${verb} ${result.count} session(s).`];
  if (!result.permanent) {
    lines.push(`Trash batch: ${result.batchId}`);
  }
  for (const item of result.results) {
    lines.push(`- ${item.action}: ${item.originalPath}${item.targetPath ? ` -> ${item.targetPath}` : ""}`);
  }
  return `${lines.join("\n")}\n`;
}

function formatEditResult(result) {
  const lines = [
    `${result.dryRun ? "Would replace" : "Replaced"} ${result.replacements} occurrence(s) in ${result.changedRecords}/${result.totalRecords} record(s).`,
    `file: ${result.file}`,
  ];
  if (result.backup) {
    lines.push(`backup: ${result.backup.backupPath}`);
  }
  return `${lines.join("\n")}\n`;
}

function formatDropResult(result) {
  const lines = [
    `${result.dryRun ? "Would remove" : "Removed"} ${result.removedLines.length} line(s).`,
    `file: ${result.file}`,
    `records: ${result.beforeLines} -> ${result.afterLines}`,
  ];
  if (result.backup) {
    lines.push(`backup: ${result.backup.backupPath}`);
  }
  return `${lines.join("\n")}\n`;
}

function formatTrashList(items) {
  if (items.length === 0) {
    return "Trash is empty.\n";
  }

  const rows = items.map((item) => ({
    id: item.id,
    cleaned: formatDate(item.cleanedAt),
    count: String(item.count),
    dir: item.dir,
  }));
  return `${table(rows, ["id", "cleaned", "count", "dir"])}\n`;
}

function formatProfilesList(profiles) {
  if (profiles.length === 0) {
    return "No Codex profile files found.\n";
  }

  const rows = profiles.map((profile) => ({
    name: profile.name,
    updated: formatDate(profile.updatedAt),
    size: profile.size,
    file: profile.file,
    activate: profile.command,
  }));
  return `${table(rows, ["name", "updated", "size", "file", "activate"])}\n`;
}

function formatProfileSaveResult(result) {
  const lines = [
    `Saved Codex profile: ${result.name}`,
    `file: ${result.file}`,
    `activate: ${result.command}`,
    `exec: ${result.execCommand}`,
  ];
  if (result.backup) {
    lines.push(`backup: ${result.backup.backupPath}`);
  }
  return `${lines.join("\n")}\n`;
}

function table(rows, columns) {
  if (rows.length === 0) {
    return "";
  }

  const widths = {};
  for (const column of columns) {
    widths[column] = Math.max(column.length, ...rows.map((row) => String(row[column] ?? "").length));
  }

  const header = columns.map((column) => String(column).padEnd(widths[column])).join("  ");
  const divider = columns.map((column) => "-".repeat(widths[column])).join("  ");
  const body = rows
    .map((row) => columns.map((column) => String(row[column] ?? "").padEnd(widths[column])).join("  "))
    .join("\n");
  return `${header}\n${divider}\n${body}`;
}

function firstDisplayText(record) {
  const payload = record.payload && typeof record.payload === "object" ? record.payload : record;
  if (typeof payload.message === "string") {
    return payload.message;
  }
  if (typeof payload.text === "string") {
    return payload.text;
  }
  if (typeof payload.content === "string") {
    return payload.content;
  }
  if (Array.isArray(payload.content)) {
    const textItem = payload.content.find((item) => item && typeof item.text === "string");
    if (textItem) {
      return textItem.text;
    }
  }
  return JSON.stringify(payload);
}

function formatDate(value) {
  if (!value) {
    return "-";
  }
  return String(value).replace("T", " ").replace(/\.\d{3}Z$/, "Z").slice(0, 19);
}

function compactPath(value, max) {
  if (!value) {
    return "-";
  }
  const home = process.env.HOME;
  const text = home && value.startsWith(home) ? `~${value.slice(home.length)}` : value;
  if (text.length <= max) {
    return text;
  }
  return `...${text.slice(-(max - 3))}`;
}

function numberOption(value, fallback) {
  if (value === undefined) {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    throw new Error(`Expected positive integer, got: ${value}`);
  }
  return parsed;
}

function requireYesUnlessDryRun(options, action) {
  if (options["dry-run"]) {
    return;
  }

  if (!options.yes) {
    throw new Error(`Refusing to ${action} without --yes. Re-run with --dry-run to preview.`);
  }
}

function guardActiveSessions(sessions, options, action) {
  if (options["dry-run"] || options["allow-active"]) {
    return;
  }

  const windowMinutes = numberOption(options["active-window-minutes"], 10);
  const cutoff = Date.now() - windowMinutes * 60 * 1000;
  const active = sessions.filter((session) => {
    const updatedAt = Date.parse(session.fileUpdatedAt || session.updatedAt);
    return Number.isFinite(updatedAt) && updatedAt >= cutoff;
  });

  if (active.length === 0) {
    return;
  }

  const lines = active
    .slice(0, 5)
    .map((session) => `- ${session.shortId} updated ${formatDate(session.fileUpdatedAt || session.updatedAt)} ${session.file}`);
  throw new Error(
    `Refusing to ${action} session(s) updated within the last ${windowMinutes} minute(s).\n${lines.join(
      "\n",
    )}${active.length > 5 ? "\n..." : ""}\nRe-run with --allow-active if you are sure Codex is not writing them.`,
  );
}

function normalizeOptionName(name) {
  return name.replace(/_/g, "-");
}

function parseBoolean(value) {
  if (["1", "true", "yes", "on"].includes(String(value).toLowerCase())) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(String(value).toLowerCase())) {
    return false;
  }
  throw new Error(`Invalid boolean value: ${value}`);
}

function briefHelp() {
  return "Run `coldxx --help` for usage.";
}

function helpText() {
  return `coldxx - local Codex session manager

Usage:
  coldxx list [--limit N] [--all] [--query TEXT] [--json]
  coldxx show <session> [--limit N] [--json|--raw]
  coldxx clean <session...> [--yes] [--permanent] [--dry-run]
  coldxx clean-all [--yes] [--permanent] [--dry-run]
  coldxx edit <session> --replace TEXT --with TEXT [--scope SCOPE] [--regex] [--yes] [--dry-run]
  coldxx drop <session> --lines RANGE [--yes] [--dry-run]
  coldxx ui [--host 127.0.0.1] [--port 4765]
  coldxx trash [list|restore <trash-id>|empty] [--yes]
  coldxx profiles [list|show <name>|save <name> --file <config.toml> --yes]
  coldxx doctor

Selectors:
  latest            most recent session
  1, 2, 3           index from "coldxx list" sorted newest first
  <id-prefix>       session id prefix, for example a1111111
  <path>            absolute or relative session file path

Options:
  --codex-home DIR      default: $CODEX_HOME or ~/.codex
  --coldxx-home DIR     default: $COLDXX_HOME or ~/.coldxx
  --host HOST           UI host, default: 127.0.0.1
  --port PORT           UI port, default: 4765
  --scope SCOPE         all, messages, user, assistant, system, tool, metadata
  --lines RANGE         1-based lines, for example 3,5-8,20-
  --permanent           delete instead of moving to trash
  --allow-active        allow writes to sessions updated within the active window
  --active-window-minutes N
                        active-session guard window, default: 10
  --version, -v         print version
  --yes, -y             required for writes
  --dry-run             preview without writing

Examples:
  coldxx list --limit 20
  coldxx show latest
  coldxx clean a1111111 --dry-run
  coldxx clean a1111111 --yes
  coldxx edit latest --replace API_KEY --with "[REDACTED]" --scope messages --yes
  coldxx drop latest --lines 12-18 --dry-run
  coldxx profiles list
  coldxx profiles save ctf --file ./ctf.config.toml --yes
  coldxx ui
`;
}

async function versionText() {
  const packageJson = JSON.parse(await fs.readFile(new URL("../package.json", import.meta.url), "utf8"));
  return `coldxx ${packageJson.version}\n`;
}

function isCliEntryPoint() {
  if (!process.argv[1]) {
    return false;
  }
  try {
    return syncFs.realpathSync(fileURLToPath(import.meta.url)) === syncFs.realpathSync(process.argv[1]);
  } catch {
    return fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
  }
}

if (isCliEntryPoint()) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 1;
    });
}
