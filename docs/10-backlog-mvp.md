# 10 — Backlog MVP et traçabilité

Sprints de 2 semaines. Phase 1 (MVP pilote) : sprints 0 à 8, soit environ 4,5 mois, cohérent avec les 4 mois du
cahier plus un sprint de socle. Phase 2 (transparence) : sprints 9 à 14.

**[D] Ajustement du découpage du cahier** : le cahier place les notifications et le super-admin en phase 2, mais
le reçu SMS (RF-034) et l'OTP (RF-001) sont *Must* et le critère d'acceptation 6 exige la création d'un tenant.
La phase 1 inclut donc l'envoi SMS (OTP, reçus, rappels) et un super-admin minimal (création et suspension de tenant).
Les annonces, projets, journal public, réunions et le support complet restent en phase 2.

## 1. Plan des sprints

| Sprint | Objectif | Épiques |
| --- | --- | --- |
| S0 | Socle : monorepo, CI, environnements local et dev, schéma initial, contexte tenant, logs, healthchecks | E0 |
| S1 | Authentification complète, sessions, contexte d'association, permissions, audit | E1, E2 (base) |
| S2 | Association, exercices, catégories, utilisateurs et rôles ; membres (CRUD, recherche) | E2, E3 |
| S3 | Familles, ayants droit, import ; campagnes et échéancier | E3, E4 |
| S4 | Paiements (console), imputation, reçus, annulation, SMS (outbox, fournisseurs, reçus, rappels) | E4, E6 |
| S5 | Synchronisation mobile (pull, push, rejets, pièces jointes), appareils | E5 |
| S6 | Trésorerie, dépenses, validation, délégations, paiement de dépense | E7 |
| S7 | Tableau de bord, rapports, exports, audit console, super-admin minimal | E8, E9 |
| S8 | Durcissement : charge, sécurité, restauration, recette avec les 2 associations pilotes | E10 |
| S9–S14 | Phase 2 : projets, annonces, journal public, réunions, documents, support complet, WhatsApp | E11–E14 |

## 2. Épiques et stories (phase 1)

Format : **ID** — en tant que … je veux … ; exigences ; règles ; livrables backend / console.

### E0 — Socle technique (S0)

| ID | Story | Livrables |
| --- | --- | --- |
| E0-01 | Monorepo pnpm/Turborepo, `apps/api`, `apps/console`, `packages/{contracts,db,config}` | 01 §3 |
| E0-02 | Migration initiale = `schema.sql`, rôles `assoflow_owner`/`assoflow_app`, seeds `demo` | 02 |
| E0-03 | `TenantContext` + helper `db.tx()` posant les `SET LOCAL` ; test qui échoue si une requête tourne sans contexte | 01 §4 |
| E0-04 | Pipeline CI (lint, types, migrations, tests, images, scan) ; déploiement dev automatique | 09 §3 |
| E0-05 | Logs pino, `/metrics`, `/health/*`, intégration GlitchTip | 01 §8 |
| E0-06 | Console : squelette (routing, layout, client généré, gestion d'erreurs, i18n) | 08 §3 |

### E1 — Authentification et sessions (S1)

| ID | Story | RF | RG / réf. |
| --- | --- | --- | --- |
| E1-01 | En tant qu'utilisateur invité, je reçois un OTP et définis mon mot de passe | RF-001, RF-004 | 04 §2.1 |
| E1-02 | Je me connecte par téléphone ou email + mot de passe | RF-002 | 04 §2.2 |
| E1-03 | En tant que membre du bureau, j'active et j'utilise le TOTP sur la console | RF-003 | 04 §2.2 |
| E1-04 | Mon compte se verrouille après 5 échecs | RF-005 | 04 §2.3 |
| E1-05 | Ma session console expire après 30 min d'inactivité | RF-006 | 04 §3 |
| E1-06 | Refresh avec rotation et détection de réutilisation ; déconnexion | — | 04 §3 |
| E1-07 | Je choisis l'association active si j'en ai plusieurs | — | 04 §1 |
| E1-08 | Politique de mot de passe forte | RF-SUP-053 | 04 §2.4 |
| E1-09 | Consentements CGU et traitement des données à la première connexion | RF-SUP-054 | 04 §8 |

### E2 — Association, accès et audit (S1–S2)

| ID | Story | RF | RG / réf. |
| --- | --- | --- | --- |
| E2-01 | Guard de permissions + cache Redis invalidé ; révocation immédiate | RF-ADM-012, RF-ADM-014 | 04 §3–4 |
| E2-02 | Journal d'audit chaîné écrit dans la transaction ; consultation et export | RF-ADM-040 à 044, RNF-012 | 02 §6 |
| E2-03 | Président : modifier le profil, les informations légales, le logo, les seuils | RF-010, RF-011, RF-ADM-020, RF-ADM-024 | RG-ASS-003 |
| E2-04 | Gérer les exercices (création, clôture contrôlée) | RF-012, RF-014, RF-ADM-022 | RG-EXE-001 à 004 |
| E2-05 | Gérer les catégories de membres et de dépenses | RF-013, RF-ADM-021 | — |
| E2-06 | Inviter, changer de rôle, révoquer, déverrouiller ; historique de connexion | RF-ADM-010, 011, 013, 014, 015 | 04 §2.1 |
| E2-07 | Rôles personnalisés et matrice de permissions | RF-ADM-012 | 04 §4 |
| E2-08 | Tests d'isolation multi-tenant automatiques sur tous les endpoints | RF-SUP-006, RNF-013 | 04 §5 |

### E3 — Membres (S2–S3)

| ID | Story | RF | RG |
| --- | --- | --- | --- |
| E3-01 | Créer, modifier, consulter une fiche membre avec photo | RF-020, RF-022 | RG-MBR-001, 002 |
| E3-02 | Rechercher et filtrer les membres | RF-025 | — |
| E3-03 | Détecter les doublons probables et les traiter | — | RG-MBR-003 |
| E3-04 | Suspendre, réactiver, désactiver | RF-027 | RG-MBR-004 |
| E3-05 | Familles et chef de famille | RF-021 | RG-MBR-006 |
| E3-06 | Ayants droit | RF-028 | — |
| E3-07 | Historique complet d'un membre | RF-026 | — |
| E3-08 | Import CSV/Excel en deux temps | RF-024 | RG-MBR-007 |
| E3-09 | Carte de membre avec QR | RF-023 | RG-MBR-008 |
| E3-10 | Passage automatique en dormance | — | RG-MBR-005 |
| E3-11 | Anonymisation sur demande | RF-SUP-055 | RG-MBR-009 |

### E4 — Cotisations et paiements (S3–S4)

| ID | Story | RF | RG |
| --- | --- | --- | --- |
| E4-01 | Créer une campagne avec aperçu | RF-030, RF-037 | RG-COT-001 |
| E4-02 | Activer une campagne et générer l'échéancier | RF-031 | RG-COT-010, 011 |
| E4-03 | Ajouter des membres à une campagne active ; prolonger, clôturer | RF-031 | RG-COT-012, 013, 015 |
| E4-04 | Ajuster ou exonérer une échéance | RF-031 | RG-COT-013, 014 |
| E4-05 | Enregistrer un paiement (console) avec imputation, mouvement et numéro de reçu | RF-032, RF-033 | RG-COT-020, 030 à 032, RG-NUM-001 |
| E4-06 | Paiement groupé par famille | RF-038 | RG-COT-021 |
| E4-07 | Avances et imputation automatique | — | RG-COT-022 |
| E4-08 | Annuler un paiement par contre-écriture | — | RG-COT-040, 041 |
| E4-09 | Solde et situation d'un membre en temps réel | RF-035 | 02 §3.4 |
| E4-10 | Écran de saisie en série (20 paiements < 10 min) | RF-032 | 08 A12 |
| E4-11 | Reçu PDF et renvoi du reçu | RF-033, RF-034 | — |
| E4-12 | Exporter la liste des cotisants | RF-039 | — |

### E5 — Synchronisation mobile (S5)

| ID | Story | RF | Réf. |
| --- | --- | --- | --- |
| E5-01 | Enregistrement d'appareil et préfixe de reçu | RNF-001 | RG-NUM-003 |
| E5-02 | Pull par curseur avec périmètre par rôle et pagination | RNF-001 | 05 §2–4 |
| E5-03 | Push idempotent par lot avec résultats par élément | RNF-001, RNF-014 | 05 §5 |
| E5-04 | Rejets enregistrés, renvoyés, acquittés | RNF-014 | 05 §6 |
| E5-05 | Pièces jointes par URL présignée et confirmation | RF-041 | 05 §7 |
| E5-06 | Versions minimales, révocation et purge d'appareil | RF-ADM-014 | 05 §8 |
| E5-07 | Tableau des appareils et rejets (console) | RF-SUP-033 | 08 A32 |

### E6 — Notifications (S4)

| ID | Story | RF | Réf. |
| --- | --- | --- | --- |
| E6-01 | Outbox, files BullMQ, reprise | — | 06 §1–2 |
| E6-02 | Deux fournisseurs SMS, bascule, webhooks de remise | RF-SUP-040 | 06 §4 |
| E6-03 | SMS de reçu < 10 s après commit | RF-034 | 06 §6 |
| E6-04 | Rappels J-7, J-1, J+7 regroupés | RF-036 | RG-COT-050 |
| E6-05 | Quotas SMS et alertes | RF-SUP-031 | 06 §4.3 |
| E6-06 | Modèles globaux et personnalisés | RF-SUP-042, RF-ADM-023 | 06 §5 |
| E6-07 | SMS aux membres sans smartphone (via téléphone ou chef de famille) | RF-060 | RG-MBR-002 |
| E6-08 | Convocation d'AG par SMS (sans module réunion complet) | RF-063 | — |

### E7 — Trésorerie et dépenses (S6)

| ID | Story | RF | RG |
| --- | --- | --- | --- |
| E7-01 | Comptes caisse / banque / mobile money et soldes | RF-043 | RG-TRE-001 |
| E7-02 | Journal chronologique des mouvements | RF-046 | RG-TRE-001 |
| E7-03 | Transferts et ajustements | — | RG-TRE-002, 004 |
| E7-04 | Créer une dépense catégorisée avec justificatif | RF-040, RF-041, RF-044 | RG-DEP-001, 002, 010 |
| E7-05 | File de validation, approuver/rejeter avec motif, double validation | RF-042, RF-ADM-030, 031, 033 | RG-DEP-003 à 007 |
| E7-06 | Notification du demandeur après décision | RF-ADM-034 | RG-DEP-006 |
| E7-07 | Délégation temporaire de validation | RF-ADM-032 | RG-DEP-004 |
| E7-08 | Payer une dépense (justificatif, solde, alerte de seuil) | RF-041, RF-045 | RG-DEP-008, 011 |
| E7-09 | Annuler une dépense non payée | — | RG-DEP-009 |

### E8 — Tableaux de bord et rapports (S7)

| ID | Story | RF | RG |
| --- | --- | --- | --- |
| E8-01 | Tableau de bord avec alertes et comparaisons | RF-070, RF-ADM-001, 002, 003, 004 | RG-RAP-001 |
| E8-02 | Statistiques de recouvrement | RF-075 | RG-RAP-002 |
| E8-03 | Rapport financier mensuel/trimestriel/annuel PDF et Excel | RF-071, RF-072 | RG-RAP-003 |
| E8-04 | Tâches asynchrones et téléchargement | — | 06 §7 |
| E8-05 | Documents de l'association (statuts, règlement, PV) — stockage simple | RF-ADM-050 | — |

### E9 — Super-admin minimal (S7)

| ID | Story | RF |
| --- | --- | --- |
| E9-01 | Créer une association et son président en < 5 min | RF-SUP-001, RF-SUP-010, critère 6 |
| E9-02 | Suspendre, réactiver, archiver une association | RF-SUP-002 |
| E9-03 | Statistiques globales | RF-SUP-003 |
| E9-04 | Historique des actions par association ; audit plateforme | RF-SUP-005, RF-SUP-052 |
| E9-05 | Demandes de création d'association (formulaire public + traitement) | RF-SUP-013, RF-SUP-014 |
| E9-06 | Réinitialiser un mot de passe, déverrouiller, désactiver | RF-SUP-011 |
| E9-07 | Paramètres globaux (passerelles, version minimale, conservation) | RF-SUP-040, RF-SUP-044 |
| E9-08 | Tickets de support (ouvrir, répondre) | RF-SUP-020, RF-SUP-021 |
| E9-09 | Suivi des performances et alertes techniques (Grafana/Alertmanager, lien depuis P1) | RF-SUP-030, RF-SUP-032 |

### E10 — Durcissement et recette (S8)

| ID | Story | Réf. |
| --- | --- | --- |
| E10-01 | Test de charge sync à 10× | 09 §1 |
| E10-02 | Scans de sécurité, correction des vulnérabilités hautes | 09 §1 |
| E10-03 | Test de restauration chronométré, runbooks validés | Revue DevOps |
| E10-04 | Purges et durées de conservation | RF-SUP-044, 03 §10 |
| E10-05 | Export complet d'une association (portabilité) | RF-SUP-055 |
| E10-06 | Recette avec les 2 associations pilotes, correction des retours | Cahier §9 |
| E10-07 | Dossier ARTCI et procédure d'export/suppression documentés | RF-SUP-050, RF-SUP-055 |

## 3. Phase 2 (S9–S14)

| Épique | Contenu | RF |
| --- | --- | --- |
| E11 Projets | Projets, affectation des cotisations et dépenses, avancement, photos, rapport, clôture | RF-050 à 056 |
| E12 Transparence et communication | Journal public, annonces ciblées, WhatsApp, push, accusés de réception | RF-061, 062, 064, 065, RF-074 |
| E13 Gouvernance | Réunions, présences, PV, mandats, rapport moral, versions et partage de documents | RF-073, RF-080 à 084, RF-ADM-051 à 053 |
| E14 Support avancé | Accès support avec consentement, impersonation, base de connaissances, plans tarifaires | RF-SUP-004, 012, 022, 023, 024, 034 |

## 4. Couverture des exigences *Must* du cahier

| Exigence Must | Story | Exigence Must | Story |
| --- | --- | --- | --- |
| RF-001 | E1-01 | RF-ADM-001, 002 | E8-01 |
| RF-002 | E1-02 | RF-ADM-010, 011 | E2-06 |
| RF-003 | E1-03 | RF-ADM-012 | E2-01, E2-07 |
| RF-004 | E1-01 | RF-ADM-014 | E2-01, E2-06 |
| RF-005 | E1-04 | RF-ADM-020 | E2-03 |
| RF-010, 011 | E2-03 | RF-ADM-021 | E2-05 |
| RF-012 | E2-04 | RF-ADM-022 | E2-04 |
| RF-013 | E2-05 | RF-ADM-030, 031, 033 | E7-05 |
| RF-020, 022 | E3-01 | RF-ADM-034 | E7-06 |
| RF-021 | E3-05 | RF-ADM-040 à 044 | E2-02 |
| RF-025 | E3-02 | RF-ADM-050 | E8-05 |
| RF-026 | E3-07 | RF-SUP-001 | E9-01 |
| RF-027 | E3-04 | RF-SUP-002 | E9-02 |
| RF-030 | E4-01 | RF-SUP-003 | E9-03 |
| RF-031 | E4-02 à E4-04 | RF-SUP-005 | E9-04 |
| RF-032 | E4-05, E4-10 | RF-SUP-006 | E2-08 |
| RF-033 | E4-05, E4-11 | RF-SUP-010 | E9-01 |
| RF-034 | E6-03, E4-11 | RF-SUP-011 | E9-06 |
| RF-035 | E4-09 | RF-SUP-013, 014 | E9-05 |
| RF-036 | E6-04 | RF-SUP-020, 021 | E9-08 |
| RF-039 | E4-12 | RF-SUP-030, 032 | E9-09 |
| RF-040, 044 | E7-04 | RF-SUP-031 | E6-05 |
| RF-041 | E7-04, E7-08, E5-05 | RF-SUP-040 | E6-02, E9-07 |
| RF-042 | E7-05 | RF-SUP-042 | E6-06 |
| RF-043 | E7-01 | RF-SUP-044 | E9-07, E10-04 |
| RF-046 | E7-02 | RF-SUP-045 | Infra (pgBackRest), E10-03 |
| RF-050 à 053, 055, 056 | E11 (phase 2) | RF-SUP-050 | E10-07 |
| RF-060 | E6-07 | RF-SUP-051 | 04 §8 (infra + E1-03) |
| RF-063 | E6-08 | RF-SUP-052 | E9-04 |
| RF-064 | E12 (phase 2) | RF-SUP-053 | E1-08 |
| RF-070 | E8-01 | RF-SUP-054 | E1-09 |
| RF-071, 072 | E8-03 | RF-SUP-055 | E3-11, E10-05 |
| RF-074 | E12 (phase 2) | RF-075 | E8-02 |

Les exigences *Must* des projets (RF-050 à 056), des annonces (RF-064) et du journal public (RF-074) sont livrées en
phase 2, conformément à la roadmap du cahier (phase 2 « Transparence ») : elles sont *Must* pour la version complète,
pas pour le pilote.
