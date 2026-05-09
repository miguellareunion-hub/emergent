# Lovable IDE — Déploiement Ubuntu Server

Ce dossier contient un installateur **one-shot** pour Ubuntu 22.04 / 24.04.

## 🚀 Installation rapide

Sur ton serveur Ubuntu (root ou sudo) :

```bash
# 1. Récupère le script
curl -fsSL https://raw.githubusercontent.com/miguellareunion-hub/code-genie/main/deploy/install.sh -o install.sh

# 2. Lance-le
sudo bash install.sh
```

C'est tout. Au bout de ~5 min tout tourne sur `http://<ip-du-serveur>`.

## ⚙️ Options

| Flag | Description | Exemple |
|---|---|---|
| `--repo URL` | Fork du dépôt à installer | `--repo https://github.com/moi/code-genie.git` |
| `--dir PATH` | Dossier d'installation (défaut `/opt/lovable-ide`) | `--dir /srv/ide` |
| `--domain DOM` | Active HTTPS Let's Encrypt sur ce domaine | `--domain ide.exemple.com` |
| `--emergent-key KEY` | Clé Emergent LLM (sinon clé par défaut Emergent) | `--emergent-key sk-emergent-xxx` |
| `--skip-mongo` | Ne pas installer MongoDB (utile si déjà présent) | |

Exemple complet :
```bash
sudo bash install.sh \
  --domain ide.example.com \
  --emergent-key sk-emergent-XXXX \
  --dir /opt/my-ide
```

## 📦 Ce que le script installe

1. **Node.js 22.x** + **yarn** (via NodeSource)
2. **Python 3.11+** + **pip** + venv pour le backend
3. **MongoDB 7.0** (sauf si `--skip-mongo`)
4. **Supervisor** (gère frontend + backend en service)
5. **Nginx** (reverse proxy intelligent : `/api/{chat,exec,http-fetch,web-search}` → TanStack Start `:3000`, le reste de `/api/*` → FastAPI `:8001`, et tout le reste → TanStack Start)
6. **UFW** (firewall : SSH + HTTP/HTTPS autorisés)
7. **Certbot** (uniquement si `--domain` fourni)

## 🔑 Variables d'environnement

Le script génère automatiquement :

**`/opt/lovable-ide/frontend/.env`**
```
EMERGENT_LLM_KEY=sk-emergent-xxx           # ta clé LLM universelle
INTEGRATION_PROXY_URL=https://integrations.emergentagent.com
APP_URL=https://ton-domaine.com
RUNNER_TOKEN=<généré aléatoirement>
```

**`/opt/lovable-ide/backend/.env`**
```
MONGO_URL=mongodb://127.0.0.1:27017
DB_NAME=lovable_ide
CORS_ORIGINS=*
TANSTACK_BASE=http://127.0.0.1:3000
```

## 🛠 Gestion

```bash
# Voir l'état
sudo supervisorctl status lovable-frontend lovable-backend

# Redémarrer
sudo supervisorctl restart lovable-frontend
sudo supervisorctl restart lovable-backend

# Logs
tail -f /var/log/lovable-frontend.out.log
tail -f /var/log/lovable-backend.out.log
tail -f /var/log/nginx/access.log
```

## 🔄 Mise à jour

Re-lance simplement le script — il est **idempotent** :

```bash
sudo bash install.sh
```

Il fera `git pull` sur le dépôt, réinstallera les nouvelles dépendances et redémarrera les services. Aucune perte de données (MongoDB conservé).

## 🔥 Désinstallation

```bash
sudo supervisorctl stop lovable-frontend lovable-backend
sudo rm /etc/supervisor/conf.d/lovable-ide.conf
sudo rm /etc/nginx/sites-enabled/lovable-ide /etc/nginx/sites-available/lovable-ide
sudo systemctl reload nginx
sudo rm -rf /opt/lovable-ide
# Optionnel : MongoDB
sudo systemctl stop mongod && sudo apt-get purge -y mongodb-org\*
```

## 📐 Architecture résumée

```
                 ┌─────────────────────────────────────────────┐
Internet ──:80── │ nginx (reverse proxy, /api routing logic)   │
         :443─→ └────────┬───────────────────────────┬────────┘
                         │                           │
                         ▼                           ▼
                 :3000 TanStack Start         :8001 FastAPI
                 (Vite + SSR)                 (status, proxy)
                         │                           │
                         └─────────┬─────────────────┘
                                   ▼
                              :27017 MongoDB
```

## 💡 Conseils prod

- **Coupe le mode dev** plus tard en buildant Vite : `cd frontend && yarn build`, puis sers le `dist/` via nginx pour gagner ~70% de RAM.
- **Sauvegarde** le dossier `/var/lib/mongodb` régulièrement (`mongodump`) si tu as des projets stockés côté serveur.
- **Coupe les sources d'abus** : limite l'accès au runner avec un firewall ou un VPN si l'instance est exposée à Internet (l'agent peut exécuter du code arbitraire).
