import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, beforeEach } from 'vitest';
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

beforeAll(() => serveur.listen({ onUnhandledFrame: 'error' }));
beforeEach(() => reinitialiserServeur());
afterEach(() => {
  cleanup();
  serveur.resetHandlers();
  definirJeton(undefined);
  reinitialiserEtatSession();
});
afterAll(() => serveur.close());
