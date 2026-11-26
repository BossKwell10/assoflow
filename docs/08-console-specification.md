# 08 — Spécification de la console web

## 1. Objet et utilisateurs

La console est une application web unique (`console.assoflow.ci`) avec deux espaces :

| Espace | Utilisateurs | Usage typique |
| --- | --- | --- |
| **Association** | Président, trésorier, secrétaire, commissaire aux comptes (et rôles personnalisés) | Saisie en volume, paramétrage, validation, rapports, contrôle |
| **Plateforme** (`/plateforme`) | Super-admin, support AssoFlow | Création et suivi des tenants, support, paramètres globaux |

L'app mobile reste l'outil principal du terrain (encaissement hors ligne). La console sert au bureau pour les tâches
de bureau : imports, campagnes, validation, rapports, audit, paramétrage. Elle **exige une connexion**.

## 2. Principes d'interface

- Français uniquement au MVP ; tous les textes passent par des clés i18n (`fr.json`) pour les langues futures.
- Ordinateur d'abord (≥ 1280 px), utilisable sur tablette (≥ 768 px). Le président valide aussi depuis l'app mobile.
- Réseau lent : bundle initial < 300 Ko gzip, routes chargées à la demande, listes paginées (50), pas d'image lourde.
- Formats : montants `25 000 FCFA` (espace insécable des milliers), dates `05/03/2027`, heures `14:30` (GMT).
- Statuts toujours affichés avec un **libellé et une couleur** (jamais la couleur seule) :
  vert = payé/validé/actif, orange = en attente/partiel/soumise, rouge = en retard/rejeté/suspendu, gris = brouillon/annulé/désactivé.
- Toute action irréversible ou financière ouvre une **boîte de confirmation** qui rappelle l'objet et le montant ;
  les actions qui exigent un motif ont un champ obligatoire dans cette boîte.
- Accessibilité WCAG 2.1 AA : contraste, navigation clavier, libellés de formulaire, focus visible.

## 3. Architecture front

| Sujet | Choix |
| --- | --- |
| Stack | React 19, Vite, TypeScript strict, TanStack Router (routes typées), TanStack Query, Mantine 9, React Hook Form + Zod |
| Client API | Généré depuis `openapi.yaml` (orval) → hooks TanStack Query typés. Aucun appel `fetch` écrit à la main |
| Schémas de formulaire | Importés de `packages/contracts` (mêmes règles que le backend) |
| Authentification | Access token en mémoire ; refresh silencieux sur `401 JETON_EXPIRE` puis rejoue la requête ; déconnexion après 30 min d'inactivité (RF-006) avec avertissement à 28 min |
| Permissions | `GET /auth/moi` au chargement ; hook `usePermission('depense.valider')` ; composant `<Si permission="…">`. Un élément non autorisé est **masqué**, une route non autorisée affiche « Accès refusé » |
| Erreurs | Intercepteur : `detail` en notification, `erreurs[].champ` sur le formulaire, `412` → « Cette fiche a été modifiée par quelqu'un d'autre, rechargez » |
| Tâches longues | Composant `<SuiviTache id>` : interroge `GET /taches/{id}` toutes les 2 s, propose le téléchargement à la fin |
| Organisation | `src/features/<domaine>/{routes,components,hooks}` ; `src/shared/{ui,format,auth,api}` |
| Tests | Vitest + Testing Library (composants), Playwright (parcours critiques §8), MSW pour simuler l'API |

## 4. Navigation

### 4.1 Espace association

En-tête : nom et logo de l'association, sélecteur d'association (si plusieurs accès), exercice courant,
cloche de notifications (dépenses à valider, demandes d'accès support, tâches terminées), menu utilisateur.

| Menu | Écrans | Permission minimale |
| --- | --- | --- |
| Tableau de bord | A1 | `rapport.lire` |
| Membres | A2 Liste, A3 Fiche, A4 Formulaire, A5 Familles, A6 Import, A7 Doublons | `membre.lire` |
| Cotisations | A8 Campagnes, A9 Campagne (détail), A10 Échéances, A11 Paiements, A12 Saisie de paiements | `cotisation.lire` |
| Trésorerie | A13 Comptes et journal, A14 Dépenses, A15 Dépense (détail), A16 À valider | `tresorerie.lire` / `depense.lire` |
| Projets | A17 Liste, A18 Projet | `projet.lire` |
| Réunions | A19 Réunions et présences | `reunion.gerer` |
| Communication | A20 Annonces, A21 Modèles, A22 Historique d'envois | `communication.annoncer` |
| Documents | A23 | `document.lire` |
| Rapports | A24 Rapports et exports, A25 Journal public | `rapport.lire` |
| Audit | A26 | `audit.lire` |
| Paramètres | A27 Association, A28 Exercices, A29 Catégories, A30 Utilisateurs et rôles, A31 Délégations, A32 Appareils, A33 Accès support | selon écran |
| Aide | A34 Tickets de support | tous |

### 4.2 Espace plateforme

| Menu | Écrans | Permission |
| --- | --- | --- |
| Tableau de bord | P1 | `pf.statistiques.lire` |
| Associations | P2 Liste, P3 Fiche, P4 Création | `pf.associations.gerer` |
| Demandes | P5 | `pf.demandes.traiter` |
| Utilisateurs | P6 | `pf.utilisateurs.gerer` |
| Synchronisations | P7 | `pf.statistiques.lire` |
| SMS | P8 | `pf.statistiques.lire` |
| Support | P9 Tickets, P10 Accès support | `pf.support.acceder` |
| Paramètres | P11 Passerelles et paramètres, P12 Modèles globaux | `pf.parametres.gerer` |
| Audit | P13 | `pf.audit.lire` |

En session support (claim `imp`) : bandeau rouge fixe « Session support — <association> — lecture seule / impersonation —
fin à 16:40 » avec bouton « Clore ».

## 5. Écrans de l'espace association

Chaque fiche donne : route, objectif (exigences), contenu, actions, règles d'affichage. Les endpoints sont ceux de
[07-contrat-api.md](07-contrat-api.md).

### A0. Connexion et contexte

- `/connexion` : identifiant (téléphone ou email), mot de passe → écran TOTP si demandé → choix d'association si plusieurs.
- Premier accès d'un membre du bureau : activation TOTP obligatoire (QR code + saisie d'un code + affichage unique
  des 10 codes de secours à télécharger).
- `/mot-de-passe-oublie` : téléphone → OTP → nouveau mot de passe (règles affichées en direct).
- Erreurs : message unique « Identifiant ou mot de passe incorrect » ; compte verrouillé → durée restante.

### A1. Tableau de bord — `/` (RF-070, RF-ADM-001 à 004)

- Cartes : recettes de l'exercice, dépenses, solde total (et par compte au survol), membres actifs, taux de recouvrement,
  avec comparaison au mois précédent et à l'année précédente.
- Bloc **Alertes** (cliquables) : cotisations en retard (nombre de membres), dépenses à valider, projets en dépassement,
  solde sous le seuil, quota SMS > 80 %, rejets de synchronisation non traités.
- Graphique : recettes et dépenses par mois de l'exercice (barres groupées).
- Raccourcis selon permissions : « Saisir des paiements », « Nouvelle dépense », « Nouveau membre », « Rapport mensuel ».
- Activité récente : 10 derniers événements (paiements, dépenses, validations).

### A2. Membres — liste — `/membres` (RF-025, RF-039)

- Recherche instantanée (nom, prénoms, numéro, téléphone) ; filtres : statut d'adhésion, état, catégorie, famille,
  diaspora, en retard.
- Colonnes : numéro, nom et prénoms, téléphone (masqué partiellement pour le commissaire), catégorie, famille,
  statut, état, solde de cotisation (rouge si négatif), accès app (icône).
- Actions de masse : exporter la sélection, ajouter à une campagne, envoyer un message (→ A20 pré-rempli).
- Boutons : « Nouveau membre », « Importer », « Doublons (n) » si `n > 0`.

### A3. Membre — fiche — `/membres/:id` (RF-026, RF-035, RF-028)

- En-tête : photo, nom, numéro, statuts, téléphone, diaspora (pays), famille (lien), situation : **reste dû**, avance,
  échéances en retard.
- Onglets : *Situation* (échéances par campagne, avec situation colorée), *Paiements* (liste, reçu PDF, renvoyer reçu,
  annuler), *Historique* (chronologie complète), *Ayants droit* (CRUD), *Informations* (formulaire A4 en lecture),
  *Accès app* (ouvrir l'accès, état, appareils).
- Actions : Modifier, Enregistrer un paiement (A12 pré-rempli), Suspendre / Réactiver / Désactiver (motif),
  Carte de membre (PDF), Anonymiser (président, double confirmation avec saisie du numéro du membre).

### A4. Membre — formulaire — `/membres/nouveau`, `/membres/:id/modifier` (RF-020 à 022)

- Champs : nom*, prénoms*, sexe, date de naissance, téléphone (+225 par défaut, normalisé), WhatsApp (case),
  email, village d'origine, lieu de résidence, pays de résidence (liste, CI par défaut), catégorie, famille
  (recherche ou création rapide), statut d'adhésion, date d'adhésion, canal préféré, notes, photo.
- Règle RG-MBR-002 affichée si ni téléphone ni famille.
- À l'enregistrement, avertissement de doublon probable (RG-MBR-003) avec lien vers la fiche existante :
  « Enregistrer quand même » / « Annuler ».
- Consentement : case « Le membre a donné son accord pour le traitement de ses données » (obligatoire à la création,
  canal `console` ou `papier`).

### A5. Familles — `/membres/familles` (RF-021, RF-038)

Liste (nom, chef de famille, nombre de membres, reste dû cumulé) ; fiche famille : membres, échéances cumulées,
« Paiement groupé » (A12 en mode famille).

### A6. Import — `/membres/import` (RF-024)

Assistant en 3 étapes : 1) télécharger le modèle Excel, déposer le fichier ; 2) rapport d'analyse (compteurs + tableau
filtrable des lignes en erreur ou doublon, export du rapport) ; 3) confirmation (option « inclure les doublons »)
puis suivi de tâche et résumé final.

### A7. Doublons — `/membres/doublons`

Paires suspectes (`doublon_statut = a_verifier`) côte à côte ; actions : « Ce n'est pas un doublon »
(`POST /membres/{id}/doublon`), « Désactiver celui-ci ». Pas de fusion automatique au MVP.

### A8. Campagnes — `/cotisations/campagnes` (RF-030, RF-037)

- Liste : libellé, type, montant/période, périodicité, période, statut, taux de recouvrement (barre).
- Formulaire de création : exercice, libellé, type (ordinaire / exceptionnelle + motif + projet), montant, périodicité,
  dates, jour d'échéance, catégories ciblées. **Aperçu avant activation** : nombre de membres ciblés, nombre
  d'échéances, montant total attendu, 3 premières périodes.

### A9. Campagne — détail — `/cotisations/campagnes/:id` (RF-031, RF-075)

- Statistiques (attendu, échu, recouvré, taux), graphique de recouvrement par période.
- Onglet *Échéancier* : tableau membres × périodes (cellule colorée selon situation, clic → détail et ajustement
  ou exonération).
- Actions : Activer (confirmation avec l'aperçu), Ajouter des membres (avec option rattrapage), Prolonger, Clôturer.

### A10. Échéances — `/cotisations/echeances` (RF-035)

Vue transversale filtrable (campagne, situation, période, membre) ; export Excel ; action de masse « Relancer »
(envoie le modèle `rappel_retard` aux membres sélectionnés, avec estimation du nombre de SMS).

### A11. Paiements — `/cotisations/paiements` (RF-032, RF-033, RF-046)

- Colonnes : n° reçu (+ provisoire), date, membre ou famille, montant, mode (+ opérateur), compte, saisi par,
  statut (effectif / annulé). Filtres : période, mode, compte, saisisseur, campagne, inclure annulés.
- Détail en panneau latéral : imputations par échéance, reçu PDF, renvoyer le reçu, annuler (motif ; bouton masqué si
  RG-COT-041 l'interdit), lien vers l'audit.
- Total de la sélection affiché en pied de tableau.

### A12. Saisie de paiements — `/cotisations/paiements/saisie` (critère d'acceptation 1)

Écran optimisé pour la saisie en série (objectif : **20 paiements en moins de 10 minutes**) :

- Ligne de saisie unique : membre (recherche au clavier par nom ou numéro, `↓`/`Entrée`), montant (pré-rempli avec
  le reste dû, modifiable), mode (raccourcis `E`/`M`/`V`), opérateur si mobile money, référence, compte (défaut selon mode),
  campagne ciblée (optionnelle), date (aujourd'hui par défaut).
- `Entrée` enregistre (id UUIDv7 généré côté console) et vide la ligne ; la liste de la session s'affiche en dessous
  avec le numéro de reçu attribué et le statut d'envoi du SMS.
- Mode famille : choix d'une famille, affichage du reste dû cumulé.
- Montant > 500 000 FCFA → confirmation explicite (RG-COT-031).
- Récapitulatif de session : nombre, total par mode, bouton « Imprimer le bordereau ».

### A13. Comptes et journal — `/tresorerie` (RF-043, RF-046)

- Cartes par compte (type, solde, dernier mouvement) ; « Nouveau compte ».
- Journal chronologique des mouvements (filtre compte, période, origine) avec solde progressif quand un seul compte
  est filtré ; export Excel.
- Actions : Transfert entre comptes, Ajustement (président : motif + pièce obligatoires).

### A14. Dépenses — `/tresorerie/depenses` (RF-040, RF-044)

- Onglets par statut (Soumises, Validées à payer, Payées, Rejetées, Annulées) avec compteurs.
- Colonnes : n°, date, libellé, catégorie, bénéficiaire, projet, montant, statut, validations (1/2), justificatif (icône).
- « Nouvelle dépense » : formulaire (libellé, montant, date, catégorie, bénéficiaire ou membre bénéficiaire, compte,
  projet, justificatifs glisser-déposer). Mention si double validation requise (montant > seuil).

### A15. Dépense — détail — `/tresorerie/depenses/:id` (RF-041, RF-042, RF-ADM-031 à 034)

- Chronologie du workflow : création, chaque décision (valideur, délégation éventuelle, motif), paiement.
- Justificatifs : vignettes, visionneuse, ajout tant que non payée.
- Actions selon statut et permissions : Approuver / Rejeter (motif) — masqué pour le demandeur (RG-DEP-003) ;
  Payer (vérifie justificatif et solde, affiche le solde après opération et l'alerte de seuil) ; Annuler (motif).

### A16. À valider — `/tresorerie/a-valider` (RF-ADM-030)

File des dépenses où l'utilisateur peut décider, triée par ancienneté ; approbation rapide ligne par ligne
avec confirmation ; badge dans la navigation.

### A17–A18. Projets — `/projets`, `/projets/:id` (RF-050 à 056)

- Liste : nom, responsable, budget, dépensé (barre, rouge si dépassement), avancement, statut.
- Fiche : objectif, calendrier, curseur d'avancement, finances (recettes affectées, dépenses, écart), dépenses liées,
  campagnes liées, photos et documents, rapport PDF, clôture (bilan obligatoire).

### A19. Réunions — `/reunions` (RF-080 à 084, Should)

Liste et calendrier ; fiche : ordre du jour, convocations (canaux, ciblage, estimation SMS, accusés de réception),
feuille de présence (liste des membres avec statut présent/absent/excusé/représenté, saisie rapide), PV (dépôt d'un
document lié). L'historique des décisions (RF-084) est la liste chronologique des PV.

### A20–A22. Communication — `/communication` (RF-060 à 065)

- A20 Annonces : brouillon, ciblage (tous / catégories / sélection), canaux, **estimation du nombre de SMS et du
  quota restant** avant publication, aperçu du message SMS (compteur de caractères et d'unités).
- A21 Modèles : liste des modèles par code et canal, édition avec variables cliquables, aperçu avec un membre fictif,
  « Revenir au modèle global ».
- A22 Historique : envois avec statut (en attente, envoyé, remis, échec, hors quota), filtre par membre et modèle ;
  consommation SMS du mois (jauge).

### A23. Documents — `/documents` (RF-ADM-050 à 053)

Arborescence par catégorie et exercice ; dépôt (upload présigné, barre de progression) ; versions ; partage aux
membres (case) ; visionneuse PDF/image.

### A24. Rapports et exports — `/rapports` (RF-071 à 075, RF-039)

- Rapport financier : période (mois, trimestre, exercice, personnalisée), format PDF/Excel → tâche.
- Recouvrement : graphique par mois et tableau par campagne, à l'écran.
- Exports : membres, cotisants, journal, audit, export complet de l'association (président).
- Liste des dernières tâches avec téléchargement (7 jours).

### A25. Journal public — `/journal-public` (RF-074)

Aperçu de ce que voient les membres (RG-RAP-004) ; interrupteur d'activation pour le président.

### A26. Audit — `/audit` (RF-ADM-040 à 044)

Recherche par période, acteur, action, entité ; détail avant/après en diff lisible ; indicateur d'intégrité de la chaîne
(dernière vérification OK / rupture) ; export. Le commissaire aux comptes a accès en lecture seule.

### A27–A33. Paramètres

| Écran | Contenu |
| --- | --- |
| A27 Association (`/parametres/association`) | Identité, informations légales (récépissé, préfecture), logo, coordonnées, seuils (double validation, alerte solde, dormance), mois de début d'exercice. RF-010, 011, RF-ADM-020, 024 |
| A28 Exercices | Liste, création, clôture avec contrôle des dépenses en cours (RG-EXE-003). RF-014, RF-ADM-022 |
| A29 Catégories | Catégories de membres et de dépenses. RF-013, RF-ADM-021 |
| A30 Utilisateurs et rôles | Onglet *Utilisateurs* : accès (nom, téléphone, rôle, mandat, dernière connexion, statut), inviter, changer de rôle, révoquer (immédiat, confirmation), déverrouiller, historique de connexion. Onglet *Rôles* : matrice permissions × rôles avec cases, rôles personnalisés. RF-ADM-010 à 015 |
| A31 Délégations | Créer (délégataire, permission, période, motif), annuler ; liste des délégations actives et passées. RF-ADM-032 |
| A32 Appareils | Appareils enregistrés : utilisateur, version d'app, dernière sync, éléments en attente, rejets ; révoquer (avec purge). RF-SUP-033, RF-ADM-014 |
| A33 Accès support | Demandes en attente (accepter / refuser), accès accordés en cours et passés avec lien vers l'audit. RF-SUP-022 |

### A34. Aide — `/aide`

FAQ courte, ouverture de ticket (catégorie, message, pièce jointe), suivi des tickets et réponses.

## 6. Écrans de l'espace plateforme

| Écran | Contenu | Exigences |
| --- | --- | --- |
| P1 Tableau de bord | Associations actives, membres actifs, paiements et montants sur 30 j, SMS du mois, appareils actifs, rejets de sync 7 j ; lien Grafana pour la santé technique | RF-SUP-003, RF-SUP-030 |
| P2 Associations | Recherche, filtres (statut, plan, région), colonnes : nom, village, région, membres, dernière activité, SMS du mois, statut | RF-SUP-001 |
| P3 Fiche association | Informations, administrateurs (nommer, réinitialiser), plan et quota SMS, suspendre / réactiver / archiver (motif), historique des actions | RF-SUP-002, 004, 005, 010, 011 |
| P4 Création | Formulaire association + président (téléphone, nom) ; objectif : **moins de 5 minutes** ; affiche l'invitation envoyée | RF-SUP-001, critère 6 |
| P5 Demandes | File des demandes, pièces jointes (récépissé), vérification d'identité (case), valider (crée le tenant) ou rejeter (motif) | RF-SUP-012 à 014 |
| P6 Utilisateurs | Recherche par téléphone ou nom, accès par association, verrouillage, réinitialisation, désactivation | RF-SUP-010, 011 |
| P7 Synchronisations | Appareils de toutes les associations : dernière sync, inactifs depuis N jours, rejets ; filtres | RF-SUP-033 |
| P8 SMS | Consommation par association vs quota, taux de remise par fournisseur, échecs récents | RF-SUP-031 |
| P9 Tickets | File, priorité, assignation, réponses, notes internes | RF-SUP-020, 021 |
| P10 Accès support | Demander un accès (association, mode, durée, motif, ticket), ouvrir la session accordée, clore | RF-SUP-022, 023 |
| P11 Paramètres | Passerelles SMS/WhatsApp (ordre, sender ID, test d'envoi), langues, durées de conservation, version minimale d'app | RF-SUP-040, 043, 044 |
| P12 Modèles globaux | Édition des modèles par code, canal et langue | RF-SUP-042 |
| P13 Audit plateforme | Actions super-admin et support | RF-SUP-052 |

## 7. Composants partagés

| Composant | Rôle |
| --- | --- |
| `TableauDonnees` | Tableau paginé par curseur, tri, filtres synchronisés dans l'URL, sélection multiple, export, états vide/chargement/erreur |
| `Montant` | Affichage FCFA formaté ; variante signée (rouge si négatif) |
| `ChampMontant` | Saisie d'entiers avec séparateur de milliers, sans décimale |
| `ChampTelephone` | Préfixe pays, normalisation E.164, validation |
| `SelecteurMembre` | Recherche asynchrone au clavier (nom, numéro, téléphone), affiche reste dû |
| `BadgeStatut` | Libellé + couleur selon le dictionnaire de statuts partagé (`packages/contracts`) |
| `ConfirmationAction` | Boîte de confirmation avec résumé, motif optionnel/obligatoire, double confirmation pour l'irréversible |
| `DepotFichier` | Upload présigné avec progression, contrôle de type et de taille côté client |
| `SuiviTache` | Suivi d'une tâche asynchrone et téléchargement |
| `ApercuSms` | Compteur de caractères GSM-7/Unicode et d'unités facturées |
| `Si` | Rendu conditionnel par permission |

## 8. Parcours critiques (tests Playwright obligatoires)

1. Connexion trésorier avec TOTP → saisie de 20 paiements en série → reçus numérotés sans trou, SMS en file.
2. Trésorier crée une dépense de 150 000 FCFA (seuil 100 000) → président approuve → second valideur approuve →
   trésorier paie → solde de caisse diminué, mouvement au journal.
3. Le demandeur ne voit pas les boutons de validation de sa propre dépense ; l'API refuse aussi (`AUTO_VALIDATION_INTERDITE`).
4. Création d'une campagne mensuelle → aperçu → activation → échéancier généré → paiement partiel → situation « partielle ».
5. Annulation d'un paiement → contre-écriture visible, reçu d'annulation, solde membre recalculé.
6. Import de 500 membres avec 3 doublons et 2 erreurs → rapport exact → confirmation.
7. Président révoque un trésorier → la session du trésorier est refusée à la requête suivante.
8. Super-admin crée une association et son président en moins de 5 minutes.
9. Agent support en mode lecture : bandeau visible, toute modification refusée, actions tracées.
10. Utilisateur de l'association A ne peut atteindre aucune ressource de B par URL directe (404).
