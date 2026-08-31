# Docker access

Companion can run with Docker read access only, with Docker management, or with management and container exec. The installed Compose profile sets the maximum. The owner selects the active mode within that maximum from the panel.

## Installed profiles

| Installed profile | Compose overlay | Proxy `POST` | Proxy `EXEC` | Available at the maximum |
| --- | --- | ---: | ---: | --- |
| Read only | none | 0 | 0 | Discovery, status, events, and logs |
| Management | `docker-compose.management.yml` | 1 | 0 | Lifecycle, image, stack, volume, network, and prune actions |
| Management + shell | `docker-compose.shell.yml` | 1 | 1 | Management plus shell, scheduled commands, and container key reads |

Use one optional access overlay after `docker-compose.example.yml`. Repeat the same `-f` list, in the same order, whenever the installation is recreated or updated. Run every recreate with `--build` so local socket-proxy changes are included.

Other overrides may be added between the base file and the access overlay. If `docker-compose.mobile.yml` is used, put it after every file that defines `ports`; see [Mobile connections](mobile-connection.md).

The proxy reads `POST` and `EXEC` when its container starts. Changing the selected mode in the panel cannot change these flags without recreating the installation.

## Active mode

New installations with an explicit `DOCKER_ACCESS_MAX` start actively in Read only. The owner can select another mode from **Docker access**, up to the installed maximum.

Raising the active mode requires the owner password and, when enabled, a current authenticator or recovery code. Lowering it applies to new actions immediately and disables scheduled jobs that require the removed capability. Work already in progress may finish.

The selected mode is stored in `/data/qm-docker-access-v1.json`. The file is authenticated, bound to the installation ID, and written with mode `0600`. Back up the full data volume. If the sidecar is absent, an explicit profile returns to Read only. If it is malformed or fails authentication, Companion stops instead of selecting a mode.

## Docker proxy boundary

The shipped profiles place a socket proxy between Companion and the Docker daemon. The Read only profile starts the proxy with `POST=0` and `EXEC=0`. This is the only shipped profile that prevents Docker writes at the proxy.

With `POST=1`, the proxy's resource flags do not reliably limit writes to individual lifecycle operations. Management and Management + shell must be treated as host-root-equivalent Docker access. Selecting Read only in the panel blocks application routes, but it does not remove the proxy permissions already granted to the Companion process.

A raw Docker socket mount has no daemon-level read-only restriction. Deployments that set `DOCKER_HOST` to a socket rely only on Companion's application checks and give a compromised process full daemon access.

Docker reads are also privileged. Container inspection can reveal environment values, labels, mounts, network topology, and host layout. Avoid container environment variables for credentials where practical, and enable only the proxy resource sections needed by the installation.

The local proxy wrapper rejects `HEAD` requests and Docker container archive and export routes. These restrictions reduce Companion's exposure to affected archive endpoints but do not patch Docker Engine or protect `docker cp` used elsewhere. Use Docker Engine 29.5.1 or later, preferably a currently supported release, or a vendor build whose security notes explicitly confirm fixes for the relevant CVEs:

- [Mountpoint creation advisory](https://github.com/moby/moby/security/advisories/GHSA-vp62-88p7-qqf5)
- [Bind mount advisory](https://github.com/moby/moby/security/advisories/GHSA-rg2x-37c3-w2rh)
- [Archive upload advisory](https://github.com/moby/moby/security/advisories/GHSA-x86f-5xw2-fm2r)

The Node base image and socket proxy are pinned by digest. Review upstream release notes and update the tag and digest together, then rebuild and rerun the verification suite.

## Service discovery mounts

`docker-compose.example.yml` mounts selected service config files beneath `/stack`. Keep the documented destination filenames. Duplicate instances can use separate directories such as `/stack/radarr-hd` and `/stack/radarr-4k`.

Mount only the files Companion needs. A read-only mount prevents writes but does not prevent the receiving process from reading the file. Do not replace the individual mounts with the whole Docker app-data directory. Recreate Companion after rotating an API key so Docker remounts the current file.

The key setup flow can use these sources:

- An approved file mounted beneath `/stack`.
- An approved file inside a container, when Management + shell is installed and active.
- Key creation through Jellyfin, Emby, or Portainer sign-in.
- Manual sealed paste for other services.

Container reads use one approved path for the detected instance. The browser cannot supply an arbitrary path. Container exec remains host-root-equivalent even when the command itself is narrow.

## Marketplace and scheduled work

Marketplace distinguishes services the phone can connect to from services Companion can deploy. Starter definitions are reviewed separately from generated proposals, and community template sources are marked as unreviewed.

The deploy path refuses Docker socket mounts and broad host binds. `DOCKER_DEPLOY_BIND_ROOTS` controls the host roots that a deployment may bind; an empty value permits named volumes only. A permitted host root still trusts other processes that can place files or symbolic links there. `DOCKER_DEPLOY_BIND_ADDRESS` controls the host address used for published ports.

Scheduled Docker changes require an active mode that allows the action both when the job is enabled and when it runs. Scheduled commands and the Console shell require Management + shell.

Registry update checks are read-only but contact the relevant container registry. Image pulls also make expected outbound registry requests.

## Configuration

| Variable | Required | Purpose |
| --- | --- | --- |
| `QM_HOST` | yes | LAN host name or IP used to suggest local service routes. Routes remain editable before pairing. |
| `BIND_ADDRESS` | no | Panel listen address. The default is `127.0.0.1`; the Compose example uses `0.0.0.0` inside the container. |
| `PORT` | no | Panel port. The default is `8787`. |
| `QM_STACK` | no | Root containing one directory per service instance and its approved config file. The default is `/stack` in Compose. |
| `DOCKER_HOST` | no | Docker transport. The shipped profiles use `tcp://socket-proxy:2375`. |
| `DOCKER_ACCESS_MAX` | no | Installed maximum: `read`, `manage`, or `shell`. Use the matching Compose profile. |
| `DOCKER_DEPLOY_BIND_ROOTS` | no | Colon- or comma-separated host roots allowed for Marketplace bind mounts. Empty permits named volumes only. |
| `DOCKER_DEPLOY_BIND_ADDRESS` | no | Host address used by Marketplace port mappings. It defaults to a literal IPv4 `QM_HOST`, otherwise loopback. |
| `DOCKER_CONTROL` | legacy | Compatibility setting used only when `DOCKER_ACCESS_MAX` is absent. New installations should not use it. |

## Running without Compose

Install dependencies and supply a stable `SECRET_KEY` through a private environment source:

```sh
npm ci
SECRET_KEY=<64-hex-character-key> \
QM_HOST=192.168.1.10 \
BIND_ADDRESS=0.0.0.0 \
QM_STACK=/path/to/appdata \
node src/index.js
```

When Docker is not configured, service discovery can still use the approved config files under `QM_STACK`.
