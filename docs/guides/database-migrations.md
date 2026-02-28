# Database migrations

This repo uses a migration runner that applies pending `src/db/migrations/*.sql` files in filename order and records them in `schema_migrations`.

## Run migrations

Automatic (on API startup):

```bash
npm start
```

Manual:

```bash
npm run migrate
```

## Reset database (development)

```bash
npm run db:reset
```

⚠️ This deletes data.

## Notes

- For conventions when **writing** migrations (idempotency, safe DDL patterns), see `.cursor/rules/migrations.mdc`.
- `src/db/migrations/README.md` documents the current consolidated schema approach.
