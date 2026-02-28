# Contributing to MosBot API

Thank you for your interest in contributing! This document covers how to get started, the branch model, and what we expect in pull requests.

## Development setup

```bash
git clone https://github.com/bymosbot/mosbot-api.git
cd mosbot-api
cp .env.example .env   # edit required values (see README)
make up                # start full stack via Docker Compose
```

Or without Docker:

```bash
npm install
npm run migrate
npm run dev
```

## Branch model (trunk-based)

We use **trunk-based development** with short-lived feature branches:

| Branch | Purpose |
| ------ | ------- |
| `main` | Production-ready code. Protected. |
| `feature/*` | New features (e.g. `feature/add-cron-api`) |
| `fix/*` | Bug fixes (e.g. `fix/auth-token-expiry`) |

**Never commit directly to `main`.** All changes go through a pull request.

## Workflow

```bash
# Start from an up-to-date main
git checkout main && git pull

# Create a feature branch
git checkout -b feature/your-feature

# Make changes, then verify
npm run lint
npm test -- --passWithNoTests

# Push and open a PR to main
git push -u origin feature/your-feature
```

## Pull request checklist

- [ ] Tests pass (`npm test -- --passWithNoTests`)
- [ ] Linter passes (`npm run lint`)
- [ ] No secrets or credentials committed
- [ ] New env vars added to `.env.example` with safe placeholder values
- [ ] Relevant docs updated

## Commit message format

Use [Conventional Commits](https://www.conventionalcommits.org/):

```
feat: add cron job pause endpoint
fix: handle missing JWT_SECRET at startup
docs: update configuration reference
refactor: extract session normalizer
test: add integration tests for auth routes
chore: bump node to 20
```

## Code style

- 2-space indentation
- Single quotes for strings
- `async/await` over callbacks
- Parameterized SQL queries (never string interpolation with user input)
- Use the project logger (`src/utils/logger.js`) instead of `console.*`
- Prefix unused parameters with `_` (e.g. `_next`, `_err`)

Run `npm run lint` before pushing. The CI will reject PRs with lint errors.

## Security

- Never commit secrets, tokens, or passwords
- Use parameterized queries to prevent SQL injection
- Hash passwords with bcrypt (salt rounds ≥ 10)
- Validate all user input before using it
- See [docs/security/secrets.md](docs/security/secrets.md) for the full policy

To report a security vulnerability privately, see [SECURITY.md](SECURITY.md).

## Adding database migrations

See [docs/guides/database-migrations.md](docs/guides/database-migrations.md).

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](LICENSE).
