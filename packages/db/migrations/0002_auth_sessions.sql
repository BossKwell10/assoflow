-- =============================================================================
-- 0002 — Authentification, sessions, audit des événements d'authentification (sprint 1)
-- Expand uniquement : colonnes nullables ou avec défaut, nouvelles fonctions et politiques.
-- =============================================================================

-- Association active de la session : le refresh réémet un access token portant le même `aid`,
-- et la révocation d'un accès révoque les sessions de ce tenant uniquement (RF-ADM-014).
ALTER TABLE sessions ADD COLUMN association_id uuid REFERENCES associations(id);
CREATE INDEX sessions_user_assoc_idx ON sessions (user_id, association_id) WHERE revoque_at IS NULL;
CREATE INDEX sessions_famille_idx ON sessions (famille_id);

-- Usage unique du jeton remis après vérification d'un OTP (définition du mot de passe).
ALTER TABLE otp_codes ADD COLUMN jeton_utilise_at timestamptz;

-- Verrouillage progressif (RF-005, docs/04 §2.3) : 15 min, doublé à chaque verrouillage dans les 24 h, max 24 h.
ALTER TABLE users ADD COLUMN verrouillages_recents smallint NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN dernier_verrouillage timestamptz;
-- Anti-rejeu TOTP (RFC 6238 §5.2) : dernier pas de temps accepté.
ALTER TABLE users ADD COLUMN totp_dernier_pas bigint;

-- -----------------------------------------------------------------------------
-- Audit : chaînage hors RLS et événements d'authentification hors tenant
-- -----------------------------------------------------------------------------

-- Le trigger de chaînage lit le dernier hash de la chaîne : sous RLS, un utilisateur sans rôle
-- plateforme ne voit pas la chaîne « plateforme » (association_id NULL) et la casserait.
-- SECURITY DEFINER (comme plateforme_statistiques) : le propriétaire contourne la RLS.
CREATE OR REPLACE FUNCTION trg_audit_chainage() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE prev text;
BEGIN
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

-- Connexions (réussies, échouées), verrouillages, mot de passe, TOTP : avant tout choix de tenant,
-- ces événements vont dans la chaîne plateforme (docs/04 §7). Insertion seule, jamais de lecture.
CREATE POLICY audit_ecriture_auth ON audit_log FOR INSERT
  WITH CHECK (association_id IS NULL AND acteur_type = 'utilisateur'
              AND entite_type IN ('utilisateur', 'session'));

-- -----------------------------------------------------------------------------
-- Accès de l'utilisateur courant, tous tenants confondus (/auth/moi, /auth/contexte, connexion)
-- -----------------------------------------------------------------------------
-- Ne renvoie QUE les accès de app_user_id() ; aucune donnée d'un autre utilisateur.
CREATE OR REPLACE FUNCTION app_mes_acces()
RETURNS TABLE (acces_id uuid, association_id uuid, association_nom text, association_statut text,
               role_code text, role_libelle text, permissions text[], en_cours boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT a.id, a.association_id, s.nom, s.statut, r.code, r.libelle,
         ARRAY(SELECT DISTINCT p FROM unnest(r.permissions || coalesce((
                 SELECT array_agg(d.permission) FROM delegations d
                  WHERE d.association_id = a.association_id AND d.delegataire_id = a.user_id
                    AND d.annulee_at IS NULL AND d.debut <= now() AND d.fin > now()), '{}')) AS p
               ORDER BY p),
         (a.mandat_debut IS NULL OR a.mandat_debut <= current_date)
           AND (a.mandat_fin IS NULL OR a.mandat_fin >= current_date)
    FROM acces_association a
    JOIN associations s ON s.id = a.association_id
    JOIN roles r ON r.id = a.role_id
   WHERE a.user_id = app_user_id()
     AND a.statut = 'actif'
     AND s.statut <> 'archivee'
   ORDER BY s.nom
$$;
REVOKE ALL ON FUNCTION app_mes_acces() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_mes_acces() TO assoflow_app;
