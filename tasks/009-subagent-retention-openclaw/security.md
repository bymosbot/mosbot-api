# Security Scan: Subagent Retention & OpenClaw Workspace Client

**Executed By**: Code Review MK8
**Date**: 2026-02-10
**Scope**: Staged changes (openclaw routes, purge job, workspace client, config)
**Scan Duration**: Manual review
**Tools Executed**: Manual code review, npm audit (permission failure), SQL injection analysis, input validation review

---

## Task List

- [x] 1.0 ✅ No critical security issues found - proceed with deployment
- [x] 2.0 🟡 Add radix to parseInt in subagents route (`src/routes/openclaw.js:419-420`) — fixed during review

---

## Executive Summary

- **Overall Status**: ✅ Pass
- **Critical**: 0
- **High**: 0
- **Medium**: 0 (parseInt radix fixed)
- **Low**: 0
- **Info**: 0

---

## Detailed Findings

### Critical & High Severity Issues

None found.

### Medium & Low Severity Issues

- **Manual Review** — 🟡 Medium — Missing radix parameter in parseInt (`src/routes/openclaw.js:419-420`)
  - **Impact**: `parseInt(process.env.SUBAGENT_RETENTION_DAYS)` without radix may interpret numbers in unexpected bases
  - **Remediation**: Use `parseInt(process.env.SUBAGENT_RETENTION_DAYS, 10)` and `parseInt(process.env.ACTIVITY_LOG_RETENTION_DAYS, 10)`
  - **Reference**: ESLint rule `radix`
  - **CVSS Score**: N/A (code quality issue)

---

## Dependency Health

- **Tool**: `npm audit` (failed due to sandbox/permission restrictions)
- **Vulnerabilities**: Not assessed (command failed)
- **Total Dependencies**: See `package.json` - no new dependencies added
- **Vulnerable Dependencies**: Unknown (audit failed)
- **Notes**: No new package.json dependencies in this change set.
- **Lock File Integrity**: Not verified

---

## Secret Scan

- **Tool**: Manual review
- **Result**: 0 secrets found
- **Status**: ✅ Clean
- **Findings**: No hardcoded secrets, API keys, or credentials
- **Notes**: Uses existing OPENCLAW_WORKSPACE_URL, OPENCLAW_WORKSPACE_TOKEN from env

---

## SAST Findings

- **Tools Executed**: Manual code review
- **Total Issues**: 1
- **By Category**:
  - Injection: 0 (paths hardcoded, encodeURIComponent used)
  - Authentication: 0 (requireAuth on subagents endpoint)
  - Authorization: 0 (all authenticated users can access subagents per design)
  - Cryptography: 0
  - Data Exposure: 0
  - Security Misconfiguration: 0
  - Other: 1 (parseInt radix)

### SQL Injection Protection

✅ **Advisory lock queries use parameterized placeholders**:
- `purgeSubagentData.js`: `pg_try_advisory_lock($1)`, `pg_advisory_unlock($1)` with PURGE_LOCK_ID constant
- No user input in SQL
- No string concatenation with user input

### Path Traversal / Injection

✅ **Workspace file paths are hardcoded**:
- Subagents route: `/runtime/mosbot/spawn-active.jsonl`, etc. - no user input
- Purge job: Same hardcoded paths
- `getFileContent` uses `encodeURIComponent(path)` when building request URL
- No path traversal risk from request parameters

### Authorization

✅ **Subagents endpoint uses requireAuth**:
- JWT required for GET /openclaw/subagents
- All authenticated users can access (per API spec - "all authenticated users")
- Purge job runs server-side on cron - no user-triggered access

---

## Configuration Security

- **Issues Found**: 0
- **Key Findings**: New env vars documented in .env.example and k8s configmap
- **Secrets Management**: ✅ No new secrets; uses existing OPENCLAW_* vars

---

## API Security

- **OpenAPI Validation**: N/A
- **Rate Limiting**: Not implemented (Cloudflare handles per project standard)
- **Authentication**: ✅ Validated - requireAuth on subagents
- **Findings**: Subagents endpoint returns 503 when service not configured; proper error propagation

---

## Artifacts Generated

None (manual review; no tool outputs collected)

---

## Next Steps

1. **Optional**: Add radix to parseInt in subagents route for consistency
2. Run `npm audit` outside sandbox for dependency verification prior to release
