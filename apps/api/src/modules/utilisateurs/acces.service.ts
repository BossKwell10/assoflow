import { Inject, Injectable, Logger } from '@nestjs/common';
import { masquerTelephone } from '@assoflow/contracts';
import type { AuthRequete } from '../../common/auth/auth-requete.js';
import { PermissionsService } from '../../common/auth/permissions.service.js';
import { ErreurMetier } from '../../common/erreur-metier.js';
import { decoderCurseur, encoderCurseur } from '../../common/pagination.js';
import { DatabaseService, type Tx } from '../../infra/database.js';
import { IdempotenceService } from '../../infra/idempotence.service.js';
import { FOURNISSEUR_SMS, type FournisseurSms } from '../../infra/sms/fournisseur-sms.js';
import { AuditService } from '../audit/audit.service.js';
import { ComptesService, type ResumeCompte } from '../auth/comptes.service.js';
import { SessionsService } from '../auth/sessions.service.js';
import { RolesService, type RoleDto } from './roles.service.js';

export interface AccesDto {
  id: string;
  user: {
    id: string;
    telephone: string;
    nom: string;
    prenoms: string;
    derniereConnexion: string | null;
    verrouille: boolean;
  };
  role: RoleDto;
  membreId: string | null;
  mandatDebut: string | null;
  mandatFin: string | null;
  statut: 'actif' | 'revoque' | 'expire';
}

interface LigneAcces {
  id: string;
  user_id: string;
  membre_id: string | null;
  mandat_debut: string | null;
  mandat_fin: string | null;
  statut: 'actif' | 'revoque' | 'expire';
  curseur_ts: string;
  role_id: string;
  role_code: string;
  role_libelle: string;
  role_permissions: string[];
  role_systeme: boolean;
}

const SELECT_ACCES = `SELECT a.id, a.user_id, a.membre_id, a.mandat_debut, a.mandat_fin, a.statut,
       a.created_at::text AS curseur_ts, r.id AS role_id, r.code AS role_code, r.libelle AS role_libelle,
       r.permissions AS role_permissions, r.systeme AS role_systeme
  FROM acces_association a JOIN roles r ON r.id = a.role_id`;

/** Accès au bureau et aux membres avec app (E2-06, RF-ADM-010 à 014). */
@Injectable()
export class AccesService {
  private readonly logger = new Logger('Acces');

  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
    private readonly comptes: ComptesService,
    private readonly sessions: SessionsService,
    private readonly roles: RolesService,
    private readonly permissions: PermissionsService,
    private readonly idempotence: IdempotenceService,
    @Inject(FOURNISSEUR_SMS) private readonly sms: FournisseurSms,
  ) {}

  async lister(f: { statut?: string; roleId?: string; limite: number; curseur?: string }) {
    const position = decoderCurseur(f.curseur);
    return this.db.tx(async (tx) => {
      const r = await tx.query<LigneAcces>(
        `${SELECT_ACCES}
          WHERE ($1::text IS NULL OR a.statut = $1)
            AND ($2::uuid IS NULL OR a.role_id = $2)
            AND ($3::timestamptz IS NULL OR (a.created_at, a.id) > ($3::timestamptz, $4::uuid))
          ORDER BY a.created_at, a.id
          LIMIT $5`,
        [f.statut ?? null, f.roleId ?? null, position?.ts ?? null, position?.id ?? null, f.limite + 1],
      );
      const lignes = r.rows.slice(0, f.limite);
      const suivante = r.rows.length > f.limite ? lignes[lignes.length - 1]! : null;
      return {
        donnees: await this.versDtos(tx, lignes),
        page: {
          curseurSuivant: suivante ? encoderCurseur({ ts: suivante.curseur_ts, id: suivante.id }) : null,
          total: null,
        },
      };
    });
  }

  /**
   * Invitation (docs/04 §2.1) : crée le compte si besoin (clé = téléphone), l'accès, puis envoie le SMS
   * d'invitation après le commit. Idempotente avec `Idempotency-Key`.
   */
  async inviter(
    auth: AuthRequete,
    p: {
      telephone: string;
      nom: string;
      prenoms: string;
      roleId: string;
      membreId?: string;
      mandatDebut?: string;
      mandatFin?: string;
    },
    cleIdempotence?: string,
    /** Complément exécuté dans la même transaction après la création (ex. lien membre ↔ compte). */
    apresCreation?: (tx: Tx, acces: AccesDto) => Promise<void>,
  ): Promise<AccesDto> {
    const aid = auth.associationId!;
    const { reponse, rejouee, associationNom } = await this.db.tx(async (tx) => {
      const nom = await tx.query<{ nom: string }>(`SELECT nom FROM associations WHERE id = $1`, [aid]);
      const resultat = await this.idempotence.executer(
        tx,
        { associationId: aid, userId: auth.userId, cle: cleIdempotence, corps: p, statut: 201 },
        async () => {
          const role = await this.roles.lire(tx, p.roleId);
          if (!role) throw this.referenceInvalide('roleId', 'Rôle introuvable');
          if (p.membreId) {
            const m = await tx.query(`SELECT 1 FROM membres WHERE id = $1 AND deleted_at IS NULL`, [
              p.membreId,
            ]);
            if ((m.rowCount ?? 0) === 0) throw this.referenceInvalide('membreId', 'Membre introuvable');
          }
          const compte = await this.comptes.trouverOuCreer(tx, p);
          const actif = await tx.query(
            `SELECT 1 FROM acces_association WHERE user_id = $1 AND statut = 'actif'`,
            [compte.id],
          );
          if ((actif.rowCount ?? 0) > 0) {
            throw new ErreurMetier(
              'ETAT_INCOMPATIBLE',
              'Cette personne a déjà un accès actif à l’association',
            );
          }
          const r = await tx.query<{ id: string }>(
            `INSERT INTO acces_association (association_id, user_id, role_id, membre_id, mandat_debut, mandat_fin)
             VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
            [aid, compte.id, p.roleId, p.membreId ?? null, p.mandatDebut ?? null, p.mandatFin ?? null],
          );
          const id = r.rows[0]!.id;
          await this.audit.tracer(tx, {
            associationId: aid,
            action: 'acces.cree',
            entiteType: 'acces',
            entiteId: id,
            apres: {
              userId: compte.id,
              telephone: masquerTelephone(p.telephone),
              role: role.code,
              compteCree: compte.cree,
              mandatDebut: p.mandatDebut ?? null,
              mandatFin: p.mandatFin ?? null,
            },
          });
          const dto = await this.lireDto(tx, id);
          await apresCreation?.(tx, dto);
          return dto;
        },
      );
      return { ...resultat, associationNom: nom.rows[0]?.nom ?? 'votre association' };
    });
    if (!rejouee) {
      await this.permissions.invalider(aid, reponse.user.id);
      try {
        await this.sms.envoyer({
          to: reponse.user.telephone,
          texte: `Votre accès AssoFlow à ${associationNom} est prêt. Téléchargez l'app et connectez-vous avec ce numéro.`,
          ref: `invitation:${reponse.id}`,
        });
      } catch (e) {
        this.logger.error(`Envoi de l'invitation ${reponse.id} impossible : ${(e as Error).message}`);
      }
    }
    return reponse;
  }

  /** Changement de rôle ou de mandat (RF-ADM-011, RF-ADM-013). */
  async modifier(
    auth: AuthRequete,
    id: string,
    p: { roleId?: string; mandatDebut?: string | null; mandatFin?: string | null },
  ): Promise<AccesDto> {
    const aid = auth.associationId!;
    const dto = await this.db.tx(async (tx) => {
      const avant = await this.lireLigne(tx, id, true);
      if (avant.statut !== 'actif')
        throw new ErreurMetier('ETAT_INCOMPATIBLE', 'Seul un accès actif est modifiable');
      let roleCode = avant.role_code;
      if (p.roleId && p.roleId !== avant.role_id) {
        const role = await this.roles.lire(tx, p.roleId);
        if (!role) throw this.referenceInvalide('roleId', 'Rôle introuvable');
        roleCode = role.code;
        if (avant.role_code === 'president' && roleCode !== 'president')
          await this.exigerAutrePresident(tx, id);
      }
      const mandatDebut = p.mandatDebut === undefined ? avant.mandat_debut : p.mandatDebut;
      const mandatFin = p.mandatFin === undefined ? avant.mandat_fin : p.mandatFin;
      if (mandatDebut && mandatFin && mandatFin < mandatDebut) {
        throw new ErreurMetier('VALIDATION', 'Mandat incohérent', [
          { champ: 'mandatFin', code: 'INVALIDE', message: 'La fin de mandat doit suivre le début' },
        ]);
      }
      await tx.query(
        `UPDATE acces_association SET role_id = $2, mandat_debut = $3, mandat_fin = $4 WHERE id = $1`,
        [id, p.roleId ?? avant.role_id, mandatDebut, mandatFin],
      );
      await this.audit.tracer(tx, {
        associationId: aid,
        action: 'acces.modifie',
        entiteType: 'acces',
        entiteId: id,
        avant: { role: avant.role_code, mandatDebut: avant.mandat_debut, mandatFin: avant.mandat_fin },
        apres: { role: roleCode, mandatDebut, mandatFin },
      });
      return this.lireDto(tx, id);
    });
    await this.permissions.invalider(aid, dto.user.id);
    return dto;
  }

  /** RF-ADM-014 : révocation immédiate ; sessions du tenant révoquées, cache invalidé. */
  async revoquer(auth: AuthRequete, id: string, motif: string): Promise<AccesDto> {
    const aid = auth.associationId!;
    const dto = await this.db.tx(async (tx) => {
      const avant = await this.lireLigne(tx, id, true);
      if (avant.statut !== 'actif') throw new ErreurMetier('ETAT_INCOMPATIBLE', 'Cet accès n’est plus actif');
      if (avant.role_code === 'president') await this.exigerAutrePresident(tx, id);
      await tx.query(
        `UPDATE acces_association SET statut = 'revoque', revoque_at = now(), revoque_par = $2, motif_revocation = $3
          WHERE id = $1`,
        [id, auth.userId, motif],
      );
      const sessions = await this.sessions.revoquerUtilisateur(tx, avant.user_id, aid);
      await this.audit.tracer(tx, {
        associationId: aid,
        action: 'acces.revoque',
        entiteType: 'acces',
        entiteId: id,
        avant: { statut: 'actif', role: avant.role_code },
        apres: { statut: 'revoque', motif, sessionsRevoquees: sessions },
      });
      return this.lireDto(tx, id);
    });
    await this.permissions.invalider(aid, dto.user.id);
    return dto;
  }

  /** RF-005 : un administrateur déverrouille le compte d'une personne ayant un accès à son association. */
  async deverrouiller(auth: AuthRequete, id: string): Promise<void> {
    await this.db.tx(async (tx) => {
      const acces = await this.lireLigne(tx, id, false);
      const { etaitVerrouille } = await this.comptes.deverrouiller(tx, acces.user_id);
      await this.audit.tracer(tx, {
        associationId: auth.associationId!,
        action: 'utilisateur.deverrouille',
        entiteType: 'utilisateur',
        entiteId: acces.user_id,
        apres: { accesId: id, etaitVerrouille },
      });
    });
  }

  /** Garde-fou : l'association garde au moins un président actif. */
  private async exigerAutrePresident(tx: Tx, accesId: string): Promise<void> {
    const r = await tx.query(
      `SELECT 1 FROM acces_association a JOIN roles r ON r.id = a.role_id
        WHERE r.code = 'president' AND a.statut = 'actif' AND a.id <> $1 LIMIT 1`,
      [accesId],
    );
    if ((r.rowCount ?? 0) === 0) {
      throw new ErreurMetier('PRESIDENT_REQUIS', "L'association doit garder au moins un président actif");
    }
  }

  private referenceInvalide(champ: string, message: string): ErreurMetier {
    return new ErreurMetier('REFERENCE_INVALIDE', message, [{ champ, code: 'REFERENCE_INVALIDE', message }]);
  }

  /** Relu sous RLS : un accès d'un autre tenant est introuvable (404, jamais 403 — docs/04 §5). */
  private async lireLigne(tx: Tx, id: string, verrouiller: boolean): Promise<LigneAcces> {
    const r = await tx.query<LigneAcces>(
      `${SELECT_ACCES} WHERE a.id = $1 ${verrouiller ? 'FOR UPDATE OF a' : ''}`,
      [id],
    );
    if (!r.rows[0]) throw new ErreurMetier('INTROUVABLE', 'Accès introuvable');
    return r.rows[0];
  }

  private async lireDto(tx: Tx, id: string): Promise<AccesDto> {
    return (await this.versDtos(tx, [await this.lireLigne(tx, id, false)]))[0]!;
  }

  private async versDtos(tx: Tx, lignes: LigneAcces[]): Promise<AccesDto[]> {
    const comptes = await this.comptes.resumes(tx, [...new Set(lignes.map((l) => l.user_id))]);
    return lignes.map((l) => {
      const c = comptes.get(l.user_id) as ResumeCompte;
      return {
        id: l.id,
        user: {
          id: c.id,
          telephone: c.telephone,
          nom: c.nom,
          prenoms: c.prenoms,
          derniereConnexion: c.derniereConnexion?.toISOString() ?? null,
          verrouille: c.verrouille,
        },
        role: {
          id: l.role_id,
          code: l.role_code,
          libelle: l.role_libelle,
          permissions: l.role_permissions,
          systeme: l.role_systeme,
        },
        membreId: l.membre_id,
        mandatDebut: l.mandat_debut,
        mandatFin: l.mandat_fin,
        statut: l.statut,
      };
    });
  }
}
