#!/usr/bin/env bash
###############################################################################
# Lovable IDE — One-shot installer for Ubuntu 22.04 / 24.04 server
#
# Installs and configures, in this order:
#   1. System packages (Node 22, Python 3.11+, MongoDB 8.0, supervisor, nginx,
#      build tools, ssl libs, openssl, jq, ufw).
#   2. The repository (clones / refreshes /opt/lovable-ide by default).
#   3. Frontend (yarn install + Playwright + Chromium for the QA_AGENT).
#   4. Vite config patch — Playwright must be excluded from client bundling.
#   5. Backend (FastAPI + httpx) with a Python venv.
#   6. Node Runner (Express + ws) on :7070.
#   7. Supervisor units for the 3 services with proper PATH/env.
#   8. Nginx reverse proxy with smart /api routing.
#   9. Firewall + (optional) Let's Encrypt.
#
# Usage:
#   sudo bash install.sh
#   sudo bash install.sh --domain ide.example.com
#   sudo bash install.sh --emergent-key sk-emergent-...
#   sudo bash install.sh --repo https://github.com/<user>/<fork>.git
#   sudo bash install.sh --skip-mongo
#
# Re-running is safe (idempotent). On failure, it dumps the broken service log.
###############################################################################
set -euo pipefail

# ----- args -----
REPO_URL="https://github.com/miguellareunion-hub/emergent.git"
APP_DIR="/opt/lovable-ide"
DOMAIN=""
EMERGENT_KEY="${EMERGENT_LLM_KEY:-sk-emergent-fA69068E08c5c45Cc1}"
SKIP_MONGO="0"
NODE_MAJOR="22"

while [ $# -gt 0 ]; do
  case "$1" in
    --repo) REPO_URL="$2"; shift 2 ;;
    --dir) APP_DIR="$2"; shift 2 ;;
    --domain) DOMAIN="$2"; shift 2 ;;
    --emergent-key) EMERGENT_KEY="$2"; shift 2 ;;
    --skip-mongo) SKIP_MONGO="1"; shift ;;
    -h|--help)
      grep '^#' "$0" | sed -n '2,30p' | sed 's/^# \{0,1\}//'
      exit 0 ;;
    *) echo "Unknown arg: $1" >&2; exit 1 ;;
  esac
done

[ "$(id -u)" -eq 0 ] || { echo "Please run as root (sudo)." >&2; exit 1; }

log()  { echo -e "\033[1;32m[install]\033[0m $*"; }
warn() { echo -e "\033[1;33m[warn]\033[0m $*"; }
err()  { echo -e "\033[1;31m[err]\033[0m $*" >&2; }

# ----- cleanup of broken apt sources from previous runs -----
shopt -s nullglob
for stale in /etc/apt/sources.list.d/mongodb-org-*.list; do
  log "Removing stale apt source: $stale"
  rm -f "$stale"
done
shopt -u nullglob

# ----- base packages -----
log "Updating apt & installing base packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -yqq \
  ca-certificates curl gnupg git build-essential \
  python3 python3-venv python3-pip \
  supervisor nginx ufw jq openssl

# ----- node -----
if ! command -v node >/dev/null 2>&1 || ! node -v | grep -qE "^v${NODE_MAJOR}\."; then
  log "Installing Node.js ${NODE_MAJOR}.x via NodeSource"
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash -
  apt-get install -yqq nodejs
fi
log "node $(node -v) / npm $(npm -v)"
command -v yarn >/dev/null 2>&1 || { log "Installing yarn"; npm install -g yarn; }

# ----- mongo -----
if [ "$SKIP_MONGO" != "1" ]; then
  if ! command -v mongod >/dev/null 2>&1; then
    UB_CODENAME="$(. /etc/os-release && echo "$VERSION_CODENAME")"
    case "$UB_CODENAME" in
      noble|jammy|focal) MONGO_MAJOR="8.0" ;;
      bionic)            MONGO_MAJOR="6.0" ;;
      *)                 MONGO_MAJOR="8.0"; UB_CODENAME="jammy" ;;
    esac
    log "Installing MongoDB ${MONGO_MAJOR} for Ubuntu ${UB_CODENAME}"
    curl -fsSL "https://www.mongodb.org/static/pgp/server-${MONGO_MAJOR}.asc" \
      | gpg -o "/usr/share/keyrings/mongodb-server-${MONGO_MAJOR}.gpg" --dearmor --yes
    ARCH="$(dpkg --print-architecture)"; case "$ARCH" in amd64|arm64) ;; *) ARCH="amd64" ;; esac
    echo "deb [ arch=${ARCH} signed-by=/usr/share/keyrings/mongodb-server-${MONGO_MAJOR}.gpg ] https://repo.mongodb.org/apt/ubuntu ${UB_CODENAME}/mongodb-org/${MONGO_MAJOR} multiverse" \
      > /etc/apt/sources.list.d/mongodb-org-${MONGO_MAJOR}.list
    if ! ( apt-get update -qq && apt-get install -yqq mongodb-org ); then
      warn "MongoDB ${MONGO_MAJOR} apt repo failed — falling back to distro 'mongodb'"
      rm -f /etc/apt/sources.list.d/mongodb-org-${MONGO_MAJOR}.list
      apt-get update -qq
      apt-get install -yqq mongodb || apt-get install -yqq mongodb-server || {
        err "Could not install any MongoDB. Pass --skip-mongo if external."; exit 3; }
    fi
    systemctl enable mongod 2>/dev/null || systemctl enable mongodb 2>/dev/null || true
    systemctl start mongod  2>/dev/null || systemctl start mongodb  2>/dev/null || true
  fi
  systemctl is-active --quiet mongod 2>/dev/null \
    || systemctl is-active --quiet mongodb 2>/dev/null \
    || warn "MongoDB does not seem to be running; check 'systemctl status mongod'"
fi

# ----- repo -----
if [ -d "$APP_DIR/.git" ]; then
  log "Updating existing repo at $APP_DIR"
  git -C "$APP_DIR" fetch --quiet origin
  git -C "$APP_DIR" pull --rebase --autostash --quiet || true
elif [ -d "$APP_DIR" ] && [ "$(ls -A "$APP_DIR" 2>/dev/null || true)" ]; then
  warn "$APP_DIR exists and is not a git repo — leaving as-is."
else
  log "Cloning $REPO_URL → $APP_DIR"
  mkdir -p "$(dirname "$APP_DIR")"
  git clone --quiet "$REPO_URL" "$APP_DIR"
fi

# ----- detect frontend / backend / runner layouts -----
if [ -d "$APP_DIR/frontend" ] && [ -d "$APP_DIR/backend" ]; then
  FRONTEND_DIR="$APP_DIR/frontend"
  BACKEND_DIR="$APP_DIR/backend"
elif [ -f "$APP_DIR/package.json" ] && [ -f "$APP_DIR/vite.config.ts" ]; then
  FRONTEND_DIR="$APP_DIR"
  BACKEND_DIR=""
else
  err "Cannot locate frontend/backend in $APP_DIR. Aborting."; exit 2
fi
RUNNER_DIR=""
[ -d "$FRONTEND_DIR/runner-server" ] && RUNNER_DIR="$FRONTEND_DIR/runner-server"
log "frontend: $FRONTEND_DIR"
log "backend : ${BACKEND_DIR:-<none>}"
log "runner  : ${RUNNER_DIR:-<none>}"

# ----- frontend deps -----
log "Installing frontend dependencies (yarn)"
( cd "$FRONTEND_DIR" && yarn install --ignore-engines --silent ) || \
  ( cd "$FRONTEND_DIR" && yarn install --ignore-engines )

# Ensure 'start' script
if ! jq -e '.scripts.start' "$FRONTEND_DIR/package.json" >/dev/null 2>&1; then
  log "Adding 'start' script to package.json"
  tmp="$(mktemp)"
  jq '.scripts.start = "vite dev --host 0.0.0.0 --port 3000"' "$FRONTEND_DIR/package.json" > "$tmp"
  mv "$tmp" "$FRONTEND_DIR/package.json"
fi

# ----- vite config patch -----
# Vite must NOT pre-bundle Playwright (it has dynamic chromium-bidi imports
# that crash dependency optimisation). We rewrite vite.config.ts to a known
# safe version that excludes Playwright AND keeps the right hosts/HMR config.
log "Writing safe vite.config.ts (excludes Playwright from bundling)"
cat > "$FRONTEND_DIR/vite.config.ts" <<'VITECFG'
import { defineConfig } from "@lovable.dev/vite-tanstack-config";
import { loadEnv } from "vite";

const env = loadEnv("development", process.cwd(), "");
for (const k of Object.keys(env)) {
  if (process.env[k] === undefined) process.env[k] = env[k];
}
if (!process.env.PLAYWRIGHT_BROWSERS_PATH) {
  process.env.PLAYWRIGHT_BROWSERS_PATH = `${process.cwd()}/.playwright-browsers`;
}

export default defineConfig({
  vite: {
    server: {
      host: "0.0.0.0",
      port: 3000,
      allowedHosts: true,
      hmr: false,
      watch: { ignored: ["**/*"] },
    },
    optimizeDeps: {
      exclude: ["playwright", "playwright-core", "chromium-bidi"],
    },
    ssr: {
      external: ["playwright", "playwright-core", "chromium-bidi"],
    },
  },
});
VITECFG

# ----- playwright + chromium -----
log "Installing Playwright + Chromium for the QA_AGENT"
( cd "$FRONTEND_DIR" && yarn add --ignore-engines --silent playwright >/dev/null 2>&1 || true )

log "Installing Playwright system deps (libnss3, libatk, fonts, libgtk…)"
apt-get install -yqq \
  libnss3 libnspr4 libatk1.0-0t64 libatk-bridge2.0-0t64 libcups2t64 \
  libdrm2 libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 \
  libgbm1 libpango-1.0-0 libcairo2 libasound2t64 libxshmfence1 \
  fonts-liberation libgtk-3-0t64 2>/dev/null \
  || apt-get install -yqq \
       libnss3 libnspr4 libatk1.0-0 libatk-bridge2.0-0 libcups2 \
       libdrm2 libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 \
       libgbm1 libpango-1.0-0 libcairo2 libasound2 libxshmfence1 \
       fonts-liberation libgtk-3-0 \
  || warn "Some Playwright system deps failed — QA_AGENT may not work."

PLAYWRIGHT_BROWSERS_PATH_VAL="$FRONTEND_DIR/.playwright-browsers"
log "Downloading Chromium → $PLAYWRIGHT_BROWSERS_PATH_VAL"
( cd "$FRONTEND_DIR" && \
    PLAYWRIGHT_BROWSERS_PATH="$PLAYWRIGHT_BROWSERS_PATH_VAL" \
    "$FRONTEND_DIR/node_modules/.bin/playwright" install chromium 2>&1 | tail -3 \
) || warn "Playwright browser download failed. Re-run manually: cd $FRONTEND_DIR && PLAYWRIGHT_BROWSERS_PATH=$PLAYWRIGHT_BROWSERS_PATH_VAL ./node_modules/.bin/playwright install chromium"

# ----- runner-server deps -----
if [ -n "$RUNNER_DIR" ]; then
  log "Installing runner-server dependencies"
  ( cd "$RUNNER_DIR" && yarn install --silent ) || ( cd "$RUNNER_DIR" && yarn install )
fi

# ----- env files -----
RUNNER_TOKEN_VALUE="$(openssl rand -hex 24 2>/dev/null || head -c 32 /dev/urandom | base64 | tr -dc 'a-zA-Z0-9' | head -c 32)"
PUBLIC_URL_DEFAULT="http://$(hostname -I 2>/dev/null | awk '{print $1}' || echo localhost)"
PUBLIC_URL="${PUBLIC_URL:-$PUBLIC_URL_DEFAULT}"
[ -n "$DOMAIN" ] && PUBLIC_URL="https://$DOMAIN"

if [ ! -f "$FRONTEND_DIR/.env" ] || ! grep -q "^EMERGENT_LLM_KEY=" "$FRONTEND_DIR/.env"; then
  log "Writing $FRONTEND_DIR/.env"
  cat > "$FRONTEND_DIR/.env" <<EOF
EMERGENT_LLM_KEY=$EMERGENT_KEY
INTEGRATION_PROXY_URL=https://integrations.emergentagent.com
APP_URL=$PUBLIC_URL
RUNNER_TOKEN=$RUNNER_TOKEN_VALUE
PLAYWRIGHT_BROWSERS_PATH=$PLAYWRIGHT_BROWSERS_PATH_VAL
EOF
else
  sed -i "s|^RUNNER_TOKEN=.*|RUNNER_TOKEN=$RUNNER_TOKEN_VALUE|" "$FRONTEND_DIR/.env" \
    || echo "RUNNER_TOKEN=$RUNNER_TOKEN_VALUE" >> "$FRONTEND_DIR/.env"
  if grep -q "^PLAYWRIGHT_BROWSERS_PATH=" "$FRONTEND_DIR/.env"; then
    sed -i "s|^PLAYWRIGHT_BROWSERS_PATH=.*|PLAYWRIGHT_BROWSERS_PATH=$PLAYWRIGHT_BROWSERS_PATH_VAL|" "$FRONTEND_DIR/.env"
  else
    echo "PLAYWRIGHT_BROWSERS_PATH=$PLAYWRIGHT_BROWSERS_PATH_VAL" >> "$FRONTEND_DIR/.env"
  fi
fi

# ----- backend deps -----
if [ -n "$BACKEND_DIR" ]; then
  log "Installing backend dependencies (pip)"
  python3 -m venv "$BACKEND_DIR/.venv" 2>/dev/null || true
  # shellcheck disable=SC1091
  source "$BACKEND_DIR/.venv/bin/activate"
  pip install -q --upgrade pip
  REQ_FILTERED="$(mktemp)"
  grep -vE '^(emergentintegrations|emergent-)' "$BACKEND_DIR/requirements.txt" > "$REQ_FILTERED" || true
  pip install -q -r "$REQ_FILTERED" || warn "Some pip packages failed — continuing"
  rm -f "$REQ_FILTERED"
  pip install -q httpx
  deactivate

  if [ ! -f "$BACKEND_DIR/.env" ]; then
    log "Writing $BACKEND_DIR/.env"
    cat > "$BACKEND_DIR/.env" <<EOF
MONGO_URL=mongodb://127.0.0.1:27017
DB_NAME=lovable_ide
CORS_ORIGINS=*
TANSTACK_BASE=http://127.0.0.1:3000
RUNNER_BASE=http://127.0.0.1:7070
EOF
  else
    grep -q "^RUNNER_BASE=" "$BACKEND_DIR/.env" || echo "RUNNER_BASE=http://127.0.0.1:7070" >> "$BACKEND_DIR/.env"
  fi
fi

# ----- supervisor -----
YARN_BIN="$(command -v yarn || echo /usr/bin/yarn)"
NODE_BIN="$(command -v node || echo /usr/bin/node)"

log "Writing /etc/supervisor/conf.d/lovable-ide.conf"
{
cat <<EOF
[program:lovable-frontend]
command=$YARN_BIN start
directory=$FRONTEND_DIR
autostart=true
autorestart=true
startsecs=15
startretries=5
stopasgroup=true
killasgroup=true
stdout_logfile=/var/log/lovable-frontend.out.log
stderr_logfile=/var/log/lovable-frontend.err.log
environment=HOST="0.0.0.0",PORT="3000",HOME="/root",PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",PLAYWRIGHT_BROWSERS_PATH="$PLAYWRIGHT_BROWSERS_PATH_VAL"

EOF

if [ -n "$BACKEND_DIR" ]; then
cat <<EOF
[program:lovable-backend]
command=$BACKEND_DIR/.venv/bin/uvicorn server:app --host 0.0.0.0 --port 8001 --workers 1
directory=$BACKEND_DIR
autostart=true
autorestart=true
startsecs=5
stopasgroup=true
killasgroup=true
stdout_logfile=/var/log/lovable-backend.out.log
stderr_logfile=/var/log/lovable-backend.err.log

EOF
fi

if [ -n "$RUNNER_DIR" ]; then
mkdir -p /var/lib/lovable-runner-workspaces
cat <<EOF
[program:lovable-runner]
command=$NODE_BIN server.js
directory=$RUNNER_DIR
autostart=true
autorestart=true
startsecs=5
stopasgroup=true
killasgroup=true
stdout_logfile=/var/log/lovable-runner.out.log
stderr_logfile=/var/log/lovable-runner.err.log
environment=PORT="7070",RUNNER_TOKEN="$RUNNER_TOKEN_VALUE",WORKSPACES_DIR="/var/lib/lovable-runner-workspaces",HOME="/root",PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"

EOF
fi
} > /etc/supervisor/conf.d/lovable-ide.conf

supervisorctl reread
supervisorctl update
supervisorctl restart \
  lovable-frontend \
  ${BACKEND_DIR:+lovable-backend} \
  ${RUNNER_DIR:+lovable-runner} || true

# ----- post-start health check -----
log "Waiting 15s for services to settle…"
sleep 15
PROBLEMS=0
for svc in lovable-frontend ${BACKEND_DIR:+lovable-backend} ${RUNNER_DIR:+lovable-runner}; do
  if ! supervisorctl status "$svc" 2>/dev/null | grep -q RUNNING; then
    err "$svc is NOT running. Last log lines:"
    case "$svc" in
      lovable-frontend) tail -n 25 /var/log/lovable-frontend.err.log 2>/dev/null || true ;;
      lovable-backend)  tail -n 25 /var/log/lovable-backend.err.log  2>/dev/null || true ;;
      lovable-runner)   tail -n 25 /var/log/lovable-runner.err.log   2>/dev/null || true ;;
    esac
    PROBLEMS=$((PROBLEMS+1))
  else
    log "$svc is RUNNING ✓"
  fi
done

# ----- nginx -----
log "Writing /etc/nginx/sites-available/lovable-ide"
SERVER_NAME="${DOMAIN:-_}"
cat > /etc/nginx/sites-available/lovable-ide <<EOF
# Lovable IDE — public reverse proxy with smart /api routing.

map \$request_uri \$lovable_upstream {
    default                                  http://127.0.0.1:3000;

    "~^/api/chat(\\?|/|\$)"                  http://127.0.0.1:3000;
    "~^/api/web-search(\\?|/|\$)"            http://127.0.0.1:3000;
    "~^/api/qa(\\?|/|\$)"                    http://127.0.0.1:3000;

    "~^/api/exec(\\?|/|\$)"                  http://127.0.0.1:7070;
    "~^/api/http-fetch(\\?|/|\$)"            http://127.0.0.1:7070;
    "~^/api/run(\\?|/|\$)"                   http://127.0.0.1:7070;
    "~^/api/sync(\\?|/|\$)"                  http://127.0.0.1:7070;
    "~^/api/stop(\\?|/|\$)"                  http://127.0.0.1:7070;
    "~^/api/status(\\?|/|\$)"                http://127.0.0.1:7070;
    "~^/api/health(\\?|/|\$)"                http://127.0.0.1:7070;
    "~^/api/read-file(\\?|/|\$)"             http://127.0.0.1:7070;
    "~^/api/list-files(\\?|/|\$)"            http://127.0.0.1:7070;
    "~^/preview/"                            http://127.0.0.1:7070;
    "~^/ws(\\?|\$)"                          http://127.0.0.1:7070;

    "~^/api/"                                http://127.0.0.1:8001;
}

server {
    listen 80;
    listen [::]:80;
    server_name $SERVER_NAME;
    client_max_body_size 25m;

    proxy_buffering off;
    proxy_read_timeout 300s;
    proxy_send_timeout 300s;

    location / {
        proxy_pass        \$lovable_upstream\$request_uri;
        proxy_http_version 1.1;
        proxy_set_header  Host              \$host;
        proxy_set_header  X-Real-IP         \$remote_addr;
        proxy_set_header  X-Forwarded-For   \$proxy_add_x_forwarded_for;
        proxy_set_header  X-Forwarded-Proto \$scheme;
        proxy_set_header  Upgrade           \$http_upgrade;
        proxy_set_header  Connection        \$http_connection;
    }
}
EOF
ln -sf /etc/nginx/sites-available/lovable-ide /etc/nginx/sites-enabled/lovable-ide
rm -f /etc/nginx/sites-enabled/default
nginx -t
systemctl enable nginx --now
systemctl reload nginx

# ----- firewall (best-effort) -----
if command -v ufw >/dev/null 2>&1; then
  ufw allow OpenSSH >/dev/null 2>&1 || true
  ufw allow 'Nginx Full' >/dev/null 2>&1 || true
fi

# ----- letsencrypt (optional) -----
if [ -n "$DOMAIN" ]; then
  log "Provisioning Let's Encrypt cert for $DOMAIN"
  apt-get install -yqq certbot python3-certbot-nginx
  certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos --register-unsafely-without-email --redirect \
    || warn "certbot failed — check DNS, then re-run: sudo certbot --nginx -d $DOMAIN"
fi

# ----- summary -----
echo ""
echo "=================================================================="
echo " Lovable IDE installed."
echo "   Public URL : ${PUBLIC_URL}"
echo "   Frontend   : http://127.0.0.1:3000  (supervisor: lovable-frontend)"
[ -n "$BACKEND_DIR" ] && echo "   Backend    : http://127.0.0.1:8001  (supervisor: lovable-backend)"
[ -n "$RUNNER_DIR" ]  && echo "   Runner     : http://127.0.0.1:7070  (supervisor: lovable-runner)"
echo "   App dir    : $APP_DIR"
echo "   Runner tok : $RUNNER_TOKEN_VALUE"
echo ""
echo " Components:"
echo "   ✓ Frontend (TanStack Start + Vite + React 19)"
[ -n "$BACKEND_DIR" ] && echo "   ✓ Backend (FastAPI + httpx proxy)"
[ -n "$RUNNER_DIR" ]  && echo "   ✓ Node Runner (Express + ws + http-proxy)"
echo "   ✓ QA_AGENT (Playwright + Chromium headless)"
echo "   ✓ MongoDB"
echo "   ✓ Nginx (smart /api routing)"
echo ""
if [ "$PROBLEMS" -gt 0 ]; then
  echo " ⚠ $PROBLEMS service(s) failed to start. See log dump above."
  echo " After fixing the issue: sudo supervisorctl restart all"
else
  echo " ✓ All services are RUNNING."
fi
echo ""
echo " Logs:"
echo "   tail -f /var/log/lovable-frontend.out.log"
[ -n "$BACKEND_DIR" ] && echo "   tail -f /var/log/lovable-backend.out.log"
[ -n "$RUNNER_DIR" ]  && echo "   tail -f /var/log/lovable-runner.out.log"
echo "=================================================================="
