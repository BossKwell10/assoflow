import ExcelJS from 'exceljs';
import { ErreurMetier } from '../../../common/erreur-metier.js';

/** RG-MBR-007 : 5 000 lignes de données au plus par fichier. */
export const LIGNES_MAX_IMPORT = 5000;

/** Colonnes du modèle d'import (RG-MBR-007), dans l'ordre du modèle Excel. */
export const COLONNES_IMPORT = [
  'nom',
  'prenoms',
  'telephone',
  'sexe',
  'date_naissance',
  'village_origine',
  'lieu_residence',
  'pays_residence',
  'categorie',
  'famille',
  'date_adhesion',
] as const;
export type ColonneImport = (typeof COLONNES_IMPORT)[number];

/** En-têtes acceptés en plus des noms canoniques (saisies courantes dans les fichiers des associations). */
const ALIAS: Record<string, ColonneImport> = {
  prenom: 'prenoms',
  tel: 'telephone',
  telephone_mobile: 'telephone',
  contact: 'telephone',
  numero_de_telephone: 'telephone',
  genre: 'sexe',
  date_de_naissance: 'date_naissance',
  naissance: 'date_naissance',
  village: 'village_origine',
  village_d_origine: 'village_origine',
  residence: 'lieu_residence',
  lieu_de_residence: 'lieu_residence',
  pays: 'pays_residence',
  pays_de_residence: 'pays_residence',
  categorie_de_membre: 'categorie',
  date_d_adhesion: 'date_adhesion',
  adhesion: 'date_adhesion',
};

export type LigneBrute = { numero: number } & Partial<Record<ColonneImport, string>>;

function invalide(code: string, message: string): ErreurMetier {
  return new ErreurMetier('VALIDATION', message, [{ champ: 'fichier', code, message }]);
}

/** « Prénoms », « Date de naissance » → `prenoms`, `date_de_naissance`. */
export function normaliserEntete(e: string): string {
  return e
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '');
}

function colonneDe(entete: string): ColonneImport | null {
  const n = normaliserEntete(entete);
  if ((COLONNES_IMPORT as readonly string[]).includes(n)) return n as ColonneImport;
  return ALIAS[n] ?? null;
}

/** Texte d'un CSV : UTF-8 (avec ou sans BOM), sinon Windows-1252 (exports Excel français). */
function decoderTexte(contenu: Buffer): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(contenu).replace(/^\uFEFF/, '');
  } catch {
    return new TextDecoder('windows-1252').decode(contenu);
  }
}

/** Lecture CSV (RFC 4180) : séparateur `;`, `,` ou tabulation détecté sur la ligne d'en-tête. */
export function lireCsv(texte: string): string[][] {
  const premiere = texte.split(/\r?\n/, 1)[0] ?? '';
  const separateur = [';', ',', '\t'].reduce((a, b) =>
    premiere.split(b).length > premiere.split(a).length ? b : a,
  );
  const lignes: string[][] = [];
  let ligne: string[] = [];
  let champ = '';
  let guillemets = false;
  for (let i = 0; i < texte.length; i++) {
    const c = texte[i]!;
    if (guillemets) {
      if (c === '"') {
        if (texte[i + 1] === '"') {
          champ += '"';
          i++;
        } else guillemets = false;
      } else champ += c;
    } else if (c === '"' && champ === '') guillemets = true;
    else if (c === separateur) {
      ligne.push(champ);
      champ = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && texte[i + 1] === '\n') i++;
      ligne.push(champ);
      lignes.push(ligne);
      ligne = [];
      champ = '';
    } else champ += c;
  }
  if (champ !== '' || ligne.length > 0) {
    ligne.push(champ);
    lignes.push(ligne);
  }
  return lignes;
}

/** Valeur texte d'une cellule Excel : dates en AAAA-MM-JJ, nombres sans notation scientifique. */
function texteCellule(cellule: ExcelJS.Cell): string {
  const v = cellule.value;
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === 'number') return Number.isInteger(v) ? v.toFixed(0) : String(v);
  if (typeof v === 'object' && 'result' in v) {
    const r = (v as { result?: unknown }).result;
    if (r instanceof Date) return r.toISOString().slice(0, 10);
    return r === undefined || r === null ? '' : String(r);
  }
  return cellule.text ?? '';
}

async function lireXlsx(contenu: Buffer): Promise<string[][]> {
  const classeur = new ExcelJS.Workbook();
  try {
    await classeur.xlsx.load(contenu as unknown as ArrayBuffer);
  } catch {
    throw invalide('FICHIER_ILLISIBLE', 'Classeur Excel illisible : enregistrez-le au format .xlsx ou .csv');
  }
  const feuille = classeur.worksheets[0];
  if (!feuille) throw invalide('FICHIER_VIDE', 'Le classeur ne contient aucune feuille');
  const lignes: string[][] = [];
  feuille.eachRow({ includeEmpty: true }, (row, n) => {
    const valeurs: string[] = [];
    for (let c = 1; c <= Math.max(row.cellCount, 1); c++) valeurs.push(texteCellule(row.getCell(c)));
    lignes[n - 1] = valeurs;
  });
  return Array.from(lignes, (l) => l ?? []);
}

/**
 * Lit un fichier d'import (CSV ou XLSX, type reconnu par son contenu) et vérifie sa structure :
 * colonnes `nom` et `prenoms` présentes, au moins une ligne, 5 000 lignes au plus (RG-MBR-007).
 * Les lignes entièrement vides sont ignorées ; `numero` = numéro de ligne dans le fichier (en-tête = 1).
 */
export async function lireFichierImport(
  contenu: Buffer,
): Promise<{ lignes: LigneBrute[]; colonnesIgnorees: string[] }> {
  if (contenu.length === 0) throw invalide('FICHIER_VIDE', 'Fichier vide');
  const zip = contenu.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
  const ole = contenu.subarray(0, 4).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0]));
  if (ole)
    throw invalide('TYPE_FICHIER_INVALIDE', 'Ancien format Excel (.xls) : enregistrez en .xlsx ou .csv');
  if (!zip && contenu.includes(0)) throw invalide('TYPE_FICHIER_INVALIDE', 'Fichier CSV ou XLSX attendu');
  const tableau = zip ? await lireXlsx(contenu) : lireCsv(decoderTexte(contenu));

  const indexEntete = tableau.findIndex((l) => l.some((c) => c.trim() !== ''));
  if (indexEntete < 0) throw invalide('FICHIER_VIDE', 'Fichier vide');
  const entetes = tableau[indexEntete]!.map(colonneDe);
  const colonnesIgnorees = tableau[indexEntete]!.filter((e, i) => e.trim() !== '' && entetes[i] === null);
  for (const requise of ['nom', 'prenoms'] as const) {
    if (!entetes.includes(requise)) {
      throw invalide(
        'COLONNE_MANQUANTE',
        `Colonne « ${requise} » introuvable : utilisez le modèle d’import (colonnes ${COLONNES_IMPORT.join(', ')})`,
      );
    }
  }
  const doublonsEntete = entetes.filter((c, i) => c !== null && entetes.indexOf(c) !== i);
  if (doublonsEntete.length > 0) {
    throw invalide('COLONNE_EN_DOUBLE', `Colonne « ${doublonsEntete[0]} » présente plusieurs fois`);
  }

  const lignes: LigneBrute[] = [];
  for (let i = indexEntete + 1; i < tableau.length; i++) {
    const brute = tableau[i]!;
    if (brute.every((c) => c.trim() === '')) continue;
    const ligne: LigneBrute = { numero: i + 1 };
    entetes.forEach((col, j) => {
      const v = (brute[j] ?? '').trim();
      if (col && v !== '') ligne[col] = v;
    });
    lignes.push(ligne);
    if (lignes.length > LIGNES_MAX_IMPORT) {
      throw invalide(
        'TROP_DE_LIGNES',
        `Plus de ${LIGNES_MAX_IMPORT} lignes : découpez le fichier (RG-MBR-007)`,
      );
    }
  }
  if (lignes.length === 0) throw invalide('FICHIER_VIDE', 'Aucune ligne de membre sous l’en-tête');
  return { lignes, colonnesIgnorees };
}

/** Modèle d'import Excel (écran A6, étape 1) : en-têtes, une ligne d'exemple et une feuille d'aide. */
export async function modeleImportXlsx(): Promise<Buffer> {
  const classeur = new ExcelJS.Workbook();
  classeur.creator = 'AssoFlow';
  const feuille = classeur.addWorksheet('Membres');
  feuille.columns = COLONNES_IMPORT.map((c) => ({ header: c, key: c, width: c === 'prenoms' ? 24 : 18 }));
  feuille.getRow(1).font = { bold: true };
  feuille.addRow({
    nom: 'Kouadio',
    prenoms: 'Aya Marie',
    telephone: '0707070707',
    sexe: 'F',
    date_naissance: '12/04/1990',
    village_origine: 'Sakassou',
    lieu_residence: 'Abidjan',
    pays_residence: 'CI',
    categorie: '',
    famille: '',
    date_adhesion: '',
  });
  // Téléphones et dates en texte : Excel ne retire pas le 0 initial ni ne convertit les dates.
  for (const c of ['telephone', 'date_naissance', 'date_adhesion'] as const) {
    feuille.getColumn(c).numFmt = '@';
  }
  const aide = classeur.addWorksheet('Aide');
  aide.columns = [
    { header: 'Colonne', key: 'c', width: 18 },
    { header: 'Contenu attendu', key: 'd', width: 90 },
  ];
  aide.getRow(1).font = { bold: true };
  const lignesAide: [ColonneImport, string][] = [
    ['nom', 'Obligatoire.'],
    ['prenoms', 'Obligatoire.'],
    [
      'telephone',
      '07 07 07 07 07 ou +33 6 12 34 56 78. Sans indicatif : +225 ajouté. Obligatoire sauf si la famille a un chef joignable.',
    ],
    ['sexe', 'F ou M (Femme, Homme acceptés).'],
    ['date_naissance', 'JJ/MM/AAAA ou AAAA-MM-JJ.'],
    ['village_origine', 'Texte libre.'],
    ['lieu_residence', 'Texte libre.'],
    ['pays_residence', 'Code pays à 2 lettres (CI, FR, US…). CI par défaut.'],
    ['categorie', 'Libellé exact d’une catégorie de membres existante (Paramètres › Catégories).'],
    ['famille', 'Nom de la famille : rattachée si elle existe, créée sinon.'],
    ['date_adhesion', 'JJ/MM/AAAA ou AAAA-MM-JJ. Date du jour par défaut.'],
  ];
  for (const [c, d] of lignesAide) aide.addRow({ c, d });
  aide.addRow({});
  aide.addRow({ c: 'Limite', d: `${LIGNES_MAX_IMPORT} lignes par fichier.` });
  return Buffer.from(await classeur.xlsx.writeBuffer());
}
