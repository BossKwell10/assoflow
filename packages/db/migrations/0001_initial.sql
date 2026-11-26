-- =============================================================================
-- AssoFlow CI — Schéma PostgreSQL de référence (migration initiale 0001)
-- Version 1.0 — 26/11/2026
-- Cible : PostgreSQL 17 (compatible 16). Rôles : assoflow_owner (migrations),
--         assoflow_app (application, SANS BYPASSRLS).
-- Conventions : voir 02-modele-donnees.md
-- =============================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS citext;
CREATE EXTENSION IF NOT EXISTS btree_gist;

-- -----------------------------------------------------------------------------
-- 0. Fonctions de contexte (posées par l'API via SET LOCAL)
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app_association_id() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('app.association_id', true), '')::uuid
$$;

CREATE OR REPLACE FUNCTION app_user_id() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('app.user_id', true), '')::uuid
$$;

CREATE OR REPLACE FUNCTION app_role_plateforme() RETURNS text
LANGUAGE sql STABLE AS $$
  SELECT coalesce(nullif(current_setting('app.role_plateforme', true), ''), 'aucun')
$$;

-- updated_at automatique
CREATE OR REPLACE FUNCTION trg_set_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END $$;

-- Interdit UPDATE / DELETE (tables append-only)
CREATE OR REPLACE FUNCTION trg_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Table % en ajout seul : % interdit', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'P0001';
END $$;

-- =============================================================================
-- 1. PLATEFORME (hors tenant)
-- =============================================================================

CREATE TABLE associations (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  nom                       text NOT NULL,
  sigle                     text,
  type                      text NOT NULL DEFAULT 'association'
                              CHECK (type IN ('association','mutuelle_developpement','mutuelle_sociale','autre')),
  village                   text NOT NULL,
  sous_prefecture           text,
  region                    text NOT NULL,
  date_creation             date,
  recepisse_numero          text,
  recepisse_date            date,
  prefecture_depot          text,
  telephone                 text,
  email                     citext,
  logo_cle                  text,
  devise                    char(3) NOT NULL DEFAULT 'XOF' CHECK (devise = 'XOF'),
  mois_debut_exercice       smallint NOT NULL DEFAULT 1 CHECK (mois_debut_exercice BETWEEN 1 AND 12),
  seuil_double_validation   bigint NOT NULL DEFAULT 100000 CHECK (seuil_double_validation >= 0),
  seuil_alerte_solde        bigint NOT NULL DEFAULT 0 CHECK (seuil_alerte_solde >= 0),
  jours_retard_dormant      integer NOT NULL DEFAULT 180 CHECK (jours_retard_dormant > 0),
  journal_public_actif      boolean NOT NULL DEFAULT true,
  langue_defaut             text NOT NULL DEFAULT 'fr',
  statut                    text NOT NULL DEFAULT 'active'
                              CHECK (statut IN ('active','suspendue','archivee')),
  plan                      text NOT NULL DEFAULT 'gratuit' CHECK (plan IN ('gratuit','premium')),
  quota_sms_mensuel         integer NOT NULL DEFAULT 500 CHECK (quota_sms_mensuel >= 0),
  sync_counter              bigint NOT NULL DEFAULT 0,
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER associations_updated BEFORE UPDATE ON associations
  FOR EACH ROW EXECUTE FUNCTION trg_set_updated_at();

-- Compteur de synchronisation par tenant (voir 05-synchronisation.md §3).
-- Le verrou de ligne sur associations sérialise les écritures d'un même tenant :
-- l'ordre des versions = l'ordre des commits.
CREATE OR REPLACE FUNCTION app_next_sync_version(p_association uuid) RETURNS bigint
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  UPDATE associations SET sync_counter = sync_counter + 1
   WHERE id = p_association
  RETURNING sync_counter
$$;

CREATE OR REPLACE FUNCTION trg_sync_version() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.sync_version := app_next_sync_version(NEW.association_id);
  IF TG_OP = 'UPDATE' THEN
    NEW.updated_at := now();
  END IF;
  RETURN NEW;
END $$;

CREATE TABLE users (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  telephone            text NOT NULL UNIQUE CHECK (telephone ~ '^\+[1-9][0-9]{7,14}$'),
  email                citext UNIQUE,
  nom                  text NOT NULL,
  prenoms              text NOT NULL,
  mot_de_passe_hash    text,                       -- argon2id ; NULL tant que non défini
  totp_secret_chiffre  bytea,                      -- AES-256-GCM (clé FIELD_ENCRYPTION_KEY)
  totp_actif           boolean NOT NULL DEFAULT false,
  codes_secours_hash   text[] NOT NULL DEFAULT '{}',
  echecs_connexion     integer NOT NULL DEFAULT 0,
  verrouille_jusqua    timestamptz,
  role_plateforme      text CHECK (role_plateforme IN ('super_admin','support')),
  langue               text NOT NULL DEFAULT 'fr',
  statut               text NOT NULL DEFAULT 'actif' CHECK (statut IN ('actif','desactive')),
  derniere_connexion   timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER users_updated BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION trg_set_updated_at();

CREATE TABLE otp_codes (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  telephone     text NOT NULL,
  but           text NOT NULL CHECK (but IN ('inscription','connexion','reinitialisation','confirmation_appareil')),
  code_hash     text NOT NULL,                     -- HMAC-SHA256(code, OTP_PEPPER)
  tentatives    smallint NOT NULL DEFAULT 0,
  expire_at     timestamptz NOT NULL,
  consomme_at   timestamptz,
  ip            inet,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX otp_codes_tel_idx ON otp_codes (telephone, created_at DESC);

CREATE TABLE appareils (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          uuid NOT NULL REFERENCES users(id),
  association_id   uuid NOT NULL REFERENCES associations(id),
  nom              text NOT NULL,
  plateforme       text NOT NULL CHECK (plateforme IN ('android','ios','web')),
  version_app      text NOT NULL,
  prefixe_recu     text NOT NULL CHECK (prefixe_recu ~ '^[A-Z][0-9]{2,3}$'),
  derniere_sync    timestamptz,
  dernier_curseur  bigint NOT NULL DEFAULT 0,
  empreinte_perimetre text,                         -- hash(rôle, permissions) : resync complète si changé
  revoque_at       timestamptz,
  revoque_par      uuid REFERENCES users(id),
  purge_demandee   boolean NOT NULL DEFAULT false,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (association_id, prefixe_recu)
);

CREATE TABLE sessions (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            uuid NOT NULL REFERENCES users(id),
  appareil_id        uuid REFERENCES appareils(id),
  refresh_hash       text NOT NULL UNIQUE,         -- SHA-256 du refresh token
  famille_id         uuid NOT NULL,                -- rotation : détection de réutilisation
  canal              text NOT NULL CHECK (canal IN ('console','mobile')),
  ip                 inet,
  user_agent         text,
  expire_at          timestamptz NOT NULL,
  revoque_at         timestamptz,
  remplace_par       uuid REFERENCES sessions(id),
  created_at         timestamptz NOT NULL DEFAULT now(),
  dernier_usage      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sessions_user_idx ON sessions (user_id) WHERE revoque_at IS NULL;

CREATE TABLE demandes_association (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  nom                text NOT NULL,
  village            text NOT NULL,
  region             text NOT NULL,
  recepisse_numero   text,
  demandeur_nom      text NOT NULL,
  demandeur_tel      text NOT NULL,
  demandeur_role     text NOT NULL,
  pieces             jsonb NOT NULL DEFAULT '[]',   -- [{cle, nom, mime}]
  statut             text NOT NULL DEFAULT 'en_attente'
                       CHECK (statut IN ('en_attente','validee','rejetee')),
  motif_rejet        text,
  traite_par         uuid REFERENCES users(id),
  traite_at          timestamptz,
  association_id     uuid REFERENCES associations(id),
  created_at         timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE acces_support (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  association_id        uuid NOT NULL REFERENCES associations(id),
  support_user_id       uuid NOT NULL REFERENCES users(id),
  mode                  text NOT NULL CHECK (mode IN ('lecture','impersonation')),
  motif                 text NOT NULL,
  ticket_id             uuid,
  consenti_par          uuid REFERENCES users(id),  -- administrateur de l'association
  consenti_at           timestamptz,
  debut                 timestamptz,
  fin                   timestamptz,
  statut                text NOT NULL DEFAULT 'demande'
                          CHECK (statut IN ('demande','accorde','refuse','expire','clos')),
  created_at            timestamptz NOT NULL DEFAULT now(),
  CHECK (fin IS NULL OR debut IS NULL OR fin <= debut + interval '24 hours')
);

CREATE TABLE consentements (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid REFERENCES users(id),
  membre_id       uuid,                              -- consentement recueilli pour un membre sans compte
  association_id  uuid REFERENCES associations(id),
  type            text NOT NULL CHECK (type IN ('cgu','traitement_donnees','communications_sms','communications_whatsapp','photo')),
  version_texte   text NOT NULL,
  accorde         boolean NOT NULL,
  recueilli_par   uuid REFERENCES users(id),
  canal           text NOT NULL CHECK (canal IN ('console','mobile','papier')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  CHECK (user_id IS NOT NULL OR membre_id IS NOT NULL)
);
CREATE TRIGGER consentements_append_only BEFORE UPDATE OR DELETE ON consentements
  FOR EACH ROW EXECUTE FUNCTION trg_append_only();

CREATE TABLE parametres_plateforme (
  cle         text PRIMARY KEY,
  valeur      jsonb NOT NULL,
  updated_by  uuid REFERENCES users(id),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE modeles_notification (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  association_id  uuid REFERENCES associations(id),  -- NULL = modèle global
  code            text NOT NULL,                     -- ex. recu_paiement, rappel_j_moins_7
  canal           text NOT NULL CHECK (canal IN ('sms','whatsapp','push','email')),
  langue          text NOT NULL DEFAULT 'fr',
  contenu         text NOT NULL,                     -- variables {{membre.prenoms}} etc.
  actif           boolean NOT NULL DEFAULT true,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE NULLS NOT DISTINCT (association_id, code, canal, langue)
);

CREATE TABLE tickets_support (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  association_id  uuid REFERENCES associations(id),
  auteur_id       uuid NOT NULL REFERENCES users(id),
  sujet           text NOT NULL,
  categorie       text NOT NULL DEFAULT 'autre'
                    CHECK (categorie IN ('connexion','synchronisation','paiement','sms','donnees','autre')),
  priorite        text NOT NULL DEFAULT 'normale' CHECK (priorite IN ('basse','normale','haute','urgente')),
  statut          text NOT NULL DEFAULT 'ouvert' CHECK (statut IN ('ouvert','en_cours','en_attente_client','resolu','ferme')),
  assigne_a       uuid REFERENCES users(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE messages_ticket (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id   uuid NOT NULL REFERENCES tickets_support(id),
  auteur_id   uuid NOT NULL REFERENCES users(id),
  contenu     text NOT NULL,
  interne     boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- =============================================================================
-- 2. TENANT — Accès, rôles, délégations
-- =============================================================================

CREATE TABLE roles (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  association_id  uuid NOT NULL REFERENCES associations(id),
  code            text NOT NULL,                     -- president, tresorier, secretaire, commissaire, membre, ou personnalisé
  libelle         text NOT NULL,
  permissions     text[] NOT NULL DEFAULT '{}',      -- voir 04-securite-autorisations.md §4
  systeme         boolean NOT NULL DEFAULT false,    -- rôle livré : code non modifiable, non supprimable
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (association_id, code)
);

CREATE TABLE acces_association (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  association_id  uuid NOT NULL REFERENCES associations(id),
  user_id         uuid NOT NULL REFERENCES users(id),
  role_id         uuid NOT NULL REFERENCES roles(id),
  membre_id       uuid,                              -- FK ajoutée après création de membres
  mandat_debut    date,
  mandat_fin      date,
  statut          text NOT NULL DEFAULT 'actif' CHECK (statut IN ('actif','revoque','expire')),
  revoque_at      timestamptz,
  revoque_par     uuid REFERENCES users(id),
  motif_revocation text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CHECK (mandat_fin IS NULL OR mandat_debut IS NULL OR mandat_fin >= mandat_debut)
);
CREATE UNIQUE INDEX acces_actif_unique ON acces_association (association_id, user_id) WHERE statut = 'actif';

CREATE TABLE delegations (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  association_id     uuid NOT NULL REFERENCES associations(id),
  delegant_id        uuid NOT NULL REFERENCES users(id),
  delegataire_id     uuid NOT NULL REFERENCES users(id),
  permission         text NOT NULL,                  -- ex. depense.valider
  debut              timestamptz NOT NULL,
  fin                timestamptz NOT NULL,
  motif              text,
  annulee_at         timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  CHECK (fin > debut AND fin <= debut + interval '90 days'),
  CHECK (delegant_id <> delegataire_id)
);

-- =============================================================================
-- 3. TENANT — Membres
-- =============================================================================

CREATE TABLE categories_membres (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  association_id  uuid NOT NULL REFERENCES associations(id),
  libelle         text NOT NULL,
  description     text,
  actif           boolean NOT NULL DEFAULT true,
  sync_version    bigint NOT NULL DEFAULT 0,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  deleted_at      timestamptz,
  UNIQUE (association_id, libelle)
);

CREATE TABLE familles (
  id                 uuid PRIMARY KEY,                -- généré par l'appareil ou l'API (UUIDv7)
  association_id     uuid NOT NULL REFERENCES associations(id),
  nom                text NOT NULL,
  chef_famille_id    uuid,                            -- FK membres, ajoutée plus bas
  village_origine    text,
  sync_version       bigint NOT NULL DEFAULT 0,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  deleted_at         timestamptz
);

CREATE TABLE membres (
  id                  uuid PRIMARY KEY,               -- UUIDv7 généré par l'appareil ou l'API
  association_id      uuid NOT NULL REFERENCES associations(id),
  numero              text NOT NULL,                  -- MBR-000123, attribué par le serveur
  nom                 text NOT NULL,
  prenoms             text NOT NULL,
  sexe                text CHECK (sexe IN ('F','M')),
  date_naissance      date,
  telephone           text CHECK (telephone IS NULL OR telephone ~ '^\+[1-9][0-9]{7,14}$'),
  telephone_whatsapp  boolean NOT NULL DEFAULT false,
  email               citext,
  village_origine     text,
  lieu_residence      text,
  pays_residence      char(2) NOT NULL DEFAULT 'CI',
  est_diaspora        boolean GENERATED ALWAYS AS (pays_residence <> 'CI') STORED,
  photo_cle           text,
  categorie_id        uuid REFERENCES categories_membres(id),
  famille_id          uuid REFERENCES familles(id),
  statut_adhesion     text NOT NULL DEFAULT 'actif'
                        CHECK (statut_adhesion IN ('actif','dormant','honoraire','bienfaiteur')),
  etat                text NOT NULL DEFAULT 'actif' CHECK (etat IN ('actif','suspendu','desactive')),
  motif_etat          text,
  date_adhesion       date NOT NULL DEFAULT current_date,
  user_id             uuid REFERENCES users(id),
  canal_prefere       text NOT NULL DEFAULT 'sms' CHECK (canal_prefere IN ('sms','whatsapp','push','aucun')),
  doublon_de          uuid REFERENCES membres(id),    -- RG-MBR-003 : fiche probablement identique
  doublon_statut      text CHECK (doublon_statut IN ('a_verifier','pas_doublon')),
  notes               text,
  sync_version        bigint NOT NULL DEFAULT 0,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  deleted_at          timestamptz,
  UNIQUE (association_id, numero)
);
CREATE INDEX membres_recherche_idx ON membres (association_id, nom, prenoms);
CREATE INDEX membres_tel_idx ON membres (association_id, telephone);
CREATE INDEX membres_famille_idx ON membres (famille_id);

ALTER TABLE familles ADD CONSTRAINT familles_chef_fk FOREIGN KEY (chef_famille_id) REFERENCES membres(id);
ALTER TABLE acces_association ADD CONSTRAINT acces_membre_fk FOREIGN KEY (membre_id) REFERENCES membres(id);
ALTER TABLE consentements ADD CONSTRAINT consentements_membre_fk FOREIGN KEY (membre_id) REFERENCES membres(id);

CREATE TABLE ayants_droit (
  id              uuid PRIMARY KEY,
  association_id  uuid NOT NULL REFERENCES associations(id),
  membre_id       uuid NOT NULL REFERENCES membres(id),
  nom             text NOT NULL,
  prenoms         text NOT NULL,
  lien            text NOT NULL CHECK (lien IN ('conjoint','enfant','parent','autre')),
  date_naissance  date,
  sync_version    bigint NOT NULL DEFAULT 0,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  deleted_at      timestamptz
);

-- =============================================================================
-- 4. TENANT — Exercices, trésorerie
-- =============================================================================

CREATE TABLE exercices (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  association_id  uuid NOT NULL REFERENCES associations(id),
  libelle         text NOT NULL,                     -- ex. « Exercice 2027 »
  date_debut      date NOT NULL,
  date_fin        date NOT NULL,
  statut          text NOT NULL DEFAULT 'ouvert' CHECK (statut IN ('ouvert','cloture')),
  cloture_at      timestamptz,
  cloture_par     uuid REFERENCES users(id),
  sync_version    bigint NOT NULL DEFAULT 0,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CHECK (date_fin > date_debut),
  EXCLUDE USING gist (association_id WITH =, daterange(date_debut, date_fin, '[]') WITH &&)
);

CREATE TABLE comptes_tresorerie (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  association_id       uuid NOT NULL REFERENCES associations(id),
  type                 text NOT NULL CHECK (type IN ('caisse','banque','mobile_money')),
  libelle              text NOT NULL,
  banque_ou_operateur  text,
  numero_compte        text,
  solde_initial        bigint NOT NULL DEFAULT 0,
  date_solde_initial   date NOT NULL DEFAULT current_date,
  actif                boolean NOT NULL DEFAULT true,
  sync_version         bigint NOT NULL DEFAULT 0,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (association_id, libelle)
);

CREATE TABLE projets (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  association_id        uuid NOT NULL REFERENCES associations(id),
  nom                   text NOT NULL,
  objectif              text,
  budget                bigint NOT NULL DEFAULT 0 CHECK (budget >= 0),
  responsable_membre_id uuid REFERENCES membres(id),
  date_debut            date,
  date_fin_prevue       date,
  statut                text NOT NULL DEFAULT 'planifie'
                          CHECK (statut IN ('planifie','en_cours','cloture','abandonne')),
  avancement_pct        smallint NOT NULL DEFAULT 0 CHECK (avancement_pct BETWEEN 0 AND 100),
  bilan                 text,
  cloture_at            timestamptz,
  sync_version          bigint NOT NULL DEFAULT 0,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  deleted_at            timestamptz
);

CREATE TABLE campagnes_cotisation (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  association_id    uuid NOT NULL REFERENCES associations(id),
  exercice_id       uuid NOT NULL REFERENCES exercices(id),
  libelle           text NOT NULL,
  type              text NOT NULL DEFAULT 'ordinaire' CHECK (type IN ('ordinaire','exceptionnelle')),
  motif             text CHECK (motif IN ('projet','deces','evenement','autre')),
  projet_id         uuid REFERENCES projets(id),
  montant           bigint NOT NULL CHECK (montant > 0),           -- montant par période
  periodicite       text NOT NULL CHECK (periodicite IN ('unique','mensuelle','trimestrielle','semestrielle','annuelle')),
  date_debut        date NOT NULL,
  date_fin          date NOT NULL,
  jour_echeance     smallint NOT NULL DEFAULT 5 CHECK (jour_echeance BETWEEN 1 AND 28),
  categories_cibles uuid[] NOT NULL DEFAULT '{}',                  -- vide = toutes catégories
  statut            text NOT NULL DEFAULT 'brouillon' CHECK (statut IN ('brouillon','active','cloturee')),
  activee_at        timestamptz,
  sync_version      bigint NOT NULL DEFAULT 0,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CHECK (date_fin >= date_debut),
  CHECK (type = 'ordinaire' OR motif IS NOT NULL)
);

CREATE TABLE echeances (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  association_id     uuid NOT NULL REFERENCES associations(id),
  campagne_id        uuid NOT NULL REFERENCES campagnes_cotisation(id),
  membre_id          uuid NOT NULL REFERENCES membres(id),
  numero_periode     smallint NOT NULL CHECK (numero_periode >= 1),
  libelle_periode    text NOT NULL,                  -- ex. « Mars 2027 »
  montant_du         bigint NOT NULL CHECK (montant_du >= 0),
  date_echeance      date NOT NULL,
  exoneree           boolean NOT NULL DEFAULT false,
  motif_exoneration  text,
  sync_version       bigint NOT NULL DEFAULT 0,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (campagne_id, membre_id, numero_periode),
  CHECK (NOT exoneree OR motif_exoneration IS NOT NULL)
);
CREATE INDEX echeances_membre_idx ON echeances (association_id, membre_id, date_echeance);

-- Paiements : AJOUT SEUL (D-004). Une annulation est une nouvelle ligne type = 'annulation'.
CREATE TABLE paiements (
  id                      uuid PRIMARY KEY,           -- UUIDv7 généré par l'appareil (clé d'idempotence)
  association_id          uuid NOT NULL REFERENCES associations(id),
  type                    text NOT NULL DEFAULT 'paiement' CHECK (type IN ('paiement','annulation')),
  annule_paiement_id      uuid UNIQUE REFERENCES paiements(id),
  numero_recu             text NOT NULL,               -- REC-2027-000145, attribué par le serveur
  numero_recu_provisoire  text,                        -- T02-000145, attribué par l'appareil
  membre_id               uuid REFERENCES membres(id),
  famille_id              uuid REFERENCES familles(id),
  campagne_id             uuid REFERENCES campagnes_cotisation(id), -- imputation ciblée (optionnelle)
  montant                 bigint NOT NULL CHECK (montant > 0),
  mode                    text NOT NULL CHECK (mode IN ('especes','mobile_money','virement','cheque')),
  operateur_mm            text CHECK (operateur_mm IN ('orange','mtn','moov','wave','autre')),
  reference_externe       text,
  compte_id               uuid NOT NULL REFERENCES comptes_tresorerie(id),
  date_paiement           timestamptz NOT NULL,        -- heure déclarée par l'appareil
  recu_serveur_at         timestamptz NOT NULL DEFAULT now(),
  motif                   text,                        -- obligatoire pour une annulation
  saisi_par               uuid NOT NULL REFERENCES users(id),
  appareil_id             uuid REFERENCES appareils(id),
  exercice_id             uuid NOT NULL REFERENCES exercices(id),
  sync_version            bigint NOT NULL DEFAULT 0,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),
  UNIQUE (association_id, numero_recu),
  CHECK ((membre_id IS NOT NULL) <> (famille_id IS NOT NULL) OR type = 'annulation'),
  CHECK (type = 'paiement' OR (annule_paiement_id IS NOT NULL AND motif IS NOT NULL)),
  CHECK (mode <> 'mobile_money' OR operateur_mm IS NOT NULL)
);
CREATE INDEX paiements_membre_idx ON paiements (association_id, membre_id, date_paiement DESC);
CREATE TRIGGER paiements_append_only BEFORE UPDATE OR DELETE ON paiements
  FOR EACH ROW EXECUTE FUNCTION trg_append_only();

-- Ventilation d'un paiement sur les échéances (calculée par le serveur, RG-COT-020).
CREATE TABLE imputations_paiement (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  association_id  uuid NOT NULL REFERENCES associations(id),
  paiement_id     uuid NOT NULL REFERENCES paiements(id),
  echeance_id     uuid REFERENCES echeances(id),      -- NULL = avance / crédit membre
  membre_id       uuid NOT NULL REFERENCES membres(id),
  montant         bigint NOT NULL,                    -- négatif pour la contre-imputation d'une annulation
  sync_version    bigint NOT NULL DEFAULT 0,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX imputations_echeance_idx ON imputations_paiement (echeance_id);
CREATE INDEX imputations_membre_idx ON imputations_paiement (association_id, membre_id);
CREATE TRIGGER imputations_append_only BEFORE UPDATE OR DELETE ON imputations_paiement
  FOR EACH ROW EXECUTE FUNCTION trg_append_only();

CREATE TABLE categories_depense (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  association_id  uuid NOT NULL REFERENCES associations(id),
  nature          text NOT NULL CHECK (nature IN ('fonctionnement','projet','aide_sociale','autre')),
  libelle         text NOT NULL,
  actif           boolean NOT NULL DEFAULT true,
  sync_version    bigint NOT NULL DEFAULT 0,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (association_id, libelle)
);

CREATE TABLE depenses (
  id                 uuid PRIMARY KEY,                -- UUIDv7 généré par l'appareil ou l'API
  association_id     uuid NOT NULL REFERENCES associations(id),
  numero             text NOT NULL,                   -- DEP-2027-000012, attribué par le serveur
  libelle            text NOT NULL,
  montant            bigint NOT NULL CHECK (montant > 0),
  date_depense       date NOT NULL,
  categorie_id       uuid NOT NULL REFERENCES categories_depense(id),
  beneficiaire       text NOT NULL,
  beneficiaire_membre_id uuid REFERENCES membres(id), -- aide sociale à un membre
  compte_id          uuid NOT NULL REFERENCES comptes_tresorerie(id),
  projet_id          uuid REFERENCES projets(id),
  exercice_id        uuid NOT NULL REFERENCES exercices(id),
  statut             text NOT NULL DEFAULT 'soumise'
                       CHECK (statut IN ('soumise','validee','rejetee','payee','annulee')),
  validations_requises smallint NOT NULL DEFAULT 1 CHECK (validations_requises IN (1,2)),
  demandeur_id       uuid NOT NULL REFERENCES users(id),
  appareil_id        uuid REFERENCES appareils(id),
  payee_at           timestamptz,
  payee_par          uuid REFERENCES users(id),
  motif_annulation   text,
  sync_version       bigint NOT NULL DEFAULT 0,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (association_id, numero)
);
CREATE INDEX depenses_statut_idx ON depenses (association_id, statut, created_at DESC);

-- Montant, compte, catégorie, demandeur figés après création (RG-DEP-010)
CREATE OR REPLACE FUNCTION trg_depense_immuable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.montant <> OLD.montant OR NEW.compte_id <> OLD.compte_id
     OR NEW.demandeur_id <> OLD.demandeur_id OR NEW.association_id <> OLD.association_id
     OR NEW.numero <> OLD.numero THEN
    RAISE EXCEPTION 'Champs figés d''une dépense modifiés' USING ERRCODE = 'P0001';
  END IF;
  IF OLD.statut IN ('payee','annulee','rejetee') AND NEW.statut <> OLD.statut THEN
    RAISE EXCEPTION 'Dépense % en statut final', OLD.numero USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER depenses_immuable BEFORE UPDATE ON depenses
  FOR EACH ROW EXECUTE FUNCTION trg_depense_immuable();
CREATE TRIGGER depenses_no_delete BEFORE DELETE ON depenses
  FOR EACH ROW EXECUTE FUNCTION trg_append_only();

CREATE TABLE validations_depense (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  association_id  uuid NOT NULL REFERENCES associations(id),
  depense_id      uuid NOT NULL REFERENCES depenses(id),
  valideur_id     uuid NOT NULL REFERENCES users(id),
  decision        text NOT NULL CHECK (decision IN ('approuvee','rejetee')),
  motif           text,
  delegation_id   uuid REFERENCES delegations(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (depense_id, valideur_id),
  CHECK (decision = 'approuvee' OR motif IS NOT NULL)
);
CREATE TRIGGER validations_append_only BEFORE UPDATE OR DELETE ON validations_depense
  FOR EACH ROW EXECUTE FUNCTION trg_append_only();

CREATE TABLE transferts (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  association_id    uuid NOT NULL REFERENCES associations(id),
  compte_source_id  uuid NOT NULL REFERENCES comptes_tresorerie(id),
  compte_dest_id    uuid NOT NULL REFERENCES comptes_tresorerie(id),
  montant           bigint NOT NULL CHECK (montant > 0),
  date_transfert    date NOT NULL,
  libelle           text NOT NULL,
  saisi_par         uuid NOT NULL REFERENCES users(id),
  created_at        timestamptz NOT NULL DEFAULT now(),
  CHECK (compte_source_id <> compte_dest_id)
);
CREATE TRIGGER transferts_append_only BEFORE UPDATE OR DELETE ON transferts
  FOR EACH ROW EXECUTE FUNCTION trg_append_only();

-- Journal de trésorerie (RF-046) : AJOUT SEUL, alimenté uniquement par TresorerieService.
CREATE TABLE mouvements (
  id              bigserial PRIMARY KEY,
  association_id  uuid NOT NULL REFERENCES associations(id),
  compte_id       uuid NOT NULL REFERENCES comptes_tresorerie(id),
  exercice_id     uuid NOT NULL REFERENCES exercices(id),
  sens            text NOT NULL CHECK (sens IN ('entree','sortie')),
  montant         bigint NOT NULL CHECK (montant > 0),
  date_operation  date NOT NULL,
  origine_type    text NOT NULL CHECK (origine_type IN ('paiement','annulation_paiement','depense','transfert','solde_initial','ajustement')),
  origine_id      uuid,
  libelle         text NOT NULL,
  projet_id       uuid REFERENCES projets(id),
  categorie_depense_id uuid REFERENCES categories_depense(id),
  created_by      uuid REFERENCES users(id),
  sync_version    bigint NOT NULL DEFAULT 0,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX mouvements_compte_idx ON mouvements (association_id, compte_id, date_operation);
CREATE INDEX mouvements_exercice_idx ON mouvements (association_id, exercice_id, date_operation);
CREATE TRIGGER mouvements_append_only BEFORE UPDATE OR DELETE ON mouvements
  FOR EACH ROW EXECUTE FUNCTION trg_append_only();

-- Numérotation séquentielle par tenant, type et année (RG-NUM-001)
CREATE TABLE compteurs (
  association_id  uuid NOT NULL REFERENCES associations(id),
  type            text NOT NULL CHECK (type IN ('membre','recu','depense')),
  annee           smallint NOT NULL,                 -- 0 pour les numéros non annuels (membres)
  valeur          bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (association_id, type, annee)
);

CREATE OR REPLACE FUNCTION app_prochain_numero(p_type text, p_annee smallint) RETURNS bigint
LANGUAGE plpgsql AS $$
DECLARE v bigint;
BEGIN
  INSERT INTO compteurs (association_id, type, annee, valeur)
  VALUES (app_association_id(), p_type, p_annee, 1)
  ON CONFLICT (association_id, type, annee)
  DO UPDATE SET valeur = compteurs.valeur + 1
  RETURNING valeur INTO v;
  RETURN v;
END $$;

-- =============================================================================
-- 5. TENANT — Réunions, documents, communication
-- =============================================================================

CREATE TABLE reunions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  association_id  uuid NOT NULL REFERENCES associations(id),
  type            text NOT NULL CHECK (type IN ('ag_ordinaire','ag_extraordinaire','bureau','autre')),
  titre           text NOT NULL,
  debut           timestamptz NOT NULL,
  lieu            text,
  ordre_du_jour   text,
  statut          text NOT NULL DEFAULT 'planifiee' CHECK (statut IN ('planifiee','tenue','annulee')),
  pv_document_id  uuid,
  sync_version    bigint NOT NULL DEFAULT 0,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  deleted_at      timestamptz
);

CREATE TABLE presences (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  association_id  uuid NOT NULL REFERENCES associations(id),
  reunion_id      uuid NOT NULL REFERENCES reunions(id),
  membre_id       uuid NOT NULL REFERENCES membres(id),
  statut          text NOT NULL CHECK (statut IN ('present','absent','excuse','represente')),
  convocation_recue_at timestamptz,
  sync_version    bigint NOT NULL DEFAULT 0,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (reunion_id, membre_id)
);

CREATE TABLE documents (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  association_id  uuid NOT NULL REFERENCES associations(id),
  categorie       text NOT NULL CHECK (categorie IN ('statuts','reglement_interieur','pv','rapport','justificatif','autre')),
  titre           text NOT NULL,
  exercice_id     uuid REFERENCES exercices(id),
  version         integer NOT NULL DEFAULT 1,
  document_parent_id uuid REFERENCES documents(id),  -- versions successives
  cle_stockage    text NOT NULL,
  mime            text NOT NULL,
  taille_octets   bigint NOT NULL,
  sha256          text NOT NULL,
  partage_membres boolean NOT NULL DEFAULT false,
  depose_par      uuid NOT NULL REFERENCES users(id),
  sync_version    bigint NOT NULL DEFAULT 0,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  deleted_at      timestamptz
);
ALTER TABLE reunions ADD CONSTRAINT reunions_pv_fk FOREIGN KEY (pv_document_id) REFERENCES documents(id);

-- Pièces jointes d'entités (justificatifs de dépense, photos de projet)
CREATE TABLE pieces_jointes (
  id              uuid PRIMARY KEY,                   -- généré par l'appareil
  association_id  uuid NOT NULL REFERENCES associations(id),
  entite_type     text NOT NULL CHECK (entite_type IN ('depense','projet','paiement','membre')),
  entite_id       uuid NOT NULL,
  cle_stockage    text NOT NULL,
  mime            text NOT NULL CHECK (mime IN ('image/jpeg','image/png','image/webp','application/pdf','audio/mp4','audio/aac')),
  taille_octets   bigint NOT NULL CHECK (taille_octets <= 10485760),
  sha256          text NOT NULL,
  statut_upload   text NOT NULL DEFAULT 'en_attente' CHECK (statut_upload IN ('en_attente','recu','rejete')),
  depose_par      uuid NOT NULL REFERENCES users(id),
  sync_version    bigint NOT NULL DEFAULT 0,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  deleted_at      timestamptz
);
CREATE INDEX pieces_entite_idx ON pieces_jointes (association_id, entite_type, entite_id);

CREATE TABLE annonces (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  association_id  uuid NOT NULL REFERENCES associations(id),
  titre           text NOT NULL,
  contenu         text NOT NULL,
  image_cle       text,
  canaux          text[] NOT NULL DEFAULT '{push}',
  cible           jsonb NOT NULL DEFAULT '{"tous": true}',  -- {tous} | {categories:[...]} | {membres:[...]}
  publiee_at      timestamptz,
  auteur_id       uuid NOT NULL REFERENCES users(id),
  sync_version    bigint NOT NULL DEFAULT 0,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  deleted_at      timestamptz
);

-- File de sortie des notifications (outbox). Le worker lit et met à jour le statut.
CREATE TABLE notifications (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  association_id      uuid NOT NULL REFERENCES associations(id),
  membre_id           uuid REFERENCES membres(id),
  user_id             uuid REFERENCES users(id),
  canal               text NOT NULL CHECK (canal IN ('sms','whatsapp','push','email')),
  modele_code         text NOT NULL,
  destinataire        text NOT NULL,                 -- téléphone E.164, jeton push ou email
  contenu             text NOT NULL,                 -- texte final rendu
  priorite            smallint NOT NULL DEFAULT 5,   -- 1 = OTP/reçu, 5 = rappel, 9 = annonce
  origine_type        text,
  origine_id          uuid,
  statut              text NOT NULL DEFAULT 'en_attente'
                        CHECK (statut IN ('en_attente','envoyee','remise','echec','annulee','hors_quota')),
  fournisseur         text,
  fournisseur_msg_id  text,
  tentatives          smallint NOT NULL DEFAULT 0,
  derniere_erreur     text,
  unites              smallint NOT NULL DEFAULT 1,   -- segments SMS facturés
  envoyee_at          timestamptz,
  remise_at           timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX notifications_statut_idx ON notifications (statut, priorite, created_at) WHERE statut = 'en_attente';
CREATE INDEX notifications_fournisseur_idx ON notifications (fournisseur, fournisseur_msg_id);
CREATE UNIQUE INDEX notifications_dedup_idx ON notifications (association_id, modele_code, origine_id, canal)
  WHERE origine_id IS NOT NULL;

CREATE TABLE consommation_sms (
  association_id  uuid NOT NULL REFERENCES associations(id),
  mois            date NOT NULL,                     -- premier jour du mois
  unites          integer NOT NULL DEFAULT 0,
  PRIMARY KEY (association_id, mois)
);

-- Tâches asynchrones visibles par l'utilisateur (exports, rapports PDF)
CREATE TABLE taches (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  association_id  uuid NOT NULL REFERENCES associations(id),
  type            text NOT NULL,                     -- export_membres, rapport_financier, …
  parametres      jsonb NOT NULL DEFAULT '{}',
  statut          text NOT NULL DEFAULT 'en_attente' CHECK (statut IN ('en_attente','en_cours','terminee','echec')),
  resultat_cle    text,
  erreur          text,
  demandee_par    uuid NOT NULL REFERENCES users(id),
  expire_at       timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

-- Rejets de synchronisation à renvoyer à l'appareil jusqu'à acquittement (05-synchronisation.md §6)
CREATE TABLE rejets_sync (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  association_id  uuid NOT NULL REFERENCES associations(id),
  appareil_id     uuid NOT NULL REFERENCES appareils(id),
  table_cible     text NOT NULL,
  element_id      uuid NOT NULL,
  code            text NOT NULL,
  message         text NOT NULL,
  empreinte       text NOT NULL,                     -- empreinte du contenu rejeté
  acquitte_at     timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (appareil_id, table_cible, element_id)
);

-- Idempotence des POST console (en-tête Idempotency-Key), purge après 7 jours
CREATE TABLE idempotence (
  association_id  uuid NOT NULL REFERENCES associations(id),
  cle             text NOT NULL,
  user_id         uuid NOT NULL REFERENCES users(id),
  empreinte_requete text NOT NULL,
  statut_http     smallint NOT NULL,
  reponse         jsonb NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (association_id, cle)
);

-- =============================================================================
-- 6. Journal d'audit immuable (RF-ADM-040..044, RNF-012)
-- =============================================================================

CREATE TABLE audit_log (
  id              bigserial PRIMARY KEY,
  association_id  uuid REFERENCES associations(id),  -- NULL = action plateforme
  acteur_id       uuid REFERENCES users(id),
  acteur_type     text NOT NULL CHECK (acteur_type IN ('utilisateur','systeme','support','impersonation')),
  acces_support_id uuid REFERENCES acces_support(id),
  action          text NOT NULL,                     -- ex. paiement.cree, depense.validee, membre.modifie
  entite_type     text NOT NULL,
  entite_id       text,
  avant           jsonb,
  apres           jsonb,
  ip              inet,
  appareil_id     uuid,
  request_id      text,
  created_at      timestamptz NOT NULL DEFAULT clock_timestamp(),
  hash_precedent  text NOT NULL,
  hash            text NOT NULL
);
CREATE INDEX audit_assoc_idx ON audit_log (association_id, created_at DESC);
CREATE INDEX audit_entite_idx ON audit_log (association_id, entite_type, entite_id);

CREATE OR REPLACE FUNCTION trg_audit_chainage() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE prev text;
BEGIN
  -- Sérialise la chaîne par tenant (ou plateforme)
  PERFORM pg_advisory_xact_lock(hashtextextended(coalesce(NEW.association_id::text, 'plateforme'), 42));
  SELECT a.hash INTO prev FROM audit_log a
   WHERE a.association_id IS NOT DISTINCT FROM NEW.association_id
   ORDER BY a.id DESC LIMIT 1;
  NEW.hash_precedent := coalesce(prev, repeat('0', 64));
  NEW.hash := encode(digest(
      NEW.hash_precedent || '|' || coalesce(NEW.association_id::text,'') || '|' ||
      coalesce(NEW.acteur_id::text,'') || '|' || NEW.action || '|' || NEW.entite_type || '|' ||
      coalesce(NEW.entite_id,'') || '|' || coalesce(NEW.avant::text,'') || '|' ||
      coalesce(NEW.apres::text,'') || '|' || NEW.created_at::text, 'sha256'), 'hex');
  RETURN NEW;
END $$;
CREATE TRIGGER audit_chainage BEFORE INSERT ON audit_log
  FOR EACH ROW EXECUTE FUNCTION trg_audit_chainage();
CREATE TRIGGER audit_append_only BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION trg_append_only();

-- =============================================================================
-- 7. Triggers de version de synchronisation (tables synchronisées)
-- =============================================================================
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'categories_membres','familles','membres','ayants_droit','exercices','comptes_tresorerie',
    'projets','campagnes_cotisation','echeances','paiements','imputations_paiement',
    'categories_depense','depenses','mouvements','reunions','presences','documents',
    'pieces_jointes','annonces']
  LOOP
    EXECUTE format('CREATE TRIGGER %I_sync BEFORE INSERT ON %I FOR EACH ROW EXECUTE FUNCTION trg_sync_version()', t, t);
    EXECUTE format('CREATE INDEX %I_sync_idx ON %I (association_id, sync_version)', t, t);
  END LOOP;
  -- Les tables append-only n'ont pas de trigger UPDATE de version
  FOREACH t IN ARRAY ARRAY[
    'categories_membres','familles','membres','ayants_droit','exercices','comptes_tresorerie',
    'projets','campagnes_cotisation','echeances','categories_depense','depenses',
    'reunions','presences','documents','pieces_jointes','annonces']
  LOOP
    EXECUTE format('CREATE TRIGGER %I_sync_upd BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION trg_sync_version()', t, t);
  END LOOP;
END $$;

-- updated_at automatique sur les tables mutables non synchronisées
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['roles','acces_association','tickets_support','notifications','taches']
  LOOP
    EXECUTE format('CREATE TRIGGER %I_updated BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION trg_set_updated_at()', t, t);
  END LOOP;
END $$;

-- =============================================================================
-- 8. Vues de calcul (soldes)
-- =============================================================================

-- Paiements effectifs = paiements non annulés
CREATE VIEW v_paiements_effectifs WITH (security_invoker = true) AS
SELECT p.* FROM paiements p
 WHERE p.type = 'paiement'
   AND NOT EXISTS (SELECT 1 FROM paiements a WHERE a.annule_paiement_id = p.id);

CREATE VIEW v_echeances_situation WITH (security_invoker = true) AS
SELECT e.id, e.association_id, e.campagne_id, e.membre_id, e.numero_periode, e.libelle_periode,
       e.date_echeance, e.exoneree,
       CASE WHEN e.exoneree THEN 0 ELSE e.montant_du END AS montant_du,
       coalesce(sum(i.montant), 0)::bigint AS montant_paye,
       CASE
         WHEN e.exoneree THEN 'exoneree'
         WHEN coalesce(sum(i.montant), 0) >= e.montant_du THEN 'payee'
         WHEN coalesce(sum(i.montant), 0) > 0 AND e.date_echeance >= current_date THEN 'partielle'
         WHEN e.date_echeance >= current_date THEN 'a_venir'
         ELSE 'en_retard'
       END AS situation
  FROM echeances e
  LEFT JOIN imputations_paiement i ON i.echeance_id = e.id
 GROUP BY e.id;

CREATE VIEW v_soldes_membres WITH (security_invoker = true) AS
SELECT m.id AS membre_id, m.association_id,
       coalesce((SELECT sum(s.montant_du) FROM v_echeances_situation s
                  WHERE s.membre_id = m.id AND s.date_echeance <= current_date), 0)::bigint AS total_exigible,
       coalesce((SELECT sum(i.montant) FROM imputations_paiement i WHERE i.membre_id = m.id), 0)::bigint AS total_paye
  FROM membres m
 WHERE m.deleted_at IS NULL;

CREATE VIEW v_soldes_comptes WITH (security_invoker = true) AS
SELECT c.id AS compte_id, c.association_id, c.libelle, c.type,
       c.solde_initial
       + coalesce(sum(CASE WHEN mv.sens = 'entree' THEN mv.montant ELSE -mv.montant END), 0)::bigint AS solde
  FROM comptes_tresorerie c
  LEFT JOIN mouvements mv ON mv.compte_id = c.id
 GROUP BY c.id;

-- =============================================================================
-- 9. Row-Level Security (D-005)
-- =============================================================================
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'roles','acces_association','delegations','categories_membres','familles','membres',
    'ayants_droit','exercices','comptes_tresorerie','projets','campagnes_cotisation','echeances',
    'paiements','imputations_paiement','categories_depense','depenses','validations_depense',
    'transferts','mouvements','compteurs','reunions','presences','documents','pieces_jointes',
    'annonces','notifications','consommation_sms','taches','idempotence','appareils','rejets_sync']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (association_id = app_association_id()) '
      'WITH CHECK (association_id = app_association_id())', t);
  END LOOP;
END $$;

-- associations : un tenant voit sa ligne ; la plateforme voit tout
ALTER TABLE associations ENABLE ROW LEVEL SECURITY;
ALTER TABLE associations FORCE ROW LEVEL SECURITY;
CREATE POLICY association_self ON associations
  USING (id = app_association_id() OR app_role_plateforme() IN ('super_admin','support'))
  WITH CHECK (id = app_association_id() OR app_role_plateforme() = 'super_admin');

-- audit : lecture par tenant, insertion libre pour le tenant courant ou la plateforme
ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log FORCE ROW LEVEL SECURITY;
CREATE POLICY audit_lecture ON audit_log FOR SELECT
  USING (association_id = app_association_id()
         OR (association_id IS NULL AND app_role_plateforme() = 'super_admin'));
CREATE POLICY audit_ecriture ON audit_log FOR INSERT
  WITH CHECK (association_id = app_association_id()
              OR (association_id IS NULL AND app_role_plateforme() IN ('super_admin','support')));

-- modèles : globaux lisibles par tous, spécifiques par leur tenant
ALTER TABLE modeles_notification ENABLE ROW LEVEL SECURITY;
ALTER TABLE modeles_notification FORCE ROW LEVEL SECURITY;
CREATE POLICY modeles_lecture ON modeles_notification FOR SELECT
  USING (association_id IS NULL OR association_id = app_association_id());
CREATE POLICY modeles_ecriture ON modeles_notification FOR ALL
  USING ((association_id IS NULL AND app_role_plateforme() = 'super_admin')
         OR association_id = app_association_id())
  WITH CHECK ((association_id IS NULL AND app_role_plateforme() = 'super_admin')
              OR association_id = app_association_id());

-- Statistiques plateforme sans lever la RLS pour l'application (RF-SUP-003)
CREATE OR REPLACE FUNCTION plateforme_statistiques()
RETURNS TABLE (associations_actives bigint, membres_actifs bigint, paiements_30j bigint, montant_30j bigint)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF app_role_plateforme() <> 'super_admin' THEN
    RAISE EXCEPTION 'réservé au super-administrateur' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
  SELECT (SELECT count(*) FROM associations WHERE statut = 'active'),
         (SELECT count(*) FROM membres WHERE etat = 'actif' AND deleted_at IS NULL),
         (SELECT count(*) FROM paiements WHERE type = 'paiement' AND recu_serveur_at > now() - interval '30 days'),
         (SELECT coalesce(sum(montant), 0)::bigint FROM paiements
           WHERE type = 'paiement' AND recu_serveur_at > now() - interval '30 days');
END $$;

-- =============================================================================
-- 10. Droits du rôle applicatif
-- =============================================================================
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'assoflow_app') THEN
    CREATE ROLE assoflow_app LOGIN NOBYPASSRLS;
  END IF;
END $$;

GRANT USAGE ON SCHEMA public TO assoflow_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO assoflow_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO assoflow_app;
-- Ajout seul, même pour l'application (défense en profondeur en plus des triggers)
REVOKE UPDATE, DELETE ON paiements, imputations_paiement, mouvements, validations_depense,
                         transferts, audit_log, consentements FROM assoflow_app;
REVOKE DELETE ON depenses FROM assoflow_app;
-- Le compteur de sync n'est modifiable que via app_next_sync_version() :
-- privilège UPDATE colonne par colonne (un REVOKE de colonne n'annule pas un GRANT de table)
REVOKE UPDATE ON associations FROM assoflow_app;
GRANT UPDATE (nom, sigle, type, village, sous_prefecture, region, date_creation, recepisse_numero,
              recepisse_date, prefecture_depot, telephone, email, logo_cle, mois_debut_exercice,
              seuil_double_validation, seuil_alerte_solde, jours_retard_dormant, journal_public_actif,
              langue_defaut, statut, plan, quota_sms_mensuel, updated_at)
  ON associations TO assoflow_app;
