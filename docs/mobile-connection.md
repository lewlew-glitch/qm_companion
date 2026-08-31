# Mobile connections

Companion supports two independent ways to configure and connect Quartermaster:

- A short-lived setup transfer containing service addresses and credentials.
- An optional persistent HTTPS connection to Companion for its native Docker overview.

The setup transfer does not relay later service traffic. The persistent connection is enabled separately with `docker-compose.mobile.yml`.

## Service setup transfer

Open **Set up** after signing in to Companion. Each detected instance has its own row and routes.

1. Review the local address for every instance.
2. Select the instances to include.
3. Add an away address where required.
4. Create the transfer, scan it in Quartermaster, and enter the separate setup code.

Companion classifies detected services before selection:

- A running service that answers the reachability check is selected by default.
- A running container that Companion cannot reach is not selected. The advanced **Include anyway** option can include it so the phone can test the route.
- A container reported as stopped, paused, restarting, created, or dead cannot be included until it is running.
- A service without enough Docker or probe information starts unselected and may be selected manually.

Local and away URLs are stored separately. Paths such as `https://example.com/radarr` are supported. User information, passwords, query strings, and fragments are rejected in base URLs.

The QR code contains a 256-bit redemption capability rather than the setup data. It retrieves an encrypted envelope and expires after three minutes. The first redemption opens a short retry window for a dropped response, after which the transfer is removed. The separately displayed setup code contains 128 bits of randomness.

The signed-in download is a `.qmcompanion` file. It consumes the same transfer as the QR code and is imported through Quartermaster's **Set up with Companion** flow. If setup stops after consumption, create a new transfer. Treat a QR screenshot, download, or setup code as sensitive until the transfer expires or is consumed.

### Cloudflare Access for away routes

Cloudflare Access service tokens apply only to service away routes in the setup transfer. They are not used by the persistent Companion connection.

Open Companion over HTTPS before entering a service-token domain, client ID, and client secret. Companion copies the encrypted header pair only to services whose reviewed HTTPS away host exactly matches that domain. The credentials are not applied to the whole profile. The server refuses these long-lived credentials when the Companion page uses plain HTTP.

Create a Service Auth policy with the minimum access required by the published applications. Rotate or revoke its credentials in Cloudflare when necessary. See [Cloudflare Access service tokens](https://developers.cloudflare.com/cloudflare-one/access-controls/service-credentials/service-tokens/).

Setup-transfer defaults can be adjusted with these variables:

| Variable | Purpose |
| --- | --- |
| `QM_REMOTE_HOST` | Preset shown for away routes. It is never applied without review. |
| `QM_TITLE` | Profile name imported by the phone. The default is `Home`. |

## Persistent Companion connection

The mobile profile enables a dedicated HTTPS listener on port 8788. Pairing uses a single-use key or QR code, followed by a five-word comparison and owner approval.

The connection supports one exact origin from `QM_ADVERTISED_ORIGIN`. A direct LAN origin or a direct Tailscale origin is supported. Automatic LAN and away switching, reverse-proxy fronting, and tunnel fronting are not supported for this listener. Once device grants exist, changing the origin requires explicit approval and every phone must pair again. An installation with no grants may adopt a valid origin automatically.

When the profile is enabled, HTTPS 8788 serves the owner panel and mobile API. Plain HTTP exposes only the limited health and static responses; it does not expose setup, sign-in, owner, device, or API data and does not accept management requests.

### Required addresses

The profile requires two values:

| Value | Meaning |
| --- | --- |
| `QM_MOBILE_BIND_IP` | An IP address assigned to the Docker host where port 8788 is published. Use a LAN or Tailscale IP, not a DNS name or `0.0.0.0`. |
| `QM_ADVERTISED_ORIGIN` | The exact `https://host:port` reached by the phone. It is recorded in pairings and supplies the certificate host. |

A LAN deployment commonly uses one address for both values:

```sh
QM_MOBILE_BIND_IP=192.168.1.20
QM_ADVERTISED_ORIGIN=https://192.168.1.20:8788
```

A Tailscale deployment can bind its Tailscale IP while advertising its MagicDNS name:

```sh
QM_MOBILE_BIND_IP=100.100.20.5
QM_ADVERTISED_ORIGIN=https://nas.tail1a2b3c.ts.net:8788
```

Store these values in the same private `.env` source used by the base installation. Do not add a second `SECRET_KEY` to the mobile overlay.

Run the host preflight before deployment:

```sh
set -a
. ./.env
set +a
node scripts/preflight-mobile.mjs
unset QM_MOBILE_BIND_IP QM_ADVERTISED_ORIGIN MOBILE_PORT SECRET_KEY QM_PROXY_KEY
```

The preflight checks that the bind IP belongs to the host, rejects wildcard addresses, and checks the origin port against `MOBILE_PORT`.

### Compose order

Place `docker-compose.mobile.yml` after every Compose file that sets `ports`. An override using `ports: !override` replaces the complete port list. If that override follows the mobile file, the HTTPS listener can start inside the container without port 8788 being published by Docker.

Read-only installation with the mobile connection:

```sh
docker compose -f docker-compose.example.yml -f docker-compose.mobile.yml up -d --build
```

Management installation with the mobile connection:

```sh
docker compose -f docker-compose.example.yml -f docker-compose.management.yml -f docker-compose.mobile.yml up -d --build
```

Repeat the same file list and order for later recreates. Custom files that replace `ports` belong before the mobile overlay.

### Pair a phone

1. Sign in through HTTPS and open **Devices**.
2. Select **Create pairing key** or **Show QR code**.
3. In Quartermaster, choose **Add connection**, then **QM Companion**.
4. Enter the key or scan the QR code.
5. Compare the five words on both screens, then approve the phone in Companion.

Pairing keys and QR codes are single-use. QR enrolments expire after ten minutes. The QR contains the advertised origin, server identity fingerprint, and a scanned pairing capability. Companion does not log or store the QR text.

For scripted owner clients, `POST /api/mobile/v1/enrolments` with `{ "mode": "qr" }` returns the QR text and a PNG data URL. A request without a body creates the typed key. Both use the same claim and approval flow.

Set `MOBILE_ENROLMENT_ENABLED=false` between pairings if new enrolment should be disabled. Existing devices remain connected. Revoke a phone from **Devices** to reject its next request.

### Failure behavior

The host port is created by Docker before Companion starts. If `QM_MOBILE_BIND_IP` is not assigned to the host, port 8788 is already allocated, or the mapping is invalid, Docker refuses to start the container and port 8787 is unavailable as well. Run `scripts/preflight-mobile.mjs` before deployment and verify both published ports from the host.

If a later Compose override removes the 8788 mapping, the internal listener may still report healthy even though it cannot be reached from another machine. Test `QM_ADVERTISED_ORIGIN` from another device after deployment.

Failures inside the mobile listener, including invalid TLS material or an unavailable internal port, do not stop the main process or its health check. The secure owner interface stays closed when the mobile profile cannot start. Use the container log or the read-only diagnosis in [Backup and recovery](recovery.md).

The listener does not send HSTS. Ports 8787 and 8788 normally share a hostname, while HSTS applies to a host rather than an individual port.

Access and refresh grants are stored as digests. Refresh rotation allows one encrypted successor response for an interrupted request and clears it when used, revoked, or expired. Reuse of an older refresh grant revokes the device family.

## Mobile configuration

| Variable | Required | Purpose |
| --- | --- | --- |
| `QM_MOBILE_BIND_IP` | Compose profile | Host IP where Docker publishes port 8788. |
| `MOBILE_API_ENABLED` | no | Parent switch for the persistent connection. The mobile overlay sets it to `true`. |
| `MOBILE_ENROLMENT_ENABLED` | no | Allows new pairings while the parent switch is enabled. Existing devices continue when it is `false`. |
| `QM_ADVERTISED_ORIGIN` | mobile profile | Exact HTTPS origin reached by phones. It cannot be a wildcard, unspecified, multicast, or reserved address. |
| `MOBILE_PORT` | no | HTTPS listener port. The default is `8788`; it must match the advertised origin. |
| `MOBILE_BIND_ADDRESS` | no | Listener address inside the container. The default is `0.0.0.0`; the published host address limits external exposure. |

Certificate setup and rotation are covered in [TLS and certificates](tls-and-certificates.md).
