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

## 11. Précisions d'implémentation (sprint 1)

Décisions prises en implémentant E1/E2 ; elles complètent les sections ci-dessus sans les contredire,
sauf mention « écart ».

| Sujet | Implémentation |
| --- | --- |
| Activation TOTP obligatoire (§2.2) | Si le TOTP est exigé mais pas encore actif, `POST /auth/connexion` répond `etape: "totp_activation"` avec un jeton intermédiaire (5 min). Ce jeton sert de Bearer **uniquement** pour `/auth/totp/activation` et `/auth/totp/confirmation` ; la confirmation renvoie alors les codes de secours **et** la session (`openapi.yaml`, schémas `EtapeTotp` et réponse de confirmation). |
| TOTP exigé (RF-003) | Console : dès qu'un accès actif porte un rôle autre que `membre` (rôles personnalisés compris). Rôle plateforme : sur tous les canaux. Mobile (bureau) : pas de TOTP, le second facteur est l'appareil (sprint 5). Anti-rejeu : un pas de 30 s déjà accepté est refusé (`users.totp_dernier_pas`). Les échecs TOTP comptent dans les 5 échecs du verrouillage (§2.3). |
| Codes de secours | 10 codes `xxxxx-xxxxx`, HMAC-SHA256 poivré (`OTP_PEPPER`), usage unique, acceptés par `POST /auth/totp` à la place du code. |
| Contexte (§1) | À la connexion, l'association est choisie d'office si l'utilisateur n'a qu'un accès actif au mandat en cours ; sinon, `POST /auth/contexte`. L'association active est mémorisée sur la session (`sessions.association_id`) pour que le refresh réémette le même `aid`. |
| Consentements (RF-SUP-054) | Recueillis par `POST /auth/mot-de-passe` (`accepteCgu`, `accepteTraitementDonnees`, version `VERSION_CGU` de `@assoflow/contracts`) à la première définition ou à un changement de version. |
| Ordre des contrôles du guard | Jeton → accès au tenant (`403 ACCES_REVOQUE`) et permission (`403 PERMISSION_REFUSEE`) → session non révoquée (`401 SESSION_REVOQUEE`). Un accès révoqué reçoit donc un motif explicite à la requête suivante, même si ses sessions sont déjà révoquées. Routes `@HorsTenant()` (`/auth/moi`, `/auth/contexte`, `/auth/deconnexion`, TOTP) : pas de contrôle d'accès au tenant. |
| Révocation (RF-ADM-014) | Révoque les sessions (familles de refresh) de l'utilisateur **dans ce tenant** et invalide le cache `perm:<aid>:<sub>`. Garde-fou : le dernier président actif ne peut être ni rétrogradé ni révoqué (`422 PRESIDENT_REQUIS`). |
| Cache des permissions | `REDIS_URL` défini → Redis ; sinon cache mémoire (développement, tests, instance unique). Redis indisponible en lecture → relecture de la base (jamais d'autorisation par défaut) ; l'invalidation, elle, doit réussir. |
| Audit des événements d'authentification (§7) | Connexions réussies/échouées, verrouillages, définition de mot de passe, activation TOTP, réutilisation de refresh : chaîne **plateforme** (`association_id NULL`), car aucun tenant n'est encore choisi. Choix de contexte, accès, rôles, déverrouillage : chaîne du tenant. Téléphones masqués, aucun secret. |
| Limites de débit (§9) | L'API applique « 3 demandes d'OTP par numéro / 15 min » (`429`, `Retry-After`) et « 5 essais par code ». Les limites par IP restent à Traefik. |
| **Écart** — mots de passe courants (§2.4) | Sprint 1 : liste réduite (~70 entrées, `MOTS_DE_PASSE_COURANTS`). La liste des 10 000 mots de passe les plus courants sera chargée depuis un fichier au sprint 8 (durcissement). « Suite de chiffres du téléphone » = au moins 6 chiffres consécutifs du numéro E.164. |
| **Écart** — envoi des SMS | Fournisseur `journal` (logs, message masqué) ; envoi direct après commit, sans outbox. L'outbox et les vrais fournisseurs arrivent au sprint 4 (E6-01, E6-02). |
| Clés | `JWT_PRIVATE_KEY(_FILE)` / `JWT_PUBLIC_KEY(_FILE)` (PEM Ed25519), `FIELD_ENCRYPTION_KEY(_FILE)`, `OTP_PEPPER(_FILE)` : obligatoires en production ; en développement et en test, valeurs éphémères générées au démarrage avec un avertissement. |

## 12. Précisions d'implémentation (sprint 2)

| Sujet | Implémentation |
| --- | --- |
| Concurrence (07 §5) | `ETag` + champ `etag` sur `Association` et `Membre` ; `If-Match` obligatoire depuis la console (claim `can = console`, sinon `428 PRECONDITION_REQUISE`), facultatif depuis le mobile ; `412 PRECONDITION_ECHOUEE` si la version a changé. Mécanisme réutilisable : `avecEtag()` / `verifierIfMatch()` / `EtagInterceptor` (`apps/api/src/common/concurrence.ts`). |
| Fichiers multipart (§8, 07 §6) | Logo et photo : 2 Mo maximum, une seule partie `fichier`, type déterminé par *magic bytes* (PNG, JPEG, WebP), type MIME et extension déclarés ignorés ; refus `422 VALIDATION` (`TYPE_FICHIER_INVALIDE`, `FICHIER_TROP_GROS`). Clés `associations/<aid>/…` aléatoires ; ancien objet supprimé après le commit, nouvel objet supprimé si la transaction échoue. **Écart** : pas de recompression WebP 1600 px au sprint 2 (dépendance d'imagerie à ajouter au sprint 5 avec les pièces jointes). |
| Stockage objet | `StockageObjets` : S3 compatible (`S3_*`, chiffrement côté serveur, URL présignée 5 min) ; hors production sans S3 : disque local, fichiers servis par `GET /v1/fichiers?c=…&exp=…&sig=…` (HMAC, 5 min, clé éphémère). Production sans `S3_BUCKET`/`S3_ACCESS_KEY`/`S3_SECRET_KEY` : démarrage refusé. |
| Consentement (§8) | `POST /membres` exige `consentement` (`traitementDonnees: true`, canal `console` ou `papier`) : une ligne `consentements` (`traitement_donnees`, version `VERSION_CGU`, `recueilli_par` = auteur). |
| Accès app d'un membre | `POST /membres/{id}/acces-app` réutilise l'invitation (§2.1) avec le rôle système `membre` et lie la fiche (`acces_association.membre_id`, `membres.user_id`). |
| Audit des membres (§7) | `membre.cree` (valeurs saisies), `membre.modifie` (champs modifiés seulement, avant/après), `membre.suspendu`, `membre.desactive`, `membre.reactive`, `membre.anonymise` (numéro et motif, aucune donnée personnelle), `membre.photo_modifiee`, `membre.doublon_ecarte`, `membre.passe_dormant` ; familles, ayants droit, catégories, exercices et paramètres de l'association de même. Téléphones toujours masqués. |

## 13. Précisions d'implémentation (sprint 5)

| Sujet | Implémentation |
| --- | --- |
| Appareil, second facteur mobile (§1, RF-003) | Après la connexion mobile : OTP `confirmation_appareil` → `POST /auth/appareils` (jeton OTP à usage unique, même utilisateur, session mobile avec association active). L'appareil est créé dans l'association active (préfixe de reçu RG-NUM-003), la session lui est liée et un jeton d'accès portant `dev` est renvoyé ; le refresh conserve `dev`. `appareilId` permet de rattacher un appareil existant (réinstallation) sans nouveau préfixe. Un appareil appartient à une association : changer de contexte impose d'enregistrer l'appareil dans l'autre association. |
| **Écart** — second facteur | Les routes de la console et de l'API restent accessibles avec un jeton mobile sans `dev` (comportement des sprints 1 à 4) ; seules `/sync/*` l'exigent (`403 PERMISSION_REFUSEE`). Imposer l'appareil à toutes les écritures mobiles du bureau est à décider avant le pilote. |
| Révocation d'appareil (§3, RF-ADM-014) | `POST /appareils/{id}/revoquer` révoque l'appareil et ses sessions ; le guard vérifie l'appareil de la claim `dev` à chaque requête (`401 APPAREIL_REVOQUE`, `erreurs[0].code = PURGE_DEMANDEE` si purge). Un refresh d'une session révoquée reçoit `401 SESSION_REVOQUEE` (sans indication de purge). |
| Pièces jointes (§8) | Fichier envoyé directement au stockage par `PUT` présigné (10 min, type et chiffrement signés) ; le serveur vérifie taille, SHA-256 et type réel (octets de signature) à la confirmation. Hors production, `PUT /v1/fichiers` signé HMAC remplace l'URL présignée. **Écart** : pas de recompression côté serveur (l'app compresse, docs/05 §7). |
| Limites de débit (§9) | `/v1/sync/push` 30/min par appareil : à configurer dans Traefik (non appliqué par l'API au sprint 5). Taille de lot plafonnée à 500 éléments par l'API. |

