import '@testing-library/jest-dom/vitest';
import { cleanup, configure } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, beforeEach } from 'vitest';
import { oublierEtags } from './api/client';
import { definirJeton } from './api/jeton';
import { reinitialiserEtatSession } from './auth/etat';
import { reinitialiserServeur, serveur } from './test/serveur';

// jsdom n'implémente pas matchMedia, utilisé par Mantine.
Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  }),
});
class ResizeObserverFactice {
  observe() {}
  unobserve() {}
  disconnect() {}
}
window.ResizeObserver = ResizeObserverFactice as unknown as typeof ResizeObserver;
// jsdom : scrollIntoView absent (utilisé par les listes Mantine).
Element.prototype.scrollIntoView = () => {};
window.scrollTo = (() => {}) as typeof window.scrollTo;

// Écrans chargés à la demande (import dynamique) : le premier rendu d'un fichier de test peut dépasser
// 1 s quand la CI construit et teste en parallèle.
configure({ asyncUtilTimeout: 5000 });

beforeAll(() => serveur.listen({ onUnhandledFrame: 'error' }));
beforeEach(() => reinitialiserServeur());
afterEach(() => {
  cleanup();
  serveur.resetHandlers();
  definirJeton(undefined);
  oublierEtags();
  reinitialiserEtatSession();
});
afterAll(() => serveur.close());
