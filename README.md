# coldxx

[中文](README.zh-CN.md)

[![Node.js](https://img.shields.io/badge/node-%3E%3D20-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Runtime deps](https://img.shields.io/badge/runtime_deps-0-brightgreen.svg)](package.json)

coldxx is a local Codex session manager. It reads JSONL session files from `~/.codex/sessions/YYYY/MM/DD/` and gives you a safer way to inspect, clean, back up, restore, and carefully edit history. Session contents stay on your machine.

<img src="docs/assets/coldxx-preview.jpg" alt="coldxx local session manager preview" width="960">

## What You Can Do

- Find recent Codex sessions with cwd, model, size, record count, and file path.
- Clean one or many sessions; files are moved to Trash by default.
- Open a local browser UI for session inspection and JSONL record editing.
- Replace sensitive text in a session, such as a token pasted by mistake.
- Drop selected JSONL lines with an automatic backup.
- Restore deleted sessions from Trash or roll back edits from backups.

## Install

Node.js 20 or newer is required.

```sh
npm install -g coldxx
```

If your npm mirror has not synced the package yet, install from the official registry:

```sh
npm install -g coldxx --registry=https://registry.npmjs.org/
```

To run from source:

```sh
git clone https://github.com/outx-sec/coldxx.git
cd coldxx
npm install
npm link
```

```sh
node ./src/cli.js list
```

## Quick Start

Check the installed version:

```sh
coldxx -v
```

Check the paths coldxx will use:

```sh
coldxx doctor
```

List recent sessions:

```sh
coldxx list --limit 20
```

Open the local UI:

```sh
coldxx ui
```

The UI prints a tokenized local URL. It listens on `127.0.0.1` by default, and API requests must include that token.

## Common Tasks

### Inspect Sessions

```sh
coldxx list --limit 20
coldxx list --all
coldxx list --query my-project
coldxx list --json
```

Show one session:

```sh
coldxx show latest
coldxx show 019dd36c
coldxx show 1 --limit 50
coldxx show latest --raw
```

### Clean Sessions

Preview first:

```sh
coldxx clean 019dd36c --dry-run
```

Move to Trash:

```sh
coldxx clean 019dd36c --yes
```

Clean multiple sessions:

```sh
coldxx clean 019dd36c 019dd36d 019dd36e --yes
```

Clean all sessions:

```sh
coldxx clean-all --dry-run
coldxx clean-all --yes
```

Manage Trash:

```sh
coldxx trash list
coldxx trash restore <trash-id>
coldxx trash empty --yes
```

Permanent deletion requires both `--permanent` and `--yes`:

```sh
coldxx clean 019dd36c --permanent --yes
```

### Edit History

Replace text:

```sh
coldxx edit latest --replace API_KEY --with "[REDACTED]" --scope messages --dry-run
coldxx edit latest --replace API_KEY --with "[REDACTED]" --scope messages --yes
```

Available scopes:

```text
all, messages, user, assistant, system, tool, metadata
```

Regex replacement:

```sh
coldxx edit latest --replace "sk-[A-Za-z0-9_-]+" --with "[REDACTED]" --regex --scope messages --yes
```

Drop JSONL lines:

```sh
coldxx drop latest --lines 12-18 --dry-run
coldxx drop latest --lines 12-18 --yes
```

Line ranges are 1-based and support `3`, `5-8`, `20-`, and comma-separated combinations.

### Use the UI

```sh
coldxx ui
coldxx ui --host 127.0.0.1 --port 4765
```

The UI is useful when you need to:

- Select sessions from the left pane and inspect cwd, preview, size, and record count.
- Browse records in the center table with resizable columns, search, filters, and batch deletion.
- View and edit current record JSON on the right with formatting, validation, copy, and wrapping.
- Use modals for search, filtering, and find-and-replace.
- Inspect Trash batches before restoring or emptying them.
- Expand operation history and roll back to automatic backups.

## Session Selectors

Most commands accept the same selector forms:

| Selector | Meaning |
| --- | --- |
| `latest` | Newest session |
| `1`, `2`, `3` | Index from `coldxx list`, newest first |
| `019dd36c` | Session id prefix |
| Full session id | Exact match |
| `/path/to/session.jsonl` | Direct JSONL file path |

## Safety Model

| Operation | Default behavior |
| --- | --- |
| `clean` / `clean-all` | Moves files to `~/.coldxx/trash/` |
| `edit` / `drop` / UI save | Creates a backup under `~/.coldxx/backups/` |
| Recent sessions | Refuses writes unless `--allow-active` is set |
| Permanent delete | Requires both `--permanent` and `--yes` |
| Writes | Require `--yes`, or use `--dry-run` to preview |

Sessions updated in the last 10 minutes are treated as possibly active. Use `--allow-active` only after confirming Codex is no longer writing that file.

## Paths

```text
Codex home:    ~/.codex
Sessions root: ~/.codex/sessions
coldxx home:   ~/.coldxx
```

Override them when needed:

```sh
coldxx list --codex-home /path/to/.codex
coldxx list --coldxx-home /path/to/coldxx
CODEX_HOME=/path/to/.codex coldxx list
COLDXX_HOME=/path/to/coldxx coldxx list
```

## Development

```sh
npm run check
npm test
```

The project currently has zero runtime dependencies. Codex session JSONL may change over time, so coldxx edits generic parsed JSONL records instead of depending on a fixed internal schema.

## Privacy

coldxx is an independent local utility and is not affiliated with OpenAI. It works with local Codex session files and does not send session contents to any remote service.
