# AssoFlow CI

Gestion des associations et mutuelles de développement villageois (Côte d'Ivoire) : backend (API + workers) et console web.
L'application mobile offline-first viendra dans `apps/mobile`.

> Dépôt privé. Les spécifications de référence sont dans [`docs/`](docs/README.md).

## Contenu

| Dossier              | Rôle                                                                                             |
| -------------------- | ------------------------------------------------------------------------------------------------ |
| `apps/api`           | NestJS 12 + Fastify : API REST `/v1`, worker (`APP_ROLE=worker`)                                 |
| `apps/console`       | React 19 + Vite + Mantine : console association et plateforme                                    |
| `packages/contracts` | Schémas Zod, permissions, codes d'erreur partagés                                                |
| `packages/db`        | Migrations SQL (PostgreSQL 17, RLS) et script de migration                                       |
| `docs/`              | Dossier de développement : architecture, données, règles, API (`openapi.yaml`), console, backlog |
| `infra/`             | Infrastructure locale (production : Ansible + Docker Swarm, à venir)                             |

## Démarrer en local

Prérequis : Node ≥ 22.12 (24 recommandé, voir `.nvmrc`), pnpm 10 (`corepack enable`), Docker.

```bash
cp .env.example .env
pnpm install
pnpm infra:up                     # PostgreSQL 17 + Redis 7
DATABASE_URL=postgres://assoflow_owner:assoflow@localhost:5432/assoflow pnpm db:migrate
pnpm build
pnpm dev                          # API sur :3000, console sur :5173
```

- Santé : `GET http://localhost:3000/health/ready`
- Console : http://localhost:5173

## Vérifications

```bash
pnpm lint && pnpm typecheck && pnpm test
```

Les tests d'intégration (isolation RLS, tables en ajout seul, chaîne d'audit) tournent quand `DATABASE_URL`
(propriétaire) et `DATABASE_APP_URL` (rôle `assoflow_app`) pointent vers une base migrée ; sinon ils sont ignorés.

## Règles du dépôt

- Branche `main` protégée ; tout passe par une pull request avec CI verte (`.github/workflows/ci.yml`).
- Commits au format Conventional Commits.
- Définition de « terminé » : `docs/09-qualite-tests-ci.md` §4.
- Aucun secret dans le dépôt ; aucune donnée réelle hors production.
