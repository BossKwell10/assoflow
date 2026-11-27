import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Injectable,
  Logger,
  Module,
  Param,
  Post,
  Query,
  Res,
  type OnModuleInit,
} from '@nestjs/common';
import {
  demandeRapportSchema,
  MODES_PAIEMENT,
  motifSchema,
  paiementCreationSchema,
  type DemandeRapport,
} from '@assoflow/contracts';
import ExcelJS from 'exceljs';
import type { FastifyReply } from 'fastify';
import { z } from 'zod';
import type { AuthRequete } from '../../common/auth/auth-requete.js';
import { Auth, Permission } from '../../common/auth/decorateurs.js';
import { invalide, referenceInvalide } from '../../common/base-de-donnees.js';
import { lireBooleen, lireLimite } from '../../common/pagination.js';
import { valider } from '../../common/validation.js';
import { DatabaseService } from '../../infra/database.js';
import { FilesService } from '../../infra/files/files.js';
import { STOCKAGE_OBJETS, type StockageObjets } from '../../infra/stockage/stockage-objets.js';
import { AvancesService } from '../cotisations/avances.service.js';
import { CotisationsModule } from '../cotisations/cotisations.module.js';
import { MembresModule } from '../membres/membres.module.js';
import { NotificationsModule } from '../notifications/notifications.module.js';
import { DiffusionService } from '../notifications/diffusion.service.js';
import { TachesService, type TacheEnCours } from '../taches/taches.service.js';
import { TresorerieModule } from '../tresorerie/tresorerie.module.js';
import { idPipe } from '../utilisateurs/acces.controller.js';
import { PaiementsService } from './paiements.service.js';
import { RecuService } from './recu.service.js';

const filtresPaiements = z.object({
  membreId: z.uuid().optional(),
  familleId: z.uuid().optional(),
  campagneId: z.uuid().optional(),
  mode: z.enum(MODES_PAIEMENT).optional(),
  compteId: z.uuid().optional(),
  du: z.iso.date().optional(),
  au: z.iso.date().optional(),
  saisiPar: z.uuid().optional(),
  inclureAnnules: z.string().optional(),
  limite: z.string().optional(),
  curseur: z.string().optional(),
});

/** Paiements (E4-05 à E4-11, RF-032 à RF-035, RF-038). */
@Controller('paiements')
export class PaiementsController {
  constructor(
    private readonly paiements: PaiementsService,
    private readonly recus: RecuService,
  ) {}

  @Get()
  @Permission('cotisation.lire')
  lister(@Auth() auth: AuthRequete, @Query() query: unknown) {
    const f = valider(filtresPaiements, query);
    return this.paiements.lister(auth, {
      ...f,
      inclureAnnules: lireBooleen(f.inclureAnnules, 'inclureAnnules'),
      limite: lireLimite(f.limite),
    });
  }

  @Post()
  @Permission('paiement.enregistrer')
  async creer(
    @Auth() auth: AuthRequete,
    @Body() corps: unknown,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const { dto, cree } = await this.paiements.creer(auth, valider(paiementCreationSchema, corps));
    void reply.status(cree ? 201 : 200);
    return dto;
  }

  @Get(':id')
  @Permission('cotisation.lire')
  lire(@Auth() auth: AuthRequete, @Param('id', idPipe) id: string) {
    return this.paiements.lire(auth, id);
  }

  @Post(':id/annuler')
  @HttpCode(201)
  @Permission('paiement.annuler')
  annuler(@Auth() auth: AuthRequete, @Param('id', idPipe) id: string, @Body() corps: unknown) {
    return this.paiements.annuler(auth, id, valider(motifSchema, corps).motif);
  }

  /** RF-033 : reçu PDF servi directement (docs/07 §6). */
  @Get(':id/recu')
  @Permission('cotisation.lire')
  async recu(
    @Auth() auth: AuthRequete,
    @Param('id', idPipe) id: string,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const { contenu, nomFichier } = await this.recus.pdf(auth, id);
    void reply.type('application/pdf').header('content-disposition', `inline; filename="${nomFichier}"`);
    return contenu;
  }

  @Post(':id/renvoyer-recu')
  @HttpCode(202)
  @Permission('paiement.enregistrer')
  renvoyerRecu(@Auth() auth: AuthRequete, @Param('id', idPipe) id: string) {
    return this.paiements.renvoyerRecu(auth, id);
  }
}

/**
 * Exports asynchrones (`POST /rapports`, docs/06 §7). Sprint 4 : `export_cotisants` (RF-039, E4-12) ; les rapports
 * financiers, l'export des membres et de l'audit arrivent aux sprints 6 et 7.
 */
@Injectable()
export class ExportsService implements OnModuleInit {
  constructor(
    private readonly db: DatabaseService,
    private readonly taches: TachesService,
    @Inject(STOCKAGE_OBJETS) private readonly stockage: StockageObjets,
  ) {}

  onModuleInit(): void {
    this.taches.enregistrer('export_cotisants', (t) => this.exporterCotisants(t));
  }

  async demander(auth: AuthRequete, d: DemandeRapport) {
    if (d.type !== 'export_cotisants') {
      throw invalide('type', 'NON_DISPONIBLE', 'Ce rapport sera disponible dans une prochaine version');
    }
    if (d.format !== 'xlsx')
      throw invalide('format', 'NON_DISPONIBLE', 'Export des cotisants au format xlsx');
    const parametres = { campagneId: d.parametres?.campagneId, exerciceId: d.parametres?.exerciceId };
    return this.taches.creer(auth, 'export_cotisants', parametres, async (tx) => {
      if (parametres.campagneId) {
        const r = await tx.query(`SELECT 1 FROM campagnes_cotisation WHERE id = $1`, [parametres.campagneId]);
        if (!r.rows[0]) throw referenceInvalide('parametres.campagneId', 'Campagne introuvable');
      }
      if (parametres.exerciceId) {
        const r = await tx.query(`SELECT 1 FROM exercices WHERE id = $1`, [parametres.exerciceId]);
        if (!r.rows[0]) throw referenceInvalide('parametres.exerciceId', 'Exercice introuvable');
      }
    });
  }

  /** Une ligne par membre ayant des échéances dans le périmètre : dû, payé, reste échu, situation. */
  private async exporterCotisants(t: TacheEnCours): Promise<Record<string, unknown>> {
    const { campagneId, exerciceId } = t.parametres as { campagneId?: string; exerciceId?: string };
    const lignes = await this.db.tx(async (tx) => {
      const r = await tx.query<{
        numero: string;
        nom: string;
        prenoms: string;
        telephone: string | null;
        categorie: string | null;
        famille: string | null;
        echeances: number;
        du: string;
        paye: string;
        reste_echu: string;
        en_retard: number;
      }>(
        `SELECT m.numero, m.nom, m.prenoms, m.telephone, cat.libelle AS categorie, f.nom AS famille,
                count(*)::int AS echeances, sum(e.montant_du)::bigint AS du,
                sum(least(e.montant_paye, e.montant_du))::bigint AS paye,
                coalesce(sum(greatest(e.montant_du - e.montant_paye, 0)) FILTER (WHERE e.date_echeance <= current_date), 0)::bigint AS reste_echu,
                count(*) FILTER (WHERE e.situation = 'en_retard')::int AS en_retard
           FROM v_echeances_situation e
           JOIN campagnes_cotisation c ON c.id = e.campagne_id
           JOIN membres m ON m.id = e.membre_id
           LEFT JOIN categories_membres cat ON cat.id = m.categorie_id
           LEFT JOIN familles f ON f.id = m.famille_id
          WHERE ($1::uuid IS NULL OR e.campagne_id = $1) AND ($2::uuid IS NULL OR c.exercice_id = $2)
          GROUP BY m.id, m.numero, m.nom, m.prenoms, m.telephone, cat.libelle, f.nom
          ORDER BY m.numero`,
        [campagneId ?? null, exerciceId ?? null],
      );
      return r.rows;
    });
    await t.avancer(50);
    const classeur = new ExcelJS.Workbook();
    classeur.creator = 'AssoFlow';
    const feuille = classeur.addWorksheet('Cotisants');
    feuille.columns = [
      { header: 'Numéro', key: 'numero', width: 13 },
      { header: 'Nom', key: 'nom', width: 20 },
      { header: 'Prénoms', key: 'prenoms', width: 24 },
      { header: 'Téléphone', key: 'telephone', width: 16 },
      { header: 'Catégorie', key: 'categorie', width: 18 },
      { header: 'Famille', key: 'famille', width: 18 },
      { header: 'Échéances', key: 'echeances', width: 10 },
      { header: 'Dû (FCFA)', key: 'du', width: 12 },
      { header: 'Payé (FCFA)', key: 'paye', width: 12 },
      { header: 'Reste dû échu (FCFA)', key: 'reste', width: 18 },
      { header: 'Situation', key: 'situation', width: 12 },
    ];
    feuille.getRow(1).font = { bold: true };
    for (const l of lignes) {
      feuille.addRow({
        numero: l.numero,
        nom: l.nom,
        prenoms: l.prenoms,
        telephone: l.telephone ?? '',
        categorie: l.categorie ?? '',
        famille: l.famille ?? '',
        echeances: l.echeances,
        du: Number(l.du),
        paye: Number(l.paye),
        reste: Number(l.reste_echu),
        situation: l.en_retard > 0 ? 'En retard' : 'À jour',
      });
    }
    for (const c of ['du', 'paye', 'reste']) feuille.getColumn(c).numFmt = '#,##0';
    const contenu = Buffer.from(await classeur.xlsx.writeBuffer());
    const cle = `exports/${t.associationId}/${t.id}.xlsx`;
    await this.stockage.deposer(
      cle,
      contenu,
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    return {
      _cle: cle,
      nomFichier: `cotisants-${new Date().toISOString().slice(0, 10)}.xlsx`,
      lignes: lignes.length,
    };
  }
}

@Controller('rapports')
export class RapportsController {
  constructor(private readonly exports: ExportsService) {}

  @Post()
  @HttpCode(202)
  @Permission('rapport.exporter')
  demander(@Auth() auth: AuthRequete, @Body() corps: unknown) {
    return this.exports.demander(auth, valider(demandeRapportSchema, corps));
  }
}

/** RG-COT-022 : filet de sécurité horaire de l'imputation des avances (docs/06 §3). */
@Injectable()
export class AvancesPlanifiees implements OnModuleInit {
  private readonly logger = new Logger('Avances');

  constructor(
    private readonly db: DatabaseService,
    private readonly files: FilesService,
    private readonly avances: AvancesService,
    private readonly diffusion: DiffusionService,
  ) {}

  onModuleInit(): void {
    this.files.planifier({
      nom: 'avances.imputer',
      cron: '15 * * * *',
      executer: () => this.diffusion.pourToutes('avances', (id) => this.imputer(id)),
    });
  }

  async imputer(associationId: string): Promise<number> {
    const r = await this.db.tx(
      async (tx) => {
        const membres = await tx.query<{ membre_id: string }>(
          `SELECT i.membre_id FROM imputations_paiement i
            WHERE i.echeance_id IS NULL
              AND NOT EXISTS (SELECT 1 FROM paiements a WHERE a.annule_paiement_id = i.paiement_id)
            GROUP BY i.membre_id HAVING sum(i.montant) > 0`,
        );
        return this.avances.imputer(
          tx,
          membres.rows.map((m) => m.membre_id),
        );
      },
      { requestId: `job-avances-${associationId}`, associationId },
    );
    if (r.montant > 0) this.logger.log(`Avances imputées (${associationId}) : ${r.montant} FCFA`);
    return r.montant;
  }
}

/** Paiements, reçus, annulations, exports des cotisants (E4-05 à E4-12). */
@Module({
  imports: [CotisationsModule, MembresModule, NotificationsModule, TresorerieModule],
  controllers: [PaiementsController, RapportsController],
  providers: [PaiementsService, RecuService, ExportsService, AvancesPlanifiees],
})
export class PaiementsModule {}
