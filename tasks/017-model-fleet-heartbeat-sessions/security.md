# Security Scan: 017-model-fleet-heartbeat-sessions

**Executed By**: Code Review MK8
**Date**: 2026-02-17
**Scope**: Staged changes (mosbot-api) — model fleet, heartbeat, session messages
**Tools Executed**: Manual review; npm audit (skipped — sandbox restriction)
**Scan Duration**: Manual

---

## Task List

- [x] 1.0 🟠 Add `requireAdmin` to GET `/api/v1/admin/models` — currently any authenticated user can list models

---

## Executive Summary

- **Overall Status**: ⚠️ Warning
- **Critical**: 0
- **High**: 1 (Admin GET lacks authorization)
- **Medium**: 0
- **Low**: 0
- **Info**: 0

## Detailed Findings

### High Severity Issues

- **Manual Review** — High — Admin models GET endpoint lacks `requireAdmin` (`src/routes/admin/models.js`)
  - **Impact**: Any authenticated user (including role `user`) can list all models via `GET /api/v1/admin/models`. Documentation states admin endpoints require `requireAdmin`. Violates least-privilege.
  - **Remediation**: Add `requireAdmin` middleware to the GET handler: `router.get('/', requireAdmin, async (req, res, next) => { ... })`
  - **Reference**: RBAC policy; docs/features/model-fleet-management.md

### Medium & Low Severity Issues

- None identified in changed code.

## Dependency Health

- **Tool**: npm audit
- **Status**: ⚠️ Skipped — Command failed due to sandbox/environment restriction (EPERM on npm-cli.js)
- **Recommendation**: Run `npm audit` and `npm audit fix` manually before merge; reference tasks/015-staged-api-changes/security.md for prior findings (qs, tar, bcrypt).

## Secret Scan

- **Tool**: Manual review
- **Result**: No hardcoded secrets in changed code
- **Notes**: OpenClaw tokens from env (`OPENCLAW_WORKSPACE_TOKEN`)

## SAST Findings

- **Tools Executed**: ESLint (lint run)
- **Total Issues**: 0 (fixed during review — removed unused vars)
- **Key**: Lint passes after fixes

## Configuration Security

- **Secrets Management**: ✅ Env vars used; no hardcoded credentials

## Input Validation & Injection

- **Model ID**: Validated (required, string, max 200 chars)
- **Alias**: Validated (required, non-empty string)
- **Params**: Validated (object, not array)
- **OpenClaw config write**: JSON.stringify; no raw user input concatenation. Model ID used as object key; alias/params are structured fields.
- **SQL Injection**: N/A — no database queries in model/config paths

## Artifacts Generated

- None

## Next Steps

1. Add `requireAdmin` to GET `/api/v1/admin/models` before merge
2. Run `npm audit` manually and address any findings
3. Verify OpenClaw workspace token is scoped appropriately for config read/write
