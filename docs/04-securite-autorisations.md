# 04 — Sécurité, authentification et autorisations

## 1. Identités et canaux

| Acteur | Canal | Authentification |
| --- | --- | --- |
| Membre | App mobile | Téléphone + OTP à l'enregistrement de l'appareil, puis mot de passe ; déverrouillage hors ligne par code PIN local |
| Bureau (président, trésorier, secrétaire, commissaire) | App mobile + console | Téléphone ou email + mot de passe ; **TOTP obligatoire** sur la console (RF-003) |
| Super-admin, support | Console, espace plateforme | Mot de passe + TOTP obligatoire, sous-domaine dédié |

Sur mobile, le second facteur exigé par RF-003 pour les administrateurs est l'**appareil enregistré** (confirmé
par OTP, lié aux jetons et révocable) ; un nouvel appareil repasse toujours par l'OTP.

Un `user` peut avoir des accès dans plusieurs associations ; il choisit l'association active après connexion
(sélecteur de contexte).

## 2. Parcours d'authentification

### 2.1 Création de compte (RF-001)

Les comptes ne sont pas créés librement : un accès naît d'une **invitation**.

1. Un administrateur ouvre l'accès d'un membre (rôle `membre`) ou nomme un membre du bureau (rôle du bureau).
   Le système crée le `user` s'il n'existe pas (clé = téléphone) et l'`acces_association`.
2. Un SMS d'invitation est envoyé : « Votre accès AssoFlow à <association> est prêt. Téléchargez l'app et connectez-vous avec ce numéro. »
3. À la première connexion : téléphone → OTP (6 chiffres, 5 min, 5 essais) → définition du mot de passe → acceptation
   des CGU et du traitement des données (`consentements`).

Une demande de création d'association (RF-SUP-013) suit un parcours public séparé, validé par le super-admin.

### 2.2 Connexion

- `POST /v1/auth/connexion` : identifiant (téléphone ou email) + mot de passe.
- Si TOTP requis (rôle du bureau sur la console, rôle plateforme) : réponse `200` avec `etape: "totp"` et un jeton
  intermédiaire (5 min) ; `POST /v1/auth/totp` termine la connexion.
- Mobile, nouvel appareil : OTP de confirmation d'appareil, puis enregistrement de l'appareil (préfixe de reçu attribué).
- Réinitialisation du mot de passe par OTP SMS (RF-004) : révoque toutes les sessions.

### 2.3 Verrouillage (RF-005)

- 5 échecs consécutifs → verrouillage 15 min ; chaque nouveau verrouillage dans les 24 h double la durée (max 24 h).
- Le message d'erreur ne révèle pas si l'identifiant existe (`IDENTIFIANTS_INVALIDES`).
- Un administrateur peut déverrouiller un compte de son association ; le super-admin tout compte (RF-SUP-011).

### 2.4 Politique de mot de passe (RF-SUP-053)

- 10 caractères minimum, refus des 10 000 mots de passe les plus courants et des suites de chiffres du téléphone.
- Hachage **argon2id** (m = 64 Mo, t = 3, p = 1).
- Pas d'expiration périodique ; changement forcé après réinitialisation par le support.

## 3. Jetons et sessions

| Élément | Console | Mobile |
| --- | --- | --- |
| Access token | JWT EdDSA, 10 min, en mémoire (jamais `localStorage`) | JWT EdDSA, 15 min |
| Refresh token | Cookie `HttpOnly; Secure; SameSite=Strict; Path=/v1/auth` | Stockage sécurisé (Keystore/Keychain) |
| Durée refresh | Inactivité 30 min (RF-006), absolue 12 h | Glissante 30 jours, liée à l'appareil |
| Rotation | À chaque usage ; réutilisation d'un ancien refresh → révocation de toute la famille | Idem |

Claims de l'access token : `sub` (user), `sid` (session), `aid` (association active, absente en espace plateforme),
`can` (`console` | `mobile`), `dev` (appareil), `imp` (identifiant `acces_support` si impersonation), `pf` (rôle plateforme).

**Les permissions ne sont pas dans le jeton.** Elles sont chargées à chaque requête depuis Redis
(clé `perm:<aid>:<sub>`, TTL 60 s), invalidées immédiatement à toute modification de rôle, d'accès ou de délégation.
C'est ce qui permet la révocation immédiate (RF-ADM-014) : un accès révoqué est refusé à la requête suivante,
et ses sessions sont révoquées.

## 4. Permissions (RF-ADM-012)

Format `<module>.<action>`. Une route déclare la permission requise par décorateur `@Permission('membre.creer')`.

| Permission | Président | Trésorier | Secrétaire | Commissaire | Membre |
| --- | :-: | :-: | :-: | :-: | :-: |
| `association.lire` | ✓ | ✓ | ✓ | ✓ | ✓ |
| `association.modifier` | ✓ | | | | |
| `exercice.gerer` / `exercice.cloturer` | ✓ | ✓ / | | | |
| `utilisateur.lire` | ✓ | ✓ | ✓ | ✓ | |
| `utilisateur.gerer` (accès, rôles, révocation) | ✓ | | | | |
| `role.gerer` | ✓ | | | | |
| `delegation.gerer` | ✓ | | | | |
| `membre.lire` | ✓ | ✓ | ✓ | ✓ | |
| `membre.creer` / `membre.modifier` | ✓ | ✓ | ✓ | | |
| `membre.importer` | ✓ | | ✓ | | |
| `membre.suspendre` | ✓ | | ✓ | | |
| `membre.anonymiser` | ✓ | | | | |
| `cotisation.lire` | ✓ | ✓ | ✓ | ✓ | |
| `cotisation.gerer` (campagnes, échéancier) | ✓ | ✓ | | | |
| `cotisation.exonerer` | ✓ | | | | |
| `paiement.enregistrer` | ✓ | ✓ | | | |
| `paiement.annuler` (ses paiements < 48 h) | ✓ | ✓ | | | |
| `paiement.annuler_tout` | ✓ | | | | |
| `depense.lire` | ✓ | ✓ | ✓ | ✓ | |
| `depense.creer` | ✓ | ✓ | | | |
| `depense.valider` | ✓ | | | | |
| `depense.payer` | | ✓ | | | |
| `depense.annuler` | ✓ | ✓ | | | |
| `tresorerie.lire` | ✓ | ✓ | | ✓ | |
| `tresorerie.transferer` | ✓ | ✓ | | | |
| `tresorerie.ajuster` | ✓ | | | | |
| `projet.lire` | ✓ | ✓ | ✓ | ✓ | ✓ |
| `projet.gerer` | ✓ | ✓ | ✓ | | |
| `reunion.gerer` | ✓ | | ✓ | | |
| `document.lire` | ✓ | ✓ | ✓ | ✓ | partagés |
| `document.gerer` | ✓ | | ✓ | | |
| `communication.annoncer` | ✓ | | ✓ | | |
| `communication.modeles` | ✓ | | ✓ | | |
| `rapport.lire` / `rapport.exporter` | ✓ | ✓ | ✓ | ✓ | |
| `audit.lire` / `audit.exporter` | ✓ | | | ✓ | |
| `support.consentir` | ✓ | | | | |
| `moi.situation` (profil, sa situation, ses paiements) | ✓ | ✓ | ✓ | ✓ | ✓ |
| `moi.journal` (journal public, annonces) | ✓ | ✓ | ✓ | ✓ | ✓ |

- Les rôles système sont modifiables en ajoutant des permissions, pas en retirant celles marquées ✓ au président
  (garde-fou contre le verrouillage de l'association).
- Rôles personnalisés (ex. « Trésorier adjoint ») : toute combinaison, sauf `utilisateur.gerer`, `role.gerer`
  et `association.modifier` réservées aux rôles système président.
- Permissions plateforme (`pf.*`) : `pf.associations.gerer`, `pf.demandes.traiter`, `pf.utilisateurs.gerer`,
  `pf.support.acceder`, `pf.parametres.gerer`, `pf.statistiques.lire`, `pf.audit.lire`.
  `super_admin` a tout ; `support` a `pf.support.acceder`, `pf.statistiques.lire` et la lecture des tickets.

## 5. Isolation multi-tenant — quatre barrières

1. **Jeton** : `aid` fixé à la sélection du contexte ; un `aid` sans accès actif est refusé.
2. **Guard** : charge l'accès actif (`acces_association.statut = 'actif'` et mandat en cours) ; sinon `403 ACCES_REVOQUE`.
3. **RLS PostgreSQL** : `SET LOCAL app.association_id` dans chaque transaction ; aucune ligne d'un autre tenant
   n'est lisible ni écrivable.
4. **Tests** : suite `isolation.spec.ts` dans la CI. Pour chaque endpoint de la spec OpenAPI, appel avec un jeton
   du tenant B sur une ressource du tenant A → `404` attendu (jamais `403`, pour ne pas révéler l'existence).

Toute ressource référencée dans un corps de requête (ex. `membreId`, `compteId`) est relue sous RLS ; si elle est
introuvable → `422 REFERENCE_INVALIDE`.

## 6. Support et impersonation (RF-SUP-022, RF-SUP-023, RF-SUP-052)

1. Le support crée une demande d'accès (motif, ticket, mode `lecture` ou `impersonation`, durée ≤ 24 h).
2. Le président (permission `support.consentir`) accepte ou refuse dans la console ; notification SMS.
3. Le jeton émis porte `imp` ; en mode `lecture`, toute méthode autre que `GET` est refusée par un guard global.
4. Chaque requête du support est tracée dans `audit_log` (`acteur_type = support` ou `impersonation`).
5. Un bandeau rouge permanent s'affiche dans la console de l'agent et l'association voit la liste des accès.

Exception : le super-admin peut ouvrir un accès **lecture** sans consentement pour un incident de sécurité ;
le président est notifié immédiatement et l'action est marquée dans l'audit.

## 7. Audit (RF-ADM-040 à 044)

Sont tracés, dans la transaction de l'opération :

- toutes les créations, modifications, annulations d'entités financières (paiement, dépense, validation, transfert, ajustement) ;
- membres : création, modification (champs modifiés), suspension, désactivation, anonymisation, import ;
- accès : connexion réussie et échouée (sans le mot de passe), verrouillage, attribution/révocation de rôle, délégation ;
- paramètres de l'association, campagnes, exercices ;
- exports de données (qui a exporté quoi) ;
- toutes les actions de la plateforme et du support.

Format de `action` : `<entite>.<verbe_passe>` (ex. `paiement.annule`, `acces.revoque`, `export.membres_genere`).

## 8. Protection des données

| Sujet | Mesure |
| --- | --- |
| Transit | TLS 1.2+ uniquement, HSTS, certificats Let's Encrypt via Traefik |
| Repos | Volumes chiffrés LUKS ; sauvegardes chiffrées (pgBackRest `repo-cipher-type=aes-256-cbc`) ; stockage objet chiffré côté serveur |
| Champs sensibles | `totp_secret_chiffre` en AES-256-GCM applicatif. Les autres données personnelles ne sont pas chiffrées en colonne au MVP (recherche nécessaire) |
| Logs | Téléphones masqués, aucun secret, aucun corps de requête de `/auth/*` |
| Fichiers | Upload par URL présignée (PUT, 10 min, 10 Mo max) ; type vérifié par *magic bytes* après réception ; images recompressées (WebP, 1600 px max) ; téléchargement par URL présignée de 5 min |
| Exports | Fichiers en S3 privés, URL présignée, suppression après 7 jours, action tracée |
| Consentement | Recueilli et versionné (`consentements`) ; consentement papier saisi par le bureau pour les membres sans smartphone |

## 9. Limites de débit (Traefik + Redis)

| Cible | Limite |
| --- | --- |
| Demande d'OTP | 3 par numéro / 15 min ; 10 par IP / heure |
| Vérification OTP | 5 essais par code |
| Connexion | 10 par IP / min ; verrouillage compte RG §2.3 |
| API authentifiée console | 300 requêtes / min par utilisateur |
| `/v1/sync/push` | 30 / min par appareil |
| SMS envoyés | quota mensuel par association (`quota_sms_mensuel`) + plafond quotidien = quota / 10 |

## 10. En-têtes et CORS

- CORS : uniquement `CONSOLE_ORIGIN`, `credentials: true` pour `/v1/auth/*`.
- Console servie avec CSP stricte (`default-src 'self'; connect-src 'self' https://api…; img-src 'self' blob: https://s3…`),
  `X-Frame-Options: DENY`, `Referrer-Policy: same-origin`.
- `/v1/auth/refresh` exige l'en-tête `X-Requested-With: assoflow-console` en plus du cookie `SameSite=Strict` (anti-CSRF).
