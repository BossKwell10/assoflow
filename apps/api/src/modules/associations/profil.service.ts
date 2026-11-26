import { Inject, Injectable, Logger } from '@nestjs/common';
import { masquerTelephone, type AssociationMaj } from '@assoflow/contracts';
import { createHash, randomUUID } from 'node:crypto';
import type { AuthRequete } from '../../common/auth/auth-requete.js';
import { PermissionsService } from '../../common/auth/permissions.service.js';
import { avecEtag, etagDe, verifierIfMatch } from '../../common/concurrence.js';
import { ErreurMetier } from '../../common/erreur-metier.js';
import type { Image } from '../../common/images.js';
import { DatabaseService, type Tx } from '../../infra/database.js';
import { STOCKAGE_OBJETS, type StockageObjets } from '../../infra/stockage/stockage-objets.js';
import { AuditService } from '../audit/audit.service.js';

interface LigneAssociation {
  id: string;
  nom: string;
  sigle: string | null;
  type: string;
  village: string;
  sous_prefecture: string | null;
  region: string;
  date_creation: string | null;
  recepisse_numero: string | null;
  recepisse_date: string | null;
  prefecture_depot: string | null;
  telephone: string | null;
  email: string | null;
  logo_cle: string | null;
  devise: string;
  mois_debut_exercice: number;
  seuil_double_validation: string;
  seuil_alerte_solde: string;
  jours_retard_dormant: number;
  journal_public_actif: boolean;
  statut: string;
  plan: string;
  quota_sms_mensuel: number;
}

/** Champs modifiables : nom d'API → colonne (GRANT UPDATE colonne par colonne, migration 0001 §10). */
const COLONNES: Record<keyof AssociationMaj, keyof LigneAssociation> = {
  nom: 'nom',
  sigle: 'sigle',
  type: 'type',
  village: 'village',
  sousPrefecture: 'sous_prefecture',
  region: 'region',
  dateCreation: 'date_creation',
  recepisseNumero: 'recepisse_numero',
  recepisseDate: 'recepisse_date',
  prefectureDepot: 'prefecture_depot',
  telephone: 'telephone',
  email: 'email',
  moisDebutExercice: 'mois_debut_exercice',
  seuilDoubleValidation: 'seuil_double_validation',
  seuilAlerteSolde: 'seuil_alerte_solde',
  joursRetardDormant: 'jours_retard_dormant',
  journalPublicActif: 'journal_public_actif',
};

const SELECT_ASSOCIATION = `SELECT id, nom, sigle, type, village, sous_prefecture, region, date_creation, recepisse_numero,
       recepisse_date, prefecture_depot, telephone, email::text AS email, logo_cle, devise, mois_debut_exercice,
       seuil_double_validation, seuil_alerte_solde, jours_retard_dormant, journal_public_actif, statut, plan,
       quota_sms_mensuel
  FROM associations WHERE id = app_association_id()`;

/** Profil et paramètres de l'association active (E2-03, RF-010, RF-011, RF-ADM-020, RF-ADM-024). */
@Injectable()
export class ProfilAssociationService {
  private readonly logger = new Logger('Association');

  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
    private readonly permissions: PermissionsService,
    @Inject(STOCKAGE_OBJETS) private readonly stockage: StockageObjets,
  ) {}

  lire() {
    return this.db.tx(async (tx) => this.versDto(await this.lireLigne(tx, false)));
  }

  async modifier(auth: AuthRequete, p: AssociationMaj, ifMatch: string | undefined) {
    return this.db.tx(async (tx) => {
      const avant = await this.lireLigne(tx, true);
      verifierIfMatch(ifMatch, etagDe(this.version(avant)), auth.canal);
      const changements: [keyof AssociationMaj, unknown, unknown][] = [];
      for (const [champ, colonne] of Object.entries(COLONNES) as [
        keyof AssociationMaj,
        keyof LigneAssociation,
      ][]) {
        const nouveau = p[champ];
        if (nouveau === undefined) continue;
        const ancien = this.valeurApi(champ, avant[colonne]);
        if (ancien !== nouveau) changements.push([champ, ancien, nouveau]);
      }
      if (changements.length === 0) return this.versDto(avant);
      // RG-ASS-003 : le seuil de double validation n'est modifiable que par le président.
      if (changements.some(([champ]) => champ === 'seuilDoubleValidation')) {
        const acces = await this.permissions.charger(
          auth.associationId!,
          auth.userId,
          auth.contexte.requestId,
        );
        if (acces?.roleCode !== 'president') {
          throw new ErreurMetier(
            'PERMISSION_REFUSEE',
            'Seul le président peut modifier le seuil de double validation (RG-ASS-003)',
          );
        }
      }
      const valeurs = changements.map(([, , v]) => v);
      const affectations = changements.map(([champ], i) => `${COLONNES[champ]} = $${i + 1}`);
      await tx.query(
        `UPDATE associations SET ${affectations.join(', ')} WHERE id = app_association_id()`,
        valeurs,
      );
      const masquer = (champ: string, v: unknown) =>
        champ === 'telephone' && typeof v === 'string' ? masquerTelephone(v) : v;
      await this.audit.tracer(tx, {
        associationId: auth.associationId!,
        action: 'association.modifiee',
        entiteType: 'association',
        entiteId: auth.associationId!,
        avant: Object.fromEntries(changements.map(([c, a]) => [c, masquer(c, a)])),
        apres: Object.fromEntries(changements.map(([c, , n]) => [c, masquer(c, n)])),
      });
      return this.versDto(await this.lireLigne(tx, false));
    });
  }

  /** Logo : objet déposé avant la transaction (pas d'appel réseau dans une transaction, docs/02 §5). */
  async remplacerLogo(auth: AuthRequete, image: Image) {
    const aid = auth.associationId!;
    const cle = `associations/${aid}/logo-${randomUUID()}.${image.extension}`;
    await this.stockage.deposer(cle, image.contenu, image.type);
    let ancienne: string | null = null;
    try {
      const dto = await this.db.tx(async (tx) => {
        const avant = await this.lireLigne(tx, true);
        ancienne = avant.logo_cle;
        await tx.query(`UPDATE associations SET logo_cle = $1 WHERE id = app_association_id()`, [cle]);
        await this.audit.tracer(tx, {
          associationId: aid,
          action: 'association.logo_modifie',
          entiteType: 'association',
          entiteId: aid,
          apres: { type: image.type, taille: image.contenu.length },
        });
        return this.versDto(await this.lireLigne(tx, false));
      });
      if (ancienne) await this.supprimerSansErreur(ancienne);
      return dto;
    } catch (e) {
      await this.supprimerSansErreur(cle);
      throw e;
    }
  }

  private async supprimerSansErreur(cle: string): Promise<void> {
    try {
      await this.stockage.supprimer(cle);
    } catch (e) {
      this.logger.warn(`Suppression de l'objet ${cle} impossible : ${(e as Error).message}`);
    }
  }

  private async lireLigne(tx: Tx, verrouiller: boolean): Promise<LigneAssociation> {
    const r = await tx.query<LigneAssociation>(`${SELECT_ASSOCIATION}${verrouiller ? ' FOR UPDATE' : ''}`);
    if (!r.rows[0]) throw new ErreurMetier('INTROUVABLE', 'Association introuvable');
    return r.rows[0];
  }

  private valeurApi(champ: keyof AssociationMaj, v: unknown): unknown {
    if (champ === 'seuilDoubleValidation' || champ === 'seuilAlerteSolde') return Number(v);
    return v;
  }

  /**
   * ETag = empreinte du contenu : `associations.updated_at` change à chaque écriture du tenant
   * (`app_next_sync_version` incrémente `sync_counter`), il ne peut donc pas servir de version.
   */
  private version(l: LigneAssociation): string {
    return createHash('sha256').update(JSON.stringify(l)).digest('base64url').slice(0, 22);
  }

  private async versDto(l: LigneAssociation) {
    const dto = {
      id: l.id,
      nom: l.nom,
      sigle: l.sigle,
      type: l.type,
      village: l.village,
      sousPrefecture: l.sous_prefecture,
      region: l.region,
      dateCreation: l.date_creation,
      recepisseNumero: l.recepisse_numero,
      recepisseDate: l.recepisse_date,
      prefectureDepot: l.prefecture_depot,
      telephone: l.telephone,
      email: l.email,
      logoUrl: l.logo_cle ? await this.stockage.urlLecture(l.logo_cle) : null,
      devise: l.devise,
      moisDebutExercice: l.mois_debut_exercice,
      seuilDoubleValidation: Number(l.seuil_double_validation),
      seuilAlerteSolde: Number(l.seuil_alerte_solde),
      joursRetardDormant: l.jours_retard_dormant,
      journalPublicActif: l.journal_public_actif,
      statut: l.statut,
      plan: l.plan,
      quotaSmsMensuel: l.quota_sms_mensuel,
    };
    return avecEtag(dto, this.version(l));
  }
}
