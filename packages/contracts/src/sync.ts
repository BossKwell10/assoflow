import { z } from 'zod';

/** Protocole de synchronisation mobile (docs/05), compatible avec `synchronize()` de WatermelonDB. */

/** Version courante du schéma local ; le serveur accepte aussi la précédente (N-1, docs/05 §8). */
export const VERSION_SCHEMA_SYNC = 1;
export const VERSIONS_SCHEMA_SUPPORTEES: readonly number[] = [
  VERSION_SCHEMA_SYNC,
  VERSION_SCHEMA_SYNC - 1,
].filter((v) => v >= 1);

/** Taille maximale d'une page de pull et d'un lot de push. */
export const SYNC_LIMITE_PULL = 2000;
export const SYNC_LIMITE_PUSH = 500;

/** Ordre de traitement d'un push (docs/05 §5.1). */
export const TABLES_PUSH = [
  'familles',
  'membres',
  'ayants_droit',
  'paiements',
  'depenses',
  'pieces_jointes',
  'presences',
] as const;
export type TablePush = (typeof TABLES_PUSH)[number];

export const STATUTS_PUSH = ['accepte', 'deja_recu', 'rejete'] as const;

/** Codes de rejet d'un élément poussé (docs/05 §6). */
export const CODES_REJET = [
  'PERMISSION_REFUSEE',
  'EXERCICE_FERME',
  'REFERENCE_INVALIDE',
  'DEPENDANCE_REJETEE',
  'MONTANT_INVALIDE',
  'OPERATION_INTERDITE',
  'CONFLIT_IDEMPOTENCE',
  'VALIDATION',
] as const;
export type CodeRejet = (typeof CODES_REJET)[number];

export const PLATEFORMES_APPAREIL = ['android', 'ios'] as const;

/** Version d'app `X.Y.Z`. */
export const versionAppSchema = z.string().regex(/^\d+\.\d+\.\d+$/, 'Version X.Y.Z attendue');

/** Compare deux versions `X.Y.Z` (négatif si a < b). */
export function comparerVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** `POST /auth/appareils` (EnregistrementAppareil). */
export const enregistrementAppareilSchema = z.object({
  nom: z.string().trim().min(1, 'Champ obligatoire').max(100),
  plateforme: z.enum(PLATEFORMES_APPAREIL),
  versionApp: versionAppSchema,
  jetonOtp: z.string().min(1),
  appareilId: z.uuid().nullable().optional(),
});
export type EnregistrementAppareil = z.infer<typeof enregistrementAppareilSchema>;

/** `POST /appareils/{id}/revoquer`. */
export const revocationAppareilSchema = z.object({
  motif: z.string().trim().min(3).max(500),
  purger: z.boolean().optional(),
});

/** `POST /sync/pull` (SyncPullRequete). */
export const syncPullSchema = z.object({
  curseur: z.number().int().min(0),
  versionSchema: z.number().int().min(1),
  versionApp: versionAppSchema,
  limite: z.number().int().min(1).max(SYNC_LIMITE_PULL).optional(),
  elementsEnAttente: z.number().int().min(0).optional(),
});
export type SyncPull = z.infer<typeof syncPullSchema>;

const ligneSchema = z.record(z.string(), z.unknown()).refine((l) => typeof l.id === 'string', {
  message: 'Chaque ligne porte un id',
});

const changesTableSchema = z.object({
  created: z.array(ligneSchema).optional(),
  updated: z.array(ligneSchema).optional(),
  deleted: z.array(z.string()).optional(),
});

/** `POST /sync/push` (SyncPushRequete) : tables inconnues refusées, 500 éléments au plus par lot. */
export const syncPushSchema = z
  .object({
    curseurBase: z.number().int().min(0),
    versionSchema: z.number().int().min(1),
    versionApp: versionAppSchema.optional(),
    changes: z.partialRecord(z.enum(TABLES_PUSH), changesTableSchema),
  })
  .superRefine((p, ctx) => {
    const total = Object.values(p.changes).reduce(
      (n, t) => n + (t?.created?.length ?? 0) + (t?.updated?.length ?? 0) + (t?.deleted?.length ?? 0),
      0,
    );
    if (total > SYNC_LIMITE_PUSH) {
      ctx.addIssue({
        code: 'custom',
        path: ['changes'],
        message: `${SYNC_LIMITE_PUSH} éléments au plus par lot (${total} reçus) : découpez le push`,
      });
    }
  });
export type SyncPush = z.infer<typeof syncPushSchema>;

// --- Pièces jointes (docs/05 §7) -------------------------------------------------------------------------

export const ENTITES_PIECE_JOINTE = ['depense', 'projet', 'paiement', 'membre'] as const;
export const MIMES_PIECE_JOINTE = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'application/pdf',
  'audio/mp4',
  'audio/aac',
] as const;
export const TAILLE_MAX_PIECE_JOINTE = 10 * 1024 * 1024;

/** `POST /pieces-jointes` (PieceJointe) : métadonnées seulement, le fichier part ensuite par URL présignée. */
export const pieceJointeSchema = z.object({
  id: z.uuid(),
  entiteType: z.enum(ENTITES_PIECE_JOINTE),
  entiteId: z.uuid(),
  mime: z.enum(MIMES_PIECE_JOINTE),
  tailleOctets: z.number().int().min(1).max(TAILLE_MAX_PIECE_JOINTE, 'Fichier de 10 Mo au plus'),
  sha256: z.string().regex(/^[0-9a-f]{64}$/i, 'Empreinte SHA-256 hexadécimale attendue'),
});
export type PieceJointeCreation = z.infer<typeof pieceJointeSchema>;
