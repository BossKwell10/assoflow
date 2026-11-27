import { Injectable, type OnModuleInit } from '@nestjs/common';
import { uuidv7, type MembreCreation } from '@assoflow/contracts';
import type { AuthRequete } from '../../../common/auth/auth-requete.js';
import { ErreurMetier } from '../../../common/erreur-metier.js';
import { DatabaseService, type Tx } from '../../../infra/database.js';
import { AuditService } from '../../audit/audit.service.js';
import { TachesService, type TacheEnCours } from '../../taches/taches.service.js';
import { FamillesService } from '../familles.service.js';
import { MembresService } from '../membres.service.js';
import { analyserLigne, normaliser, type MembreImporte, type Referentiels } from './analyse.js';
import { lireFichierImport, type LigneBrute } from './lecture-fichier.js';

export const TACHE_ANALYSE = 'import_membres_analyse';
export const TACHE_CONFIRMATION = 'import_membres_confirmer';

type StatutAnalyse = 'a_creer' | 'doublon_probable' | 'erreur';

export interface DetailLigne {
  ligne: number;
  statut: StatutAnalyse;
  nom: string;
  message: string | null;
}

/** Ligne retenue après analyse (conservée dans le résultat interne `_lignes` pour la confirmation). */
interface LigneRetenue {
  ligne: number;
  statut: Exclude<StatutAnalyse, 'erreur'>;
  donnees: MembreImporte;
}

interface ResultatAnalyse {
  nomFichier: string;
  lignes: number;
  aCreer: number;
  doublons: number;
  erreurs: number;
  colonnesIgnorees: string[];
  details: DetailLigne[];
  _lignes: LigneRetenue[];
}

interface Existant {
  id: string;
  numero: string;
  nom: string;
  prenoms: string;
  dateNaissance: string | null;
}

/** RG-MBR-003 : même téléphone et (mêmes nom + prénoms, ou même date de naissance). */
function memePersonne(a: Omit<Existant, 'id' | 'numero'>, b: Omit<Existant, 'id' | 'numero'>): boolean {
  return (
    (normaliser(a.nom) === normaliser(b.nom) && normaliser(a.prenoms) === normaliser(b.prenoms)) ||
    (a.dateNaissance !== null && a.dateNaissance === b.dateNaissance)
  );
}

/**
 * Import de membres en deux temps (E3-08, RF-024, RG-MBR-007) :
 * 1. `POST /membres/import` : structure du fichier vérifiée tout de suite (422), puis analyse ligne par ligne en
 *    tâche (`import_membres_analyse`) : à créer, doublon probable (base ou fichier), erreur ;
 * 2. `POST /membres/import/{id}/confirmer` : création en tâche (`import_membres_confirmer`), une seule fois par
 *    analyse ; doublons inclus sur demande et alors marqués « à vérifier » (écran A7).
 * Chaque membre est créé par `MembresService.creer` : mêmes règles, numérotation et audit que la saisie manuelle.
 */
@Injectable()
export class ImportMembresService implements OnModuleInit {
  constructor(
    private readonly db: DatabaseService,
    private readonly taches: TachesService,
    private readonly membres: MembresService,
    private readonly familles: FamillesService,
    private readonly audit: AuditService,
  ) {}

  onModuleInit(): void {
    this.taches.enregistrer(TACHE_ANALYSE, (t) => this.analyser(t));
    this.taches.enregistrer(TACHE_CONFIRMATION, (t) => this.executerConfirmation(t));
  }

  async demanderAnalyse(auth: AuthRequete, fichier: { contenu: Buffer; nom: string }) {
    const { lignes, colonnesIgnorees } = await lireFichierImport(fichier.contenu);
    return this.taches.creer(auth, TACHE_ANALYSE, { nomFichier: fichier.nom, colonnesIgnorees, lignes });
  }

  /** Rapport d'analyse (`RapportImport`) ; `409` tant que l'analyse n'est pas terminée. */
  rapport(auth: AuthRequete, tacheId: string) {
    return this.db.tx(async (tx) => {
      const t = await this.taches.ligne(tx, auth.userId, tacheId, TACHE_ANALYSE);
      if (t.statut === 'echec') throw new ErreurMetier('ETAT_INCOMPATIBLE', t.erreur ?? 'Analyse en échec');
      if (t.statut !== 'terminee') throw new ErreurMetier('ETAT_INCOMPATIBLE', 'Analyse en cours');
      const r = t.resultat as unknown as ResultatAnalyse;
      return {
        tacheId,
        nomFichier: r.nomFichier,
        lignes: r.lignes,
        aCreer: r.aCreer,
        doublons: r.doublons,
        erreurs: r.erreurs,
        colonnesIgnorees: r.colonnesIgnorees,
        details: r.details,
        confirmationId: (t.parametres.confirmationId as string | undefined) ?? null,
      };
    });
  }

  /** Lance la création ; une analyse ne se confirme qu'une fois (`409` ensuite). */
  confirmer(auth: AuthRequete, tacheId: string, inclureDoublons: boolean) {
    return this.taches.creer(
      auth,
      TACHE_CONFIRMATION,
      { analyseId: tacheId, inclureDoublons },
      async (tx, id) => {
        await tx.query(`SELECT 1 FROM taches WHERE id = $1 FOR UPDATE`, [tacheId]);
        const t = await this.taches.ligne(tx, auth.userId, tacheId, TACHE_ANALYSE);
        if (t.statut !== 'terminee') {
          throw new ErreurMetier('ETAT_INCOMPATIBLE', 'L’analyse n’est pas terminée : attendez son rapport');
        }
        if (t.parametres.confirmationId) {
          throw new ErreurMetier('ETAT_INCOMPATIBLE', 'Cet import a déjà été confirmé');
        }
        const r = t.resultat as unknown as ResultatAnalyse;
        if (r.aCreer + (inclureDoublons ? r.doublons : 0) === 0) {
          throw new ErreurMetier('VALIDATION', 'Aucune ligne à créer', [
            { champ: 'inclureDoublons', code: 'AUCUNE_LIGNE', message: 'Aucune ligne à créer' },
          ]);
        }
        await tx.query(
          `UPDATE taches SET parametres = parametres || jsonb_build_object('confirmationId', $2::text) WHERE id = $1`,
          [tacheId, id],
        );
      },
    );
  }

  // --- Exécution des tâches ---------------------------------------------------------------------------------

  private async referentiels(tx: Tx): Promise<Referentiels & { parTelephone: Map<string, Existant[]> }> {
    const categories = await tx.query<{ id: string; libelle: string }>(
      `SELECT id, libelle FROM categories_membres WHERE deleted_at IS NULL AND actif`,
    );
    const familles = await tx.query<{ id: string; nom: string; chef_joignable: boolean }>(
      `SELECT f.id, f.nom, coalesce(c.telephone IS NOT NULL, false) AS chef_joignable
         FROM familles f LEFT JOIN membres c ON c.id = f.chef_famille_id
        WHERE f.deleted_at IS NULL ORDER BY f.created_at`,
    );
    const membres = await tx.query<{
      id: string;
      numero: string;
      nom: string;
      prenoms: string;
      telephone: string;
      date_naissance: string | null;
    }>(
      `SELECT id, numero, nom, prenoms, telephone, date_naissance FROM membres
        WHERE telephone IS NOT NULL AND deleted_at IS NULL AND anonymise_at IS NULL ORDER BY created_at, id`,
    );
    const parTelephone = new Map<string, Existant[]>();
    for (const m of membres.rows) {
      const liste = parTelephone.get(m.telephone) ?? [];
      liste.push({
        id: m.id,
        numero: m.numero,
        nom: m.nom,
        prenoms: m.prenoms,
        dateNaissance: m.date_naissance,
      });
      parTelephone.set(m.telephone, liste);
    }
    const mapFamilles = new Map<string, { id: string; nom: string; chefJoignable: boolean }>();
    for (const f of familles.rows) {
      const cle = normaliser(f.nom);
      if (!mapFamilles.has(cle))
        mapFamilles.set(cle, { id: f.id, nom: f.nom, chefJoignable: f.chef_joignable });
    }
    return {
      categories: new Map(categories.rows.map((c) => [normaliser(c.libelle), c.id])),
      familles: mapFamilles,
      aujourdhui: new Date().toISOString().slice(0, 10),
      parTelephone,
    };
  }

  private async analyser(t: TacheEnCours): Promise<Record<string, unknown>> {
    const lignes = t.parametres.lignes as LigneBrute[];
    const ref = await this.db.tx((tx) => this.referentiels(tx));
    const dansFichier = new Map<string, (Omit<Existant, 'id' | 'numero'> & { ligne: number })[]>();
    const details: DetailLigne[] = [];
    const retenues: LigneRetenue[] = [];
    let aCreer = 0;
    let doublons = 0;
    let erreurs = 0;
    for (const [i, l] of lignes.entries()) {
      const nom = [l.prenoms, l.nom].filter(Boolean).join(' ');
      const a = analyserLigne(l, ref);
      if ('erreurs' in a) {
        erreurs++;
        details.push({ ligne: l.numero, statut: 'erreur', nom, message: a.erreurs.join(' ; ') });
      } else {
        const d = a.donnees;
        let message: string | null = null;
        if (d.telephone) {
          const personne = { nom: d.nom, prenoms: d.prenoms, dateNaissance: d.dateNaissance };
          const base = ref.parTelephone.get(d.telephone)?.find((e) => memePersonne(e, personne));
          const fichier = dansFichier.get(d.telephone)?.find((e) => memePersonne(e, personne));
          if (base) message = `Doublon probable de ${base.numero} — ${base.prenoms} ${base.nom}`;
          else if (fichier) message = `Doublon probable de la ligne ${fichier.ligne}`;
          const liste = dansFichier.get(d.telephone) ?? [];
          liste.push({ ...personne, ligne: l.numero });
          dansFichier.set(d.telephone, liste);
        }
        if (message) {
          doublons++;
          details.push({ ligne: l.numero, statut: 'doublon_probable', nom, message });
          retenues.push({ ligne: l.numero, statut: 'doublon_probable', donnees: d });
        } else {
          aCreer++;
          retenues.push({ ligne: l.numero, statut: 'a_creer', donnees: d });
        }
      }
      if (i % 250 === 0) await t.avancer((i / lignes.length) * 100);
    }
    const resultat: ResultatAnalyse = {
      nomFichier: t.parametres.nomFichier as string,
      lignes: lignes.length,
      aCreer,
      doublons,
      erreurs,
      colonnesIgnorees: t.parametres.colonnesIgnorees as string[],
      details,
      _lignes: retenues,
    };
    return resultat as unknown as Record<string, unknown>;
  }

  private async executerConfirmation(t: TacheEnCours): Promise<Record<string, unknown>> {
    const inclureDoublons = t.parametres.inclureDoublons === true;
    const analyse = await this.db.tx((tx) =>
      this.taches.ligne(tx, t.userId, t.parametres.analyseId as string, TACHE_ANALYSE),
    );
    const r = analyse.resultat as unknown as ResultatAnalyse;
    const aTraiter = r._lignes.filter((l) => l.statut === 'a_creer' || inclureDoublons);
    const ignorees = r._lignes.length - aTraiter.length;
    // Auteur de l'import : l'identité du demandeur, dans l'association de la tâche.
    const auth = {
      type: 'acces',
      userId: t.userId,
      associationId: t.associationId,
      canal: 'console',
      permissions: [],
      contexte: { requestId: `tache-${t.id}`, associationId: t.associationId, userId: t.userId },
    } as AuthRequete;

    // Familles nommées dans le fichier : rattachement à l'existante (même nom), sinon création unique.
    const famillesCreees = new Map<string, string>();
    let nouvellesFamilles = 0;
    const idFamille = async (f: NonNullable<MembreImporte['famille']>): Promise<string> => {
      if (f.id) return f.id;
      const cle = normaliser(f.nom);
      const connue = famillesCreees.get(cle);
      if (connue) return connue;
      const existante = await this.db.tx((tx) =>
        tx.query<{ id: string }>(
          `SELECT id FROM familles WHERE deleted_at IS NULL AND app_normaliser(nom) = app_normaliser($1)
            ORDER BY created_at LIMIT 1`,
          [f.nom],
        ),
      );
      let id = existante.rows[0]?.id;
      if (!id) {
        id = (await this.familles.creer(auth, { nom: f.nom })).dto.id;
        nouvellesFamilles++;
      }
      famillesCreees.set(cle, id);
      return id;
    };

    const details: {
      ligne: number;
      statut: 'creee' | 'erreur';
      numero: string | null;
      message: string | null;
    }[] = [];
    let creees = 0;
    let doublonsCrees = 0;
    let erreurs = 0;
    for (const [i, l] of aTraiter.entries()) {
      const d = l.donnees;
      try {
        const corps: MembreCreation = {
          id: uuidv7(),
          nom: d.nom,
          prenoms: d.prenoms,
          telephone: d.telephone,
          sexe: d.sexe,
          dateNaissance: d.dateNaissance,
          villageOrigine: d.villageOrigine,
          lieuResidence: d.lieuResidence,
          paysResidence: d.paysResidence,
          categorieId: d.categorieId,
          familleId: d.famille ? await idFamille(d.famille) : null,
          ...(d.dateAdhesion ? { dateAdhesion: d.dateAdhesion } : {}),
          // Consentement attesté par le bureau à la confirmation (recueilli sur papier).
          consentement: { traitementDonnees: true, canal: 'papier' },
          confirmationDoublon: true,
        };
        const { dto } = await this.membres.creer(auth, corps);
        creees++;
        if (dto.doublonProbable) doublonsCrees++;
        details.push({ ligne: l.ligne, statut: 'creee', numero: dto.numero, message: null });
      } catch (e) {
        if (!(e instanceof ErreurMetier)) throw e;
        erreurs++;
        details.push({ ligne: l.ligne, statut: 'erreur', numero: null, message: e.detail });
      }
      if (i % 50 === 0) await t.avancer((i / aTraiter.length) * 100);
    }
    await this.db.tx((tx) =>
      this.audit.tracer(tx, {
        associationId: t.associationId,
        action: 'membres.importes',
        entiteType: 'import',
        entiteId: t.id,
        apres: {
          fichier: r.nomFichier,
          analyse: analyse.id,
          creees,
          doublonsCrees,
          ignorees,
          erreurs,
          famillesCreees: nouvellesFamilles,
        },
      }),
    );
    return { creees, doublonsCrees, ignorees, erreurs, famillesCreees: nouvellesFamilles, details };
  }
}
