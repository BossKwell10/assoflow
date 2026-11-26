import { normaliserTelephone } from '@assoflow/contracts';
import { Alert, Button, Group, Modal, NativeSelect, SimpleGrid, Stack, Text, TextInput } from '@mantine/core';
import { useState, type FormEvent } from 'react';
import { postAcces, useGetRoles } from '../../api/generated/acces-et-roles/acces-et-roles';
import type { Acces, AccesInvitation } from '../../api/generated/modeles';
import { t } from '../../i18n';
import { erreursDeChamps, messageErreur } from '../../shared/erreurs';

type Champs = 'telephone' | 'nom' | 'prenoms' | 'roleId' | 'mandatDebut' | 'mandatFin';

/** Invitation d'un utilisateur (`POST /acces`, avec `Idempotency-Key`) — RF-ADM-010, RF-ADM-011. */
export function InvitationAcces({
  onFermer,
  onInvite,
}: {
  onFermer: () => void;
  onInvite: (a: Acces) => void;
}) {
  const roles = useGetRoles();
  // Une clé par formulaire : un double clic ou un nouvel essai après coupure ne crée pas deux invitations.
  const [cle] = useState(() => crypto.randomUUID());
  const [valeurs, setValeurs] = useState<Record<Champs, string>>({
    telephone: '',
    nom: '',
    prenoms: '',
    roleId: '',
    mandatDebut: '',
    mandatFin: '',
  });
  const [erreurs, setErreurs] = useState<Partial<Record<Champs, string>>>({});
  const [erreur, setErreur] = useState<string>();
  const [enCours, setEnCours] = useState(false);

  const champ = (nom: Champs) => ({
    value: valeurs[nom],
    error: erreurs[nom],
    onChange: (e: { currentTarget: { value: string } }) => {
      const valeur = e.currentTarget.value;
      setValeurs((v) => ({ ...v, [nom]: valeur }));
    },
  });

  const soumettre = async (e: FormEvent) => {
    e.preventDefault();
    const requis = t('connexion.champRequis');
    const nouvelles: Partial<Record<Champs, string>> = {};
    for (const c of ['telephone', 'nom', 'prenoms', 'roleId'] as const)
      if (!valeurs[c].trim()) nouvelles[c] = requis;
    let telephone = '';
    if (!nouvelles.telephone) {
      try {
        telephone = normaliserTelephone(valeurs.telephone);
      } catch {
        nouvelles.telephone = t('connexion.telephoneInvalide');
      }
    }
    setErreurs(nouvelles);
    if (Object.keys(nouvelles).length) return;

    const corps: AccesInvitation = {
      telephone,
      nom: valeurs.nom.trim(),
      prenoms: valeurs.prenoms.trim(),
      roleId: valeurs.roleId,
      ...(valeurs.mandatDebut ? { mandatDebut: valeurs.mandatDebut } : {}),
      ...(valeurs.mandatFin ? { mandatFin: valeurs.mandatFin } : {}),
    };
    setEnCours(true);
    setErreur(undefined);
    try {
      const acces = await postAcces(corps, { headers: { 'Idempotency-Key': cle } });
      onInvite(acces);
      onFermer();
    } catch (err) {
      setErreurs(erreursDeChamps(err));
      setErreur(messageErreur(err));
    } finally {
      setEnCours(false);
    }
  };

  return (
    <Modal opened onClose={onFermer} title={t('utilisateurs.invitationTitre')} size="lg" centered>
      <form onSubmit={(e) => void soumettre(e)} noValidate>
        <Stack>
          <Text size="sm" c="dimmed">
            {t('utilisateurs.invitationIntro')}
          </Text>
          {erreur && (
            <Alert color="red" role="alert">
              {erreur}
            </Alert>
          )}
          <SimpleGrid cols={{ base: 1, sm: 2 }}>
            <TextInput label={t('utilisateurs.nom')} required {...champ('nom')} data-autofocus />
            <TextInput label={t('utilisateurs.prenoms')} required {...champ('prenoms')} />
          </SimpleGrid>
          <TextInput
            label={t('utilisateurs.telephone')}
            description={t('otp.telephoneAide')}
            type="tel"
            required
            {...champ('telephone')}
          />
          <NativeSelect
            label={t('utilisateurs.role')}
            required
            data={[
              { value: '', label: '—' },
              ...(roles.data ?? []).filter((r) => r.id).map((r) => ({ value: r.id!, label: r.libelle })),
            ]}
            {...champ('roleId')}
          />
          <SimpleGrid cols={{ base: 1, sm: 2 }}>
            <TextInput type="date" label={t('utilisateurs.mandatDebut')} {...champ('mandatDebut')} />
            <TextInput type="date" label={t('utilisateurs.mandatFin')} {...champ('mandatFin')} />
          </SimpleGrid>
          <Group justify="flex-end">
            <Button variant="default" onClick={onFermer}>
              {t('commun.annuler')}
            </Button>
            <Button type="submit" loading={enCours}>
              {t('utilisateurs.envoyerInvitation')}
            </Button>
          </Group>
        </Stack>
      </form>
    </Modal>
  );
}
