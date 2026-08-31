# Security policy

Quartermaster Companion handles service credentials and can optionally control Docker. Do not publish suspected vulnerabilities, proof-of-concept payloads, credentials, or pairing codes in a public issue.

Report security issues through the repository's private vulnerability-reporting page:

https://github.com/lewlew-glitch/qm_companion/security/advisories/new

Include the affected revision, deployment shape, reproduction steps, and likely impact. Redact real API keys, session cookies, setup tokens, QR values, and `SECRET_KEY`. We aim to acknowledge reports within seven days.

Security support covers the current default branch. A fix may require credential rotation; any required action will be documented with the fix.

Deployment assumptions, trust boundaries, and security limits are documented in [Security model](docs/security-model.md).
