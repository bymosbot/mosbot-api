# Local development

## Prerequisites

- Node.js (see `package.json` engines)
- PostgreSQL

## Setup

1. Install dependencies:

```bash
npm install
```

1. Configure environment:

- Copy `.env.example` to `.env`
- Set your `DB_*` values

1. Run migrations:

```bash
npm run migrate
```

1. Start the API:

```bash
npm run dev
```

## Health check

```bash
curl http://localhost:3000/health
```

## Related

- Database migrations: `docs/guides/database-migrations.md`
- OpenClaw local dev: `docs/guides/openclaw-local-development.md`
