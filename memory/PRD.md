# Lovable IDE - Code Genie

## Problem Statement
Charger le dépôt https://github.com/miguellareunion-hub/code-genie.git pour permettre les modifications.

## Architecture
- **Frontend (SSR)**: TanStack Start + Vite 7 + React 19 + TailwindCSS 4 + Monaco Editor
- **Runner**: `runner-server/` (Express + WebSocket) exécute les projets utilisateur
- **API Routes**: Intégrées dans TanStack Start (`src/routes/api.*.ts`)
- **Stack UI**: Radix UI + lucide-react + shadcn components (src/components/ui)

## Stack technique
- Node 20 (installé avec --ignore-engines car miniflare exige 22+)
- Vite dev sur port 3000 via `yarn start`
- Pas de backend FastAPI / MongoDB utilisés dans ce projet

## Modifications appliquées
- `package.json`: ajout du script `start` (vite dev --host 0.0.0.0 --port 3000)
- `vite.config.ts`: ajout `allowedHosts` pour preview.emergentagent.com et emergentcf.cloud + HMR sur wss:443

## What's been implemented (2026-01-05)
- Clone du dépôt code-genie dans `/app/frontend`
- Installation des dépendances (yarn install --ignore-engines)
- Configuration Vite pour tunnel Emergent
- Application Lovable IDE accessible et rendue correctement

## Backlog / Next tasks
- Définir les modifications à apporter (à préciser par l'utilisateur)
- Optionnel: configurer le runner-server si besoin d'exécuter des projets utilisateur
