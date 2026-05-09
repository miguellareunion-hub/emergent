#!/usr/bin/env bash
###############################################################################
# Lovable IDE — One-shot installer for Ubuntu 22.04 / 24.04 server
#
# What it does:
#   1. Installs system packages: Node 22, Python 3.11+, MongoDB 7,
#      supervisor, nginx, build essentials.
#   2. Clones / refreshes the Lovable IDE repository into /opt/lovable-ide.
#   3. Installs frontend (yarn) and backend (pip) dependencies.
#   4. Writes /etc/supervisor/conf.d/lovable-ide.conf so the frontend
#      (Vite on :3000) and backend (FastAPI on :8001) start at boot.
#   5. Writes /etc/nginx/sites-available/lovable-ide to serve the public
#      HTTP(S) port and route /api/(chat|exec|http-fetch|web-search) to the
#      TanStack Start dev server, everything else to FastAPI.
#   6. Generates a strong RUNNER_TOKEN and seeds /opt/lovable-ide/frontend/.env
#      and /opt/lovable-ide/backend/.env.
#   7. Starts/reloads everything.
#
# Usage:
#   sudo bash install.sh                        # default install
#   sudo bash install.sh --domain ide.exemple.com   # provision Let's Encrypt
#   sudo bash install.sh --emergent-key sk-emergent-...  # override LLM key
#   sudo bash install.sh --repo https://github.com/<user>/<fork>.git
#
# Re-running is safe: the script is idempotent.
###############################################################################
set -euo pipefail

#------------------------------------------------------------------------- args
REPO_URL="https://github.com/miguellareunion-hub/code-genie.git"
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
      grep '^#' "$0" | sed -n '2,40p' | sed 's/^# \{0,1\}//'
      exit 0 ;;
    *)
      echo "Unknown arg: $1" >&2
      exit 1 ;;
  esac
done

if [ "$(id -u)" -ne 0 ]; then
  echo "Please run as root (sudo)." >&2
  exit 1
fi

log() { echo -e "\033[1;32m[install]\033[0m $*"; }
warn() { echo -e "\033[1;33m[warn]\033[0m $*"; }
err()  { echo -e "\033[1;31m[err]\033[0m $*" >&2; }

#------------------------------------------------------------------- cleanup
# Remove any stale MongoDB apt repo file from a previous failed run. If left
# in place, the FIRST `apt-get update` below would fail with
# "does not have a Release file" and abort the whole installer.
shopt -s nullglob
for stale in /etc/apt/sources.list.d/mongodb-org-*.list; do
  log "Removing stale apt source: $stale"
  rm -f "$stale"
done
shopt -u nullglob

#------------------------------------------------------------------ system update
log "Updating apt & installing base packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -yqq \
  ca-certificates curl gnupg git build-essential \
  python3 python3-venv python3-pip \
  supervisor nginx ufw jq openssl

#----------------------------------------------------------------------- node
if ! command -v node >/dev/null 2>&1 || ! node -v | grep -qE "^v${NODE_MAJOR}\."; then
  log "Installing Node.js ${NODE_MAJOR}.x via NodeSource"
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash -
  apt-get install -yqq nodejs
fi
log "node $(node -v) / npm $(npm -v)"

if ! command -v yarn >/dev/null 2>&1; then
  log "Installing yarn"
  npm install -g yarn
fi

#---------------------------------------------------------------------- mongo
if [ "$SKIP_MONGO" != "1" ]; then
  if ! command -v mongod >/dev/null 2>&1; then
    UB_CODENAME="$(. /etc/os-release && echo "$VERSION_CODENAME")"
    # Pick a MongoDB major version that supports the running Ubuntu release.
    # 8.0 → focal/jammy/noble. 7.0 → focal/jammy. 6.0 → bionic/focal/jammy.
    case "$UB_CODENAME" in
      noble)              MONGO_MAJOR="8.0" ;;
      jammy|focal)        MONGO_MAJOR="8.0" ;;
      bionic)             MONGO_MAJOR="6.0" ;;
      *)                  MONGO_MAJOR="8.0"; UB_CODENAME="jammy" ;;
    esac
    log "Installing MongoDB ${MONGO_MAJOR} for Ubuntu ${UB_CODENAME}"
    curl -fsSL "https://www.mongodb.org/static/pgp/server-${MONGO_MAJOR}.asc" \
      | gpg -o "/usr/share/keyrings/mongodb-server-${MONGO_MAJOR}.gpg" --dearmor --yes
    ARCH="$(dpkg --print-architecture)"
    case "$ARCH" in amd64|arm64) ;; *) ARCH="amd64" ;; esac
    echo "deb [ arch=${ARCH} signed-by=/usr/share/keyrings/mongodb-server-${MONGO_MAJOR}.gpg ] https://repo.mongodb.org/apt/ubuntu ${UB_CODENAME}/mongodb-org/${MONGO_MAJOR} multiverse" \
      > /etc/apt/sources.list.d/mongodb-org-${MONGO_MAJOR}.list
    # Noble dropped libssl1.1 — MongoDB 8 ships its own deps. Try install,
    # fallback to distro mongodb if the repo is unavailable.
    if ! ( apt-get update -qq && apt-get install -yqq mongodb-org ); then
      warn "MongoDB ${MONGO_MAJOR} apt repo failed — falling back to distro 'mongodb' package"
      rm -f /etc/apt/sources.list.d/mongodb-org-${MONGO_MAJOR}.list
      apt-get update -qq
      apt-get install -yqq mongodb || apt-get install -yqq mongodb-server || {
        err "Could not install any MongoDB. Pass --skip-mongo if you'll provide it externally."
        exit 3
      }
    fi
    systemctl enable mongod 2>/dev/null || systemctl enable mongodb 2>/dev/null || true
    systemctl start mongod 2>/dev/null || systemctl start mongodb 2>/dev/null || true
  fi
  systemctl is-active --quiet mongod 2>/dev/null \
    || systemctl is-active --quiet mongodb 2>/dev/null \
    || systemctl start mongod 2>/dev/null \
    || systemctl start mongodb 2>/dev/null \
    || warn "MongoDB does not seem to be running; check 'systemctl status mongod'"
  log "MongoDB ready"
fi

#--------------------------------------------------------------------- repo
if [ ! -d "$APP_DIR/.git" ] && [ -d "$APP_DIR" ] && [ "$(ls -A "$APP_DIR" 2>/dev/null || true)" ]; then
  warn "$APP_DIR exists and is not a git repo — leaving as-is. Use --dir to pick another path."
else
  if [ -d "$APP_DIR/.git" ]; then
    log "Updating existing repo at $APP_DIR"
    git -C "$APP_DIR" fetch --quiet origin
    git -C "$APP_DIR" pull --rebase --autostash --quiet
  else
    log "Cloning $REPO_URL → $APP_DIR"
    mkdir -p "$(dirname "$APP_DIR")"
    git clone --quiet "$REPO_URL" "$APP_DIR"
  fi
fi

#------------------------------------------------------ project layout discovery
# Some forks ship the whole project at the repo root (frontend = root) and a
# minimal Python backend under backend/. The Emergent template uses
# /app/frontend + /app/backend. Detect both.
if [ -d "$APP_DIR/frontend" ] && [ -d "$APP_DIR/backend" ]; then
  FRONTEND_DIR="$APP_DIR/frontend"
  BACKEND_DIR="$APP_DIR/backend"
elif [ -f "$APP_DIR/package.json" ] && [ -f "$APP_DIR/vite.config.ts" ]; then
  FRONTEND_DIR="$APP_DIR"
  BACKEND_DIR=""
else
  err "Cannot locate frontend/backend in $APP_DIR. Aborting."
  exit 2
fi
log "frontend: $FRONTEND_DIR"
log "backend : ${BACKEND_DIR:-<none, frontend-only>}"

#------------------------------------------------------------------ frontend
log "Installing frontend dependencies (yarn)"
( cd "$FRONTEND_DIR" && yarn install --ignore-engines --silent )

# Ensure a 'start' script that supervisor can call
if ! jq -e '.scripts.start' "$FRONTEND_DIR/package.json" >/dev/null 2>&1; then
  log "Adding 'start' script to package.json"
  tmp="$(mktemp)"
  jq '.scripts.start = "vite dev --host 0.0.0.0 --port 3000"' "$FRONTEND_DIR/package.json" > "$tmp"
  mv "$tmp" "$FRONTEND_DIR/package.json"
fi

RUNNER_TOKEN_VALUE="$(openssl rand -hex 24 2>/dev/null || head -c 32 /dev/urandom | base64 | tr -dc 'a-zA-Z0-9' | head -c 32)"
PUBLIC_URL_DEFAULT="http://$(hostname -I 2>/dev/null | awk '{print $1}' || echo localhost)"
PUBLIC_URL="${PUBLIC_URL:-$PUBLIC_URL_DEFAULT}"
if [ -n "$DOMAIN" ]; then PUBLIC_URL="https://$DOMAIN"; fi

if [ ! -f "$FRONTEND_DIR/.env" ] || ! grep -q "^EMERGENT_LLM_KEY=" "$FRONTEND_DIR/.env"; then
  log "Writing $FRONTEND_DIR/.env"
  cat > "$FRONTEND_DIR/.env" <<EOF
EMERGENT_LLM_KEY=$EMERGENT_KEY
INTEGRATION_PROXY_URL=https://integrations.emergentagent.com
APP_URL=$PUBLIC_URL
RUNNER_TOKEN=$RUNNER_TOKEN_VALUE
EOF
else
  # Replace RUNNER_TOKEN value (other vars left untouched).
  sed -i "s|^RUNNER_TOKEN=.*|RUNNER_TOKEN=$RUNNER_TOKEN_VALUE|" "$FRONTEND_DIR/.env" \
    || echo "RUNNER_TOKEN=$RUNNER_TOKEN_VALUE" >> "$FRONTEND_DIR/.env"
fi

#------------------------------------------------------------------- backend
if [ -n "$BACKEND_DIR" ]; then
  log "Installing backend dependencies (pip)"
  python3 -m venv "$BACKEND_DIR/.venv" 2>/dev/null || true
  # shellcheck disable=SC1091
  source "$BACKEND_DIR/.venv/bin/activate"
  pip install -q --upgrade pip
  pip install -q -r "$BACKEND_DIR/requirements.txt"
  pip install -q httpx
  deactivate

  if [ ! -f "$BACKEND_DIR/.env" ]; then
    log "Writing $BACKEND_DIR/.env"
    cat > "$BACKEND_DIR/.env" <<EOF
MONGO_URL=mongodb://127.0.0.1:27017
DB_NAME=lovable_ide
CORS_ORIGINS=*
TANSTACK_BASE=http://127.0.0.1:3000
EOF
  fi
fi

#---------------------------------------------------------------- supervisor
log "Writing /etc/supervisor/conf.d/lovable-ide.conf"
cat > /etc/supervisor/conf.d/lovable-ide.conf <<EOF
[program:lovable-frontend]
command=/usr/bin/yarn start
directory=$FRONTEND_DIR
autostart=true
autorestart=true
stopasgroup=true
killasgroup=true
stdout_logfile=/var/log/lovable-frontend.out.log
stderr_logfile=/var/log/lovable-frontend.err.log
environment=HOST="0.0.0.0",PORT="3000",NODE_ENV="production",HOME="/root"

EOF

if [ -n "$BACKEND_DIR" ]; then
cat >> /etc/supervisor/conf.d/lovable-ide.conf <<EOF
[program:lovable-backend]
command=$BACKEND_DIR/.venv/bin/uvicorn server:app --host 0.0.0.0 --port 8001 --workers 1
directory=$BACKEND_DIR
autostart=true
autorestart=true
stopasgroup=true
killasgroup=true
stdout_logfile=/var/log/lovable-backend.out.log
stderr_logfile=/var/log/lovable-backend.err.log
EOF
fi

supervisorctl reread
supervisorctl update
supervisorctl restart lovable-frontend ${BACKEND_DIR:+lovable-backend} || true

#--------------------------------------------------------------------- nginx
log "Writing /etc/nginx/sites-available/lovable-ide"
SERVER_NAME="${DOMAIN:-_}"
cat > /etc/nginx/sites-available/lovable-ide <<EOF
# ---------- Lovable IDE — public reverse proxy ----------
# Routes the four IDE-specific /api endpoints to TanStack Start (Vite) on
# :3000, everything else under /api to FastAPI on :8001, and any other path
# to TanStack Start so the SSR/HMR client app loads normally.

map \$request_uri \$lovable_upstream {
    default                          http://127.0.0.1:3000;
    "~^/api/chat(\\?|/|\$)"          http://127.0.0.1:3000;
    "~^/api/exec(\\?|/|\$)"          http://127.0.0.1:3000;
    "~^/api/http-fetch(\\?|/|\$)"    http://127.0.0.1:3000;
    "~^/api/web-search(\\?|/|\$)"    http://127.0.0.1:3000;
    "~^/api/"                        http://127.0.0.1:8001;
}

server {
    listen 80;
    listen [::]:80;
    server_name $SERVER_NAME;
    client_max_body_size 25m;

    # Allow long SSE streams from /api/chat
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

#-------------------------------------------------------------- firewall (best effort)
if command -v ufw >/dev/null 2>&1; then
  ufw allow OpenSSH >/dev/null 2>&1 || true
  ufw allow 'Nginx Full' >/dev/null 2>&1 || true
fi

#------------------------------------------------------- letsencrypt (optional)
if [ -n "$DOMAIN" ]; then
  log "Provisioning Let's Encrypt cert for $DOMAIN (requires DNS pointing to this server)"
  apt-get install -yqq certbot python3-certbot-nginx
  certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos --register-unsafely-without-email --redirect || \
    warn "certbot failed — fix DNS and re-run: sudo certbot --nginx -d $DOMAIN"
fi

#------------------------------------------------------------------- summary
echo ""
echo "=================================================================="
echo " Lovable IDE installed."
echo "   Public URL : ${PUBLIC_URL}"
echo "   Frontend   : http://127.0.0.1:3000  (supervisor: lovable-frontend)"
[ -n "$BACKEND_DIR" ] && echo "   Backend    : http://127.0.0.1:8001  (supervisor: lovable-backend)"
echo "   App dir    : $APP_DIR"
echo "   Runner tok : $RUNNER_TOKEN_VALUE"
echo ""
echo " Next steps:"
echo "   1. Open $PUBLIC_URL in your browser."
echo "   2. In the IDE, go to Settings → Runner and paste the token above"
echo "      (or leave it blank — the default 'lovable-ide-local' is generic)."
echo "   3. Edit $FRONTEND_DIR/.env to set EMERGENT_LLM_KEY (or any provider key)."
echo "      sudo supervisorctl restart lovable-frontend"
echo "   4. Logs:"
echo "      tail -f /var/log/lovable-frontend.out.log"
[ -n "$BACKEND_DIR" ] && echo "      tail -f /var/log/lovable-backend.out.log"
echo "=================================================================="
