# 07 — Contrat d'API

Le contrat de référence est [`openapi.yaml`](openapi.yaml) (OpenAPI 3.1, 185 opérations, validé avec
`openapi-spec-validator`). Le client TypeScript de la console est **généré** à partir de ce fichier (orval) ;
le backend vérifie en CI que ses routes correspondent au contrat (test de conformité, voir 09). Toute modification
d'API commence par une modification de `openapi.yaml` dans la même merge request.

## 1. Conventions générales

| Sujet | Règle |
| --- | --- |
| Base | `https://api.assoflow.ci/v1` ; version majeure dans le chemin. Changement incompatible = `/v2` |
| Format | JSON UTF-8, champs en `camelCase`, `null` explicite pour une valeur absente |
| Identifiants | UUID (v7 pour les entités créées hors ligne, fournis par le client) |
| Montants | Entiers en FCFA (`25000`), jamais de chaîne ni de décimale |
| Dates | `date` = `AAAA-MM-JJ` ; `date-time` = ISO 8601 UTC (`2027-03-05T09:14:00Z`). Exception : la sync utilise des millisecondes epoch (convention WatermelonDB) |
| Tenant | Jamais dans l'URL : il vient de la claim `aid` du jeton (`POST /auth/contexte`) |
| Espace plateforme | Préfixe `/plateforme/*`, jeton sans `aid` avec claim `pf` |
| Langue | `Accept-Language: fr` (défaut). Les messages d'erreur sont en français ; les `code` sont stables et en majuscules |

## 2. Méthodes et statuts

| Cas | Méthode | Statut |
| --- | --- | --- |
| Lecture | `GET` | `200` |
| Création | `POST` | `201` + ressource ; `200` si rejouée avec le même id (idempotence) |
| Modification partielle | `PATCH` (champs envoyés seulement) | `200` |
| Remplacement | `PUT` | `200` ou `204` |
| Action métier | `POST /ressource/{id}/<verbe>` (`activer`, `annuler`, `payer`, `decision`) | `200` ou `201` si une écriture est créée |
| Traitement long | `POST` | `202` + `Tache` |
| Suppression | `DELETE` (rare : seulement données non financières) | `204` |

Les écritures financières n'ont **ni `PUT`, ni `DELETE`** ; une annulation est une action qui crée une contre-écriture.

## 3. Pagination, filtres, tri

- Pagination par curseur : `?limite=50&curseur=<opaque>` → `{ "donnees": [...], "page": { "curseurSuivant": "...", "total": 1234 } }`.
  `total` n'est calculé que si `?total=true` (coûteux).
- Filtres : paramètres nommés (`?statut=soumise&du=2027-01-01&au=2027-03-31`). Recherche texte : `q`.
- Tri : `?tri=nom` ou `?tri=-dateAdhesion` (préfixe `-` = décroissant), liste blanche par endpoint.

## 4. Erreurs

Format *Problem Details* (RFC 9457), `Content-Type: application/problem+json` :

```json
{
  "type": "https://docs.assoflow.ci/erreurs/SOLDE_INSUFFISANT",
  "title": "Solde insuffisant",
  "status": 422,
  "code": "SOLDE_INSUFFISANT",
  "detail": "Le solde de « Caisse » (45 000 FCFA) ne couvre pas la dépense DEP-2027-000012 (150 000 FCFA).",
  "requestId": "01JD…",
  "erreurs": []
}
```

| Statut | Code | Quand |
| --- | --- | --- |
| 400 | `REQUETE_MALFORMEE` | JSON illisible |
| 401 | `NON_AUTHENTIFIE`, `JETON_EXPIRE`, `SESSION_REVOQUEE`, `APPAREIL_REVOQUE` | Authentification |
| 401 | `IDENTIFIANTS_INVALIDES`, `OTP_INVALIDE`, `OTP_EXPIRE`, `TOTP_INVALIDE` | Connexion |
| 403 | `PERMISSION_REFUSEE`, `ACCES_REVOQUE`, `LECTURE_SEULE_SUPPORT` | Autorisation |
| 404 | `INTROUVABLE` | Ressource absente ou d'un autre tenant |
| 409 | `CONFLIT_IDEMPOTENCE`, `ETAT_INCOMPATIBLE` | Même id/clé avec contenu différent ; transition de statut impossible |
| 412 | `PRECONDITION_ECHOUEE` | `If-Match` ne correspond plus à la version courante (§5) |
| 422 | `VALIDATION` | Champs invalides (détail dans `erreurs[]`) |
| 422 | `REFERENCE_INVALIDE`, `EXERCICE_FERME`, `SOLDE_INSUFFISANT`, `MONTANT_INVALIDE`, `CONFIRMATION_REQUISE`, `JUSTIFICATIF_REQUIS`, `AUTO_VALIDATION_INTERDITE`, `VALIDEUR_DEJA_DECIDE`, `PRESIDENT_REQUIS`, `ECHEANCE_DEJA_IMPUTEE`, `DEPENSES_EN_COURS`, `MOT_DE_PASSE_FAIBLE` | Règles de gestion (voir 03) |
| 423 | `COMPTE_VERROUILLE`, `TENANT_SUSPENDU` | Verrouillages |
| 426 | `APP_OBSOLETE`, `SCHEMA_OBSOLETE` | Versions mobiles |
| 428 | `PRECONDITION_REQUISE` | `If-Match` absent sur un `PATCH` concurrentiel depuis la console (§5) |
| 429 | `TROP_DE_REQUETES` | Limites de débit (en-tête `Retry-After`) |
| 500 | `ERREUR_INTERNE` | Inattendu (jamais de pile d'appel dans la réponse) |

La console affiche `detail` à l'utilisateur ; elle mappe `erreurs[].champ` sur les champs du formulaire.

## 5. Idempotence et concurrence

- Créations d'entités hors ligne : l'`id` fourni par le client est la clé d'idempotence.
- Autres `POST` sensibles (invitations, transferts, ajustements, création de tenant) : en-tête `Idempotency-Key`
  (UUID). Même clé + même corps → même réponse pendant 7 jours ; corps différent → `409 CONFLIT_IDEMPOTENCE`.
- Concurrence sur les entités modifiables (`membres`, `campagnes`, `depenses` soumises…) : `ETag` sur le `GET`
  (dérivé de `sync_version`), `If-Match` **obligatoire** sur `PATCH` depuis la console → `412` si la ressource a changé.
  Valeur opaque, aussi exposée dans le champ `etag` du corps (le client généré ne lit pas les en-têtes) ; `If-Match: *`
  accepté. `If-Match` absent depuis la console (claim `can = console`) → `428 PRECONDITION_REQUISE` ; depuis le mobile,
  facultatif (la synchronisation gère ses propres conflits, 05). Sprint 2 : `PATCH /association` (ETag = empreinte du
  contenu : `associations.updated_at` change à chaque écriture du tenant via `sync_counter`) et `PATCH /membres/{id}`
  (ETag = `sync_version`).
- Créations à `id` client (`membres`, `familles`, `ayants droit`) : l'empreinte du corps de création est conservée
  (`empreinte_creation`) ; rejeu avec le même id et le même corps → `200` et l'état **actuel** de la ressource, même si
  elle a été modifiée depuis ; corps différent → `409 CONFLIT_IDEMPOTENCE`. Un id déjà pris par un autre tenant donne
  aussi `409` (sans révéler l'existence).

## 6. Fichiers

- Pas d'upload de fichiers lourds via l'API : URL présignée S3 (`/pieces-jointes/{id}/url-upload`, `/documents`).
- Exceptions multipart (petits fichiers, < 2 Mo) : logo, photo de membre, fichier d'import.
- Téléchargements : URL présignée de 5 minutes ; PDF unitaires (reçu, carte) servis directement.

## 7. Sécurité transverse

- `Authorization: Bearer <accessToken>` sur toutes les routes sauf celles marquées « public ».
- Chaque réponse porte `X-Request-Id` (généré ou repris de la requête) ; il figure dans les logs et l'audit.
- Les réponses de l'espace support en mode lecture refusent toute méthode autre que `GET`.

## 8. Catalogue des endpoints

Généré depuis `openapi.yaml` ; la colonne « Exigences » renvoie au cahier des charges CI.

### Authentification

| Méthode | Chemin | Permission | Objet | Exigences |
| --- | --- | --- | --- | --- |
| `POST` | `/v1/auth/otp/demander` | public | Demander un code OTP par SMS | RF-001, RF-004 |
| `POST` | `/v1/auth/otp/verifier` | public | Vérifier un code OTP | RF-001 |
| `POST` | `/v1/auth/mot-de-passe` | public | Définir ou réinitialiser le mot de passe (après OTP) | RF-004, RF-SUP-053 |
| `POST` | `/v1/auth/connexion` | public | Se connecter | RF-002, RF-003, RF-005 |
| `POST` | `/v1/auth/totp` | public | Second facteur TOTP | RF-003 |
| `POST` | `/v1/auth/totp/activation` | authentifié | Démarrer l'activation TOTP | RF-003 |
| `POST` | `/v1/auth/totp/confirmation` | authentifié | Confirmer TOTP et obtenir les codes de secours | RF-003 |
| `POST` | `/v1/auth/refresh` | public | Renouveler l'access token |  |
| `POST` | `/v1/auth/deconnexion` | authentifié | Se déconnecter (révoque la session) |  |
| `GET` | `/v1/auth/moi` | authentifié | Profil et accès de l'utilisateur connecté |  |
| `POST` | `/v1/auth/contexte` | authentifié | Choisir l'association active |  |
| `POST` | `/v1/auth/appareils` | authentifié | Enregistrer un appareil mobile | RNF-001 |

### Association

| Méthode | Chemin | Permission | Objet | Exigences |
| --- | --- | --- | --- | --- |
| `GET` | `/v1/association` | `association.lire` | Profil de l'association active | RF-010, RF-011 |
| `PATCH` | `/v1/association` | `association.modifier` | Modifier le profil et les paramètres | RF-ADM-020, RF-ADM-024 |
| `PUT` | `/v1/association/logo` | `association.modifier` | Remplacer le logo (multipart) |  |
| `GET` | `/v1/exercices` | `association.lire` | Lister les exercices | RF-012, RF-014 |
| `POST` | `/v1/exercices` | `exercice.gerer` | Créer un exercice | RF-ADM-022 |
| `POST` | `/v1/exercices/{id}/cloturer` | `exercice.cloturer` | Clôturer un exercice |  |

### Accès et rôles

| Méthode | Chemin | Permission | Objet | Exigences |
| --- | --- | --- | --- | --- |
| `GET` | `/v1/acces` | `utilisateur.lire` | Lister les accès (bureau et membres avec app) | RF-ADM-010 |
| `POST` | `/v1/acces` | `utilisateur.gerer` | Inviter un utilisateur (crée le compte si besoin) | RF-ADM-010, RF-ADM-011 |
| `PATCH` | `/v1/acces/{id}` | `utilisateur.gerer` | Changer de rôle ou de mandat | RF-ADM-011, RF-ADM-013 |
| `POST` | `/v1/acces/{id}/revoquer` | `utilisateur.gerer` | Révoquer immédiatement un accès | RF-ADM-014 |
| `POST` | `/v1/acces/{id}/deverrouiller` | `utilisateur.gerer` | Déverrouiller le compte | RF-005 |
| `GET` | `/v1/acces/{id}/connexions` | `utilisateur.lire` | Historique de connexion | RF-ADM-015 |
| `GET` | `/v1/roles` | `utilisateur.lire` | Lister les rôles |  |
| `POST` | `/v1/roles` | `role.gerer` | Créer un rôle personnalisé | RF-ADM-012 |
| `PATCH` | `/v1/roles/{id}` | `role.gerer` | Modifier un rôle | RF-ADM-012 |
| `DELETE` | `/v1/roles/{id}` | `role.gerer` | Supprimer un rôle personnalisé non utilisé |  |
| `GET` | `/v1/permissions` | `utilisateur.lire` | Catalogue des permissions |  |
| `GET` | `/v1/delegations` | `utilisateur.lire` | Lister les délégations |  |
| `POST` | `/v1/delegations` | `delegation.gerer` | Déléguer une permission | RF-ADM-032 |
| `POST` | `/v1/delegations/{id}/annuler` | `delegation.gerer` | Annuler une délégation |  |

### Membres

| Méthode | Chemin | Permission | Objet | Exigences |
| --- | --- | --- | --- | --- |
| `GET` | `/v1/membres` | `membre.lire` | Rechercher et filtrer les membres | RF-025 |
| `POST` | `/v1/membres` | `membre.creer` | Créer un membre | RF-020 |
| `GET` | `/v1/membres/doublons` | `membre.lire` | Membres marqués doublon probable |  |
| `GET` | `/v1/membres/import/modele` | `membre.importer` | Modèle Excel de l'import | RF-024 |
| `POST` | `/v1/membres/import` | `membre.importer` | Analyser un fichier d'import (CSV/XLSX) | RF-024 |
| `GET` | `/v1/membres/import/{tacheId}` | `membre.importer` | Rapport d'analyse d'import |  |
| `POST` | `/v1/membres/import/{tacheId}/confirmer` | `membre.importer` | Confirmer l'import analysé | RF-024 |
| `POST` | `/v1/membres/{id}/doublon` | `membre.modifier` | Statuer sur un doublon probable |  |
| `GET` | `/v1/membres/{id}` | `membre.lire` | Fiche membre |  |
| `PATCH` | `/v1/membres/{id}` | `membre.modifier` | Modifier un membre |  |
| `POST` | `/v1/membres/{id}/suspendre` | `membre.suspendre` | Suspendre | RF-027 |
| `POST` | `/v1/membres/{id}/reactiver` | `membre.suspendre` | Réactiver | RF-027 |
| `POST` | `/v1/membres/{id}/desactiver` | `membre.suspendre` | Désactiver | RF-027 |
| `POST` | `/v1/membres/{id}/anonymiser` | `membre.anonymiser` | Anonymiser (irréversible) | RF-SUP-055 |
| `POST` | `/v1/membres/{id}/acces-app` | `utilisateur.gerer` | Ouvrir l'accès à l'app au membre (invitation) |  |
| `PUT` | `/v1/membres/{id}/photo` | `membre.modifier` | Remplacer la photo (multipart) | RF-020 |
| `GET` | `/v1/membres/{id}/situation` | `membre.lire` | Situation de cotisation | RF-035 |
| `GET` | `/v1/membres/{id}/historique` | `membre.lire` | Historique complet | RF-026 |
| `GET` | `/v1/membres/{id}/carte` | `membre.lire` | Carte de membre (PDF avec QR) | RF-023 |
| `GET` | `/v1/membres/{id}/ayants-droit` | `membre.lire` | Ayants droit | RF-028 |
| `POST` | `/v1/membres/{id}/ayants-droit` | `membre.modifier` | Ajouter un ayant droit | RF-028 |
| `PATCH` | `/v1/membres/{id}/ayants-droit/{ayantDroitId}` | `membre.modifier` | Modifier un ayant droit |  |
| `DELETE` | `/v1/membres/{id}/ayants-droit/{ayantDroitId}` | `membre.modifier` | Retirer un ayant droit |  |
| `GET` | `/v1/familles` | `membre.lire` | Lister les familles | RF-021 |
| `POST` | `/v1/familles` | `membre.creer` | Créer une famille | RF-021 |
| `PATCH` | `/v1/familles/{id}` | `membre.modifier` | Modifier une famille |  |
| `GET` | `/v1/familles/{id}/membres` | `membre.lire` | Membres d'une famille |  |
| `GET` | `/v1/categories-membres` | `membre.lire` | Catégories de membres | RF-013 |
| `POST` | `/v1/categories-membres` | `association.modifier` | Créer une catégorie | RF-ADM-021 |
| `PATCH` | `/v1/categories-membres/{id}` | `association.modifier` | Modifier une catégorie |  |

### Cotisations

| Méthode | Chemin | Permission | Objet | Exigences |
| --- | --- | --- | --- | --- |
| `GET` | `/v1/campagnes` | `cotisation.lire` | Lister les campagnes | RF-030 |
| `POST` | `/v1/campagnes` | `cotisation.gerer` | Créer une campagne (brouillon) | RF-030, RF-037 |
| `GET` | `/v1/campagnes/{id}` | `cotisation.lire` | Détail d'une campagne |  |
| `PATCH` | `/v1/campagnes/{id}` | `cotisation.gerer` | Modifier une campagne |  |
| `GET` | `/v1/campagnes/{id}/apercu` | `cotisation.lire` | Aperçu de l'échéancier (membres ciblés, périodes, montant) | RF-030 |
| `POST` | `/v1/campagnes/{id}/activer` | `cotisation.gerer` | Activer et générer l'échéancier | RF-031 |
| `POST` | `/v1/campagnes/{id}/cloturer` | `cotisation.gerer` | Clôturer la campagne |  |
| `POST` | `/v1/campagnes/{id}/membres` | `cotisation.gerer` | Ajouter des membres à la campagne |  |
| `GET` | `/v1/campagnes/{id}/statistiques` | `cotisation.lire` | Statistiques de recouvrement | RF-075 |
| `GET` | `/v1/campagnes/{id}/echeancier` | `cotisation.lire` | Échéancier membres × périodes (écran A9) | RF-031 |
| `GET` | `/v1/echeances` | `cotisation.lire` | Lister les échéances | RF-031, RF-035 |
| `PATCH` | `/v1/echeances/{id}` | `cotisation.gerer` | Ajuster une échéance sans imputation | RF-031 |
| `POST` | `/v1/echeances/{id}/exonerer` | `cotisation.exonerer` | Exonérer une échéance |  |
| `POST` | `/v1/echeances/relancer` | `cotisation.gerer` | Relancer les membres d'échéances en retard (A10) | RF-036 |
| `GET` | `/v1/paiements` | `cotisation.lire` | Lister les paiements |  |
| `POST` | `/v1/paiements` | `paiement.enregistrer` | Enregistrer un paiement (mode connecté) | RF-032, RF-033, RF-034, RF-038 |
| `GET` | `/v1/paiements/{id}` | `cotisation.lire` | Détail d'un paiement |  |
| `POST` | `/v1/paiements/{id}/annuler` | `paiement.annuler` | Annuler un paiement (contre-écriture) |  |
| `GET` | `/v1/paiements/{id}/recu` | `cotisation.lire` | Reçu PDF | RF-033 |
| `POST` | `/v1/paiements/{id}/renvoyer-recu` | `paiement.enregistrer` | Renvoyer le reçu par SMS/WhatsApp | RF-034 |

### Trésorerie

| Méthode | Chemin | Permission | Objet | Exigences |
| --- | --- | --- | --- | --- |
| `GET` | `/v1/comptes` | `tresorerie.lire` | Comptes et soldes | RF-043 |
| `POST` | `/v1/comptes` | `tresorerie.transferer` | Créer un compte | RF-043 |
| `PATCH` | `/v1/comptes/{id}` | `tresorerie.transferer` | Modifier un compte |  |
| `GET` | `/v1/mouvements` | `tresorerie.lire` | Journal chronologique des mouvements | RF-046 |
| `POST` | `/v1/transferts` | `tresorerie.transferer` | Transférer entre comptes |  |
| `POST` | `/v1/ajustements` | `tresorerie.ajuster` | Ajustement de trésorerie |  |

### Dépenses

| Méthode | Chemin | Permission | Objet | Exigences |
| --- | --- | --- | --- | --- |
| `GET` | `/v1/depenses` | `depense.lire` | Lister les dépenses | RF-040, RF-044 |
| `GET` | `/v1/depenses/a-valider` | `depense.valider` | File des dépenses à valider par l'utilisateur | RF-ADM-030 |
| `POST` | `/v1/depenses` | `depense.creer` | Créer une dépense | RF-040, RF-044 |
| `GET` | `/v1/depenses/{id}` | `depense.lire` | Détail d'une dépense |  |
| `PATCH` | `/v1/depenses/{id}` | `depense.creer` | Modifier une dépense soumise |  |
| `POST` | `/v1/depenses/{id}/decision` | `depense.valider` | Approuver ou rejeter | RF-042, RF-ADM-031, RF-ADM-033, RF-ADM-034 |
| `POST` | `/v1/depenses/{id}/payer` | `depense.payer` | Enregistrer le décaissement | RF-041, RF-045 |
| `POST` | `/v1/depenses/{id}/annuler` | `depense.annuler` | Annuler une dépense non payée |  |
| `GET` | `/v1/categories-depense` | `depense.lire` | Catégories de dépense | RF-044 |
| `POST` | `/v1/categories-depense` | `association.modifier` | Créer une catégorie de dépense |  |
| `PATCH` | `/v1/categories-depense/{id}` | `association.modifier` | Modifier une catégorie de dépense |  |

### Fichiers

| Méthode | Chemin | Permission | Objet | Exigences |
| --- | --- | --- | --- | --- |
| `POST` | `/v1/pieces-jointes` | authentifié + droit d'écriture sur l'entité | Déclarer une pièce jointe | RF-041, RF-054 |
| `POST` | `/v1/pieces-jointes/{id}/url-upload` | authentifié | URL présignée d'envoi |  |
| `POST` | `/v1/pieces-jointes/{id}/confirmer` | authentifié | Confirmer la réception du fichier |  |
| `GET` | `/v1/pieces-jointes/{id}/url-telechargement` | authentifié | URL présignée de lecture |  |
| `GET` | `/v1/documents` | `document.lire` | Lister les documents | RF-ADM-050, RF-ADM-051 |
| `POST` | `/v1/documents` | `document.gerer` | Déclarer un document (puis upload présigné) | RF-ADM-050, RF-ADM-052 |
| `POST` | `/v1/documents/{id}/confirmer` | `document.gerer` | Confirmer l'upload d'un document |  |
| `POST` | `/v1/documents/{id}/versions` | `document.gerer` | Nouvelle version d'un document | RF-ADM-052 |
| `PATCH` | `/v1/documents/{id}` | `document.gerer` | Partager / renommer | RF-ADM-053 |
| `GET` | `/v1/documents/{id}/url-telechargement` | `document.lire` | URL présignée de lecture |  |

### Projets

| Méthode | Chemin | Permission | Objet | Exigences |
| --- | --- | --- | --- | --- |
| `GET` | `/v1/projets` | `projet.lire` | Lister les projets | RF-050 |
| `POST` | `/v1/projets` | `projet.gerer` | Créer un projet | RF-050 |
| `GET` | `/v1/projets/{id}` | `projet.lire` | Détail d'un projet |  |
| `PATCH` | `/v1/projets/{id}` | `projet.gerer` | Modifier un projet / avancement | RF-053 |
| `GET` | `/v1/projets/{id}/finances` | `projet.lire` | Recettes et dépenses du projet | RF-051, RF-052 |
| `POST` | `/v1/projets/{id}/cloturer` | `projet.gerer` | Clôturer avec bilan | RF-055, RF-056 |

### Réunions

| Méthode | Chemin | Permission | Objet | Exigences |
| --- | --- | --- | --- | --- |
| `GET` | `/v1/reunions` | `association.lire` | Lister les réunions | RF-080 |
| `POST` | `/v1/reunions` | `reunion.gerer` | Planifier une réunion | RF-080 |
| `PATCH` | `/v1/reunions/{id}` | `reunion.gerer` | Modifier une réunion |  |
| `POST` | `/v1/reunions/{id}/convoquer` | `reunion.gerer` | Envoyer les convocations | RF-063, RF-065 |
| `PUT` | `/v1/reunions/{id}/presences` | `reunion.gerer` | Enregistrer les présences | RF-081 |

### Communication

| Méthode | Chemin | Permission | Objet | Exigences |
| --- | --- | --- | --- | --- |
| `GET` | `/v1/annonces` | `association.lire` | Lister les annonces | RF-064 |
| `POST` | `/v1/annonces` | `communication.annoncer` | Créer une annonce (brouillon) | RF-064 |
| `PATCH` | `/v1/annonces/{id}` | `communication.annoncer` | Modifier une annonce non publiée |  |
| `POST` | `/v1/annonces/{id}/publier` | `communication.annoncer` | Publier et diffuser | RF-060, RF-061, RF-062, RF-064 |
| `GET` | `/v1/modeles-notification` | `communication.modeles` | Modèles de messages | RF-ADM-023 |
| `PUT` | `/v1/modeles-notification/{code}/{canal}` | `communication.modeles` | Personnaliser un modèle |  |
| `DELETE` | `/v1/modeles-notification/{code}/{canal}` | `communication.modeles` | Revenir au modèle global |  |
| `GET` | `/v1/notifications` | `communication.annoncer` | Historique des envois |  |
| `GET` | `/v1/sms/consommation` | `association.lire` | Consommation SMS du mois | RF-SUP-031 |

### Rapports

| Méthode | Chemin | Permission | Objet | Exigences |
| --- | --- | --- | --- | --- |
| `GET` | `/v1/tableau-de-bord` | `rapport.lire` | Tableau de bord | RF-070, RF-ADM-001, RF-ADM-002, RF-ADM-004 |
| `GET` | `/v1/rapports/recouvrement` | `rapport.lire` | Statistiques de recouvrement | RF-075 |
| `POST` | `/v1/rapports` | `rapport.exporter` | Demander un rapport ou un export | RF-039, RF-071, RF-072, RF-073, RF-ADM-042 |
| `POST` | `/v1/projets/{id}/rapport` | `projet.lire` | Rapport de projet PDF | RF-055 |
| `GET` | `/v1/taches` | authentifié | Mes tâches récentes |  |
| `GET` | `/v1/taches/{id}` | authentifié | État d'une tâche |  |
| `GET` | `/v1/journal-public` | `moi.journal` | Journal public de l'association | RF-074 |
| `GET` | `/v1/audit` | `audit.lire` | Journal d'audit | RF-ADM-040, RF-ADM-041, RF-ADM-044 |

### Espace membre

| Méthode | Chemin | Permission | Objet | Exigences |
| --- | --- | --- | --- | --- |
| `GET` | `/v1/moi/situation` | `moi.situation` | Ma situation de cotisation |  |
| `GET` | `/v1/moi/paiements` | `moi.situation` | Mes paiements |  |

### Synchronisation

| Méthode | Chemin | Permission | Objet | Exigences |
| --- | --- | --- | --- | --- |
| `POST` | `/v1/sync/pull` | authentifié (appareil) | Récupérer les changements depuis un curseur | RNF-001, RNF-014 |
| `POST` | `/v1/sync/push` | authentifié (appareil) + permissions par élément | Envoyer les écritures locales | RNF-001, RNF-014 |
| `GET` | `/v1/sync/rejets` | `utilisateur.lire` | Rejets de synchronisation par appareil (A32) | RF-SUP-033 |
| `POST` | `/v1/sync/rejets/{id}/acquitter` | authentifié (appareil) | Acquitter un rejet |  |
| `GET` | `/v1/appareils` | `utilisateur.lire` | Appareils et état de synchronisation | RF-SUP-033 |
| `POST` | `/v1/appareils/{id}/revoquer` | `utilisateur.gerer` | Révoquer un appareil (et purger) | RF-ADM-014 |

### Support

| Méthode | Chemin | Permission | Objet | Exigences |
| --- | --- | --- | --- | --- |
| `GET` | `/v1/tickets` | `association.lire` | Mes tickets de support | RF-SUP-020 |
| `POST` | `/v1/tickets` | `association.lire` | Ouvrir un ticket |  |
| `GET` | `/v1/tickets/{id}/messages` | `association.lire` | Messages d'un ticket |  |
| `POST` | `/v1/tickets/{id}/messages` | `association.lire` | Répondre |  |
| `GET` | `/v1/acces-support` | `support.consentir` | Demandes d'accès du support | RF-SUP-022 |
| `POST` | `/v1/acces-support/{id}/accepter` | `support.consentir` | Accepter un accès support | RF-SUP-022, RF-SUP-023 |
| `POST` | `/v1/acces-support/{id}/refuser` | `support.consentir` | Refuser un accès support |  |

### Public

| Méthode | Chemin | Permission | Objet | Exigences |
| --- | --- | --- | --- | --- |
| `POST` | `/v1/public/demandes-association` | public | Demander la création d'une association | RF-SUP-013 |
| `POST` | `/v1/webhooks/sms/{fournisseur}` | public | Accusé de remise SMS |  |

### Plateforme

| Méthode | Chemin | Permission | Objet | Exigences |
| --- | --- | --- | --- | --- |
| `GET` | `/v1/plateforme/statistiques` | `pf.statistiques.lire` | Statistiques globales | RF-SUP-003 |
| `GET` | `/v1/plateforme/associations` | `pf.associations.gerer` | Lister les associations | RF-SUP-001 |
| `POST` | `/v1/plateforme/associations` | `pf.associations.gerer` | Créer une association et son président | RF-SUP-001, RF-SUP-010 |
| `GET` | `/v1/plateforme/associations/{id}` | `pf.associations.gerer` | Détail d'une association |  |
| `PATCH` | `/v1/plateforme/associations/{id}` | `pf.associations.gerer` | Changer le plan ou le quota | RF-SUP-004 |
| `POST` | `/v1/plateforme/associations/{id}/suspendre` | `pf.associations.gerer` | Suspendre une association | RF-SUP-002 |
| `POST` | `/v1/plateforme/associations/{id}/reactiver` | `pf.associations.gerer` | Reactiver une association | RF-SUP-002 |
| `POST` | `/v1/plateforme/associations/{id}/archiver` | `pf.associations.gerer` | Archiver une association | RF-SUP-002, RF-015 |
| `GET` | `/v1/plateforme/associations/{id}/historique` | `pf.audit.lire` | Historique des actions sur l'association | RF-SUP-005 |
| `GET` | `/v1/plateforme/associations/{id}/administrateurs` | `pf.utilisateurs.gerer` | Administrateurs d'une association | RF-SUP-010 |
| `POST` | `/v1/plateforme/associations/{id}/administrateurs` | `pf.utilisateurs.gerer` | Nommer un administrateur | RF-SUP-010 |
| `GET` | `/v1/plateforme/demandes` | `pf.demandes.traiter` | Demandes de création | RF-SUP-013 |
| `POST` | `/v1/plateforme/demandes/{id}/valider` | `pf.demandes.traiter` | Valider une demande (crée le tenant) | RF-SUP-014 |
| `POST` | `/v1/plateforme/demandes/{id}/rejeter` | `pf.demandes.traiter` | Rejeter une demande | RF-SUP-014 |
| `GET` | `/v1/plateforme/utilisateurs` | `pf.utilisateurs.gerer` | Rechercher un utilisateur |  |
| `POST` | `/v1/plateforme/utilisateurs/{id}/reinitialiser-mot-de-passe` | `pf.utilisateurs.gerer` | Forcer la réinitialisation | RF-SUP-011 |
| `POST` | `/v1/plateforme/utilisateurs/{id}/deverrouiller` | `pf.utilisateurs.gerer` | Déverrouiller |  |
| `POST` | `/v1/plateforme/utilisateurs/{id}/desactiver` | `pf.utilisateurs.gerer` | Désactiver un compte | RF-SUP-010 |
| `GET` | `/v1/plateforme/appareils` | `pf.statistiques.lire` | Synchronisations de tous les tenants | RF-SUP-033 |
| `GET` | `/v1/plateforme/sms` | `pf.statistiques.lire` | Consommation SMS par association | RF-SUP-031 |
| `GET` | `/v1/plateforme/parametres` | `pf.parametres.gerer` | Paramètres globaux | RF-SUP-040, RF-SUP-043, RF-SUP-044 |
| `PUT` | `/v1/plateforme/parametres/{cle}` | `pf.parametres.gerer` | Modifier un paramètre global | RF-SUP-040 |
| `GET` | `/v1/plateforme/modeles-notification` | `pf.parametres.gerer` | Modèles globaux | RF-SUP-042 |
| `PUT` | `/v1/plateforme/modeles-notification/{code}/{canal}` | `pf.parametres.gerer` | Modifier un modèle global | RF-SUP-042 |
| `GET` | `/v1/plateforme/tickets` | `pf.support.acceder` | Tous les tickets | RF-SUP-020 |
| `PATCH` | `/v1/plateforme/tickets/{id}` | `pf.support.acceder` | Assigner, prioriser, changer le statut | RF-SUP-021 |
| `GET` | `/v1/plateforme/tickets/{id}/messages` | `pf.support.acceder` | Messages d'un ticket |  |
| `POST` | `/v1/plateforme/tickets/{id}/messages` | `pf.support.acceder` | Répondre (ou note interne) | RF-SUP-021 |
| `POST` | `/v1/plateforme/acces-support` | `pf.support.acceder` | Demander un accès à une association | RF-SUP-022, RF-SUP-023 |
| `POST` | `/v1/plateforme/acces-support/{id}/ouvrir` | `pf.support.acceder` | Ouvrir la session support accordée | RF-SUP-023 |
| `POST` | `/v1/plateforme/acces-support/{id}/clore` | `pf.support.acceder` | Clore l'accès support |  |
| `GET` | `/v1/plateforme/audit` | `pf.audit.lire` | Journal d'audit plateforme | RF-SUP-052 |

### Santé

| Méthode | Chemin | Permission | Objet | Exigences |
| --- | --- | --- | --- | --- |
| `GET` | `/v1/health/live` | public | Processus vivant |  |
| `GET` | `/v1/health/ready` | public | Dépendances prêtes (BDD, Redis) |  |
