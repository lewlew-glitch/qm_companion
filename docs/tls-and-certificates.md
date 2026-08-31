# TLS and certificates

The persistent mobile connection uses one certificate for its HTTPS listener. Companion can generate this certificate or load a certificate supplied by the operator. Paired phones pin the approved certificate and the exact advertised origin.

## Generated certificate

On the first mobile-profile start, Companion creates a self-signed P-256 certificate for the host in `QM_ADVERTISED_ORIGIN`. An IP address receives an IP subject alternative name; a host name receives a DNS subject alternative name.

Generated files are stored in `/data/tls` within the `qm-data` volume:

| File | Contents |
| --- | --- |
| `mobile.crt` | PEM certificate |
| `mobile.key` | PEM private key with mode `0600` |
| `mobile.json` | Issued host, creation time, and SHA-256 fingerprint |

The generated certificate is valid for 825 days. It remains unchanged across restarts and upgrades. Companion warns when fewer than 30 days remain and refuses expired or not-yet-valid material.

The self-signed certificate is expected for this direct connection. The phone verifies the certificate it approved during pairing rather than relying on a public certificate authority. The Devices page shows its host and fingerprint.

Companion does not rotate a certificate automatically. A changed host or an expired generated certificate stops the mobile listener until the change is approved. An origin change is also refused while existing grants remain valid; an installation with no grants may adopt a valid origin automatically. The main process and health check remain available.

## Advertised origin binding

Pairing records the complete `QM_ADVERTISED_ORIGIN`, including scheme, host, and port. Changing only the port still changes the server address approved by each phone.

The origin binding is stored outside `/data/tls` so it remains writable when an operator certificate directory is mounted read-only. If the binding is missing or damaged on an installation with paired devices, follow the reported recovery action rather than adopting a new address silently.

## Rotate generated material or approve an origin change

Run the rotation command without `--confirm` to see its effect without changing files. To approve the change while the container is running:

```sh
docker exec qm-companion node src/mobile/rotate-cert.js --confirm
docker restart qm-companion
```

These commands address the fixed container name and can run outside the Compose project directory.

If the container is not up, use the same Compose files as the deployed installation. The mobile overlay must be included after every file that changes `ports`:

```sh
docker compose -f docker-compose.example.yml -f docker-compose.mobile.yml \
  run --rm --no-deps --entrypoint node companion src/mobile/rotate-cert.js --confirm
docker compose -f docker-compose.example.yml -f docker-compose.mobile.yml up -d --build
```

For a generated certificate, the confirmed command creates a certificate for the current origin and records the new origin binding. It revokes every paired device family. The owner account, browser sessions, and server identity are unchanged. Pair each phone again after the restart.

If an operator certificate already covers a newly advertised origin, the same command can approve the origin change without replacing the certificate. Device families are still revoked because their approved origin changed.

## Operator-supplied certificate

Place `mobile.crt` and `mobile.key` in a `tls` directory beside the Compose files, then enable the read-only mount in `docker-compose.mobile.yml`:

```yaml
services:
  companion:
    volumes:
      - ./tls:/data/tls:ro
```

The files must be PEM encoded, the private key must match the certificate, and the certificate must have a subject alternative name covering the host in `QM_ADVERTISED_ORIGIN`. Companion refuses a missing half, corrupt material, a host mismatch, an expired certificate, or a certificate that is not yet valid.

Companion does not rewrite operator-supplied material. Replace both files through the host when renewal is required, restart Companion, and pair each phone again. The rotation command refuses to replace these files.

The certificate lock is kept at `/data/.mobile-tls.lock`, outside the read-only certificate mount.

## Generated certificate transaction

`mobile.key`, `mobile.crt`, and `mobile.json` form one generated set. Installing only part of a set could leave a mismatched key and certificate or an incorrect ownership record. Companion installs a generated set in two phases:

1. It writes and syncs all three files under `/data/tls/pending` and syncs that directory.
2. It atomically replaces each live file, syncs `/data/tls`, and removes the pending directory.

A complete pending set is the transaction commit point. Recovery runs before any normal certificate read or write. It removes an incomplete pending set and keeps the previous live generation. It finishes installing a complete pending set. Installation is repeatable, so recovery can continue after an interruption during the second phase.

Normal listener classification and every mutating certificate operation use one interprocess file lock. The lock is exclusive, has a bounded wait, and is re-entrant within one process. A lock owned by a process that no longer exists can be removed; a live lock that exceeds the timeout causes the operation to fail closed. The read-only repair command does not acquire the lock because doing so would write under `/data`; it reports a pending transaction instead of recovering it.

Do not copy or restore individual generated TLS files independently. Back up and restore the full data volume so the certificate set, origin binding, mobile identity, and paired device state remain consistent. See [Backup and recovery](recovery.md).
