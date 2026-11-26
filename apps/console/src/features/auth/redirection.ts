/** N'accepte qu'un chemin interne (pas de redirection ouverte vers un autre site). */
export function cheminRetour(redirect: unknown): string {
  return typeof redirect === 'string' && redirect.startsWith('/') && !redirect.startsWith('//')
    ? redirect
    : '/';
}
