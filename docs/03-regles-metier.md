# 03 — Règles de gestion

Chaque règle porte un identifiant `RG-<DOMAINE>-<NNN>` cité dans le code (commentaire) et dans les tests
(nom du test). Les règles marquées **[D]** sont des décisions prises pour combler un manque du cahier des
charges ; elles sont à confirmer avec les associations pilotes.

## 1. Association (tenant)

| ID | Règle |
| --- | --- |
| RG-ASS-001 | La création d'un tenant (super-admin ou validation d'une demande) crée dans la même transaction : les 5 rôles système, l'accès `president` pour l'administrateur désigné, un compte `Caisse`, les catégories de dépense par défaut (Fonctionnement, Projet, Aide sociale, Autre), une catégorie de membre « Membre ordinaire » et l'exercice couvrant la date du jour. Objectif : tenant utilisable en moins de 5 minutes (critère d'acceptation 6). |
| RG-ASS-002 | La devise est XOF et n'est pas modifiable au MVP (RF-012, D-007). |
| RG-ASS-003 | **[D]** `seuil_double_validation` par défaut : 100 000 FCFA ; modifiable par le président uniquement, tracé dans l'audit. |
| RG-ASS-004 | Une association `suspendue` est en lecture seule (console et sync pull autorisés, sync push et écritures refusés avec `TENANT_SUSPENDU`). Une association `archivee` n'est plus accessible qu'au super-admin. |

## 2. Exercices

| ID | Règle |
| --- | --- |
| RG-EXE-001 | Les exercices d'une association ne se chevauchent pas. Durée par défaut : 12 mois à partir de `mois_debut_exercice`. |
| RG-EXE-002 | Toute écriture financière (paiement, dépense, transfert, mouvement) est rattachée à l'exercice qui contient sa date métier. Si aucun exercice ouvert ne la contient → erreur `EXERCICE_FERME`. |
| RG-EXE-003 | Clôture d'un exercice (permission `exercice.cloturer`) : refusée s'il reste des dépenses `soumise` ou `validee` datées dans l'exercice. Après clôture, plus aucune écriture datée dans la période, y compris les annulations. |
| RG-EXE-004 | L'exercice suivant est créé automatiquement 30 jours avant la fin de l'exercice courant (job planifié). |

## 3. Membres

| ID | Règle |
| --- | --- |
| RG-MBR-001 | Le numéro `MBR-NNNNNN` est attribué par le serveur à la première réception, sans trou, jamais réutilisé. |
| RG-MBR-002 | Champs obligatoires : nom, prénoms, et au moins un moyen de contact parmi téléphone, ou rattachement à une famille dont le chef a un téléphone (membres sans téléphone, RF-060). |
| RG-MBR-003 | Doublon probable (même nom + prénoms + téléphone, ou même téléphone + même date de naissance) : avertissement non bloquant, l'utilisateur confirme. |
| RG-MBR-004 | `etat = suspendu` : aucune nouvelle échéance générée, paiements encore acceptés, pas de rappel. `etat = desactive` : membre masqué des listes par défaut, aucune échéance ni notification, historique conservé. |
| RG-MBR-005 | **[D]** Passage automatique `actif → dormant` (job nocturne) si le membre a au moins une échéance en retard et aucun paiement depuis `jours_retard_dormant` jours (180 par défaut). Retour `dormant → actif` automatique au premier paiement. `honoraire` et `bienfaiteur` ne changent que manuellement. |
| RG-MBR-006 | Un membre n'appartient qu'à une famille. Le chef de famille doit être membre de cette famille. |
| RG-MBR-007 | Import CSV/Excel (RF-024) : en deux temps, *analyse* (rapport ligne par ligne : créée, doublon probable, erreur) puis *confirmation*. 5 000 lignes maximum par fichier. Colonnes : `nom, prenoms, telephone, sexe, date_naissance, village_origine, lieu_residence, pays_residence, categorie, famille, date_adhesion`. Téléphones normalisés en E.164 (préfixe +225 par défaut). |
| RG-MBR-008 | Carte de membre (RF-023, Should) : QR code contenant uniquement `assoflow:m:<association_id>:<membre_id>` signé (HMAC), aucune donnée personnelle. |
| RG-MBR-009 | Anonymisation sur demande (RF-SUP-055) : nom, prénoms, téléphone, email, photo, date de naissance remplacés ou effacés ; numéro, paiements et imputations conservés (obligation de traçabilité financière). Irréversible, permission `membre.anonymiser`, motif obligatoire. |

### Précisions d'implémentation (sprint 2)

| Règle | Implémentation |
| --- | --- |
| RG-ASS-003 | « Président » = accès actif portant le rôle système `president`. Un autre rôle titulaire de `association.modifier` qui change `seuilDoubleValidation` reçoit `403 PERMISSION_REFUSEE` ; tout changement est tracé (`association.modifiee`, valeurs avant/après). |
| RG-EXE-001 | Chevauchement → `422 VALIDATION` (`erreurs[0].code = CHEVAUCHEMENT`), y compris entre créations simultanées (contrainte d'exclusion). Création manuelle : dates explicites (le défaut de 12 mois s'applique à la création automatique, RG-ASS-001 et RG-EXE-004). |
| RG-EXE-003 | Dépenses « en cours » = `soumise` ou `validee` rattachées à l'exercice **ou** datées dans sa période → `422 DEPENSES_EN_COURS` avec leur nombre. Exercice déjà clôturé → `409 ETAT_INCOMPATIBLE`. |
| RG-MBR-001 | Numéro attribué dans la transaction de création (`app_prochain_numero('membre', 0)`) : une création refusée ou annulée ne consomme pas de numéro. |
| RG-MBR-002 | Vérifiée à la création et à chaque modification de téléphone ou de famille (`422`, code `CONTACT_REQUIS`). Un chef de famille ne peut pas retirer son téléphone si des membres sans téléphone de sa famille dépendent de lui (`CONTACT_FAMILLE`) ; un nouveau chef doit alors avoir un téléphone. |
| RG-MBR-003 | Comparaison sans casse ni accents, dans le tenant, fiches anonymisées exclues, téléphone obligatoire pour les deux critères. Console : `POST /membres` répond `422 CONFIRMATION_REQUISE` (`erreurs[0].ref` = fiche existante) ; renvoyé avec `confirmationDoublon: true`, la fiche est créée et marquée `a_verifier` (écran A7). Une modification d'identité qui crée un doublon marque la fiche sans bloquer. « Ce n'est pas un doublon » → `pas_doublon` (n'est plus signalée). |
| RG-MBR-004 | Transitions : `suspendre` depuis `actif` ; `desactiver` depuis `actif` ou `suspendu` ; `reactiver` depuis `suspendu` ou `desactive` (motif effacé). Autres cas → `409 ETAT_INCOMPATIBLE`. Liste : `etat ≠ desactive` par défaut, `?etat=desactive` pour les voir. |
| RG-MBR-005 | Date de référence = dernier paiement effectif (direct ou imputé) **ou, à défaut, la date d'adhésion** : un nouveau membre n'est pas dormant avant `jours_retard_dormant` jours d'ancienneté. Membres désactivés et anonymisés ignorés. Sprint 2 : `DormanceService.passerEnDormance()` et `reactiverApresPaiement()` (audit `acteur_type = systeme`) ; le job nocturne et l'appel depuis les paiements restent à brancher. |
| RG-MBR-006 | Une famille créée avec un chef y rattache ce chef (refus `AUTRE_FAMILLE` s'il appartient à une autre famille) ; le chef désigné ensuite doit déjà appartenir à la famille (`CHEF_HORS_FAMILLE`) ; le chef ne quitte pas sa famille sans successeur (`CHEF_DE_FAMILLE`). |
| RG-MBR-009 | Effacés : nom (« Anonyme »), prénoms, sexe, date de naissance, téléphone, email, village, résidence, photo (objet supprimé), notes, famille, lien de compte ; ayants droit effacés et supprimés ; chef de famille retiré des familles concernées ; fiche `desactive`, `anonymise_at` posé. Conservés : numéro, pays, catégorie, statut d'adhésion, paiements, imputations, consentements. Refusée (`409`) si le membre a un accès app actif (le révoquer d'abord). **Écart à valider juridiquement** : le journal d'audit, immuable et chaîné, conserve les valeurs des événements antérieurs (création, modifications) ; l'historique exposé n'en reprend aucune. |

### Précisions d'implémentation (sprint 3)

| Règle | Implémentation |
| --- | --- |
| RG-MBR-005 | Job `membres.dormance` planifié à 02:00 GMT (file `maintenance`, une exécution par échéance même avec plusieurs workers) pour chaque association `active`, chacune dans sa transaction. |
| RG-MBR-007 | Structure vérifiée à l'envoi (`422` : colonnes `nom` et `prenoms` obligatoires, colonne en double, fichier vide, plus de 5 000 lignes, ancien `.xls`) ; CSV UTF-8 ou Windows-1252, séparateur `;` `,` ou tabulation ; XLSX première feuille. En-têtes sans casse ni accents, alias courants (`prenom`, `tel`, `pays`…). Dates `JJ/MM/AAAA`, `AAAA-MM-JJ` ou série Excel ; téléphone numérique à 9 chiffres complété d'un 0. Catégorie = libellé exact d'une catégorie active ; famille = rattachement par nom, sinon créée à la confirmation (une seule fois). Doublon probable (RG-MBR-003) contre la base **et** entre lignes du fichier. Confirmation unique par analyse, avec attestation du consentement (canal `papier`) ; chaque membre est créé par le même service que la saisie manuelle (numéro, audit `membre.cree`) plus une trace `membres.importes`. |
| RG-MBR-008 | Signature = HMAC-SHA256 tronqué à 128 bits (base64url) avec `QR_SIGNING_KEY` ; carte refusée (`409`) pour une fiche anonymisée ou désactivée. |

## 4. Cotisations et échéancier

| ID | Règle |
| --- | --- |
| RG-COT-001 | Une campagne `brouillon` est modifiable librement et ne génère rien. |
| RG-COT-010 | L'**activation** génère les échéances pour chaque membre ciblé : `etat = actif` et `statut_adhesion ∈ {actif, dormant}`, appartenant aux `categories_cibles` (toutes si vide). **[D]** Les membres honoraires et bienfaiteurs ne sont pas ciblés par défaut ; ils peuvent être ajoutés individuellement. |
| RG-COT-011 | Périodes : `unique` → 1 échéance à `date_debut` ; `mensuelle` → une par mois civil entre `date_debut` et `date_fin`, échéance au `jour_echeance` du mois ; `trimestrielle`, `semestrielle`, `annuelle` : même principe par période. Libellé lisible (« Mars 2027 », « T2 2027 »). |
| RG-COT-012 | Un membre ajouté après l'activation reçoit les échéances des périodes **non encore échues** à sa date d'adhésion (pas de rattrapage). Un rattrapage est possible manuellement. |
| RG-COT-013 | Après activation, seuls modifiables : libellé, prolongation de `date_fin` (ajoute des périodes), montant des échéances **futures et sans imputation** (tracé). La réduction de `date_fin` supprime les échéances futures sans imputation uniquement. |
| RG-COT-014 | Exonération d'une échéance (permission `cotisation.exonerer`) : motif obligatoire, refusée si l'échéance a déjà des imputations. |
| RG-COT-015 | Clôture d'une campagne : plus de génération ; les échéances restantes restent dues. |
| RG-COT-020 | **Imputation** (calculée par le serveur, jamais par l'appareil) d'un paiement : 1) si `campagne_id` est renseigné, échéances non soldées de cette campagne par date croissante ; 2) puis toutes les échéances **échues** non soldées du membre, par date croissante ; 3) puis les échéances à venir par date croissante ; 4) le reste devient une **avance** (imputation sans échéance). |
| RG-COT-021 | Paiement groupé famille (RF-038) : même ordre que RG-COT-020 appliqué à l'ensemble des échéances des membres actifs de la famille, triées par date puis par numéro de membre. |
| RG-COT-022 | Les avances sont imputées automatiquement sur les nouvelles échéances dès leur génération (imputation négative sur l'avance + positive sur l'échéance, même `paiement_id`). |
| RG-COT-030 | Modes de paiement : espèces, mobile money (opérateur obligatoire, référence de transaction recommandée), virement, chèque. Au MVP, le mobile money est **déclaratif** : aucune vérification auprès de l'opérateur. |
| RG-COT-031 | **[D]** Montant maximum d'un paiement : 5 000 000 FCFA. Au-delà de 500 000 FCFA, l'interface demande une confirmation explicite. |
| RG-COT-032 | Un paiement est rattaché à un compte de trésorerie : par défaut `Caisse` pour les espèces, le compte mobile money ou banque correspondant sinon. Il crée un mouvement `entree` dans la même transaction. |
| RG-COT-040 | **Annulation** (permission `paiement.annuler`) : motif obligatoire, seulement si l'exercice est ouvert, une seule fois par paiement. Produit : une ligne `annulation` (nouveau numéro de reçu), les contre-imputations, un mouvement `sortie`, un SMS d'information au membre. Le paiement d'origine n'est jamais modifié. |
| RG-COT-041 | **[D]** Un trésorier ne peut annuler que ses propres paiements de moins de 48 h ; au-delà ou pour un autre saisisseur, la permission `paiement.annuler_tout` (président) est requise. |
| RG-COT-050 | Rappels automatiques (RF-036) : J-7, J-1 et J+7 de chaque échéance non soldée, si le membre a un canal de contact. Regroupement : **un seul message par membre et par jour**, listant les montants dus. Pas de rappel aux membres suspendus, désactivés ou ayant `canal_prefere = 'aucun'`. |

### Précisions d'implémentation (sprint 3)

| Règle | Implémentation |
| --- | --- |
| RG-COT-001 | Dates de la campagne comprises dans son exercice (`422 HORS_EXERCICE`), exercice ouvert (`422 EXERCICE_FERME`), y compris à l'activation, à l'ajout de membres et à la prolongation. |
| RG-COT-010 | Ciblés : `etat = actif`, `statut_adhesion ∈ {actif, dormant}`, ni supprimés ni anonymisés, catégorie dans `categories_cibles` (vide = toutes). Aperçu (`GET /campagnes/{id}/apercu`) calculé avec la même requête. |
| RG-COT-011 | Périodes **civiles** ; échéance au `jour_echeance` du premier mois de la période, ramenée dans `[date_debut, date_fin]` pour la première et la dernière période. Numéros à partir de `date_debut` : prolonger ou réduire `date_fin` conserve les numéros. 120 périodes au plus. Calcul partagé console/serveur (`genererPeriodes`, `packages/contracts`). |
| RG-COT-012 | « Non encore échues » = échéance ≥ max(date d'adhésion, date d'ajout). Un membre déjà présent ne reçoit que ses périodes manquantes. Campagne brouillon ou clôturée → `409`. |
| RG-COT-013 | Réduction refusée (`422 ECHEANCE_DEJA_IMPUTEE`) si une échéance supprimée est échue ou imputée. Changement de montant appliqué aux échéances futures, non exonérées, sans imputation **et non ajustées individuellement** (montant égal à l'ancien montant de la campagne). Ajustement individuel (`PATCH /echeances/{id}`) : campagne active, exercice ouvert, sans imputation, date dans l'exercice. |
| RG-COT-022 | Avance = somme des imputations sans échéance d'un même paiement ; consommée de la plus ancienne à la plus récente, sur les échéances non soldées par date. Imputations du membre sérialisées par verrou transactionnel (`imputation:<membre>`), repris par les paiements (S4). |
| RG-RAP-002 | Taux d'une campagne : `null` tant qu'aucune échéance n'est échue ; montant recouvré plafonné au dû par échéance. |

### Précisions d'implémentation (sprint 4)

| Règle | Implémentation |
| --- | --- |
| RG-COT-020 | « Échues » = date d'échéance ≤ aujourd'hui (GMT). Ordre : campagne ciblée (toutes dates), puis échues, puis à venir, chaque groupe par date puis numéro de période. Échéances exonérées ignorées ; celles des campagnes clôturées restent dues. Ventilation pure (`ventiler`), sous le verrou `imputation:<membre>`. |
| RG-COT-021 | Membres de la famille avec `etat = actif` ; à date égale, tri par numéro de membre. L'avance va au chef de famille s'il est actif, sinon au premier membre par numéro ; le reçu SMS part au chef de famille. Famille sans membre actif → `409 ETAT_INCOMPATIBLE`. |
| RG-COT-022 | Les avances d'un paiement annulé ne sont plus imputées (déjà contre-passées). Filet de sécurité `avances.imputer` toutes les heures (minute 15). |
| RG-COT-030 | Mode mobile money : `operateurMm` obligatoire, interdit pour les autres modes. Date du paiement : au plus 5 min dans le futur ; la date métier est la date GMT de `datePaiement`. |
| RG-COT-031 | `confirmationMontantEleve: true` exigé au-delà de 500 000 FCFA (`422 CONFIRMATION_REQUISE`, champ `confirmationMontantEleve`). |
| RG-COT-032 | Compte actif choisi par le saisisseur (la console propose le compte du type correspondant au mode). Mouvement `entree` daté de la date métier, libellé `Cotisation REC-… — <membre ou famille>`. Les écritures de `mouvements` passent toutes par `TresorerieService`. |
| RG-COT-040 | Annulation datée du jour : exercice du paiement **et** exercice du jour ouverts (`EXERCICE_FERME`). Contre-imputations = net de chaque (échéance, membre) du paiement d'origine, rattachées à la ligne d'annulation. Mouvement `sortie` sur le compte d'origine, refusé si le solde ne la couvre pas (`SOLDE_INSUFFISANT`, RG-TRE-003). Déjà annulé ou ligne d'annulation → `409`. SMS `annulation_paiement` au membre (ou au chef de famille). |
| RG-COT-041 | Fenêtre de 48 h mesurée sur `recu_serveur_at`. `annulable` (DTO) indique à la console si l'utilisateur courant peut annuler. |
| RG-COT-050 | Job `rappels.generer` à 08:00 GMT : échéances non soldées à J-7, J-1 et J+7 (échéance dans 7 jours, demain, ou échue depuis 7 jours). Un message par membre et par jour (`cle_dedup = rappel:<membre>:<jour>`) : `rappel_retard` (total, date de la plus ancienne échéance en retard) s'il y a un retard, sinon `rappel_avant`. Relance manuelle (A10) : `rappel_retard` des seules échéances en retard sélectionnées, une par membre et par jour. |
| RG-MBR-002 / RF-060 | Destinataire SMS d'un membre sans téléphone : le chef de sa famille (`relais_famille = true`). Fiches désactivées, anonymisées ou `canal_prefere = aucun` : aucun message (le reçu n'est pas envoyé, `recuSms = null`). |
| RG-MBR-004 | Paiement refusé pour un membre désactivé (`409`, le réactiver d'abord) ; accepté pour un membre suspendu. |
| RG-MBR-005 | Retour `dormant → actif` de chaque membre crédité par le paiement (direct ou groupé), dans sa transaction. |
| RG-NUM-001 | `REC-AAAA-NNNNNN`, `AAAA` = année GMT de réception ; l'annulation consomme un numéro. Un paiement refusé ne consomme pas de numéro (même transaction). |
| RG-NUM-002 | Le SMS de reçu porte `REC-… (prov. T02-…)` quand un numéro provisoire est fourni. |

## 5. Numérotation

| ID | Règle |
| --- | --- |
| RG-NUM-001 | Formats serveur : membre `MBR-000123` ; reçu `REC-AAAA-000145` ; dépense `DEP-AAAA-000012`. `AAAA` = année civile de réception par le serveur. Séquence sans trou par association, type et année (`app_prochain_numero`). |
| RG-NUM-002 | Hors ligne, l'appareil attribue un numéro provisoire `<prefixe_recu>-<compteur local>` (ex. `T02-000145`), affiché sur le reçu local avec la mention « provisoire ». Le reçu SMS envoyé après synchronisation porte le numéro définitif **et** le provisoire. |
| RG-NUM-003 | Le préfixe d'appareil est attribué par le serveur à l'enregistrement de l'appareil (lettre + 2 ou 3 chiffres), unique par association, jamais réattribué. |

## 6. Dépenses et validation

| ID | Règle |
| --- | --- |
| RG-DEP-001 | Création (permission `depense.creer`) : libellé, montant, date, catégorie, bénéficiaire, compte, projet optionnel. Possible hors ligne ; la dépense est `soumise` à sa réception par le serveur. |
| RG-DEP-002 | `validations_requises = 2` si `montant > seuil_double_validation`, sinon 1 (RF-ADM-033). Valeur figée à la création. |
| RG-DEP-003 | Le demandeur ne peut jamais valider sa propre dépense, même par délégation. |
| RG-DEP-004 | Valideurs : détenteurs de la permission `depense.valider` (président par défaut) ou bénéficiaires d'une délégation active de cette permission. En double validation, les deux valideurs sont des personnes distinctes ; **[D]** l'une des deux doit être le président ou son délégataire. |
| RG-DEP-005 | Un rejet (motif obligatoire) termine le workflow : `rejetee`. Le demandeur peut créer une nouvelle dépense. |
| RG-DEP-006 | Quand le nombre d'approbations atteint `validations_requises` → `validee`. Le demandeur est notifié de chaque décision (RF-ADM-034). |
| RG-DEP-007 | La validation exige le réseau (décision 7 de la revue) : elle n'est effective qu'enregistrée par le serveur. |
| RG-DEP-008 | Paiement de la dépense (permission `depense.payer`) : statut `validee` requis, **au moins une pièce justificative** reçue (RF-041 ; photo d'une attestation acceptée), solde du compte ≥ montant sinon erreur `SOLDE_INSUFFISANT`. Crée le mouvement `sortie` dans la même transaction. |
| RG-DEP-009 | Annulation possible depuis `soumise` ou `validee` uniquement (permission `depense.annuler`, motif obligatoire). Une dépense payée ne s'annule pas : une erreur se corrige par un ajustement (RG-TRE-004). |
| RG-DEP-010 | Montant, compte, demandeur et numéro sont figés après création (trigger). Libellé, catégorie, bénéficiaire et projet restent modifiables tant que le statut est `soumise`, avec trace d'audit. |
| RG-DEP-011 | Alerte (RF-045) quand un paiement de dépense ferait passer le compte sous `seuil_alerte_solde` : avertissement non bloquant + notification au président. |

## 7. Trésorerie

| ID | Règle |
| --- | --- |
| RG-TRE-001 | Le journal `mouvements` est la seule source des soldes. Il n'est alimenté que par `TresorerieService`. |
| RG-TRE-002 | Transfert entre comptes (permission `tresorerie.transferer`) : une sortie et une entrée dans la même transaction, même date ; solde source suffisant requis. |
| RG-TRE-003 | Le solde d'un compte ne peut pas devenir négatif par une sortie, sauf compte de type `banque` marqué découvert autorisé (hors MVP). |
| RG-TRE-004 | Ajustement (permission `tresorerie.ajuster`, président) : mouvement `ajustement` avec motif et pièce obligatoires, notification automatique au commissaire aux comptes. |
| RG-TRE-005 | Rapprochement bancaire (RF-047, Could) : hors MVP. |

## 8. Projets

| ID | Règle |
| --- | --- |
| RG-PRJ-001 | Un projet `cloture` ou `abandonne` n'accepte plus de dépense ni de campagne. |
| RG-PRJ-002 | Alerte de dépassement (RF-ADM-002) quand Σ dépenses payées du projet > budget. |
| RG-PRJ-003 | Clôture (RF-056) : bilan texte obligatoire, génération automatique du rapport de projet PDF (recettes affectées, dépenses, écart au budget, photos). |
| RG-PRJ-004 | L'avancement (%) est saisi manuellement ; il n'est pas déduit des dépenses. |

## 9. Transparence et rapports

| ID | Règle |
| --- | --- |
| RG-RAP-001 | Tableau de bord (RF-070) : recettes et dépenses de l'exercice, solde par compte, nombre de membres actifs, taux de recouvrement, dépenses en attente de validation, projets en dépassement. |
| RG-RAP-002 | **Taux de recouvrement** d'une période = Σ imputations sur les échéances échues dans la période ÷ Σ montants dus de ces échéances (exonérées exclues). |
| RG-RAP-003 | Rapport financier (RF-071) mensuel, trimestriel, annuel : solde d'ouverture, entrées par origine, sorties par catégorie, solde de clôture par compte, liste des dépenses, liste des annulations. PDF et Excel (RF-072), générés en tâche asynchrone. |
| RG-RAP-004 | **[D]** Journal public (RF-074) visible par tous les membres de l'association : mouvements avec date, libellé, montant, catégorie. Les paiements y apparaissent avec le **numéro** du membre, jamais son nom ni son téléphone. Chaque membre voit en clair ses propres paiements. Désactivable par le président (`journal_public_actif`). |
| RG-RAP-005 | Les rapports sont calculés sur le réplica PostgreSQL quand il est disponible (lecture seule). |

## 10. Conservation des données (RF-SUP-044)

| Donnée | Durée | Ensuite |
| --- | --- | --- |
| Écritures financières, reçus, audit | 10 ans après clôture de l'exercice **[D, à confirmer juridiquement]** | Archivage froid |
| Membres désactivés | 5 ans après désactivation | Anonymisation (RG-MBR-009) |
| Codes OTP | 24 h | Suppression |
| Sessions expirées ou révoquées | 90 jours | Suppression |
| Notifications envoyées | 13 mois | Suppression du contenu, compteurs conservés |
| Exports et rapports générés | 7 jours | Suppression du fichier |
| Sauvegardes | 90 jours (RNF-011) | Rotation |
