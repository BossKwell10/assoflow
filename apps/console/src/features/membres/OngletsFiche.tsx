import { Alert, Button, Card, Group, SimpleGrid, Stack, Text, Timeline } from '@mantine/core';
import type { UseQueryResult } from '@tanstack/react-query';
import { useState } from 'react';
import { useGetMembresIdHistorique } from '../../api/generated/membres/membres';
import type { Membre, SituationMembre as Situation } from '../../api/generated/modeles';
import { t, type CleTexte } from '../../i18n';
import { messageErreur } from '../../shared/erreurs';
import { formatDate, formatDateHeure } from '../../shared/format';
import { Montant } from '../../shared/Montant';
import { BadgeStatut } from '../../shared/Statut';
import { Chargement, nomPays, TAILLE_PAGE, useAffichageTelephone, useReferentielsMembres } from './commun';

const carte = { withBorder: true, radius: 12, padding: 'lg', style: { borderColor: '#E3E6EA' } } as const;

function Valeur({ libelle, children }: { libelle: string; children: React.ReactNode }) {
  return (
    <div>
      <Text size="sm" c="dimmed">
        {libelle}
      </Text>
      <Text component="div" fw={500}>
        {children || '—'}
      </Text>
    </div>
  );
}

/** Onglet Situation : `GET /membres/{id}/situation` (RF-035). */
export function SituationMembre({ situation }: { situation: UseQueryResult<Situation, unknown> }) {
  if (situation.isPending) return <Chargement />;
  if (situation.isError)
    return (
      <Alert color="red" role="alert">
        {messageErreur(situation.error)}
      </Alert>
    );
  const s = situation.data;
  const prochaine = s.prochaineEcheance;
  return (
    <Stack>
      <Card {...carte}>
        <SimpleGrid cols={{ base: 1, sm: 3 }}>
          <Valeur libelle={t('membres.totalExigible')}>
            <Montant valeur={s.totalExigible ?? 0} />
          </Valeur>
          <Valeur libelle={t('membres.totalPaye')}>
            <Montant valeur={s.totalPaye ?? 0} />
          </Valeur>
          <Valeur libelle={t('membres.resteDu')}>
            <Montant valeur={s.resteDu ?? 0} c={s.resteDu ? '#A11B1B' : undefined} />
          </Valeur>
        </SimpleGrid>
      </Card>
      <Card {...carte}>
        <Text fw={600} mb="xs">
          {t('membres.prochaineEcheance')}
        </Text>
        {prochaine ? (
          <Group gap="md">
            <Text>
              {prochaine.campagneLibelle} — {prochaine.libellePeriode} ({formatDate(prochaine.dateEcheance)})
            </Text>
            <Montant valeur={(prochaine.montantDu ?? 0) - (prochaine.montantPaye ?? 0)} />
            <BadgeStatut domaine="echeance" valeur={prochaine.situation} />
          </Group>
        ) : (
          <Text c="dimmed">{t('membres.aucuneEcheance')}</Text>
        )}
        <Text size="sm" c="dimmed" mt="sm">
          {t('membres.detailEcheancesBientot')}
        </Text>
      </Card>
    </Stack>
  );
}

/** Onglet Historique : chronologie paginée par curseur (RF-026). */
export function HistoriqueMembre({ id }: { id: string }) {
  const [curseurs, setCurseurs] = useState<string[]>([]);
  const curseur = curseurs.at(-1);
  const historique = useGetMembresIdHistorique(id, { limite: TAILLE_PAGE, ...(curseur ? { curseur } : {}) });
  if (historique.isPending) return <Chargement />;
  if (historique.isError)
    return (
      <Alert color="red" role="alert">
        {messageErreur(historique.error)}
      </Alert>
    );
  const { donnees, page } = historique.data;
  return (
    <Card {...carte}>
      {donnees.length === 0 ? (
        <Text c="dimmed">{t('membres.historiqueVide')}</Text>
      ) : (
        <Timeline bulletSize={14} lineWidth={2} color="accent">
          {donnees.map((e, i) => (
            <Timeline.Item
              key={`${e.date}-${i}`}
              title={e.libelle}
              aria-label={`${formatDateHeure(e.date)} — ${e.libelle ?? ''}`}
            >
              <Group gap="sm">
                <Text size="sm" c="dimmed">
                  {formatDateHeure(e.date)}
                  {e.type ? ` · ${t(`historique.${e.type}` as CleTexte)}` : ''}
                </Text>
                {typeof e.montant === 'number' && <Montant valeur={e.montant} size="sm" />}
              </Group>
            </Timeline.Item>
          ))}
        </Timeline>
      )}
      {(curseurs.length > 0 || page.curseurSuivant) && (
        <Group justify="flex-end" mt="md">
          <Button
            variant="default"
            disabled={!curseurs.length}
            onClick={() => setCurseurs((c) => c.slice(0, -1))}
          >
            {t('commun.pagePrecedente')}
          </Button>
          <Button
            variant="default"
            disabled={!page.curseurSuivant}
            onClick={() => page.curseurSuivant && setCurseurs((c) => [...c, page.curseurSuivant!])}
          >
            {t('commun.pageSuivante')}
          </Button>
        </Group>
      )}
    </Card>
  );
}

/** Onglet Informations : formulaire A4 en lecture. */
export function InformationsMembre({ membre: m }: { membre: Membre }) {
  const telephone = useAffichageTelephone();
  const ref = useReferentielsMembres();
  const oui = (v?: boolean) => (v ? t('commun.oui') : t('commun.non'));
  return (
    <Card {...carte}>
      <SimpleGrid cols={{ base: 1, sm: 2, lg: 3 }} spacing="lg">
        <Valeur libelle={t('membres.nom')}>{m.nom}</Valeur>
        <Valeur libelle={t('membres.prenoms')}>{m.prenoms}</Valeur>
        <Valeur libelle={t('membres.sexe')}>
          {m.sexe === 'F' ? t('membres.sexeF') : m.sexe === 'M' ? t('membres.sexeM') : ''}
        </Valeur>
        <Valeur libelle={t('membres.dateNaissance')}>{formatDate(m.dateNaissance)}</Valeur>
        <Valeur libelle={t('membres.colTelephone')}>{telephone(m.telephone)}</Valeur>
        <Valeur libelle={t('membres.whatsapp')}>{oui(m.telephoneWhatsapp)}</Valeur>
        <Valeur libelle={t('membres.email')}>{m.email}</Valeur>
        <Valeur libelle={t('membres.villageOrigine')}>{m.villageOrigine}</Valeur>
        <Valeur libelle={t('membres.lieuResidence')}>{m.lieuResidence}</Valeur>
        <Valeur libelle={t('membres.paysResidence')}>{nomPays(m.paysResidence)}</Valeur>
        <Valeur libelle={t('membres.colCategorie')}>{ref.libelleCategorie(m.categorieId)}</Valeur>
        <Valeur libelle={t('membres.colFamille')}>{ref.famille(m.familleId)?.nom}</Valeur>
        <Valeur libelle={t('membres.dateAdhesion')}>{formatDate(m.dateAdhesion)}</Valeur>
        <Valeur libelle={t('membres.canalPrefere')}>
          {m.canalPrefere ? t(`canaux.${m.canalPrefere}` as CleTexte) : ''}
        </Valeur>
        <Valeur libelle={t('membres.notes')}>{m.notes}</Valeur>
      </SimpleGrid>
    </Card>
  );
}
