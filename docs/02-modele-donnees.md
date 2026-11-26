# 02 — Modèle de données

La référence exécutable est [`schema.sql`](schema.sql) (migration initiale). Elle a été installée et testée
sur PostgreSQL 16 : isolation RLS entre deux tenants, refus des `UPDATE`/`DELETE` sur les tables en ajout seul,
numérotation, versions de synchronisation, chaînage du journal d'audit et vues de soldes.
Ce document explique les choix ; en cas d'écart, `schema.sql` fait foi et ce document doit être corrigé.

## 1. Conventions

| Sujet | Règle |
| --- | --- |
| Nommage | Tables au pluriel, colonnes en `snake_case`, français sans accents |
| Clés primaires | `uuid`. Les entités créables hors ligne (`membres`, `familles`, `ayants_droit`, `paiements`, `depenses`, `pieces_jointes`) reçoivent un **UUIDv7 généré par l'appareil** ; les autres un UUID généré par l'API (`gen_random_uuid()` ou UUIDv7) |
| Tenant | Toute table métier porte `association_id NOT NULL` + politique RLS `tenant_isolation` |
| Montants | `bigint` en francs CFA (XOF), sans décimales (D-007). Jamais `numeric` flottant ni `float` |
| Dates | `timestamptz` (UTC) pour les instants ; `date` pour les dates métier (échéance, date de dépense) |
| Énumérations | `text` + `CHECK` (et non `ENUM` PostgreSQL) pour faciliter l'ajout de valeurs (*expand/contract*) |
| Suppression | Entités descriptives : suppression logique `deleted_at`. Entités financières : **jamais** supprimées |
| Synchronisation | Tables synchronisées : colonne `sync_version bigint`, renseignée par trigger (§5) |
| Audit | Pas de trigger d'audit générique : l'audit est écrit par le service métier, avec le contexte (acteur, motif, appareil) |

## 2. Cartographie des entités

```
associations ─┬─< roles ─< acces_association >── users ──< sessions
              │                    │                 └──< appareils
              ├─< delegations      └── membres (optionnel)
              ├─< categories_membres ─< membres >── familles
              │                          ├─< ayants_droit
              │                          └─< echeances >── campagnes_cotisation >── exercices
              ├─< comptes_tresorerie                                   └── projets
              ├─< paiements ─< imputations_paiement >── echeances
              ├─< depenses ─< validations_depense
              ├─< transferts
              ├─< mouvements  (journal de trésorerie, alimenté par paiements, dépenses, transferts)
              ├─< reunions ─< presences
              ├─< documents, pieces_jointes, annonces
              ├─< notifications, consommation_sms, taches, idempotence, compteurs
              └─< audit_log
plateforme : users, otp_codes, sessions, demandes_association, acces_support, consentements,
             parametres_plateforme, modeles_notification, tickets_support, messages_ticket
```

## 3. Description par domaine

### 3.1 Plateforme et identité

| Table | Rôle | Points clés |
| --- | --- | --- |
| `associations` | Le tenant | Paramètres métier (`seuil_double_validation`, `seuil_alerte_solde`, `jours_retard_dormant`, `mois_debut_exercice`), `plan`, `quota_sms_mensuel`, `sync_counter` |
| `users` | Personne physique qui se connecte | Identifiant = téléphone E.164 unique. Peut accéder à plusieurs associations. `role_plateforme` ∈ {`super_admin`, `support`} pour l'équipe AssoFlow |
| `otp_codes` | Codes à usage unique | Code jamais stocké en clair (HMAC + pepper), 5 tentatives, 5 min de validité |
| `sessions` | Refresh tokens | Hash uniquement, rotation à chaque usage, `famille_id` pour détecter la réutilisation |
| `appareils` | Téléphone enregistré pour la sync | `prefixe_recu` unique par association (ex. `T02`), curseur de sync, révocation |
| `demandes_association` | Demande de création (RF-SUP-013/014) | Validée → création du tenant |
| `acces_support` | Accès support à un tenant (RF-SUP-022/023) | Consentement d'un administrateur, durée ≤ 24 h |
| `consentements` | Preuve de consentement (RF-SUP-054) | Ajout seul, versionné par texte |

**Exception RLS documentée** : `users`, `otp_codes`, `sessions` ne sont pas sous RLS (elles servent avant
qu'un tenant soit connu). Seul le module `auth` y accède ; une règle ESLint interdit leur import ailleurs.

### 3.2 Accès au bureau

- `roles` : rôles par association, avec un tableau `permissions` (codes définis dans
  [04-securite-autorisations.md](04-securite-autorisations.md)). Les rôles `systeme` sont créés à l'ouverture du tenant :
  `president`, `tresorier`, `secretaire`, `commissaire`, `membre`.
- `acces_association` : lien user ↔ association ↔ rôle, avec dates de mandat (RF-ADM-013). Un seul accès actif
  par couple user/association. La révocation (RF-ADM-014) passe `statut = 'revoque'` et révoque les sessions.
- `delegations` : délégation temporaire d'une permission (RF-ADM-032), 90 jours maximum.

### 3.3 Membres

- `membres.numero` (`MBR-000123`) est attribué **par le serveur** à la réception ; l'appareil affiche
  « provisoire » tant que le numéro n'est pas connu.
- `statut_adhesion` (actif, dormant, honoraire, bienfaiteur — RF-022) est distinct de `etat`
  (actif, suspendu, désactivé — RF-027) : un membre honoraire peut être suspendu.
- `est_diaspora` est calculé à partir de `pays_residence`.
- `familles` regroupe des membres (RF-021) et permet le paiement groupé (RF-038).
- `ayants_droit` : conjoint, enfants (RF-028). Ce ne sont pas des membres.

### 3.4 Cotisations

- `exercices` : périodes sans chevauchement (contrainte d'exclusion). Un exercice clôturé n'accepte plus
  d'écriture datée dans sa période.
- `campagnes_cotisation` : montant **par période**, périodicité, catégories cibles. Ordinaire ou exceptionnelle
  (décès, projet — RF-037).
- `echeances` : l'échéancier par membre (RF-031), généré à l'activation de la campagne (RG-COT-010).
  Ajustable (montant, exonération motivée) tant qu'aucun paiement n'y est imputé.
- `paiements` : **ajout seul**. Annulation = nouvelle ligne `type = 'annulation'` pointant le paiement annulé,
  avec motif. `numero_recu` serveur + `numero_recu_provisoire` appareil (RG-NUM-002).
- `imputations_paiement` : ventilation du paiement sur les échéances, calculée par le serveur. Une annulation
  produit des imputations négatives symétriques. Un surplus devient une imputation sans échéance (avance).

Situation d'une échéance (vue `v_echeances_situation`) : `a_venir`, `partielle`, `payee`, `en_retard`, `exoneree`.
Solde d'un membre (vue `v_soldes_membres`) : `total_paye − total_exigible` (exigible = échéances échues).

### 3.5 Trésorerie et dépenses

- `comptes_tresorerie` : caisse, banque, mobile money (RF-043), avec solde initial.
- `mouvements` : **journal unique, ajout seul** (RF-046). Toute entrée ou sortie d'argent y figure une fois :
  paiement (entrée), annulation de paiement (sortie), dépense payée (sortie), transfert (une sortie + une entrée).
  Solde d'un compte = `solde_initial + Σ entrées − Σ sorties` (vue `v_soldes_comptes`).
- `depenses` : workflow `soumise → validee → payee`, ou `rejetee`, ou `annulee` (RG-DEP-xxx). Montant, compte,
  demandeur et numéro figés par trigger. Pas de suppression.
- `validations_depense` : une ligne par décision, ajout seul ; un valideur ne décide qu'une fois.
- `transferts` : caisse ↔ banque ↔ mobile money.

### 3.6 Projets, réunions, documents, communication

- `projets` : budget, responsable, avancement (RF-050 à 056). Les cotisations (via `campagnes_cotisation.projet_id`)
  et les dépenses (`depenses.projet_id`) y sont rattachées.
- `reunions`, `presences` : RF-080 à 084 (Should). Le PV est un `document` lié.
- `documents` : statuts, règlement, PV, rapports, versionnés (`document_parent_id`).
- `pieces_jointes` : justificatifs (RF-041), photos de projets ; fichiers dans S3, métadonnées ici,
  `statut_upload` pour l'envoi différé depuis l'appareil.
- `annonces` (RF-064), `modeles_notification` (globaux ou par tenant), `notifications` (outbox d'envoi),
  `consommation_sms` (quota mensuel, RF-SUP-031).

### 3.7 Technique

- `compteurs` + fonction `app_prochain_numero(type, annee)` : numérotation sans trou par tenant (verrou de ligne).
- `taches` : exports et rapports asynchrones.
- `idempotence` : réponses mémorisées des `POST` console portant un `Idempotency-Key`.
- `audit_log` : journal immuable chaîné (§6).

## 4. Row-Level Security (D-005)

- Toutes les tables tenant : `ENABLE` + `FORCE ROW LEVEL SECURITY`, politique
  `association_id = app_association_id()` en lecture **et** en écriture.
- `app_association_id()` lit `current_setting('app.association_id')`, posé par `SET LOCAL` en début de transaction.
  Sans contexte, aucune ligne n'est visible (vérifié).
- `associations` : un tenant ne voit que sa ligne ; `super_admin` et `support` voient toutes les lignes.
- Les statistiques transverses passent par des fonctions `SECURITY DEFINER` qui vérifient le rôle plateforme
  (`plateforme_statistiques()`), jamais par un rôle `BYPASSRLS`.
- Le rôle `assoflow_app` a `NOBYPASSRLS` ; il n'a pas `UPDATE`/`DELETE` sur les tables en ajout seul
  (double protection avec les triggers).

## 5. Versions de synchronisation

- Chaque tenant possède un compteur `associations.sync_counter`.
- Les triggers `*_sync` appellent `app_next_sync_version(association_id)` à chaque `INSERT`/`UPDATE` d'une table
  synchronisée ; la ligne reçoit la nouvelle valeur dans `sync_version`.
- Le verrou de ligne sur `associations` **sérialise les écritures d'un même tenant jusqu'au commit**. Les versions
  sont donc visibles dans l'ordre : un pull par `sync_version > curseur` ne peut pas manquer une ligne.
- Coût : deux transactions d'écriture du même tenant s'attendent. Acceptable aux volumes visés (quelques
  écritures par minute et par association). Les transactions d'écriture doivent rester courtes (< 200 ms) ;
  aucun appel réseau externe dans une transaction.
- Suppressions : les entités descriptives sont supprimées logiquement (`deleted_at`) et remontent dans le pull
  comme `deleted`.

## 6. Journal d'audit

- Insertion uniquement (trigger + privilèges). Champs : acteur, type d'acteur (utilisateur, système, support,
  impersonation), action, entité, valeurs avant/après, IP, appareil, `request_id`.
- Chaînage : `hash = SHA-256(hash_precedent | champs)` par tenant, sérialisé par verrou consultatif.
  Une vérification nocturne recalcule la chaîne et alerte en cas de rupture.
- Export quotidien vers le stockage objet en mode WORM (rétention ≥ 10 ans, à confirmer juridiquement).
- Données personnelles dans `avant`/`apres` : uniquement les champs modifiés ; téléphones masqués.

## 7. Index et volumétrie

Hypothèse MVP (décision 11 de la revue) : 100 associations, 20 000 membres, environ 20 paiements par membre et par an,
soit ~400 000 paiements/an. Toutes les tables tiennent en mémoire sur un VPS de 8 Go. Les index fournis couvrent :
recherche de membres, échéances par membre, paiements par membre, dépenses par statut, mouvements par compte,
pull de sync (`association_id, sync_version`), notifications en attente.

## 8. Migrations

- Outil : drizzle-kit pour générer, **SQL relu à la main** avant commit (`packages/db/migrations/NNNN_nom.sql`).
- Règle *expand/contract* : ajout de colonne nullable ou avec défaut → déploiement → remplissage → contrainte.
  Jamais de renommage ni de suppression de colonne utilisée par la version N-1 de l'API ou de l'app mobile.
- Toute migration est testée dans la CI sur une base contenant le jeu de données de staging.
- `schema.sql` = migration `0001` ; les évolutions suivantes sont dans `packages/db/migrations` :
  - `0002_auth_sessions.sql` (sprint 1) : `sessions.association_id` (association active, révocation par tenant),
    `otp_codes.jeton_utilise_at` (jeton OTP à usage unique), `users.verrouillages_recents`,
    `users.dernier_verrouillage` (verrouillage progressif), `users.totp_dernier_pas` (anti-rejeu TOTP) ;
    politique `audit_ecriture_auth` (événements d'authentification dans la chaîne plateforme) ; trigger de chaînage
    d'audit en `SECURITY DEFINER` (sinon, sous RLS, un utilisateur sans rôle plateforme ne voit pas la fin de la chaîne
    plateforme et la casse) ; fonction `app_mes_acces()` (`SECURITY DEFINER`, accès actifs de `app_user_id()` tous
    tenants confondus, pour `/auth/moi`, `/auth/contexte` et la connexion).
- Les fonctions `SECURITY DEFINER` (`plateforme_statistiques`, `app_next_sync_version`, `app_mes_acces`,
  `trg_audit_chainage`) supposent que leur propriétaire (`assoflow_owner`) contourne la RLS (superutilisateur ou
  `BYPASSRLS`) : les tables étant en `FORCE ROW LEVEL SECURITY`, c'est à vérifier au provisionnement de production.
