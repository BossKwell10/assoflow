-- =============================================================================
-- 0004 — Import de membres, tâches asynchrones, campagnes et échéancier (sprint 3)
-- Expand uniquement : colonnes nullables ou à défaut, index.
-- =============================================================================

-- Tâches asynchrones (docs/06 §7) : avancement et résultat structuré (rapport d'import, résumé).
-- Les clés commençant par « _ » dans `resultat` sont internes (jamais exposées par l'API).
ALTER TABLE taches ADD COLUMN progression smallint NOT NULL DEFAULT 0 CHECK (progression BETWEEN 0 AND 100);
ALTER TABLE taches ADD COLUMN resultat jsonb;
ALTER TABLE taches ADD COLUMN termine_at timestamptz;
CREATE INDEX taches_demandeur_idx ON taches (association_id, demandee_par, created_at DESC);

-- Échéancier (RF-031) : lecture par campagne et par date ; situation calculée par v_echeances_situation.
CREATE INDEX echeances_campagne_idx ON echeances (association_id, campagne_id, numero_periode);
CREATE INDEX echeances_date_idx ON echeances (association_id, date_echeance, id);
CREATE INDEX campagnes_exercice_idx ON campagnes_cotisation (association_id, exercice_id, statut);

-- Avances (RG-COT-022) : imputations sans échéance, lues par membre.
CREATE INDEX imputations_avances_idx ON imputations_paiement (association_id, membre_id, paiement_id)
  WHERE echeance_id IS NULL;
