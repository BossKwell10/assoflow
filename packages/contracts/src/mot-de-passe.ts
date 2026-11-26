/**
 * Politique de mot de passe (RF-SUP-053, docs/04-securite-autorisations.md §2.4).
 * Partagée entre l'API (contrôle faisant foi) et la console (affichage des règles en direct).
 */

export const MOT_DE_PASSE_LONGUEUR_MIN = 10;

/**
 * Mots de passe courants refusés. Extrait volontairement court au sprint 1 : la liste complète
 * (10 000 entrées) sera chargée depuis un fichier côté API (écart documenté dans 04 §2.4).
 */
export const MOTS_DE_PASSE_COURANTS: ReadonlySet<string> = new Set([
  '123456789',
  '1234567890',
  '0123456789',
  '12345678910',
  '0987654321',
  '9876543210',
  '1111111111',
  '0000000000',
  '1234512345',
  '1122334455',
  '1q2w3e4r5t',
  'qwertyuiop',
  'azertyuiop',
  'motdepasse',
  'motdepasse1',
  'motdepasse123',
  'password12',
  'password123',
  'password1234',
  'passw0rd123',
  'abcdefghij',
  'abc1234567',
  'azerty1234',
  'azerty12345',
  'azerty123456',
  'qwerty1234',
  'qwerty12345',
  'qwerty123456',
  'iloveyou12',
  'jetaime123',
  'jetaime1234',
  'bonjour123',
  'bonjour1234',
  'soleil1234',
  'football12',
  'football123',
  'abidjan123',
  'abidjan2024',
  'abidjan2025',
  'abidjan2026',
  'cotedivoire',
  'cotedivoire1',
  'cotedivoire225',
  'ivoire2026',
  'association',
  'association1',
  'association123',
  'mutuelle123',
  'assoflow123',
  'assoflow2026',
  'admin12345',
  'administrateur',
  'president123',
  'tresorier123',
  'secretaire123',
  'welcome123',
  'bienvenue1',
  'bienvenue123',
  'changeme123',
  'letmein123',
  'dragon1234',
  'monkey1234',
  'sunshine12',
  'princess12',
  'superman12',
  'trustno123',
  'starwars12',
  'zaq12wsxcde',
  '1qaz2wsx3edc',
]);

export type ProblemeMotDePasse = 'TROP_COURT' | 'TROP_COURANT' | 'SUITE_TELEPHONE';

export const MESSAGES_MOT_DE_PASSE: Record<ProblemeMotDePasse, string> = {
  TROP_COURT: `Le mot de passe doit contenir au moins ${MOT_DE_PASSE_LONGUEUR_MIN} caractères.`,
  TROP_COURANT: 'Ce mot de passe est trop courant.',
  SUITE_TELEPHONE: 'Le mot de passe ne doit pas reprendre les chiffres de votre numéro de téléphone.',
};

/** Longueur minimale d'une suite de chiffres du téléphone considérée comme reprise. */
const SUITE_MIN = 6;

/**
 * Vérifie un mot de passe. Renvoie la liste des problèmes (vide si le mot de passe est acceptable).
 * `telephone` est au format E.164.
 */
export function verifierMotDePasse(motDePasse: string, telephone?: string): ProblemeMotDePasse[] {
  const problemes: ProblemeMotDePasse[] = [];
  if ([...motDePasse].length < MOT_DE_PASSE_LONGUEUR_MIN) problemes.push('TROP_COURT');
  if (MOTS_DE_PASSE_COURANTS.has(motDePasse.toLowerCase())) problemes.push('TROP_COURANT');
  if (telephone && reprendTelephone(motDePasse, telephone)) problemes.push('SUITE_TELEPHONE');
  return problemes;
}

/** Vrai si le mot de passe contient une suite d'au moins 6 chiffres consécutifs du téléphone. */
function reprendTelephone(motDePasse: string, telephone: string): boolean {
  const chiffresTel = telephone.replace(/\D/g, '');
  for (const suite of motDePasse.match(/\d+/g) ?? []) {
    if (suite.length < SUITE_MIN) continue;
    for (let i = 0; i + SUITE_MIN <= suite.length; i++) {
      if (chiffresTel.includes(suite.slice(i, i + SUITE_MIN))) return true;
    }
  }
  return false;
}
