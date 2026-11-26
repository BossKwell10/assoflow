# 05 — Protocole de synchronisation mobile

L'app mobile utilise WatermelonDB (contrainte du cahier CI). Le protocole ci-dessous est compatible avec
`synchronize()` de WatermelonDB : `pullChanges` et `pushChanges` sont implémentés côté app en appelant
`/v1/sync/pull` et `/v1/sync/push`. Le « timestamp » WatermelonDB transporte notre **curseur** (`sync_version`).

## 1. Principes

1. **Le serveur est la source de vérité.** L'appareil travaille sur une copie partielle et envoie des intentions.
2. **Écritures financières en ajout seul** (D-004) : un paiement ou une dépense poussé n'est jamais modifié ensuite ;
   pas de conflit possible, donc pas de *last-write-wins* sur l'argent.
3. **Identifiants générés par l'appareil** (UUIDv7) : rejouer un push ne crée jamais de doublon.
4. **Horloge de l'appareil non fiable** : l'heure déclarée est conservée (`date_paiement`) mais l'ordre et la
   numérotation suivent l'heure serveur (`recu_serveur_at`).
5. **Un rejet n'interrompt pas le lot** : chaque élément est traité dans son propre savepoint et reçoit un résultat.

## 2. Périmètre synchronisé (selon le rôle)

| Table | Bureau (trésorier, président, secrétaire, commissaire) | Membre | Écriture depuis l'appareil |
| --- | --- | --- | --- |
| `associations` (paramètres utiles) | ✓ | ✓ | — |
| `exercices`, `comptes_tresorerie`, `categories_membres`, `categories_depense` | ✓ | — | — |
| `familles`, `membres` | ✓ (tous) | sa fiche seulement | création, modification des champs descriptifs |
| `ayants_droit` | ✓ | les siens | création, modification |
| `campagnes_cotisation`, `echeances` | ✓ | ses échéances | — |
| `paiements`, `imputations_paiement` | ✓ | les siens | **création de `paiement` uniquement** |
| `mouvements` | si `tresorerie.lire` | — | — |
| `depenses` | si `depense.lire` | — | **création uniquement** |
| `projets` | ✓ | ✓ | — |
| `annonces` | ✓ | ✓ | — |
| `pieces_jointes` (métadonnées) | ✓ | — | création |
| `reunions`, `presences` | ✓ | ses présences | présences (Should) |

Opérations **réservées au mode connecté** (décision 7 de la revue) : validation et paiement d'une dépense,
annulation d'un paiement, activation de campagne, gestion des accès, rapports PDF consolidés.

Le serveur calcule une empreinte du périmètre (`hash(rôle, permissions)`) stockée par appareil. Si elle change
(ex. un membre devient trésorier), le pull suivant répond `reinitialiser: true` et l'app refait une synchronisation complète.

## 3. Curseur et ordre

- Chaque ligne synchronisée porte `sync_version`, issue du compteur par tenant (`app_next_sync_version`).
- Les écritures d'un tenant sont sérialisées par le verrou sur sa ligne `associations` : les versions deviennent
  visibles **dans l'ordre croissant**. Un pull `sync_version > curseur` ne manque donc aucune ligne.
- Le curseur renvoyé par le pull est le plus grand `sync_version` inclus dans la réponse (ou le compteur courant si
  la réponse est complète).

## 4. Pull

`POST /v1/sync/pull`

```json
{
  "curseur": 18452,
  "versionSchema": 3,
  "versionApp": "1.2.0",
  "limite": 2000
}
```

Réponse `200` :

```json
{
  "changes": {
    "membres":   { "created": [], "updated": [ { "id": "0193…", "numero": "MBR-000123", "nom": "Yao", "…": "…" } ], "deleted": ["0192…"] },
    "paiements": { "created": [], "updated": [ { "id": "0193…", "numero_recu": "REC-2027-000145", "numero_recu_provisoire": "T02-000145", "…": "…" } ], "deleted": [] }
  },
  "curseur": 18611,
  "complet": true,
  "reinitialiser": false,
  "rejets": []
}
```

- Toutes les lignes sont envoyées dans `updated` (option WatermelonDB `sendCreatedAsUpdated`).
- `deleted` : identifiants des lignes avec `deleted_at` renseigné depuis le curseur.
- Pagination : si `complet = false`, l'app rappelle immédiatement avec le nouveau curseur. Taille d'une page :
  2 000 lignes, réponse compressée (gzip/br).
- Première synchronisation : `curseur = 0`.
- Colonnes : noms `snake_case` identiques au schéma local WatermelonDB ; dates en millisecondes epoch
  (convention WatermelonDB), montants en entiers.
- `rejets` : rejets d'éléments poussés depuis cet appareil non encore acquittés (voir §6).

## 5. Push

`POST /v1/sync/push` — en-têtes `Authorization`, `X-Appareil-Id`.

```json
{
  "curseurBase": 18611,
  "versionSchema": 3,
  "changes": {
    "familles":  { "created": [ { "id": "0193…", "nom": "Famille Kouadio" } ], "updated": [] },
    "membres":   { "created": [ { "id": "0193…", "nom": "Kouadio", "prenoms": "Ama", "telephone": "+2250700000000", "famille_id": "0193…" } ],
                   "updated": [ { "id": "0192…", "lieu_residence": "Paris", "_changed": "lieu_residence,pays_residence", "pays_residence": "FR" } ] },
    "paiements": { "created": [ { "id": "0193…", "membre_id": "0193…", "montant": 2000, "mode": "especes",
                                  "compte_id": "…", "date_paiement": 1795680000000, "numero_recu_provisoire": "T02-000145",
                                  "campagne_id": null } ] },
    "depenses":  { "created": [ { "id": "0193…", "libelle": "Achat ciment", "montant": 150000, "…": "…" } ] },
    "pieces_jointes": { "created": [ { "id": "0193…", "entite_type": "depense", "entite_id": "0193…",
                                       "mime": "image/webp", "taille_octets": 182344, "sha256": "…" } ] }
  }
}
```

Réponse `200` (toujours, sauf erreur d'authentification, de version ou de tenant) :

```json
{
  "resultats": [
    { "table": "membres",   "id": "0193…", "statut": "accepte", "serveur": { "numero": "MBR-000456" } },
    { "table": "paiements", "id": "0193…", "statut": "accepte", "serveur": { "numero_recu": "REC-2027-000146" } },
    { "table": "paiements", "id": "0193…", "statut": "deja_recu" },
    { "table": "depenses",  "id": "0193…", "statut": "rejete", "code": "EXERCICE_FERME",
      "message": "Aucun exercice ouvert au 12/01/2026" }
  ],
  "curseur": 18618
}
```

### 5.1 Ordre de traitement

`familles` → `membres` → `ayants_droit` → `paiements` → `depenses` → `pieces_jointes` → `presences`.
Un élément qui référence un élément rejeté du même lot est rejeté avec `DEPENDANCE_REJETEE`.

### 5.2 Règles par table

| Table | Opération | Règles serveur |
| --- | --- | --- |
| `familles`, `membres`, `ayants_droit` | création | Permission `membre.creer`. Numéro attribué (RG-MBR-001). Doublon probable : accepté, marqué pour revue dans la console |
| `membres`, `familles`, `ayants_droit` | modification | Permission `membre.modifier`. Seuls les champs listés dans `_changed` sont appliqués (*last-write-wins par champ*, ordre d'arrivée serveur). Champs non modifiables depuis l'appareil : `numero`, `etat`, `statut_adhesion`, `user_id` |
| `paiements` | création | Permission `paiement.enregistrer`. Règles RG-COT-030 à 032. Exercice déterminé par `date_paiement` ; si `date_paiement` > heure serveur + 10 min → remplacée par l'heure serveur et signalée dans l'audit. Imputation (RG-COT-020), mouvement, numéro de reçu, SMS de reçu mis en file **après commit** |
| `paiements` | modification, suppression | Refusées : `OPERATION_INTERDITE` |
| `depenses` | création | Permission `depense.creer`. Statut `soumise`, numéro attribué, `validations_requises` calculé (RG-DEP-002), notification aux valideurs |
| `pieces_jointes` | création | Métadonnées seulement ; fichier envoyé ensuite (§7) |

### 5.3 Idempotence

| Cas | Résultat |
| --- | --- |
| `id` inconnu | traité normalement → `accepte` ou `rejete` |
| `id` connu, même contenu (empreinte des champs envoyés) | `deja_recu` + champs serveur |
| `id` connu, contenu différent, table en ajout seul | `rejete` / `CONFLIT_IDEMPOTENCE` (bug client à investiguer, alerte) |
| `id` déjà rejeté auparavant | même rejet renvoyé |

## 6. Rejets

- Un élément rejeté est enregistré (`table`, `id`, `code`, `message`, `appareil_id`) et renvoyé dans `rejets` à chaque
  pull de cet appareil jusqu'à acquittement (`POST /v1/sync/rejets/{id}/acquitter`).
- L'app affiche les rejets dans un écran « À corriger » (ex. paiement daté dans un exercice clôturé) et conserve
  l'élément local marqué en erreur ; le trésorier corrige puis renvoie **avec un nouvel id**.
- La console liste les rejets par appareil (tableau de bord des synchronisations, RF-SUP-033).

| Code | Signification |
| --- | --- |
| `PERMISSION_REFUSEE` | Le rôle de l'utilisateur ne permet plus l'opération |
| `EXERCICE_FERME` | Aucun exercice ouvert ne couvre la date |
| `REFERENCE_INVALIDE` | Membre, compte, campagne introuvable ou désactivé |
| `DEPENDANCE_REJETEE` | Élément du lot dont dépend celui-ci rejeté |
| `MONTANT_INVALIDE` | Hors bornes (RG-COT-031) |
| `OPERATION_INTERDITE` | Modification ou suppression d'une écriture en ajout seul |
| `CONFLIT_IDEMPOTENCE` | Même id, contenu différent |
| `VALIDATION` | Champ manquant ou mal formé (détail dans `message`) |

## 7. Fichiers (justificatifs, photos)

1. L'app compresse l'image (WebP, 1600 px max, objectif < 300 Ko).
2. Push des métadonnées (`pieces_jointes`, `statut_upload = en_attente`).
3. `POST /v1/pieces-jointes/{id}/url-upload` → URL présignée PUT (10 min).
4. Envoi du fichier directement vers S3 (reprise possible, Wi-Fi préféré pour les fichiers > 1 Mo).
5. `POST /v1/pieces-jointes/{id}/confirmer` → le serveur vérifie présence, taille, SHA-256, type → `recu`.
6. Les fichiers déjà synchronisés peuvent être purgés de l'appareil après 30 jours (stockage limité).

## 8. Versions, révocation, sécurité

| Situation | Réponse |
| --- | --- |
| `versionApp` < `MIN_APP_VERSION` | `426 APP_OBSOLETE` avec lien de mise à jour (store et APK) |
| `versionSchema` non supporté | `426 SCHEMA_OBSOLETE` |
| Appareil révoqué | `401 APPAREIL_REVOQUE` ; si `purge_demandee`, l'app efface sa base locale |
| Tenant suspendu | pull autorisé, push → `423 TENANT_SUSPENDU` |

- Le serveur supporte la version de schéma courante et la précédente (N-1).
- Base locale chiffrée SQLCipher ; clé en Keystore/Keychain ; déverrouillage par code PIN local.

## 9. Fréquence et consommation (RNF-006)

- Synchronisation à l'ouverture de l'app, 10 s après une écriture si le réseau est disponible, toutes les 15 min
  au premier plan, et en arrière-plan quand l'OS le permet.
- Objectif : < 50 Mo/mois/utilisateur actif ; mesuré par la taille des réponses (métrique `sync_octets_total`).

## 10. Exigences de test du protocole

- Rejouer un même push 3 fois → un seul paiement, un seul mouvement, un seul SMS.
- Deux appareils poussent simultanément 50 paiements chacun sur le même tenant → 100 reçus numérotés sans trou,
  aucun pull ne manque de ligne.
- Push contenant un membre rejeté et un paiement qui le référence → deux rejets, le reste du lot accepté.
- Appareil hors ligne 30 jours avec 300 opérations → push en lots de 50, tous traités en < 30 s.
