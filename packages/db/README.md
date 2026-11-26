# @assoflow/db

- `migrations/NNNN_nom.sql` : migrations relues à la main, appliquées une seule fois, jamais modifiées après application.
- `0001_initial.sql` = `docs/schema.sql` (schéma de référence v1.0).
- Règle _expand/contract_ : voir `docs/02-modele-donnees.md` §8.

```bash
DATABASE_URL=postgres://assoflow_owner:assoflow@localhost:5432/assoflow pnpm db:migrate
```
