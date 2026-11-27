import {
  Alert,
  Anchor,
  Button,
  Card,
  Checkbox,
  Group,
  SegmentedControl,
  SimpleGrid,
  Stack,
  Stepper,
  Table,
  Text,
  Title,
} from '@mantine/core';
import { useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import {
  getMembresImportModele,
  postMembresImport,
  postMembresImportTacheIdConfirmer,
  useGetMembresImportTacheId,
} from '../../api/generated/membres/membres';
import type { RapportImportDetailsItem } from '../../api/generated/modeles';
import { t } from '../../i18n';
import { telechargerBlob, telechargerFichier, versCsv } from '../../shared/csv';
import { DepotFichier } from '../../shared/DepotFichier';
import { messageErreur } from '../../shared/erreurs';
import { BadgeStatut } from '../../shared/Statut';
import { SuiviTache, useSuiviTache } from '../../shared/SuiviTache';
import { invaliderMembres } from './commun';

/** RG-MBR-007 : CSV ou Excel, 2 Mo au plus (docs/07 §6). */
const TYPES_IMPORT = [
  'text/csv',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
] as const;
const EXTENSIONS_IMPORT = ['csv', 'xlsx'] as const;
const TAILLE_MAX_IMPORT = 2 * 1024 * 1024;

type Filtre = 'tous' | 'erreur' | 'doublon_probable';

function Compteur({ libelle, valeur, couleur }: { libelle: string; valeur: number; couleur?: string }) {
  return (
    <Card withBorder radius={12} padding="md" style={{ borderColor: '#E3E6EA' }}>
      <Text size="sm" c="dimmed">
        {libelle}
      </Text>
      <Text size="xl" fw={700} c={couleur}>
        {valeur}
      </Text>
    </Card>
  );
}

/** Étape 2 : rapport d'analyse (compteurs, lignes en erreur ou doublon, export). */
function RapportAnalyse({ tacheId }: { tacheId: string }) {
  const rapport = useGetMembresImportTacheId(tacheId);
  const [filtre, setFiltre] = useState<Filtre>('tous');
  if (rapport.isPending) return null;
  if (rapport.isError)
    return (
      <Alert color="red" role="alert">
        {messageErreur(rapport.error)}
      </Alert>
    );
  const r = rapport.data;
  const lignes = r.details.filter((d) => filtre === 'tous' || d.statut === filtre);
  const exporter = () =>
    telechargerFichier(
      `rapport-import-${r.nomFichier.replace(/\.[^.]+$/, '')}.csv`,
      versCsv<RapportImportDetailsItem>(
        [
          { titre: t('import.colLigne'), valeur: (d) => d.ligne },
          { titre: t('import.colNom'), valeur: (d) => d.nom },
          { titre: t('import.colStatut'), valeur: (d) => t(`import.statut_${d.statut}`) },
          { titre: t('import.colMessage'), valeur: (d) => d.message },
        ],
        r.details,
      ),
    );
  return (
    <Stack gap="md">
      <SimpleGrid cols={{ base: 2, md: 4 }}>
        <Compteur libelle={t('import.lignes')} valeur={r.lignes} />
        <Compteur libelle={t('import.aCreer')} valeur={r.aCreer} couleur="#1B6B34" />
        <Compteur libelle={t('import.doublons')} valeur={r.doublons} couleur="#8A4B00" />
        <Compteur libelle={t('import.erreurs')} valeur={r.erreurs} couleur="#A11B1B" />
      </SimpleGrid>
      {r.colonnesIgnorees.length > 0 && (
        <Alert color="gray">
          {t('import.colonnesIgnorees', { colonnes: r.colonnesIgnorees.join(', ') })}
        </Alert>
      )}
      {r.details.length > 0 && (
        <Stack gap="sm">
          <Group justify="space-between">
            <SegmentedControl
              aria-label={t('import.filtrer')}
              value={filtre}
              onChange={(v) => setFiltre(v as Filtre)}
              data={[
                { value: 'tous', label: t('import.filtreTous') },
                { value: 'erreur', label: t('import.erreurs') },
                { value: 'doublon_probable', label: t('import.doublons') },
              ]}
            />
            <Button variant="default" onClick={exporter}>
              {t('import.exporterRapport')}
            </Button>
          </Group>
          <Table striped withTableBorder aria-label={t('import.tableauRapport')}>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>{t('import.colLigne')}</Table.Th>
                <Table.Th>{t('import.colNom')}</Table.Th>
                <Table.Th>{t('import.colStatut')}</Table.Th>
                <Table.Th>{t('import.colMessage')}</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {lignes.map((d) => (
                <Table.Tr key={d.ligne}>
                  <Table.Td>{d.ligne}</Table.Td>
                  <Table.Td>{d.nom}</Table.Td>
                  <Table.Td>
                    <BadgeStatut domaine="ligneImport" valeur={d.statut} />
                  </Table.Td>
                  <Table.Td>{d.message}</Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </Stack>
      )}
    </Stack>
  );
}

/** Étape 3 : résumé de la création. */
function ResumeConfirmation({ tacheId }: { tacheId: string }) {
  const suivi = useSuiviTache(tacheId);
  const r = suivi.data?.statut === 'terminee' ? (suivi.data.resultat as Record<string, unknown>) : null;
  const details =
    (r?.details as { ligne: number; statut: string; message: string | null }[] | undefined) ?? [];
  const erreurs = details.filter((d) => d.statut === 'erreur');
  return (
    <Stack gap="sm">
      <SuiviTache id={tacheId} libelle={t('import.creationEnCours')} />
      {r && (
        <Alert color="green" role="status">
          {t('import.resume', {
            creees: Number(r.creees),
            doublons: Number(r.doublonsCrees),
            familles: Number(r.famillesCreees),
            ignorees: Number(r.ignorees),
            erreurs: Number(r.erreurs),
          })}
        </Alert>
      )}
      {erreurs.length > 0 && (
        <Table withTableBorder aria-label={t('import.erreursCreation')}>
          <Table.Tbody>
            {erreurs.map((d) => (
              <Table.Tr key={d.ligne}>
                <Table.Td>{t('import.ligneN', { n: d.ligne })}</Table.Td>
                <Table.Td>{d.message}</Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      )}
      {r && (
        <Group>
          <Button component={Link} to="/membres">
            {t('import.voirMembres')}
          </Button>
          {Number(r.doublonsCrees) > 0 && (
            <Button component={Link} to="/membres/doublons" variant="default">
              {t('import.verifierDoublons')}
            </Button>
          )}
        </Group>
      )}
    </Stack>
  );
}

/** A6 — Import de membres en 3 étapes (RF-024, RG-MBR-007). */
export function ImportMembres() {
  const client = useQueryClient();
  const [analyseId, setAnalyseId] = useState<string>();
  const [confirmationId, setConfirmationId] = useState<string>();
  const [envoi, setEnvoi] = useState(false);
  const [erreur, setErreur] = useState<string>();
  const [inclureDoublons, setInclureDoublons] = useState(false);
  const [attestation, setAttestation] = useState(false);
  const [attestationTouchee, setAttestationTouchee] = useState(false);
  const analyse = useSuiviTache(analyseId);
  const confirmation = useSuiviTache(confirmationId);
  const rapport = useGetMembresImportTacheId(analyseId ?? '', {
    query: { enabled: analyse.data?.statut === 'terminee' },
  });

  const etape = confirmationId ? 2 : analyseId ? 1 : 0;
  const aCreer = (rapport.data?.aCreer ?? 0) + (inclureDoublons ? (rapport.data?.doublons ?? 0) : 0);

  const telechargerModele = async () => {
    setErreur(undefined);
    try {
      telechargerBlob('modele-import-membres.xlsx', await getMembresImportModele());
    } catch (e) {
      setErreur(messageErreur(e));
    }
  };

  const envoyer = async (fichier: File) => {
    setEnvoi(true);
    setErreur(undefined);
    try {
      setAnalyseId((await postMembresImport({ fichier })).id);
    } catch (e) {
      setErreur(messageErreur(e));
    } finally {
      setEnvoi(false);
    }
  };

  const confirmer = async () => {
    setAttestationTouchee(true);
    if (!attestation || !analyseId) return;
    setEnvoi(true);
    setErreur(undefined);
    try {
      const tache = await postMembresImportTacheIdConfirmer(analyseId, {
        inclureDoublons,
        attestationConsentement: true,
      });
      setConfirmationId(tache.id);
    } catch (e) {
      setErreur(messageErreur(e));
    } finally {
      setEnvoi(false);
    }
  };

  const confirmationTerminee = confirmation.data?.statut === 'terminee';
  useEffect(() => {
    if (confirmationTerminee) void invaliderMembres(client);
  }, [confirmationTerminee, client]);

  const recommencer = () => {
    setAnalyseId(undefined);
    setConfirmationId(undefined);
    setInclureDoublons(false);
    setAttestation(false);
    setAttestationTouchee(false);
    setErreur(undefined);
  };

  return (
    <Stack gap="lg" maw={1100}>
      <Anchor component={Link} to="/membres" size="sm">
        ← {t('membres.retourListe')}
      </Anchor>
      <Title order={1} size={28}>
        {t('import.titre')}
      </Title>
      {erreur && (
        <Alert color="red" role="alert">
          {erreur}
        </Alert>
      )}
      <Stepper active={etape} allowNextStepsSelect={false}>
        <Stepper.Step label={t('import.etape1')}>
          <Card withBorder radius={12} padding="lg" style={{ borderColor: '#E3E6EA' }}>
            <Stack gap="md">
              <Text>{t('import.consigne')}</Text>
              <Group>
                <Button variant="default" onClick={() => void telechargerModele()}>
                  {t('import.telechargerModele')}
                </Button>
              </Group>
              <DepotFichier
                label={t('import.fichier')}
                types={TYPES_IMPORT}
                tailleMax={TAILLE_MAX_IMPORT}
                extensions={EXTENSIONS_IMPORT}
                enCours={envoi}
                onFichier={(f) => void envoyer(f)}
              />
            </Stack>
          </Card>
        </Stepper.Step>
        <Stepper.Step label={t('import.etape2')}>
          <Card withBorder radius={12} padding="lg" style={{ borderColor: '#E3E6EA' }}>
            <Stack gap="md">
              {analyseId && analyse.data?.statut !== 'terminee' && (
                <SuiviTache id={analyseId} libelle={t('import.analyseEnCours')} />
              )}
              {analyseId && analyse.data?.statut === 'terminee' && (
                <>
                  <RapportAnalyse tacheId={analyseId} />
                  <Checkbox
                    label={t('import.inclureDoublons', { n: rapport.data?.doublons ?? 0 })}
                    description={t('import.inclureDoublonsAide')}
                    checked={inclureDoublons}
                    disabled={!rapport.data?.doublons}
                    onChange={(e) => setInclureDoublons(e.currentTarget.checked)}
                  />
                  <Checkbox
                    label={t('import.attestation')}
                    checked={attestation}
                    onChange={(e) => setAttestation(e.currentTarget.checked)}
                    error={attestationTouchee && !attestation ? t('import.attestationRequise') : undefined}
                  />
                  <Group>
                    <Button onClick={() => void confirmer()} loading={envoi} disabled={aCreer === 0}>
                      {t('import.confirmer', { n: aCreer })}
                    </Button>
                    <Button variant="default" onClick={recommencer}>
                      {t('import.autreFichier')}
                    </Button>
                  </Group>
                </>
              )}
              {analyse.data?.statut === 'echec' && (
                <Button variant="default" onClick={recommencer}>
                  {t('import.autreFichier')}
                </Button>
              )}
            </Stack>
          </Card>
        </Stepper.Step>
        <Stepper.Step label={t('import.etape3')}>
          <Card withBorder radius={12} padding="lg" style={{ borderColor: '#E3E6EA' }}>
            {confirmationId && <ResumeConfirmation tacheId={confirmationId} />}
          </Card>
        </Stepper.Step>
      </Stepper>
    </Stack>
  );
}
