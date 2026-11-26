# 09 — Qualité, tests et CI/CD

## 1. Stratégie de test

| Niveau | Outil | Portée | Seuil |
| --- | --- | --- | --- |
| Unitaire | Vitest | Règles pures : imputation (RG-COT-020/021), génération d'échéancier (RG-COT-011), calcul de validations requises, formatage, numérotation | 90 % de lignes sur `modules/*/domain` |
| Intégration backend | Vitest + Testcontainers (PostgreSQL 17, Redis 7) | Services + base réelle avec RLS, triggers, transactions ; un test par règle `RG-xxx` (nom du test = identifiant) | Toutes les règles `RG` couvertes |
| Contrat API | Test de conformité : chaque route NestJS ↔ opération `openapi.yaml` (méthode, chemin, statuts, schéma de réponse validé avec Ajv sur les tests d'intégration) | Backend | 100 % des opérations |
| Isolation multi-tenant | `isolation.spec.ts` : pour chaque opération, jeton du tenant B sur ressource du tenant A → 404 ; écriture croisée → refus | Backend | 100 % des opérations avec `{id}` |
| Sync | Scénarios de 05-synchronisation §10 (rejeu, concurrence, dépendances rejetées, longue période hors ligne) | Backend | Tous |
| Composants console | Vitest + Testing Library + MSW | Formulaires, affichage selon permissions, mapping d'erreurs | Composants partagés 80 % |
| Bout en bout | Playwright sur staging | Parcours critiques de 08 §8 | Tous verts avant mise en production |
| Charge | k6 | Sync push/pull à 10× la cible MVP (1 000 associations simulées, 200 appareils simultanés) | p95 push < 800 ms, 0 erreur 5xx |
| Sécurité | `pnpm audit`, Trivy (images), Semgrep (règles OWASP), ZAP baseline sur staging | Tous | Aucune vulnérabilité critique/haute non traitée |
| Restauration | Job mensuel : restauration pgBackRest dans un environnement jetable + comptages + vérification chaîne d'audit | Infra | Durée mesurée ≤ RTO |

### Jeux de données

- `seed:demo` : 2 associations réalistes (noms fictifs), 300 membres, 2 campagnes, 6 mois d'historique.
- `seed:charge` : 100 associations, 20 000 membres, 400 000 paiements (staging, tests de charge).
- Aucune donnée réelle hors production (D-002). Générateur de noms et de téléphones fictifs (`+225 01 00 xx xx xx`).

## 2. Règles de code

- TypeScript `strict`, ESLint (dont règle interdisant l'import de `users`/`sessions`/`otp_codes` hors module `auth`,
  et l'accès direct à `db` hors `TenantContext`), Prettier.
- Montants : type `Montant` (alias `bigint` côté serveur, `number` entier côté JSON) ; lint interdisant `parseFloat`
  et `toFixed` dans les modules financiers.
- Pas de logique métier dans les contrôleurs : contrôleur → service → repository.
- Chaque règle `RG-xxx` implémentée porte un commentaire `// RG-xxx` à l'endroit de l'implémentation.
- Commits : Conventional Commits ; pull request obligatoire, 1 relecture minimum, 2 pour `packages/db/migrations`,
  `modules/auth`, `modules/sync`, `modules/tresorerie`.

## 3. Pipeline CI/CD (GitHub Actions)

Le dépôt est hébergé sur GitHub (dépôt privé). Le pipeline de référence est `.github/workflows/ci.yml` :

| Job | Déclencheur | Contenu |
| --- | --- | --- |
| `verifier` | chaque push et pull request | install figée, Prettier, migrations sur PostgreSQL 17 vierge (deux fois, pour l'idempotence), lint, typecheck, tests (dont intégration RLS), build |
| `images` | push sur `main` et tags `v*` | build des images `api` et `console`, publication sur GitHub Container Registry (`ghcr.io/<owner>/assoflow/<app>`), tags SHA court et version, scan Trivy (HIGH/CRITICAL bloquants) |
| `deployer_*` | à ajouter avec l'infrastructure | dev automatique sur `main`, staging sur tag `vX.Y.Z-rcN`, production manuelle (environnement GitHub protégé avec approbation) sur tag `vX.Y.Z` |

Le déploiement exécute `infra/deploy.sh <env> <version>` : migration one-shot, puis
`docker service update --image … --update-failure-action rollback` sur `api` puis `worker`, et vérification de
`/health/ready`. Toutes les images (node, postgres, nginx, trivy) sont épinglées par version ; Dependabot propose
les mises à jour (`.github/dependabot.yml`).

## 4. Définition de « terminé »

Une story est terminée quand :

- [ ] le code et les tests sont fusionnés sur `main`, pipeline vert ;
- [ ] chaque règle `RG` concernée a son test d'intégration nommé par son identifiant ;
- [ ] `openapi.yaml` est à jour et le client console régénéré ;
- [ ] les écritures sensibles sont tracées dans l'audit (vérifié par test) ;
- [ ] le test d'isolation couvre les nouveaux endpoints ;
- [ ] les textes de la console sont dans `fr.json` ; les états vide, chargement, erreur sont traités ;
- [ ] les métriques et logs utiles sont présents (sans donnée personnelle en clair) ;
- [ ] la documentation de ce dossier est mise à jour si une règle ou un contrat a changé ;
- [ ] démontrée sur l'environnement dev.

## 5. Critères d'acceptation du cahier → preuves

| Critère (cahier §12) | Preuve automatisée |
| --- | --- |
| 1. 20 cotisations en moins de 10 min | Playwright A12 chronométré (saisie simulée à vitesse humaine : 20 s par paiement) + test mobile équivalent |
| 2. Reçu SMS en moins d'1 min | Métrique `notification_delai_envoi_seconds` p95 < 10 s en staging ; mesure de remise sur le pilote |
| 3. Président valide une dépense sur téléphone | Test e2e mobile (hors de ce dossier) + test API `POST /depenses/{id}/decision` |
| 4. Commissaire consulte l'audit complet | Test permissions `audit.lire` + export |
| 5. 100 % hors ligne pour la caisse | Tests mobile en mode avion + tests sync §10 |
| 6. Créer une association en 5 min | Playwright P4 |
| 7. Toutes les exigences Must couvertes et testées | Matrice de traçabilité générée depuis 10-backlog-mvp (RF → story → tests) |
