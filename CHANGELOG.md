# Changelog

All notable changes to MosBot API will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Committed `docker-compose.override.yml` for local development convenience (auto-loaded by docker compose)
- Development override swaps production nginx dashboard for Vite dev server with HMR and bind-mounted source
- OpenClaw split-root support, including native `~/.openclaw` remaps and config-root/workspace separation
- Comprehensive test suite covering config, app entry point, database migrations, jobs (archiveDoneTasks, runDailyStandup), routes (activity, auth, models, openclaw, standups, tasks, users, admin/users agent-config), services (activityLogService, modelPricingService, openclawGatewayClient, openclawWorkspaceClient, sessionUsageService, standupService, subagentsRuntimeService), and utilities (configParser, jwt, logger)
- `.claude/` project rules and configuration (CLAUDE.md + rules for architecture, contributing, openclaw, security, testing)
- Internal docs-link reconciliation service for OpenClaw workspaces (`docs` links), plus workspace client helpers for `/links/:type/:agentId`
- Startup + agent create/update lifecycle hooks that reconcile docs links only when missing (`GET` state first, `PUT` only on `missing`)

### Changed

- Simplified org chart generation to derive from `agents.list` and removed corporate defaults
- Renamed org chart references to agents
- Improved CORS configuration to handle requests with no origin (mobile apps, curl requests)
- Updated Helmet security middleware configuration with crossOriginResourcePolicy
- Reordered middleware (CORS before Helmet) to avoid configuration conflicts
- Normalized main OpenClaw workspace paths to `/workspace` and removed legacy aliasing
- OpenClaw remap defaults are now additive with longest-prefix matching
- CI workflow updated to include test execution step
- Jest config updated to support full test suite
- Various route and service refinements to support test coverage (activity, openclaw, admin/users, tasks, users)
- `.gitignore` updated to exclude additional generated files
- Documentation references updated for OpenClaw path changes
- API startup now performs non-fatal docs-link reconciliation for `main` and configured agents from `openclaw.json`
- Agent configuration create/update flows now trigger non-fatal docs-link reconciliation for affected agents
- Docs-link reconciliation remains internal-only in this phase (no public Mosbot API link-management endpoint; dashboard does not trigger writes)

### Fixed

- Disabled OpenClaw workspace client when the workspace URL is unset
- Gateway auth fallback now uses the backend client identity
- OpenClaw remap handling now remaps absolute paths before workspace allowlist checks
- OpenClaw fallback agents now allow legacy archived paths

### Security

- Switched Gitleaks license key to an organization secret

## [0.1.2] - 2026-03-01

### Changed

- Updated workspace paths: `/shared/docs` → `/docs` and `/shared/projects` → `/projects`
- Updated README and documentation to reference new documentation site (bymosbot.github.io/mosbot-docs)
- Added backward compatibility for legacy `/shared/projects` paths in activity feed
- Updated API documentation to reflect new workspace path structure

## [0.1.1] - 2026-03-01

### Added

- OpenClaw integration instructions in README

### Changed

- Updated Dockerfile to ignore scripts during npm installation
- Enhanced Dockerfile for multi-platform support
- Improved CI workflows

## [0.1.0] - 2026-02-28

First push. Initial project setup and open source release of MosBot API.

[Unreleased]: https://github.com/bymosbot/mosbot-api/compare/v0.1.2...HEAD
[0.1.2]: https://github.com/bymosbot/mosbot-api/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/bymosbot/mosbot-api/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/bymosbot/mosbot-api/releases/tag/v0.1.0
