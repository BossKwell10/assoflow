# 01 — Architecture technique

## 1. Vue d'ensemble

```
                ┌──────────────┐      ┌───────────────────┐
                │ App mobile   │      │ Console web       │
                │ RN + Watermelon│    │ React (SPA)       │
                └──────┬───────┘      └─────────┬─────────┘
                       │ HTTPS /v1/sync/*        │ HTTPS /v1/*
                       ▼                         ▼
                ┌──────────────────────────────────────────┐
                │ Traefik (TLS, rate limiting, routage)    │
                └──────────────────┬───────────────────────┘
                                   ▼
                ┌──────────────────────────────────────────┐
                │ api (NestJS, x2 réplicas)                │──► S3 (pièces, exports)
                │  modules métier + module sync            │
                └───────┬───────────────────────┬──────────┘
                        │ SQL (RLS)             │ BullMQ
                        ▼                       ▼
                ┌──────────────┐        ┌──────────────┐     ┌───────────────┐
                │ PostgreSQL   │◄───────│ worker       │────►│ Passerelles   │
                │ primaire +   │        │ (NestJS)     │     │ SMS/WhatsApp  │
                │ réplica      │        └──────────────┘     └───────────────┘
                └──────────────┘          ▲  Redis (AOF)
```

Un seul code backend, deux points d'entrée :

- `api` : sert HTTP (console, mobile, webhooks fournisseurs) ;
- `worker` : consomme les files BullMQ et exécute les tâches planifiées.

## 2. Stack (D-006)

| Couche | Choix | Raison |
| --- | --- | --- |
| Runtime | Node.js 24 LTS (≥ 22.12 accepté en local) | Un seul langage (TypeScript) sur API, console et mobile |
| Framework API | NestJS 12, adaptateur Fastify 5 | Modules, injection de dépendances, guards ; Fastify pour la performance |
| Validation | Zod (schémas partagés dans `packages/contracts`) | Même validation côté console et mobile |
| Accès BDD | Drizzle ORM + `pg` | SQL explicite, transactions maîtrisées, compatible RLS (`SET LOCAL`) |
| Migrations | drizzle-kit (génération) + revue manuelle du SQL | Le SQL de migration est relu et versionné |
| Base | PostgreSQL 17 | RLS, JSONB, `pgcrypto` |
| Files | BullMQ sur Redis 7 (AOF activé) | Reprises, délais, tâches planifiées |
| Stockage fichiers | S3-compatible via `@aws-sdk/client-s3` | Justificatifs, photos, exports, archives d'audit |
| PDF | `pdfmake` | Génération côté worker sans navigateur headless |
| Excel | `exceljs` | Exports RF-039, RF-072 |
| Logs | `pino` (JSON) | Collecte Loki |
| Métriques | `prom-client` exposé sur `/metrics` (port interne) | Prometheus |
| Erreurs | SDK Sentry → GlitchTip auto-hébergé | Données gardées en CI |
| Console | React 19 + Vite + TypeScript, TanStack Router + Query, Mantine 9, React Hook Form + Zod | Composants de formulaire et de tableau prêts à l'emploi |
| Client API console | Généré depuis `openapi.yaml` (orval) | Contrat unique, pas de types écrits à la main |
| Tests | Vitest, Testcontainers (PostgreSQL, Redis), Playwright (console) | Tests d'intégration sur une vraie base |

Les versions exactes sont figées dans le lockfile pnpm et l'image Docker de base.

## 3. Organisation du dépôt (monorepo pnpm + Turborepo)

```
assoflow/
├── apps/
│   ├── api/                 # NestJS : main.api.ts (HTTP) et main.worker.ts (files)
│   │   └── src/
│   │       ├── main.api.ts
│   │       ├── main.worker.ts
│   │       ├── common/      # filtres d'erreur, intercepteurs, guards, contexte tenant
│   │       ├── infra/       # db, redis, s3, sms, pdf, metrics
│   │       └── modules/
│   │           ├── auth/            # OTP, mot de passe, TOTP, jetons, sessions
│   │           ├── associations/    # profil, paramètres, exercices
│   │           ├── utilisateurs/    # accès au bureau, rôles, délégations
│   │           ├── membres/         # membres, familles, ayants droit, catégories
│   │           ├── cotisations/     # campagnes, échéances, paiements, reçus
│   │           ├── tresorerie/      # comptes, mouvements, dépenses, validations
│   │           ├── projets/
│   │           ├── reunions/        # réunions, présences, PV (Should)
│   │           ├── documents/       # documents, pièces jointes
│   │           ├── communication/   # annonces, notifications, modèles
│   │           ├── rapports/        # tableaux de bord, rapports, exports
│   │           ├── audit/
│   │           ├── sync/            # pull / push mobile
│   │           └── plateforme/      # tenants, demandes, support, quotas, paramètres globaux
│   ├── console/             # React SPA
│   └── mobile/              # React Native (hors de ce dossier)
├── packages/
│   ├── contracts/           # schémas Zod, enums, codes d'erreur, permissions
│   ├── db/                  # schéma Drizzle, migrations SQL, seeds
│   └── config/              # tsconfig, eslint, prettier partagés
├── infra/
│   ├── ansible/             # provisioning VPS, durcissement, Docker, Swarm
│   ├── stacks/              # fichiers docker stack (app, data, monitoring)
│   └── backup/              # pgBackRest, scripts de test de restauration
├── docs/                    # ce dossier
└── .github/workflows/ci.yml
```

### Règles de dépendance entre modules

- Un module n'importe que l'**interface publique** (service exporté) d'un autre module, jamais ses repositories.
- `cotisations` et `tresorerie` écrivent les mouvements via `TresorerieService.enregistrerMouvement()` uniquement.
- Toute écriture métier passe par `AuditService.tracer()` dans la **même transaction**.
- `sync` réutilise les services métier : il n'écrit jamais directement en base.

## 4. Contexte de requête et transactions

Chaque requête authentifiée ouvre **une transaction** par unité de travail, qui commence par :

```sql
SET LOCAL app.association_id = '<uuid du tenant>';
SET LOCAL app.user_id        = '<uuid utilisateur>';
SET LOCAL app.role_plateforme = '';          -- 'super_admin' ou 'support' pour l'espace plateforme
```

- Implémentation : un `TenantContext` (AsyncLocalStorage) alimenté par le guard d'authentification,
  et un helper `db.tx(async (tx) => …)` qui pose les `SET LOCAL` puis exécute le travail.
- Le rôle PostgreSQL applicatif `assoflow_app` n'a **pas** `BYPASSRLS`. Les migrations utilisent `assoflow_owner`.
- Le worker pose le même contexte à partir des données du job (`associationId` obligatoire dans chaque job).

## 5. Environnements

| Env | Hébergement | Données | Déploiement | Accès |
| --- | --- | --- | --- | --- |
| local | Docker Compose sur poste | Seeds fictifs | `pnpm dev` | Développeurs |
| dev | VPS Europe | Seeds fictifs, réinitialisés chaque semaine | Automatique sur `main` | Équipe |
| staging | VPS Europe | Jeu fictif volumineux (100 associations, 20 000 membres) | Automatique sur tag `v*-rc*` | Équipe + pilotes en recette |
| production | 4 VPS en Côte d'Ivoire | Réelles | Manuel (approbation) sur tag `v*` | Restreint |

**Interdit** : copier des données de production hors production (D-002). Les tests de restauration se font
dans un environnement jetable *en Côte d'Ivoire*.

## 6. Configuration (variables d'environnement)

Toute configuration passe par l'environnement, validée au démarrage par un schéma Zod (le service refuse de
démarrer si une variable manque). Les secrets sont des **Docker secrets** montés dans `/run/secrets/*` ;
les variables `*_FILE` pointent vers ces fichiers.

| Variable | Exemple | Secret |
| --- | --- | --- |
| `NODE_ENV` | `production` | non |
| `APP_ROLE` | `api` ou `worker` | non |
| `PORT` | `3000` | non |
| `PUBLIC_BASE_URL` | `https://api.assoflow.ci` | non |
| `CONSOLE_ORIGIN` | `https://console.assoflow.ci` | non |
| `DATABASE_URL_FILE` | `/run/secrets/database_url` | oui |
| `DATABASE_REPLICA_URL_FILE` | `/run/secrets/database_replica_url` (lecture rapports) | oui |
| `REDIS_URL_FILE` | `/run/secrets/redis_url` | oui |
| `S3_ENDPOINT`, `S3_REGION`, `S3_BUCKET` | `https://s3.exemple.ci`, `ci-abj`, `assoflow-prod` | non |
| `S3_ACCESS_KEY_FILE`, `S3_SECRET_KEY_FILE` | | oui |
| `JWT_PRIVATE_KEY_FILE`, `JWT_PUBLIC_KEY_FILE` | clés Ed25519 (PEM PKCS#8 / SPKI) ; absentes hors production → paire éphémère | oui |
| `FIELD_ENCRYPTION_KEY_FILE` | clé AES-256 (32 octets, base64) | oui |
| `OTP_PEPPER_FILE` | | oui |
| `SMS_PROVIDERS` | `agregateur_a,agregateur_b` (ordre de préférence ; `journal` en local et en test) | non |
| `SMS_<FOURNISSEUR>_API_KEY_FILE` | | oui |
| `SENTRY_DSN_FILE` | DSN GlitchTip | oui |
| `LOG_LEVEL` | `info` | non |
| `MIN_APP_VERSION` | `1.0.0` | non |

## 7. Déploiement (Docker Swarm)

- Images construites par la CI, taguées par SHA court et version (`registry/assoflow/api:1.4.2`). Jamais `latest`.
- Une seule image `api` ; le rôle est choisi par `APP_ROLE`.
- Stacks : `assoflow-data` (PostgreSQL, Redis, contraintes de placement), `assoflow-app` (traefik, api, worker,
  console statique), `assoflow-monitoring` (sur le VPS 4).
- `api` : 2 réplicas minimum, `update_config: parallelism 1, delay 30s, failure_action rollback, order start-first`.
- `worker` : 1 réplica (les tâches planifiées utilisent un verrou Redis ; passer à 2 est sans risque).
- Healthchecks : `GET /health/live` (processus) et `GET /health/ready` (BDD + Redis joignables).
- Limites de ressources obligatoires sur chaque service (ex. api : 1 CPU, 768 Mo).
- Migrations : job one-shot `api migrate` exécuté **avant** la mise à jour du service, avec la règle
  *expand/contract* : une migration ne casse jamais la version N-1 de l'API ni de l'app mobile.

## 8. Observabilité

- Logs JSON avec `requestId`, `associationId`, `userId`, `appareilId`, `route`, `duree_ms`, `statut`.
  **Jamais** de numéro de téléphone complet, de code OTP, de mot de passe ou de jeton dans les logs
  (masquage `+225 07 •• •• 12 34`).
- Métriques applicatives minimales : `http_requests_total`, `http_request_duration_seconds` (par route),
  `sync_push_items_total{resultat}`, `sync_pull_duration_seconds`, `sms_envoyes_total{fournisseur,statut}`,
  `jobs_total{file,statut}`, `rls_violation_total`.
- Les seuils d'alerte sont ceux de la revue DevOps (taux d'erreur sync, remise SMS, retard de réplication,
  âge de sauvegarde).

## 9. Performance (RNF-002)

| Indicateur | Cible |
| --- | --- |
| p95 latence serveur, endpoints console | < 300 ms |
| p95 latence serveur, `/v1/sync/push` (lot de 50) | < 800 ms |
| p95 affichage écran console (3G Abidjan) | < 2 s |
| Taille d'une réponse de pull incrémental typique | < 50 Ko compressée |

Les rapports lourds (PDF annuel, exports) sont **asynchrones** : l'API répond `202` avec un identifiant de tâche.
