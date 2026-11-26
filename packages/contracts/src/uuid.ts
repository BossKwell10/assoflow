/**
 * UUIDv7 (RFC 9562) : horodatage milliseconde sur 48 bits puis aléa. Identifiant des entités créables hors ligne,
 * généré par le client (docs/02 §1, docs/07 §5). Utilise `crypto.getRandomValues` (Node ≥ 20 et navigateurs).
 */
export function uuidv7(instantMs: number = Date.now()): string {
  const octets = new Uint8Array(16);
  (
    globalThis as unknown as { crypto: { getRandomValues(a: Uint8Array): Uint8Array } }
  ).crypto.getRandomValues(octets);
  let t = instantMs;
  for (let i = 5; i >= 0; i--) {
    octets[i] = t % 256;
    t = Math.floor(t / 256);
  }
  octets[6] = (octets[6]! & 0x0f) | 0x70;
  octets[8] = (octets[8]! & 0x3f) | 0x80;
  const hex = Array.from(octets, (o) => o.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
