# Unraid

Community Apps installs Quartermaster Companion as two containers. The dedicated `qm-socket-proxy` keeps the Docker socket out of the main application and authenticates Companion before forwarding an allowed Docker request.

## Install

Open the Unraid terminal and generate two different keys:

```sh
printf 'SECRET_KEY='; openssl rand -hex 32
printf 'QM_PROXY_KEY='; openssl rand -hex 32
```

Keep both values private. `SECRET_KEY` protects the saved Companion state and must not change during an upgrade. `QM_PROXY_KEY` authenticates the connection between the two containers.

Use the supplied `qm-socket-proxy`; other socket proxies do not enforce Companion's key and endpoint rules. If another application already uses one, leave it in place and install `qm-socket-proxy` separately for Companion.

1. Install `qm-socket-proxy` from Apps. Keep that container name, enter the generated `QM_PROXY_KEY`, and leave Docker writes and Container shell set to `0`.
2. Install `qm-companion`. Enter the same `QM_PROXY_KEY`, the separate `SECRET_KEY`, and the LAN or Tailscale address of the Unraid server in Server address.
3. Open the Companion Web UI and create the owner account. If the first-run token is requested, open the `qm-companion` container log in Unraid.

Keep both container names and leave Companion's Docker host set to `tcp://socket-proxy:2375`. Do not add a host port to `qm-socket-proxy`; Companion reaches it through the template's internal Docker link.

Standard setup transfer works without the persistent mobile connection. To enable persistent access, edit `qm-companion` in Unraid, open the advanced settings and:

1. Set Mobile HTTPS port to `8788`. Keep Mobile listener port and Mobile bind address at `8788` and `0.0.0.0`.
2. Set Mobile HTTPS origin to the exact direct address the phone will use, such as `https://nas.tail1a2b3c.ts.net:8788`.
3. Set Persistent mobile connection to `true`, leave new phone pairings enabled and apply the template.

Open the owner panel at that exact HTTPS address before pairing. Enabling this feature deliberately moves browser sign-in away from plain port 8787. A normal reverse-proxy address cannot front the mobile listener because phones pin its origin and certificate. Do not forward port 8788 from the router unless remote exposure is deliberate.

Unraid publishes this bridge port on the server's interfaces. Using a Tailscale origin does not make port 8788 Tailscale-only; use host firewall rules if it must be isolated from the LAN.

Unraid creates the default appdata directory for its `nobody:users` account (`99:100`), which is also the account used by the Companion template. If a custom directory already exists, make sure that account can write to it before starting the container.

## Service config files

Companion can discover supported containers without mounting their appdata. A read-only config file mount lets it also find the service API key. The template includes optional paths for the supported file formats under Advanced View.

The built-in Radarr and Sonarr paths are for containers named `radarr` and `sonarr`. Select the matching config file on the Unraid host and do not mount an entire appdata parent directory.

The supplied fields are starter slots, not a one-instance limit. For every extra instance, choose **Add another Path** in the Unraid template and add one file-to-file, read-only mapping. For example:

```text
/mnt/user/appdata/radarr-4k/config.xml -> /stack/radarr-4k/config.xml
/mnt/user/appdata/sonarr-anime/config.xml -> /stack/sonarr-anime/config.xml
```

If the container has another name, add or edit its Path so the folder beneath `/stack` matches that name and begins with the service kind followed by `-`, `_` or `.`. Apply the template and scan again. Config mounts are optional; each API key can instead be pasted against the matching service under **Review setup**.

## Docker access

The default installation is read only. To allow more, edit both containers and keep these settings aligned:

| Access available in Companion | qm-companion `DOCKER_ACCESS_MAX` | qm-socket-proxy `POST` | qm-socket-proxy `EXEC` |
| --- | --- | --- | --- |
| Status, logs and discovery | `read` | `0` | `0` |
| Container and image management | `manage` | `1` | `0` |
| Management and container shell | `shell` | `1` | `1` |

After raising the installed maximum, Companion still starts with Read only selected. The owner can change the active mode from Docker access in the web interface.

`DOCKER_DEPLOY_BIND_ROOTS` controls which host directories Marketplace deployments may mount. Leave it blank to permit named volumes only. Docker management and shell access are host-level permissions, so enable only what is needed.

## Reverse proxies

The default Web UI uses plain HTTP and should stay on a trusted private network. When a trusted reverse proxy provides HTTPS, set Trusted reverse proxy to `true` in the `qm-companion` template. Keep it `false` for direct HTTP access.
