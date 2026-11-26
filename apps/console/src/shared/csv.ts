/** Colonne d'un export CSV. */
export interface ColonneCsv<T> {
  titre: string;
  valeur: (ligne: T) => string | number | null | undefined;
}

const echapper = (v: string) => (/[";\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);

/**
 * CSV pour Excel en français : séparateur `;`, fin de ligne CRLF, BOM UTF-8 pour les accents.
 * Les valeurs commençant par `= + - @` sont préfixées d'une apostrophe (injection de formules).
 */
export function versCsv<T>(colonnes: ColonneCsv<T>[], lignes: readonly T[]): string {
  const cellule = (v: string | number | null | undefined) => {
    const texte = v === null || v === undefined ? '' : String(v);
    return echapper(typeof v === 'string' && /^[=+\-@]/.test(texte) ? `'${texte}` : texte);
  };
  const entete = colonnes.map((c) => echapper(c.titre)).join(';');
  const corps = lignes.map((l) => colonnes.map((c) => cellule(c.valeur(l))).join(';'));
  return `\uFEFF${[entete, ...corps].join('\r\n')}\r\n`;
}

/** Déclenche le téléchargement d'un fichier généré côté client. */
export function telechargerFichier(nom: string, contenu: string, type = 'text/csv;charset=utf-8') {
  const url = URL.createObjectURL(new Blob([contenu], { type }));
  const lien = document.createElement('a');
  lien.href = url;
  lien.download = nom;
  document.body.append(lien);
  lien.click();
  lien.remove();
  URL.revokeObjectURL(url);
}
