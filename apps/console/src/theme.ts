import { createTheme, type MantineColorsTuple } from '@mantine/core';

// Accent vert-bleu de la maquette (canvas « AssoFlow – Aperçu de la console »).
const accent: MantineColorsTuple = [
  '#E6F2EF',
  '#CDE5DF',
  '#A6D2C8',
  '#7BBDAF',
  '#4FA796',
  '#2C9281',
  '#0E7C6B',
  '#0B6B5C',
  '#084F44',
  '#06392F',
];

export const theme = createTheme({
  primaryColor: 'accent',
  primaryShade: 6,
  colors: { accent },
  fontFamily: 'Inter, system-ui, sans-serif',
  headings: { fontFamily: '"Space Grotesk", Inter, sans-serif', fontWeight: '600' },
  defaultRadius: 'md',
});
