# Unraid

Community Apps installs Quartermaster Companion as two containers. The dedicated `qm-socket-proxy` keeps the Docker socket out of the main application and authenticates Companion before forwarding an allowed Docker request.

## Install

For existing containers, follow [Existing installations](#existing-installations) below and keep the current keys and appdata.

Create a dedicated user-defined bridge network once from the Unraid terminal:

```sh
docker network create qm-companion
```

If that name already exists, check that it is a bridge network intended for these two containers. The templates select `qm-companion`; choose **Custom: qm-companion** in each container's Network Type field if Unraid has not selected it automatically. Both containers must join the same network. Do not select the default `bridge`, `host`, or a direct LAN network such as `br0`.

For a new installation, generate two different keys:

```sh
printf 'SECRET_KEY='; openssl rand -hex 32
printf 'QM_PROXY_KEY='; openssl rand -hex 32
```

Keep both values private. `SECRET_KEY` protects the saved Companion state and must not change during an upgrade. `QM_PROXY_KEY` authenticates the connection between the two containers.

Use the supplied `qm-socket-proxy`; other socket proxies do not enforce Companion's key and endpoint rules. If another application already uses one, leave it in place and install `qm-socket-proxy` separately for Companion.

1. Install `qm-socket-proxy` from Apps on the `qm-companion` network. Keep that container name, enter the generated `QM_PROXY_KEY`, and leave Docker writes and Container shell set to `0`.
2. Install `qm-companion` on the same network. Enter the same `QM_PROXY_KEY`, the separate `SECRET_KEY`, and the LAN or Tailscale address of the Unraid server in Server address.
3. Open the Companion Web UI and create the owner account. If the first-run token is requested, open the `qm-companion` container log in Unraid.

Keep both container names and leave Companion's Docker host set to `tcp://qm-socket-proxy:2375`. The shared user-defined network resolves the proxy's container name without `--link`. Do not add a host port to `qm-socket-proxy`; only Companion's web and optional mobile ports are published. Other application containers do not need to join this network for discovery.

If Unraid removes custom networks when Docker is disabled, enable **Preserve user-defined networks** in Docker settings during a planned maintenance window, or recreate this network before starting these containers. Changing Docker's global settings may stop other containers.

Standard setup transfer works without the persistent mobile connection. To enable persistent access, edit `qm-companion` in Unraid, open the advanced settings and:

1. Set Mobile HTTPS port to `8788`. Keep Mobile listener port and Mobile bind address at `8788` and `0.0.0.0`.
2. Set Mobile HTTPS origin to the exact direct address the phone will use, such as `https://nas.tail1a2b3c.ts.net:8788`.
3. Set Persistent mobile connection to `true`, leave new phone pairings enabled and apply the template.

Open the owner panel at that exact HTTPS address before pairing. Enabling this feature deliberately moves browser sign-in away from plain port 8787. A normal reverse-proxy address cannot front the mobile listener because phones pin its origin and certificate. Do not forward port 8788 from the router unless remote exposure is deliberate.

Unraid publishes this bridge port on the server's interfaces. Using a Tailscale origin does not make port 8788 Tailscale-only; use host firewall rules if it must be isolated from the LAN.

Unraid creates the default appdata directory for its `nobody:users` account (`99:100`), which is also the account used by the Companion template. If a custom directory already exists, make sure that account can write to it before starting the container.

## Existing installations

An image update does not necessarily replace Unraid's saved container templates. If your saved template still uses `bridge` and `--link`, update both containers' settings as follows. This also repairs the installation error `links are only supported for user-defined networks`; changing the server address cannot fix that Docker argument error.

1. Keep the existing appdata mapping, `SECRET_KEY`, `QM_PROXY_KEY`, service config mounts and mobile origin. Do not generate new keys or delete appdata. Changing the network does not require rotating the certificate or revoking phones.
2. Create the `qm-companion` network with the command above if it does not exist. Stop only `qm-companion` while changing its proxy connection.
3. Edit `qm-socket-proxy`, select **Custom: qm-companion**, and Apply. Keep port 2375 unpublished and keep the current proxy key and access flags.
4. Edit `qm-companion` in Advanced View. Select **Custom: qm-companion**, remove only `--link=qm-socket-proxy:socket-proxy` from Extra Parameters, and set Docker host to `tcp://qm-socket-proxy:2375`. Keep the other hardening parameters, keys, paths, host ports and addresses. Apply, then start Companion if it is stopped.
5. Open the Companion web interface and check that the existing owner account and discovered services are present. A `403` from the proxy is a separate key or access-permission issue; see [Docker proxy refuses requests](#docker-proxy-refuses-requests).

If you use another dedicated user-defined bridge network, select the same one for both containers. If you intentionally renamed the proxy, use that exact container name in Docker host. Recreating a container on a network does not need a published Docker socket or privileged mode.

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

## Docker proxy refuses requests

If the proxy log shows `403` for several read endpoints such as `/info`, `/containers/json` and `/images/json`, the requests reached the proxy but were refused. Enabling the persistent mobile connection does not repair Docker discovery.

1. Check **Proxy key** in both container settings. Both must contain the same private value, at least 32 characters long, without surrounding whitespace. Never post either key or a complete container environment dump.
2. If the keys match, check that the proxy's Containers, Images, Volumes, Networks, Events, Host information, Disk usage and Ping APIs are set to `1`.
3. Apply changes to the affected containers from Unraid. Keep Docker writes and Container shell at `0` for a read-only installation. Do not expose port 2375 or replace the authenticated proxy with an unrestricted socket mount.

A `403` alone does not establish whether the key or a read permission was rejected. Changing Docker networks will not fix an authentication mismatch.

## Tailscale subnet routes and the mobile origin

A phone using a Tailscale subnet route can connect to the server's LAN origin, for example `https://192.168.4.100:8788`. A `100.x` address or MagicDNS name is not required. Choose the stable, reachable origin before first enabling the persistent mobile connection, and publish port 8788 as described above.

If Companion already generated a certificate for another host, changing **Mobile HTTPS origin** does not replace it. The secure listener will refuse to start until the certificate change is approved. Read [TLS and certificates](tls-and-certificates.md#rotate-generated-material-or-approve-an-origin-change) before running the recovery command: confirmed rotation replaces the generated certificate and revokes every paired device, so each phone must pair again. It does not repair a separate Docker proxy refusal.
