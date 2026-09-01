# Backup and recovery

Back up the private configuration and the complete Companion data volume. The backup set should include the `.env` file, `qm-companion.json`, authenticated sidecars, mobile identity, TLS files, and origin binding.

Do not use deletion as a first response to an authentication or startup error. Keep the original volume unchanged, make a read-only copy where possible, and run the diagnostic command against that copy.

## Preserve `SECRET_KEY`

`SECRET_KEY` encrypts stored credentials and authenticates state. An upgrade preserves the existing value. Replacing it does not re-encrypt the data; existing state becomes unreadable.

Keep the private source used by the running installation, such as `.env`, a private Compose override, or a secrets manager. Back it up with its permissions before changing the application or Compose files:

```sh
mkdir -p /path/to/secure-backup
chmod 700 /path/to/secure-backup
cp -a .env /path/to/secure-backup/qm-companion.env
```

Check the value through the same environment as the deployed installation without printing it. This example includes the mobile overlay and works even if the normal container is stopped:

```sh
docker compose -f docker-compose.example.yml -f docker-compose.mobile.yml \
  run --rm --no-deps --entrypoint sh companion -lc 'printf "SECRET_KEY length: %s\n" "${#SECRET_KEY}"'
```

Use the same Compose file list as the installation, in the same order. A length of 64 confirms the required shape but does not prove that it is the key that encrypted the volume.

When state authentication fails after a configuration change, restore the previous `SECRET_KEY`. Do not delete the state or mobile sidecar. If several authenticated files fail together while the TLS certificate remains readable, the configured key is likely wrong.

`QM_PROXY_KEY` is separate from `SECRET_KEY`. It authenticates Companion to the Docker proxy and must be at least 32 characters. Restore it from the same private configuration backup when Docker becomes unavailable after an upgrade.

## Diagnose the mobile installation

On Unraid, run the read-only check while `qm-companion` is running:

```sh
docker exec qm-companion node src/mobile/repair.js
```

If the container will not start, check its log and confirm the mobile settings and the 8788 port mapping in the template first. The command above needs a running container.

For Docker Compose, run the out-of-band diagnosis from the host:

```sh
docker compose -f docker-compose.example.yml -f docker-compose.mobile.yml \
  run --rm --no-deps --entrypoint node companion src/mobile/repair.js
```

Use the same list this installation is deployed with, in the same order. Include `docker-compose.mobile.yml` after every file that changes `ports`. For example, a Management installation uses:

```sh
docker compose -f docker-compose.example.yml -f docker-compose.management.yml -f docker-compose.mobile.yml \
  run --rm --no-deps --entrypoint node companion src/mobile/repair.js
```

A bare `docker compose` command does not find the shipped profiles because their names do not use Compose's default filename. Omitting the mobile overlay also omits the mobile environment, which can make an enabled installation appear disabled.

The Compose command starts a throwaway container with the same image, environment, and `/data` volume, so it still works while the application container is stopped or restarting.

The diagnosis does not modify the data directory. It checks the panel state before mobile state, validates authenticated sidecars with the configured `SECRET_KEY`, checks the certificate and listener plan, and compares watched file hashes before and after. It is suitable for a read-only copy of the volume.

Output includes the mobile installation ID, Ed25519 identity fingerprint, certificate fingerprint and source, certificate expiry, advertised origin, device count, clone status, and fixed failure reasons. It does not print private keys, tokens, capabilities, stored credentials, or the clone nonce.

Exit codes are:

| Code | Meaning |
| ---: | --- |
| 0 | State is readable and the configured mobile listener would start. |
| 1 | A configuration, state, or TLS check failed. No repair was attempted. |
| 2 | Mobile support has not been provisioned. |

Certificate rotation and the separate command used when the container is not up are documented in [TLS and certificates](tls-and-certificates.md).

## Restore or copy a volume

Restoring a backup over the same installation requires no mobile reset. Its mobile installation ID, server identity, generated certificate, and device records remain valid together.

Copying a volume to create a second independent Companion requires a one-time clone reset. Generate a nonce:

```sh
openssl rand -hex 16
```

Add the resulting 32 lowercase hexadecimal characters to the copied installation for one boot:

```yaml
services:
  companion:
    environment:
      QM_CLONE_AS_NEW: "paste the 32 hex characters here"
```

Recreate the copied installation and wait for the log to report `mobile api: clone-as-new applied`. Remove `QM_CLONE_AS_NEW` and recreate it again.

The reset creates a new mobile installation ID and Ed25519 identity, removes paired devices and spent pairing keys, and replaces a generated certificate. Operator-supplied certificate files are not changed and must be replaced separately. The owner account, browser sessions, and standard setup-transfer state remain unchanged.

The consumed nonce is recorded, so leaving the same value in place does not reset the installation twice. A value that is not exactly 32 lowercase hexadecimal characters is refused. If the process stops after the mobile identity changes but before TLS is complete, the next start completes the TLS step before enabling the listener.

## Legacy v1 state

Only an installation with an existing v1 `qm-companion.json` should use `MIGRATE_V1_STATE=true`.

1. Back up the complete data directory.
2. Start Companion once with `MIGRATE_V1_STATE=true`.
3. Confirm that the state file is authenticated v2.
4. Remove the setting before the next normal start.

A consumed migration marker prevents a later v1 downgrade. Do not enable this setting on a new installation.
