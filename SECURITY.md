# Security Policy

## Supported versions

| Version | Supported |
| ------- | --------- |
| Latest (`main`) | Yes |
| Older tags | Best-effort |

## Reporting a vulnerability

**Please do not report security vulnerabilities through public GitHub issues.**

To report a vulnerability privately:

1. Open a [GitHub Security Advisory](https://github.com/bymosbot/mosbot-api/security/advisories/new) in this repository.
2. Provide a clear description of the issue, steps to reproduce, and potential impact.

We aim to acknowledge reports within **48 hours** and provide a fix or mitigation within **14 days** for critical issues.

## Disclosure policy

- We follow [coordinated disclosure](https://en.wikipedia.org/wiki/Coordinated_vulnerability_disclosure).
- We will credit reporters in release notes unless they prefer to remain anonymous.

## Security best practices for self-hosters

- Always set a strong, unique `JWT_SECRET` (see [docs/security/secrets.md](docs/security/secrets.md)).
- Run behind a reverse proxy (nginx, Caddy, Cloudflare) with TLS in production.
- Restrict database access to the API container only.
- Rotate secrets regularly and after any suspected compromise.
- Keep Node.js and dependencies up to date (`npm audit`).
