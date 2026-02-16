# Database constraints

This guide documents the database-level constraints that provide defense-in-depth for Mosbot.

## Source of truth

- The effective schema is applied via migrations in `src/db/migrations/` (see `docs/guides/database-migrations.md`).
- If `src/db/schema.sql` exists, treat it as **reference/legacy** unless your migration docs explicitly state otherwise.

## Constraints (high level)

- **Tags**
  - Max 20 tags per task
  - Max 50 chars per tag
  - Lowercase-only
  - No empty/whitespace-only tags
- **Users**
  - Basic email format validation
  - Non-empty `name`
- **Tasks**
  - Non-empty `title`
  - `done_at` consistency with `status='DONE'`
  - `archived_at` consistency with `status='ARCHIVE'`
  - Basic “reasonable” `due_date` check

## Related

- Migration guide: `docs/guides/database-migrations.md`
- Public API tags normalization rules: `docs/api/openclaw-public-api.md`
