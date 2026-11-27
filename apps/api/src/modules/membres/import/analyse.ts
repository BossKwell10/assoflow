import { membreMajSchema, normaliserTelephone } from '@assoflow/contracts';
import type { LigneBrute } from './lecture-fichier.js';

/** Données d'un membre prêtes à créer, issues d'une ligne d'import. */
export interface MembreImporte {
  nom: string;
  prenoms: string;
  telephone: string | null;
  sexe: 'F' | 'M' | null;
  dateNaissance: string | null;
  villageOrigine: string | null;
  lieuResidence: string | null;
  paysResidence: string;
  categorieId: string | null;
  /** Nom de famille tel que saisi : famille existante (id) ou à créer (id null). */
  famille: { id: string | null; nom: string } | null;
  dateAdhesion: string | null;
}

export interface Referentiels {
  /** Catégories actives : libellé normalisé → id. */
  categories: Map<string, string>;
  /** Familles : nom normalisé → id et joignabilité de leur chef (RG-MBR-002). */
  familles: Map<string, { id: string; nom: string; chefJoignable: boolean }>;
  /** Date du jour (AAAA-MM-JJ, UTC). */
  aujourdhui: string;
}

/** Comparaison sans casse ni accents ni espaces superflus (comme `app_normaliser`, RG-MBR-003). */
export function normaliser(t: string): string {
  return t.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
}

const SEXES: Record<string, 'F' | 'M'> = {
  f: 'F',
  femme: 'F',
  feminin: 'F',
  m: 'M',
  h: 'M',
  homme: 'M',
  masculin: 'M',
};

const PAYS: Record<string, string> = {
  "cote d'ivoire": 'CI',
  'cote divoire': 'CI',
  'cote d ivoire': 'CI',
  france: 'FR',
  'etats-unis': 'US',
  usa: 'US',
  italie: 'IT',
  espagne: 'ES',
  belgique: 'BE',
  canada: 'CA',
  allemagne: 'DE',
  'royaume-uni': 'GB',
  suisse: 'CH',
  ghana: 'GH',
  'burkina faso': 'BF',
  mali: 'ML',
  senegal: 'SN',
  guinee: 'GN',
  liberia: 'LR',
  togo: 'TG',
  benin: 'BJ',
  maroc: 'MA',
};

/**
 * JJ/MM/AAAA, J/M/AAAA, JJ-MM-AAAA, JJ.MM.AAAA, AAAA-MM-JJ ou numéro de série Excel (jours depuis le
 * 30/12/1899, cellule date au format texte) → AAAA-MM-JJ (date réelle).
 */
export function lireDate(saisie: string): string | null {
  const s = saisie.trim();
  if (/^\d{5}$/.test(s)) {
    return new Date(Date.UTC(1899, 11, 30) + Number(s) * 86_400_000).toISOString().slice(0, 10);
  }
  let a: number, m: number, j: number;
  let r = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s);
  if (r) [a, m, j] = [Number(r[1]), Number(r[2]), Number(r[3])];
  else {
    r = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(s);
    if (!r) return null;
    [j, m, a] = [Number(r[1]), Number(r[2]), Number(r[3])];
  }
  const d = new Date(Date.UTC(a, m - 1, j));
  if (d.getUTCFullYear() !== a || d.getUTCMonth() !== m - 1 || d.getUTCDate() !== j) return null;
  if (a < 1900) return null;
  return d.toISOString().slice(0, 10);
}

/** Téléphone saisi : un numéro ivoirien enregistré comme nombre perd son 0 initial (9 chiffres) : on le rétablit. */
function lireTelephone(saisie: string): string {
  const s = saisie.trim();
  return /^\d{9}$/.test(s) ? normaliserTelephone(`0${s}`) : normaliserTelephone(s);
}

/**
 * Contrôle et normalisation d'une ligne (RG-MBR-007) : champs obligatoires, formats, catégorie existante,
 * contact (RG-MBR-002). Renvoie les données prêtes à créer, ou la liste des problèmes de la ligne.
 */
export function analyserLigne(
  l: LigneBrute,
  ref: Referentiels,
): { donnees: MembreImporte } | { erreurs: string[] } {
  const erreurs: string[] = [];
  let telephone: string | null = null;
  if (l.telephone) {
    try {
      telephone = lireTelephone(l.telephone);
    } catch {
      erreurs.push(`téléphone « ${l.telephone} » invalide`);
    }
  }
  let sexe: 'F' | 'M' | null = null;
  if (l.sexe) {
    sexe = SEXES[normaliser(l.sexe)] ?? null;
    if (!sexe) erreurs.push(`sexe « ${l.sexe} » invalide (F ou M)`);
  }
  const date = (champ: 'date_naissance' | 'date_adhesion', libelle: string) => {
    const v = l[champ];
    if (!v) return null;
    const d = lireDate(v);
    if (!d) erreurs.push(`${libelle} « ${v} » invalide (JJ/MM/AAAA attendu)`);
    else if (d > ref.aujourdhui) erreurs.push(`${libelle} dans le futur`);
    return d;
  };
  const dateNaissance = date('date_naissance', 'date de naissance');
  const dateAdhesion = date('date_adhesion', 'date d’adhésion');
  let paysResidence = 'CI';
  if (l.pays_residence) {
    const p = l.pays_residence.trim();
    const code = /^[A-Za-z]{2}$/.test(p) ? p.toUpperCase() : PAYS[normaliser(p)];
    if (!code) erreurs.push(`pays « ${p} » inconnu (code à 2 lettres attendu : CI, FR…)`);
    else paysResidence = code;
  }
  let categorieId: string | null = null;
  if (l.categorie) {
    categorieId = ref.categories.get(normaliser(l.categorie)) ?? null;
    if (!categorieId) erreurs.push(`catégorie « ${l.categorie} » inconnue ou inactive`);
  }
  let famille: MembreImporte['famille'] = null;
  if (l.famille) {
    const existante = ref.familles.get(normaliser(l.famille));
    famille = existante ? { id: existante.id, nom: existante.nom } : { id: null, nom: l.famille.trim() };
  }

  // Longueurs et formats : mêmes règles que la saisie manuelle (schéma partagé).
  const verif = membreMajSchema.safeParse({
    nom: l.nom ?? '',
    prenoms: l.prenoms ?? '',
    villageOrigine: l.village_origine ?? null,
    lieuResidence: l.lieu_residence ?? null,
  });
  if (!verif.success) {
    for (const i of verif.error.issues) {
      const champ = String(i.path[0]);
      const libelle =
        { nom: 'nom', prenoms: 'prénoms', villageOrigine: 'village', lieuResidence: 'résidence' }[champ] ??
        champ;
      erreurs.push(i.code === 'too_small' ? `${libelle} manquant` : `${libelle} trop long`);
    }
  }

  // RG-MBR-002 : téléphone, ou famille existante dont le chef a un téléphone.
  if (!telephone && erreurs.length === 0) {
    const chefJoignable = famille?.id ? ref.familles.get(normaliser(famille.nom))?.chefJoignable : false;
    if (!chefJoignable) {
      erreurs.push('téléphone obligatoire (ou famille existante dont le chef a un téléphone, RG-MBR-002)');
    }
  }
  if (erreurs.length > 0) return { erreurs };
  return {
    donnees: {
      nom: l.nom!.trim(),
      prenoms: l.prenoms!.trim(),
      telephone,
      sexe,
      dateNaissance,
      villageOrigine: l.village_origine ?? null,
      lieuResidence: l.lieu_residence ?? null,
      paysResidence,
      categorieId,
      famille,
      dateAdhesion,
    },
  };
}
