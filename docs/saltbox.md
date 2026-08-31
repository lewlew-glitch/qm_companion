# Saltbox

Only Companion joins the external `saltbox` network. Traefik terminates HTTPS and forwards requests to port 8787 inside the container; the host does not publish that port. The Docker proxy stays on `qm-internal`, publishes no port and remains the only service with the Docker socket mounted.

## Configure the address

Add the Saltbox host, Companion domain and certificate resolver to `.env`. Replace the example address and domain with values from this installation:

```sh
QM_HOST=192.0.2.10
QM_COMPANION_DOMAIN=companion.example.com
QM_TRAEFIK_CERTRESOLVER=cfdns
```

`QM_HOST` is the LAN or Tailscale address used when Companion suggests service routes. `QM_COMPANION_DOMAIN` is the host name handled by Traefik and must not include a scheme or path. Use the certificate resolver configured by this Saltbox installation; common values are `cfdns` and `httpresolver`.

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
