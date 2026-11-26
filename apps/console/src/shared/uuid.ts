/**
 * UUIDv7 (RFC 9562) : horodatage en millisecondes sur 48 bits puis aléa. Identifiant fourni par le
 * client à la création (clé d'idempotence, docs/07 §1 et §5), trié dans l'ordre de création.
 */
export function uuidV7(maintenant: number = Date.now()): string {
  const octets = crypto.getRandomValues(new Uint8Array(16));
  for (let i = 0; i < 6; i++) octets[i] = Math.floor(maintenant / 2 ** (8 * (5 - i))) & 0xff;
  octets[6] = (octets[6]! & 0x0f) | 0x70;
  octets[8] = (octets[8]! & 0x3f) | 0x80;
  const hex = Array.from(octets, (o) => o.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
