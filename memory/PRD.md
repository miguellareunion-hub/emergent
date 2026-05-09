# Lovable IDE — Autonomous Coding Platform

## Problem Statement
Build a fully autonomous, browser-based IDE inspired by Emergent E1: the in-app
AI agent must have the same capabilities as the host platform (read/write
files, run shell commands, run an automated QA pass with Playwright, install
projects from a ZIP, analyze attached images via vision LLMs, deploy on a
user-owned Ubuntu server with one script).

## Architecture
- **Frontend (SSR)**: TanStack Start + Vite 7 + React 19 + Tailwind 4 + Monaco
- **Runner**: `frontend/runner-server/` (Express + WebSocket + adm-zip) — executes user projects, extracts ZIPs, runs shell commands, hosts iframe preview
- **Backend (FastAPI)**: routes `/api/*` to TanStack (`/api/chat`, `/api/qa`, `/api/web-search`) or to runner (`/api/exec`, `/api/extract-zip`, `/api/run`, …)
- **MongoDB**: ready, currently unused (persistence is localStorage-side)
- **LLM**: Emergent universal key via `integrations.emergentagent.com` (Claude / GPT / Gemini)

## Components
- `AgentChat.tsx` — main chat UI with attachments (paperclip), file chips, multimodal LLM payloads
- `attachments.ts` — image (vision) / zip (runner extraction) / text-file processing helpers
- `agentTools.ts` — tool-calling definitions (read_file, write_file, exec_shell, http_fetch, web_search, finish)
- `QAPanel.tsx` + `api.qa.ts` — Playwright-based QA agent
- `runner-server/server.js` — child-process runner + ZIP extractor + log streamer

## What's been implemented

### 2026-01-05 — Initial port
- Cloned the code-genie repo into `/app/frontend`
- Installed deps (yarn --ignore-engines)
- Vite tunnel config for Emergent preview

### 2026-02-XX — Autonomous IDE
- Emergent LLM proxy (`/api/chat`) with streaming + tool calling
- Node Runner with `/api/exec`, `/api/run`, `/api/sync`, `/api/http-fetch`, `/api/list-files`, `/api/read-file`, `/api/status`, `/api/stop`, `/api/health`
- FastAPI smart router proxying `/api/*` to TanStack vs runner
- Auto-fix runtime loop (iframe console + runner stderr → fixer agent)
- QA_AGENT (Playwright) auto-validation after each `finish` call
- One-shot Ubuntu installer `deploy/install.sh` (Node 22, MongoDB 8, Playwright deps, supervisor, nginx, optional certbot)
- Vite hardening: HMR off, pull-to-refresh disabled, beforeunload guard during streams
- `playwright` excluded from Vite client bundle (rollup `external`)

### 2026-02-09 — Attachments (images + ZIP + text files)
- New endpoint `POST /api/extract-zip` on runner: decodes base64 zip, extracts to workspace, returns text-file contents inline (binaries kept on disk)
- New helper `src/lib/attachments.ts` with `processFile` + `extractZipOnRunner`
- `AgentChat.tsx`: paperclip button, hidden multi-file input, attachment chips with thumbnails for images, X button to remove
- Multimodal `Msg` content (`string | MsgContentPart[]`) — images flow as `image_url` parts to the LLM (vision)
- Text files inlined as fenced code blocks in the user prompt
- ZIPs extracted server-side; text files auto-loaded into the project state (visible in the FILES panel and editable); binary files stay in the workspace and are accessible to `exec_shell`
- `data-testid` set on every interactive element of the new UI
- Tested E2E: ZIP upload → files appear in FILES panel → editor opens `hello.txt` → agent uses `list_files` to confirm

### 2026-02-09 — Critical Node Runner port-conflict fix
- **Bug**: when the user clicked Run on a project, the runner spawned the user app on port 3000 — same port as the TanStack IDE itself. `freePort(3000)` killed the IDE; the iframe `/preview/:projectId/` proxy then fell back to whatever was on 3000 again (the IDE restarted by supervisor) and returned its own 404 page instead of a clear "no app running" error.
- **Fix 1 (server.js)**: default `APP_PORT` changed from `3000` → `3100`.
- **Fix 2 (install.sh)**: added `APP_PORT="3100"` to the runner's supervisor `environment=` line.
- **Fix 3 (server.js)**: when no `package.json` exists, the runner aborts immediately with a clear stderr log and never calls `freePort`.
- **Fix 4 (RunnerPanel.tsx)**: detects browser-only projects (no `package.json` in the file list) and replaces the iframe with a friendly "Projet browser-only — utilise l'onglet Preview" banner; the **Run** button is also disabled in that case.

## Endpoints
| Method | Path | Service | Purpose |
|--------|------|---------|---------|
| POST | `/api/chat` | TanStack | LLM streaming + tool calling |
| POST | `/api/qa` | TanStack | Playwright QA validation |
| POST | `/api/web-search` | TanStack | Web search |
| POST | `/api/exec` | Runner | Shell command in workspace |
| POST | `/api/run` | Runner | npm install + npm run dev |
| POST | `/api/sync` | Runner | Hot-sync files without restart |
| POST | `/api/http-fetch` | Runner | HTTP test from runner |
| POST | `/api/extract-zip` | Runner | **NEW** — Decode + extract ZIP |
| POST | `/api/read-file` | Runner | Read file from workspace |
| POST | `/api/list-files` | Runner | List workspace files |

## Backlog
- P1: Add `analyze_image` shortcut tool that the agent can call by id (currently images are passed in the user message which works for vision models)
- P1: Persist projects in MongoDB (replace/augment localStorage)
- P2: Optimize Vite build for prod (reduce RAM use of `vite dev`)
- P2: UI polish on QA panel & attachment thumbnails
- P3: Per-attachment max size override in Settings

## Test credentials
None — IDE is single-user / browser-local.
