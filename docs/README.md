# AssoFlow CI — Dossier de développement (backend + console)

Version 1.0 — 26/11/2026 — statut : **référence pour le MVP**

Ce dossier est la base sur laquelle le backend (API + workers) et la console web sont développés.
Il traduit le *Cahier des charges fonctionnel Associations & Mutuelles CI v1.0* et les décisions de la
*Revue critique DevOps* en spécifications exécutables. En cas de conflit, l'ordre de priorité est :

1. ce dossier (décisions `D-xxx` et règles `RG-xxx`),
2. le cahier des charges CI v1.0 (exigences `RF-xxx`, `RNF-xxx`),
3. les spécifications AssoFlow FR v1.0/v1.1 (gelées, marché UE ultérieur).

## Sommaire

| Fichier | Contenu | Lecteurs principaux |
| --- | --- | --- |
| [01-architecture-technique.md](01-architecture-technique.md) | Stack, monorepo, modules, environnements, configuration, déploiement | Tous |
| [02-modele-donnees.md](02-modele-donnees.md) | Entités, tables, contraintes, RLS, conventions SQL | Backend |
| [schema.sql](schema.sql) | DDL PostgreSQL de référence (migration initiale), testé | Backend |
| [03-regles-metier.md](03-regles-metier.md) | Règles de gestion numérotées `RG-xxx` | Backend, console, QA |
| [04-securite-autorisations.md](04-securite-autorisations.md) | Authentification, jetons, rôles, permissions, multi-tenant, audit | Backend, console |
| [05-synchronisation.md](05-synchronisation.md) | Protocole de sync mobile (pull/push), idempotence, conflits | Backend, mobile |
| [06-jobs-notifications.md](06-jobs-notifications.md) | Files, workers, SMS/WhatsApp, relances, rapports | Backend |
| [07-contrat-api.md](07-contrat-api.md) | Conventions REST, erreurs, pagination, catalogue des endpoints | Backend, console |
| [openapi.yaml](openapi.yaml) | Contrat OpenAPI 3.1 (source de génération du client console) | Backend, console |
| [08-console-specification.md](08-console-specification.md) | Écrans de la console association et super-admin | Console, QA |
| [09-qualite-tests-ci.md](09-qualite-tests-ci.md) | Stratégie de test, pipeline CI/CD, définition de « terminé » | Tous |
| [10-backlog-mvp.md](10-backlog-mvp.md) | Épiques, stories, ordre des sprints, traçabilité RF | Tous |

## Périmètre couvert

- **Backend** : API REST (console + mobile), endpoint de synchronisation, workers asynchrones
  (SMS, relances, PDF/Excel, sauvegardes d'audit), administration plateforme.
- **Console** : application web unique avec deux espaces :
  - *Espace association* (bureau : président, trésorier, secrétaire, commissaire aux comptes) ;
  - *Espace plateforme* (super-administrateur, support).
- **Hors périmètre de ce dossier** : application mobile (seul le contrat de sync la concerne ici),
  API mobile money (v2), votes en ligne, comptabilité SYSCOHADA.

## Décisions structurantes (rappel)

| ID | Décision |
| --- | --- |
| D-001 | Cahier CI v1.0 = seule référence fonctionnelle du MVP |
| D-002 | Production hébergée en Côte d'Ivoire ; aucune donnée personnelle réelle hors CI |
| D-003 | Docker Swarm sur 4 VPS ; PostgreSQL primaire + réplica, bascule manuelle |
| D-004 | Écritures financières append-only ; annulation par contre-écriture uniquement |
| D-005 | Isolation multi-tenant par Row-Level Security PostgreSQL |
| D-006 | TypeScript de bout en bout : NestJS (API/workers), React (console), React Native (mobile) |
| D-007 | Montants en francs CFA (XOF) entiers, type `bigint`, jamais de flottant |
| D-008 | Toutes les dates en UTC (`timestamptz`) ; affichage Africa/Abidjan (UTC+0) |
| D-009 | RPO ≤ 5 min, RTO ≤ 2 h (nœud) / ≤ 8 h (site), disponibilité 99 % mensuelle |
| D-010 | Biométrie (RF-007), votes, mobile money API, SYSCOHADA : hors MVP |

Les décisions détaillées se trouvent dans chaque document, sous la forme `D-xxx`.

## Conventions de rédaction

- `RF-xxx` / `RNF-xxx` : exigence du cahier CI. `RG-xxx` : règle de gestion de ce dossier.
- `D-xxx` : décision d'architecture. Toute remise en cause passe par une revue et une mise à jour du document.
- Les noms de tables, colonnes et champs d'API sont en **français sans accents**, en `snake_case`
  (base) et `camelCase` (JSON).
- « Doit » = obligatoire ; « devrait » = recommandé ; « peut » = optionnel.
