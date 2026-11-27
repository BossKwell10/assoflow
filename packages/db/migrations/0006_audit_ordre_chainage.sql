-- =============================================================================
-- 0006 — Audit : l'ordre des identifiants suit l'ordre de chaînage (sprint 4)
-- =============================================================================
-- L'id (bigserial) était attribué par le DEFAULT avant le trigger, donc avant le verrou de chaînage : deux insertions
-- simultanées dans une même chaîne pouvaient se chaîner dans l'ordre inverse de leurs id, et la vérification
-- « ORDER BY id » (job audit.verifier_chaine, docs/06 §3) signalait une rupture. Plus probable avec l'encaissement
-- simultané de paiements dans un même tenant. L'id est désormais tiré après la prise du verrou : ordre des id =
-- ordre de la chaîne (les valeurs consommées par le DEFAULT laissent des trous, sans conséquence).
CREATE OR REPLACE FUNCTION trg_audit_chainage() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE prev text;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(coalesce(NEW.association_id::text, 'plateforme'), 42));
  NEW.id := nextval(pg_get_serial_sequence('public.audit_log', 'id'));
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
