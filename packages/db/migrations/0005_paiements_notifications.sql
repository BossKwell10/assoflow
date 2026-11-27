-- =============================================================================
-- 0005 — Paiements, reçus, notifications SMS (sprint 4)
-- Expand : colonnes nullables ou à défaut, index, fonctions. Seul l'index de dédoublonnage des notifications est
-- remplacé (clé explicite `cle_dedup`, pour permettre le renvoi d'un reçu et les rappels quotidiens).
-- =============================================================================

-- Idempotence des paiements créés avec l'id du client (docs/07 §5) : empreinte SHA-256 du corps de création.
ALTER TABLE paiements ADD COLUMN empreinte_creation text;

-- Liste des paiements (écran A11) : plus récents d'abord ; paiements groupés d'une famille ; annulation d'un paiement.
CREATE INDEX paiements_liste_idx ON paiements (association_id, recu_serveur_at DESC, id DESC);
CREATE INDEX paiements_famille_idx ON paiements (association_id, famille_id) WHERE famille_id IS NOT NULL;
CREATE INDEX imputations_paiement_idx ON imputations_paiement (paiement_id);
CREATE INDEX mouvements_origine_idx ON mouvements (association_id, origine_type, origine_id);

-- -----------------------------------------------------------------------------
-- Outbox des notifications (docs/06 §1)
-- -----------------------------------------------------------------------------
-- Clé de dédoublonnage explicite : `recu:<paiement>`, `rappel:<membre>:<jour>`, `convocation:<reunion>:<membre>`…
-- Un renvoi de reçu porte une clé nulle (nouvel envoi volontaire).
ALTER TABLE notifications ADD COLUMN cle_dedup text;
DROP INDEX IF EXISTS notifications_dedup_idx;
CREATE UNIQUE INDEX notifications_cle_dedup_idx ON notifications (association_id, cle_dedup)
  WHERE cle_dedup IS NOT NULL;
-- RF-060 : message envoyé au chef de famille d'un membre sans téléphone.
ALTER TABLE notifications ADD COLUMN relais_famille boolean NOT NULL DEFAULT false;
-- Réservation par un worker (un seul envoi simultané par notification ; reprise après 5 min si le worker meurt).
ALTER TABLE notifications ADD COLUMN traitement_at timestamptz;
CREATE INDEX notifications_historique_idx ON notifications (association_id, created_at DESC, id DESC);
CREATE INDEX notifications_origine_idx ON notifications (association_id, origine_type, origine_id);
CREATE INDEX notifications_membre_idx ON notifications (association_id, membre_id, created_at DESC);

-- Quotas (RF-SUP-031) : alerte au président une seule fois par seuil et par mois.
ALTER TABLE consommation_sms ADD COLUMN alerte_80_at timestamptz;
ALTER TABLE consommation_sms ADD COLUMN alerte_100_at timestamptz;

-- -----------------------------------------------------------------------------
-- Accusés de remise (webhook public, hors tenant)
-- -----------------------------------------------------------------------------
-- Le webhook ne connaît que l'identifiant du fournisseur : la fonction met à jour la seule notification
-- correspondante sans exposer d'autre donnée (même principe que plateforme_statistiques).
CREATE OR REPLACE FUNCTION app_accuse_sms(p_fournisseur text, p_msg_id text, p_statut text, p_at timestamptz)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE n integer;
BEGIN
  IF p_statut NOT IN ('remise', 'echec') THEN
    RAISE EXCEPTION 'statut d''accusé invalide : %', p_statut USING ERRCODE = '22023';
  END IF;
  UPDATE notifications
     SET statut = p_statut,
         remise_at = CASE WHEN p_statut = 'remise' THEN coalesce(p_at, now()) ELSE remise_at END,
         derniere_erreur = CASE WHEN p_statut = 'echec' THEN 'Non remis au destinataire (accusé du fournisseur)'
                                ELSE derniere_erreur END
   WHERE fournisseur = p_fournisseur AND fournisseur_msg_id = p_msg_id
     AND statut IN ('envoyee', 'remise', 'echec');
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;
REVOKE ALL ON FUNCTION app_accuse_sms(text, text, text, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_accuse_sms(text, text, text, timestamptz) TO assoflow_app;

-- Disjoncteur (docs/06 §4.1) : taux de remise d'un fournisseur sur la dernière heure, tous tenants confondus.
-- Les envois des 2 dernières minutes sont exclus (accusé pas encore reçu). Agrégats uniquement.
CREATE OR REPLACE FUNCTION app_remise_fournisseur_sms(p_fournisseur text)
RETURNS TABLE (envoyes bigint, remis bigint)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT count(*) FILTER (WHERE statut IN ('envoyee', 'remise', 'echec')),
         count(*) FILTER (WHERE statut = 'remise')
    FROM notifications
   WHERE fournisseur = p_fournisseur
     AND envoyee_at > now() - interval '1 hour'
     AND envoyee_at < now() - interval '2 minutes'
$$;
REVOKE ALL ON FUNCTION app_remise_fournisseur_sms(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_remise_fournisseur_sms(text) TO assoflow_app;
