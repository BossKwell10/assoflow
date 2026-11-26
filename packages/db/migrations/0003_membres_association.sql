-- =============================================================================
-- 0003 — Association, exercices, catégories, membres (sprint 2)
-- Expand uniquement : colonnes nullables, extensions, fonction et index.
-- =============================================================================

-- Recherche de membres (RF-025) insensible à la casse et aux accents.
-- unaccent et pg_trgm sont des extensions « trusted » (PostgreSQL ≥ 13) : installables par le propriétaire de la base.
CREATE EXTENSION IF NOT EXISTS unaccent;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- unaccent() n'est que STABLE (dictionnaire modifiable) : enveloppe IMMUTABLE à dictionnaire explicite,
-- utilisable dans un index d'expression.
CREATE OR REPLACE FUNCTION app_normaliser(p text) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE STRICT SET search_path = public AS $$
  SELECT lower(public.unaccent('public.unaccent'::regdictionary, p))
$$;

CREATE INDEX membres_recherche_trgm_idx ON membres
  USING gin (app_normaliser(nom || ' ' || prenoms) gin_trgm_ops);

-- RG-MBR-009 : anonymisation irréversible (date de l'opération ; NULL = fiche normale).
ALTER TABLE membres ADD COLUMN anonymise_at timestamptz;

-- Idempotence des créations à id client (docs/07 §5) : empreinte SHA-256 du corps de création.
-- Même id + même empreinte → rejeu (200) ; empreinte différente → 409 CONFLIT_IDEMPOTENCE.
ALTER TABLE membres ADD COLUMN empreinte_creation text;
ALTER TABLE familles ADD COLUMN empreinte_creation text;
ALTER TABLE ayants_droit ADD COLUMN empreinte_creation text;

-- RG-MBR-003 : recherche des doublons probables (même téléphone).
CREATE INDEX membres_doublons_idx ON membres (association_id, doublon_statut) WHERE doublon_statut IS NOT NULL;
CREATE INDEX ayants_droit_membre_idx ON ayants_droit (association_id, membre_id) WHERE deleted_at IS NULL;
