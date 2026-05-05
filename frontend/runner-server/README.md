# Lovable IDE — Local Node Runner

This is a small Node server you run **on your own machine** (or on a VPS).
It receives the files from your Lovable IDE web project, runs `npm install`
and `npm run dev` (or whatever script you choose), streams logs back to the
IDE in real-time, and exposes the running app's URL for preview.

## ⚠️ Security warning

This server **executes arbitrary code** (whatever is in `package.json`).
Run it ONLY on a machine you trust. Always set a `RUNNER_TOKEN`. Never
expose it publicly without protection.

## Install & run

```bash
cd runner-server
npm install
RUNNER_TOKEN=mysecrettoken npm start
```

By default it listens on `http://localhost:7070`.

### Environment variables

| Variable        | Default         | Description                                      |
|-----------------|-----------------|--------------------------------------------------|
| `PORT`          | `7070`          | HTTP port the runner listens on                  |
| `RUNNER_TOKEN`  | (none)          | Required token. Sent by the IDE in `Authorization: Bearer <token>`. If unset, the runner refuses all requests. |
| `WORKSPACES_DIR`| `./workspaces`  | Where projects are written on disk               |
| `APP_PORT`      | `3000`          | Port the user's app is expected to listen on (for preview proxy) |

## Configure the Lovable IDE

In the IDE, open **Settings → Runner** and set:

- Runner URL: `http://localhost:7070`
- Runner Token: same as `RUNNER_TOKEN`

Then in the IDE click **▶ Run** to push files and start the project.

## Endpoints

- `POST /api/run` — push files + run a script (body: `{ projectId, files, script }`)
- `POST /api/stop` — kill the running process for a project
- `GET  /api/status` — current process status
- `WS   /ws?projectId=...` — streams stdout/stderr lines as JSON
- `ANY  /preview/:projectId/*` — proxies to the user app on `APP_PORT`
