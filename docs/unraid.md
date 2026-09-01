# Unraid

Community Apps installs Quartermaster Companion as two containers. The socket proxy is kept separate so the main application never mounts the Docker socket.

## Install

Open the Unraid terminal and generate two different keys:

```sh
printf 'SECRET_KEY='; openssl rand -hex 32
printf 'QM_PROXY_KEY='; openssl rand -hex 32
```

Keep both values private. `SECRET_KEY` protects the saved Companion state and must not change during an upgrade. `QM_PROXY_KEY` authenticates the connection between the two containers.

1. Install `qm-socket-proxy` from Apps. Keep that container name, enter the generated `QM_PROXY_KEY`, and leave Docker writes and Container shell set to `0`.
2. Install `qm-companion`. Enter the same `QM_PROXY_KEY`, the separate `SECRET_KEY`, and the LAN or Tailscale address of the Unraid server in Server address.
3. Open the Companion Web UI and create the owner account. If the first-run token is requested, open the `qm-companion` container log in Unraid.

Do not add a host port to `qm-socket-proxy`. Companion reaches it through an internal Docker link.

This installation supports the web panel and the standard setup transfer. The optional persistent mobile connection on port 8788 needs the manual Docker Compose mobile profile described in [Mobile connections](mobile-connection.md).

Unraid creates the default appdata directory for its `nobody:users` account (`99:100`), which is also the account used by the Companion template. If a custom directory already exists, make sure that account can write to it before starting the container.

## Service config files

Companion can discover supported containers without mounting their appdata. A read-only config file mount lets it also find the service API key. The template includes optional paths for the supported file formats under Advanced View.

Select the config file on the Unraid host and keep the container path supplied by the template. Do not mount an entire appdata parent directory. Duplicate instances can use another matching folder beneath `/stack`, such as `/stack/radarr-4k/config.xml`.

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
