# Security Scan: 015-staged-api-changes

**Executed By**: Code Review MK8
**Date**: 2026-02-16
**Scope**: Staged changes (mosbot-api)
**Tools Executed**: npm audit

---

## Task List

- [ ] 1.0 🟠 Run `npm audit fix` to address qs vulnerability
- [ ] 2.0 🟡 Evaluate `npm audit fix --force` for tar/bcrypt (breaking change to bcrypt@6)
- [ ] 3.0 🟠 Mitigate credential logging — post-migration `001_initial_schema.post.js` prints agent passwords to console; ensure production logs do not capture this

---

## Executive Summary

- **Overall Status**: ⚠️ Warning
- **Critical**: 0
- **High**: 3 (tar/node-pre-gyp/bcrypt)
- **Medium**: 0
- **Low**: 1 (qs)
- **Info**: 0

## Detailed Findings

### High Severity Issues

- **npm audit** — High — tar / node-pre-gyp / bcrypt (`node_modules/tar`, `node_modules/@mapbox/node-pre-gyp`, `node_modules/bcrypt`)
  - **Impact**: tar has path overwrite/symlink issues; bcrypt depends on vulnerable node-pre-gyp
  - **Remediation**: `npm audit fix --force` upgrades bcrypt to 6.x (breaking). Alternative: Monitor for bcrypt/node-pre-gyp updates that don’t require force
  - **Reference**: GHSA-8qq5-rm4j-mr97, GHSA-r6q2-hw4h-h46w, GHSA-34x7-hfp2-rc4v

### Low Severity Issues

- **npm audit** — Low — qs (6.7.0 - 6.14.1)
  - **Impact**: Array limit bypass can cause DoS
  - **Remediation**: `npm audit fix`
  - **Reference**: GHSA-w7fw-mjwx-w883

## Dependency Health

- **Tool**: npm audit
- **Vulnerabilities**: Critical 0 | High 3 | Medium 0 | Low 1
- **Total Dependencies**: Standard for Node/Express stack
- **Vulnerable Dependencies**: 4 (qs, tar, @mapbox/node-pre-gyp, bcrypt)
- **Notes**: Run `npm audit fix` for qs. For tar/bcrypt, `npm audit fix --force` is a breaking change.
- **Lock File Integrity**: ✅ Verified

## Secret Scan

- **Tool**: Manual review
- **Result**: No hardcoded secrets in changed code
- **Notes**: Post-migration logs generated passwords to console; ensure they are not persisted to log aggregators

## SAST Findings

- **Tools Executed**: ESLint (lint run)
- **Total Issues**: 14 (3 errors, 11 warnings) — see review.md
- **Key**: Use of `console.log` for credentials in post-migration; unused variable; dead code in openclaw.js

## Configuration Security

- **Secrets Management**: ✅ Env vars used for tokens; no hardcoded credentials

## Artifacts Generated

- None (manual review)

## Next Steps

1. Run `npm audit fix` before merge
2. Decide on bcrypt upgrade (breaking) vs. accepting risk short-term
3. Ensure migration credential output is not captured by production log pipelines
