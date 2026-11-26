import { List, Text, ThemeIcon, VisuallyHidden } from '@mantine/core';
import { t, type CleTexte } from '../../i18n';

export const LONGUEUR_MIN_MOT_DE_PASSE = 10;
const SEQUENCE_TELEPHONE = 6;

/** Vrai si le mot de passe reprend une suite d'au moins 6 chiffres du numéro (RF-SUP-053). */
function reprendTelephone(motDePasse: string, telephone: string): boolean {
  const chiffres = telephone.replace(/\D/g, '').slice(-10);
  for (let i = 0; i + SEQUENCE_TELEPHONE <= chiffres.length; i++) {
    if (motDePasse.includes(chiffres.slice(i, i + SEQUENCE_TELEPHONE))) return true;
  }
  return false;
}

export function evaluerMotDePasse(motDePasse: string, confirmation: string, telephone: string) {
  const regles: { cle: CleTexte; ok: boolean }[] = [
    { cle: 'regles.longueur', ok: motDePasse.length >= LONGUEUR_MIN_MOT_DE_PASSE },
    { cle: 'regles.telephone', ok: motDePasse.length > 0 && !reprendTelephone(motDePasse, telephone) },
    { cle: 'regles.confirmation', ok: motDePasse.length > 0 && motDePasse === confirmation },
  ];
  return { regles, valide: regles.every((r) => r.ok) };
}

/** Règles du mot de passe affichées en direct (docs/08 A0, docs/04 §2.4). */
export function ReglesMotDePasse({ regles }: { regles: { cle: CleTexte; ok: boolean }[] }) {
  return (
    <div>
      <Text size="sm" fw={500} id="regles-mot-de-passe">
        {t('regles.titre')}
      </Text>
      <List spacing={4} size="sm" mt={4} aria-labelledby="regles-mot-de-passe" aria-live="polite">
        {regles.map((r) => (
          <List.Item
            key={r.cle}
            c={r.ok ? '#1B6B34' : '#4A5260'}
            icon={
              <ThemeIcon size={18} radius="xl" color={r.ok ? '#1B6B34' : 'gray.5'} aria-hidden>
                {r.ok ? '✓' : '•'}
              </ThemeIcon>
            }
          >
            {t(r.cle)}
            <VisuallyHidden> — {r.ok ? t('regles.respectee') : t('regles.nonRespectee')}</VisuallyHidden>
          </List.Item>
        ))}
      </List>
      <Text size="xs" c="dimmed" mt={6}>
        {t('regles.courant')}
      </Text>
    </div>
  );
}
