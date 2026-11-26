/** « 15 minutes », « 1 h 30 min », « 45 secondes ». */
export function formatDuree(secondes: number): string {
  if (secondes < 60) return `${secondes} seconde${secondes > 1 ? 's' : ''}`;
  const minutes = Math.ceil(secondes / 60);
  if (minutes < 60) return `${minutes} minute${minutes > 1 ? 's' : ''}`;
  const h = Math.floor(minutes / 60);
  const reste = minutes % 60;
  return reste ? `${h} h ${reste.toString().padStart(2, '0')} min` : `${h} h`;
}

const DATE = new Intl.DateTimeFormat('fr-FR', {
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  timeZone: 'UTC',
});
const HEURE = new Intl.DateTimeFormat('fr-FR', { hour: '2-digit', minute: '2-digit', timeZone: 'UTC' });

/** `2027-03-05` → `05/03/2027` (docs/08 §2). */
export function formatDate(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso.length === 10 ? `${iso}T00:00:00Z` : iso);
  return Number.isNaN(d.getTime()) ? iso : DATE.format(d);
}

/** `2027-03-05T14:30:00Z` → `05/03/2027 14:30` (GMT). */
export function formatDateHeure(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : `${DATE.format(d)} ${HEURE.format(d)}`;
}

/** `+2250701020304` → `+225 07 01 02 03 04` ; autres indicatifs : inchangé. */
export function formatTelephone(e164: string | null | undefined): string {
  if (!e164) return '';
  const ci = /^\+225(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/.exec(e164);
  return ci ? `+225 ${ci.slice(1).join(' ')}` : e164;
}
