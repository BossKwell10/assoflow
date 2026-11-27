import { createRequire } from 'node:module';
import path from 'node:path';
import type { TDocumentDefinitions } from 'pdfmake/interfaces.js';

interface Pdfmake {
  addFonts(f: unknown): void;
  setUrlAccessPolicy(f: (url: string) => boolean): void;
  setLocalAccessPolicy(f: (chemin: string) => boolean): void;
  createPdf(d: TDocumentDefinitions): { getBuffer(): Promise<Buffer> };
}

// pdfmake (CommonJS) : polices Roboto embarquées, aucun accès réseau, disque limité aux polices.
const require = createRequire(import.meta.url);
const pdfmake = require('pdfmake') as Pdfmake;
const polices = require('pdfmake/fonts/Roboto') as { Roboto: { normal: string } };
const dossierPolices = path.dirname(polices.Roboto.normal);
pdfmake.addFonts(polices);
pdfmake.setUrlAccessPolicy(() => false);
pdfmake.setLocalAccessPolicy((chemin) => path.resolve(chemin).startsWith(dossierPolices));

/** PDF généré côté serveur (carte de membre, reçu) avec les polices embarquées. */
export function genererPdf(definition: TDocumentDefinitions): Promise<Buffer> {
  return pdfmake.createPdf(definition).getBuffer();
}
