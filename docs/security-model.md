# Security model

Companion is a privileged component in a self-hosted installation. It can read selected service credentials and Docker metadata. Optional profiles can give it Docker write and container-exec access.

The main assets to protect are the owner account, browser sessions, `SECRET_KEY`, `QM_PROXY_KEY`, the data volume, service API keys, Cloudflare Access tokens, and mobile pairing material.

## Owner authentication

Application routes use exact method and path matches and deny unknown routes. First-run setup requires the configured or generated bootstrap token and closes after one owner claim succeeds.

Passwords are processed with scrypt. Login and two-factor attempts are throttled by the direct TCP peer. Forwarded client-address headers are not trusted for authentication throttling because an exposed origin could spoof them. If all traffic reaches Companion through one local reverse proxy, its clients share a throttle bucket; apply an additional rate limit for login routes at that proxy.

Two-factor tickets are bound to the peer that completed the password step. Changing the password or two-factor settings revokes older browser sessions and gives the current browser one replacement session. State-changing authenticated requests require same-origin and CSRF checks.

Browser responses deny framing, set a restrictive content security policy, and disable unneeded browser permissions.

## Stored data

Persistent state is authenticated. Sensitive fields are encrypted with keys derived from `SECRET_KEY`, including service credentials, scheduled command text, and stored command results. Writes use restrictive file permissions and atomic replacement where state continuity is required.

Docker access mode and mobile state use separate authenticated sidecars bound to the installation. Back up the whole data volume rather than only `qm-companion.json`. A damaged or unauthenticated sidecar is refused instead of being interpreted with a default that could raise access.

API keys are not rendered in panel pages. Companion may use a key in a server-side request to its matching service. A phone setup receives it only inside the encrypted one-time package. Container inspection sends the browser an allowlist of operational values and otherwise reports only that a value exists.

Pairing secrets are submitted by `POST`, not query strings. Pairing responses use `no-store` and a no-referrer policy. A standard setup transfer requires possession of both the redemption capability and the separately displayed setup code.

## Network transport

The panel's plain HTTP mode is intended for a trusted private network. An on-path peer can observe the owner password and session. Use a trusted HTTPS reverse proxy before exposing the panel beyond that network. Set `TRUST_PROXY=true` only when requests arrive through that proxy.

Cloudflare Access service credentials are accepted only when the Companion page itself uses HTTPS. They are encrypted and attached only to matching reviewed HTTPS away hosts.

The persistent mobile connection has a separate TLS and pairing design. Phones pin the approved certificate and origin. See [Mobile connections](mobile-connection.md) and [TLS and certificates](tls-and-certificates.md).

## Service credentials

Companion can create a service key by signing in only for Jellyfin, Emby, and Portainer. Other services use a manual sealed paste. A key can also be read from an approved mounted file or, with Management + shell, from the approved path inside a detected container.

Each sign-in flow binds its target on the server to the detected service instance. The browser cannot supply an arbitrary target. Public HTTPS certificates are verified. For a private resolved address, the current transport accepts a self-signed certificate without a stored fingerprint and discloses this in the key-creation dialog. Plain HTTP targets are limited to private, loopback, ULA, and link-local addresses.

The service administrator credential exists only for the request. It is not stored, logged, or written to the audit entry. A created API key is sealed into state with additional authenticated data for its service instance so it cannot be replayed against another instance. Companion does not create a service's single shared global key where doing so would replace the key used by other integrations.

Mounting an individual config file read-only prevents writes but permits reads. Mount only the files needed for the selected services. A directory mount makes every file beneath it available to the Companion process even if discovery ignores most of them.

## Docker authority

The installed Compose profile is the maximum Docker authority granted to the process. The active mode selected in the panel is an application authorization control within that maximum.

The shipped Read only profile uses proxy `POST=0` and `EXEC=0`. Management enables broad Docker writes. Management + shell also enables container exec. The latter two profiles should be treated as host-root-equivalent. Lowering the active panel mode does not remove the proxy permission from a compromised Companion process.

A raw Docker socket mount has no read-only security boundary. Docker inspection can also disclose container environment values, mounts, and host topology. Configuration and operational limits are covered in [Docker access](docker-access.md).

Marketplace deployment rejects Docker socket binds and host binds outside the configured roots. This validation does not make Docker writes low privilege. Review proposed Compose before deployment, especially proposals sourced from unreviewed community templates.

## External communication

Companion has no telemetry and no hosted account dependency. These features make outbound requests:

- Service probes contact configured local service addresses.
- Registry update checks and image operations contact container registries.
- Registry metadata requests use HTTPS, reject redirects, limit response size, and reject names that resolve to local, private, or link-local addresses.

## Limits

The design does not protect against a compromised host, a stolen signed-in browser session, or disclosure of both a live setup capability and its setup code. Revoke affected sessions and service credentials after such an event.

Script bearer tokens are read-only and limited to documented status endpoints. Container logs remain session-only because logs can contain application secrets.

## Security-related configuration

| Variable | Required | Purpose |
| --- | --- | --- |
| `SECRET_KEY` | yes | Exactly 64 hexadecimal characters. Encrypts sensitive state and must remain stable across upgrades. |
| `QM_PROXY_KEY` | socket proxy | At least 32 characters and different from `SECRET_KEY`. Authenticates requests to the Docker proxy. |
| `SETUP_TOKEN` | no | First-run bootstrap token containing 32 to 256 base64url characters. A 256-bit value is generated and logged while ownerless when absent. |
| `DATA_DIR` | no | Persistent state directory. The Compose profile uses `/data`. |
| `SESSION_TTL_HOURS` | no | Owner session lifetime. The default is 24 hours. |
| `COOKIE_SECURE` | no | Explicitly controls the session cookie's Secure flag. |
| `TRUST_PROXY` | no | Enables trusted reverse-proxy handling and Secure cookies by default. Set only behind a trusted HTTPS proxy. |

## Reporting a vulnerability

Follow [SECURITY.md](../SECURITY.md). Do not include real credentials, session cookies, setup tokens, QR contents, or `SECRET_KEY` in a public issue.
