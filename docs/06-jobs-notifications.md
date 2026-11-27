# 06 — Tâches asynchrones et notifications

## 1. Principes

- Aucun appel à un service externe (SMS, WhatsApp, S3 lourd, PDF) dans une transaction ni dans le chemin
  synchrone d'une requête HTTP.
- Les notifications suivent le modèle **outbox** : la ligne `notifications` est insérée dans la transaction
  métier ; un job `notifications.envoyer` est mis en file **après commit** (hook `afterCommit`). Un balayage
  toutes les minutes reprend les lignes `en_attente` orphelines (crash entre commit et mise en file).
- Chaque job porte `associationId` ; le worker pose le contexte RLS avant tout accès en base.
- Toutes les tâches sont idempotentes (rejouables sans effet double).

## 2. Files BullMQ

| File | Concurrence | Tentatives | Délai entre tentatives | Contenu |
| --- | --- | --- | --- | --- |
| `notifications-prioritaires` | 20 | 5 | exponentiel, 10 s → 10 min | OTP, reçus de paiement, décisions de dépense |
| `notifications` | 10 | 5 | exponentiel, 1 min → 2 h | Rappels, annonces, invitations |
| `rapports` | 2 | 2 | 1 min | PDF, Excel, imports CSV |
| `maintenance` | 1 | 3 | 5 min | Jobs planifiés ci-dessous |

Messages en échec définitif : statut `echec`, compteur Prometheus, visibles dans la console plateforme.

## 3. Tâches planifiées (job `maintenance`, verrou Redis pour une seule exécution)

| Tâche | Fréquence (GMT) | Règle |
| --- | --- | --- |
| `rappels.generer` | Tous les jours 08:00 | RG-COT-050 : J-7, J-1, J+7, un message par membre et par jour |
| `membres.dormance` | Tous les jours 02:00 | RG-MBR-005 |
| `exercices.preparer` | Tous les jours 03:00 | RG-EXE-004 |
| `avances.imputer` | Toutes les heures | RG-COT-022 (filet de sécurité ; l'imputation se fait aussi à la génération) |
| `notifications.reprise` | Toutes les minutes | Lignes `en_attente` depuis > 2 min sans job |
| `audit.verifier_chaine` | Tous les jours 01:00 | Recalcule la chaîne de hash par tenant ; alerte si rupture |
| `audit.exporter_worm` | Tous les jours 01:30 | Export JSONL du jour vers S3 (verrouillage objet) |
| `purge.donnees` | Tous les jours 04:00 | Durées du §10 de 03-regles-metier |
| `delegations.expirer`, `acces.expirer_mandats` | Toutes les heures | Statut `expire` à la date de fin ; invalidation du cache de permissions |
| `acces_support.expirer` | Toutes les 5 min | Fin d'accès support → révocation des jetons |
| `quotas.alerter` | Toutes les heures | Alerte au président à 80 % et 100 % du quota SMS |

## 4. Canaux et fournisseurs

### 4.1 Abstraction

```ts
interface FournisseurSms {
  code: string;                                   // 'agregateur_a'
  envoyer(msg: { to: string; texte: string; ref: string }): Promise<{ idFournisseur: string; unites: number }>;
  traiterAccuse(payload: unknown): AccuseRemise | null;  // webhook de remise
  prendEnCharge(telephone: string): boolean;       // routage par préfixe si besoin
}
```

- Deux fournisseurs configurés (`SMS_PROVIDERS`, ordre de préférence). Bascule automatique vers le second quand le
  premier renvoie une erreur réseau/5xx, ou quand son taux de remise sur 1 h passe sous 90 % (disjoncteur).
- Les identifiants d'expéditeur (*sender ID*) sont configurés par fournisseur dans `parametres_plateforme`.
- Webhooks d'accusé de remise : `POST /v1/webhooks/sms/{fournisseur}` avec vérification de signature ou de jeton
  secret ; met à jour `statut = remise` et `remise_at`.

### 4.2 Choix du canal

Pour un membre : `canal_prefere` si disponible, sinon SMS. WhatsApp (Should, RF-061) seulement si
`telephone_whatsapp = true` et modèle approuvé. Push seulement si le membre a l'app.
Les OTP passent toujours par SMS au MVP.

### 4.3 Quotas (RF-SUP-031)

- Avant envoi d'un SMS non prioritaire : si `consommation_sms.unites` du mois ≥ `quota_sms_mensuel` → statut `hors_quota`, pas d'envoi.
- OTP et reçus de paiement ne sont **jamais** bloqués par le quota (comptés quand même).
- Un SMS de plus de 160 caractères GSM-7 (70 en Unicode) compte plusieurs unités : les modèles doivent éviter
  les caractères hors GSM-7 (accents courants acceptés : é, è, à, ù… sont dans GSM-7 ; `ê`, `ô`, `â`, `ç` minuscule ne le sont pas et font passer tout le message en Unicode).

## 5. Modèles de messages (RF-SUP-042)

Les modèles sont rendus avec des variables `{{…}}` échappées. Les modèles globaux sont fournis ci-dessous ;
une association peut surcharger le texte (`modeles_notification.association_id`), pas les variables.

| Code | Canal | Texte par défaut (≤ 160 caractères visés) |
| --- | --- | --- |
| `otp` | sms | `AssoFlow : votre code est {{code}}. Valable 5 min. Ne le communiquez a personne.` |
| `invitation` | sms | `{{association.nom}} vous donne acces a AssoFlow. Telechargez l'app : {{lien}} et connectez-vous avec ce numero.` |
| `recu_paiement` | sms | `{{association.sigle}} : recu {{paiement.numero_recu}} - {{paiement.montant}} FCFA recus de {{membre.prenoms}} le {{paiement.date}}. Reste du : {{membre.reste_du}} FCFA.` |
| `annulation_paiement` | sms | `{{association.sigle}} : le recu {{paiement.numero_recu}} de {{paiement.montant}} FCFA a ete annule. Motif : {{motif}}.` |
| `rappel_avant` | sms | `{{association.sigle}} : rappel, {{montant}} FCFA de cotisation a regler avant le {{date}}. Merci.` |
| `rappel_retard` | sms | `{{association.sigle}} : votre cotisation de {{montant}} FCFA est en retard depuis le {{date}}. Contactez le tresorier.` |
| `depense_a_valider` | push+sms | `{{association.sigle}} : depense {{depense.numero}} de {{depense.montant}} FCFA a valider.` |
| `depense_decision` | push+sms | `{{association.sigle}} : depense {{depense.numero}} {{decision}}.` |
| `convocation` | sms | `{{association.sigle}} : {{reunion.titre}} le {{reunion.date}} a {{reunion.lieu}}. Ordre du jour dans l'app.` |
| `quota_sms` | sms | `AssoFlow : {{pourcentage}}% du quota SMS mensuel de {{association.nom}} utilise.` |

Les accents sont volontairement omis dans les modèles par défaut pour rester en GSM-7 (1 unité). Formats :
montants avec espace des milliers (`25 000`), dates `JJ/MM/AAAA`.

## 6. Critères mesurables

- Reçu de paiement : SMS remis au fournisseur **< 10 s** après le commit du paiement (p95), remis au téléphone
  **< 60 s** dans 95 % des cas mesurés au pilote (reformulation du critère d'acceptation 2).
- Métriques : `notifications_envoyees_total{canal,fournisseur,modele,statut}`, `notification_delai_envoi_seconds`,
  `notification_delai_remise_seconds`.

## 7. Rapports et exports

| Type de tâche | Sortie | Déclencheur |
| --- | --- | --- |
| `export_membres` | Excel / CSV | RF-039, console |
| `export_cotisants` | Excel | RF-039 |
| `rapport_financier` | PDF + Excel | RF-071/072, période choisie |
| `rapport_projet` | PDF | RF-055, et à la clôture (RG-PRJ-003) |
| `rapport_moral` | PDF | RF-073 (Should) |
| `export_audit` | CSV / JSONL | RF-ADM-042 |
| `import_membres_analyse`, `import_membres_confirmer` | rapport JSON | RF-024, RG-MBR-007 |
| `export_association_complet` | ZIP (JSON + fichiers) | Portabilité, RF-SUP-055 |

Cycle : `POST` → `202 { tacheId }` → la console interroge `GET /v1/taches/{id}` toutes les 2 s (ou notification) →
`terminee` avec URL présignée valable 5 min ; fichier supprimé après 7 jours.

## 8. Implémentation (sprint 4)

| Sujet | Implémentation |
| --- | --- |
| Outbox | `NotificationsService.preparer()` insère la ligne dans la transaction métier ; `publier()` met en file après le commit (`notification-<id>-<essai>`, file selon la priorité). Dédoublonnage par `cle_dedup` (`recu:<paiement>`, `annulation:<paiement>`, `rappel:<membre>:<jour>`, `relance:<membre>:<jour>`, `convocation:<réunion>:<membre>`, `quota:<mois>:<seuil>:<user>`) ; un renvoi de reçu n'a pas de clé. |
| Envoi | Réservation (`traitement_at`, reprise après 5 min), contrôle du quota (priorité > 1), envoi par le routeur **hors transaction**, puis `envoyee` + `consommation_sms`. Erreur transitoire avant la 5e tentative : la ligne reste `en_attente` et le job est relancé ; sinon `echec`. |
| Reprise | `notifications.reprise` chaque minute : lignes `en_attente` de plus de 2 min, non réservées, moins de 5 tentatives. |
| Fournisseurs | `RouteurSms` (ordre de `SMS_PROVIDERS`) : bascule sur le suivant à toute erreur ; disjoncteur (taux de remise < 90 % sur 1 h et ≥ 20 messages, fonction `app_remise_fournisseur_sms`, cache 1 min) qui place le fournisseur en dernier. Adaptateurs `agregateur_a` / `agregateur_b` (HTTP JSON + Bearer, format générique **à aligner sur l'API réelle des fournisseurs retenus**), `simulateur` / `simulateur_b` (recette, accusés simulés, panne simulable), `journal` (logs). Les OTP et invitations passent par le même routeur, en direct (hors tenant pour l'OTP). |
| Accusés | `POST /v1/webhooks/sms/{fournisseur}` : jeton `X-Webhook-Token` ; mise à jour par `app_accuse_sms` (seule la notification de cet identifiant). |
| Quotas | Mois civil GMT. `quotas.alerter` (toutes les heures) : alerte prioritaire `quota_sms` aux présidents à 80 % puis 100 %, une fois par seuil et par mois (`consommation_sms.alerte_*_at`). |
| Modèles | Texte personnalisé par l'association > modèle global en base > défaut du code (`packages/contracts`, `MODELES_NOTIFICATION`). OTP et `quota_sms` non personnalisables. L'édition des modèles globaux (P12) arrive avec la console plateforme (sprint 7). |
| Non livré | Métriques Prometheus `notifications_*` (sprint 8), WhatsApp et push (phase 2), expéditeur par fournisseur dans `parametres_plateforme` (variables d'environnement au MVP). |
