-- =============================================================================
-- 0007 — Synchronisation mobile : appareils, rejets, pièces jointes (sprint 5)
-- Expand uniquement : colonnes nullables, index.
-- =============================================================================

-- A32 (RF-SUP-033) : écritures locales en attente déclarées par l'appareil à chaque pull ; motif de révocation.
ALTER TABLE appareils ADD COLUMN elements_en_attente integer CHECK (elements_en_attente >= 0);
ALTER TABLE appareils ADD COLUMN revoque_motif text;
CREATE INDEX appareils_liste_idx ON appareils (association_id, derniere_sync DESC NULLS LAST);
CREATE INDEX appareils_user_idx ON appareils (association_id, user_id);

-- Rejets renvoyés à l'appareil jusqu'à acquittement (docs/05 §6) et listés dans la console.
CREATE INDEX rejets_sync_appareil_idx ON rejets_sync (association_id, appareil_id, created_at DESC)
  WHERE acquitte_at IS NULL;
CREATE INDEX rejets_sync_liste_idx ON rejets_sync (association_id, created_at DESC, id DESC);

-- Sessions liées à un appareil (révocation, docs/05 §8).
CREATE INDEX sessions_appareil_idx ON sessions (appareil_id) WHERE appareil_id IS NOT NULL AND revoque_at IS NULL;
