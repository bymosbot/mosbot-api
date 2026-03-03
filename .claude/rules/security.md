# Security & Secrets

No paths frontmatter — these rules apply globally at all times.

## Do

- Load all config via `process.env` — initialize `dotenv` at the top of `src/index.js`.
- Commit `.env.example` with placeholder values only (e.g. `JWT_SECRET=change-me`).
- Fail fast on startup if required secrets are missing — never fall back to a default.
- Hash passwords with `bcrypt` (`saltRounds = 10`); use `bcrypt.compare` for login.
- Validate and normalize all file paths before forwarding to external services — block `..` sequences.

## Don't

- Don't hardcode credentials, tokens, connection strings, or internal URLs in source.
- Don't commit `.env`, `.env.local`, or any file containing real values.
- Don't log passwords, tokens, or PII at any log level.
- Don't return stack traces or internal error details in API responses — log server-side only.
- Don't set `CORS_ORIGIN=*` when credentials are enabled.

## Required env vars (must never have defaults)

| Variable | Why |
| -------- | --- |
| `JWT_SECRET` | A default secret makes all tokens forgeable |
| `DATABASE_URL` | A wrong DB silently corrupts or exposes data |

## .env files

| File | Committed? | Purpose |
| ---- | ---------- | ------- |
| `.env.example` | Yes | Placeholder template for contributors |
| `.env` | No | Local secrets (git-ignored) |

## If you accidentally committed a secret

1. Immediately revoke/rotate the exposed credential — assume it is compromised.
2. Remove from history: use `git filter-repo` or BFG Repo Cleaner.
3. Force-push the cleaned branch and notify maintainers.
4. Verify: `git log -p | grep <partial-secret>`.
5. If the repo is public, treat the credential as fully compromised regardless of removal speed.

## Dependencies

- Run `npm audit` before opening a PR that adds or upgrades dependencies.
- Do not add dependencies with known high/critical CVEs without documented justification.
