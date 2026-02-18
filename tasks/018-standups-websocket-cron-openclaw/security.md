# Security Scan: 018-standups-websocket-cron-openclaw

**Executed By**: Code review command
**Date**: 2026-02-18
**Scope**: Commits cb430d7..HEAD (18 commits)
**Tools Executed**: npm audit, manual review

---

## Executive Summary

- **Overall Status**: ⚠️ Warning
- **Critical**: 0
- **High**: 0
- **Medium**: 7 (dev dependencies only)
- **Low**: 0
- **Info**: 0

---

## Task List

- [ ] 1.0 🟡 Address ESLint/ajv ReDoS vulnerability in dev dependencies — consider `npm audit fix` or upgrading ESLint when feasible (`package.json`, devDependencies)
- [ ] 2.0 ✅ Verify no secrets in new code paths (standups, gateway WebSocket) — manual review performed; no hardcoded secrets
- [ ] 3.0 ✅ Re-run npm audit after any dependency updates

---

## Detailed Findings

### Dependency Health

- **Tool**: `npm audit`
- **Vulnerabilities**: Critical 0 | High 0 | Medium 7 | Low 0
- **Total Dependencies**: As per package-lock.json
- **Vulnerable Dependencies**: ajv (via @eslint/eslintrc), eslint, eslint-plugin-promise, eslint-plugin-node
- **Notes**: All 7 moderate issues are in **devDependencies** (ESLint ecosystem). The ajv ReDoS (GHSA-2g4f-4pwh-qvx6) affects `$data` option usage. ESLint uses ajv for config validation. Production runtime dependencies (express, pg, bcrypt, etc.) are not affected.
- **Lock File Integrity**: ✅ Verified

### Secret Scan

- **Tool**: Manual review
- **Result**: No hardcoded secrets in changed files
- **Status**: ✅ Clean
- **Notes**: OPENCLAW_GATEWAY_URL, OPENCLAW_GATEWAY_TOKEN, TIMEZONE are env vars. No credentials in code.

### Access Control Changes (Positive)

- **requireManageUsers**: New middleware restricts user create/update/delete to **admin and owner only**. Agent role can no longer manage users — improves RBAC.
- **System config protection**: Agent role blocked from modifying `/openclaw.json` and `/org-chart.json` via POST/PUT/DELETE workspace files.

### API Security

- **Standups routes**: Require `authenticateToken`; admin-only routes use `requireAdmin`. UUID validation on path params.
- **Public config**: `GET /api/v1/config` exposes only `timezone` — no sensitive data.

---

## Artifacts

- SARIF: Not generated (manual scan)
- Logs: npm audit output captured during review

---

## Next Steps

1. **Immediate**: Accept medium dev-dependency risk or schedule ESLint upgrade.
2. **Follow-up**: Track ESLint 9.x migration for ajv update path.
3. **Verification**: Re-run `npm audit` after any `npm update` or `npm install`.
