# Saltbox

Only Companion joins the external `saltbox` network. Traefik terminates HTTPS and forwards requests to port 8787 inside the container; the host does not publish that port. The Docker proxy stays on `qm-internal`, publishes no port and remains the only service with the Docker socket mounted.

`docker-compose.saltbox.yml` is an override for `docker-compose.example.yml`, not a standalone Compose file. The base file supplies Companion, the authenticated Docker proxy, health checks, security settings and persistent storage. The Saltbox file changes only the routing, networks and mounts needed behind Traefik.

Use Docker Compose 2.24.4 or newer. Check the installed version with `docker compose version`.

## Configure the address

Complete the main [Quick install](../README.md#quick-install) first so `.env` already contains `SECRET_KEY` and `QM_PROXY_KEY`. Then add the Saltbox host, Companion domain and certificate resolver. Replace the example address and domain with values from this installation:

```sh
QM_HOST=192.0.2.10
QM_COMPANION_DOMAIN=companion.example.com
QM_TRAEFIK_CERTRESOLVER=cfdns
```

`QM_HOST` is the LAN or Tailscale address used when Companion suggests service routes. `QM_COMPANION_DOMAIN` is the host name handled by Traefik and must not include a scheme or path. Use the certificate resolver configured by this Saltbox installation; common values are `cfdns` and `httpresolver`.

Compose expressions such as `${QM_HOST:?QM_HOST is required}` read the named value from `.env`. Everything after `:?` is only the error shown when the value is missing; it is not part of the setting. `ports: !override []` replaces the port list inherited from the base file with an empty list, so port 8787 is not exposed directly on the host. The other `!override` entries replace the example mounts and networks instead of adding to them.

Saltbox's generated custom-container file is a generic starting point, not a replacement for the base file. Keep the service name `companion` so the files merge correctly, keep `qm-data:/data` for application state, and retain the supplied `socket-proxy` service through the base file.

The overlay sets `TRUST_PROXY=true` because Traefik terminates HTTPS. Companion uses `X-Forwarded-Proto` when creating setup links and marks its session cookie Secure. Forwarded client addresses are not used for login throttling.

## Service configuration files

Docker discovery and management use the supplied socket proxy and do not need access to application data. `/data` is the Companion service's only required data mount; the socket proxy keeps the Docker socket bind from the base file.

To let Companion read an API key from a service configuration file, add that file to the `companion` volume list in `docker-compose.saltbox.yml`:

```yaml
    volumes: !override
      - /opt/radarr/config.xml:/stack/radarr/config.xml:ro
      - /opt/sonarr/config.xml:/stack/sonarr/config.xml:ro
      - qm-data:/data
```

Use only files that exist on the host. Do not mount `/opt` or an entire application directory. Keys can also be entered through Companion without adding these mounts.

Keep `qm-data:/data` in the list whenever `volumes: !override` is changed.

## Start Companion

Check the merged configuration before starting it:

```sh
docker compose -f docker-compose.example.yml -f docker-compose.saltbox.yml config --quiet
docker compose -f docker-compose.example.yml -f docker-compose.saltbox.yml up -d --build
```

Place an access overlay between the base file and the Saltbox file. For example, Management mode uses:

```sh
docker compose -f docker-compose.example.yml -f docker-compose.management.yml -f docker-compose.saltbox.yml up -d --build
```

The supplied router uses Companion's own owner login and two-factor authentication. If Authelia, Authentik, or another forward-auth middleware is added, leave only `GET /pair/redeem/<token>` outside it so Quartermaster can retrieve the one-time transfer. Do not bypass `/pair` as a whole.

## Direct mobile connection

With the mobile profile enabled, the owner panel and mobile API move to direct HTTPS on port 8788. Port 8787 then serves only health and static responses. Do not route 8788 through Traefik or forward auth: phones pin Companion's certificate and exact origin, so the mobile profile must remain a direct LAN or Tailscale connection.

Apply the mobile file last so its port is not removed by the Saltbox overlay:

```sh
docker compose -f docker-compose.example.yml -f docker-compose.saltbox.yml -f docker-compose.mobile.yml up -d --build
```

See [Mobile connections](mobile-connection.md) for the required bind address and advertised origin.
