# Updating Companion

A notice above Sign out appears when a newer stable Companion release is available.
Open it for release notes and these instructions. It does not install the update.
Release checks run on the server at most every six hours while the panel is in use.
A failed check is retried later and never prevents pairing or Docker access.

## Docker Compose

Run commands from the directory containing your installation's Compose file. Keep the
same file names, overrides, project name and environment file that you used to start it.
Keep your existing data volume and `SECRET_KEY`.

For an installation using the published images and the default Compose file name:

```sh
docker compose pull companion socket-proxy
docker compose up -d --no-build companion socket-proxy
```

If you pinned an image version, change that tag to the desired published version first.
If you use `-f` files or a project name, include the same options in both commands.
Your service names may also differ; use the names in your own Compose file.

For an installation built from a Git checkout:

```sh
git pull --ff-only
docker compose -f docker-compose.example.yml up -d --build companion socket-proxy
```

Include your existing management, shell, mobile or Saltbox override files in their
original order. A local change that prevents `git pull --ff-only` needs review before
continuing. Do not replace your Compose configuration with a new default file.

Wait for the release's container publishing workflow to finish before pulling images.
A release may appear on GitHub while its images are still being built.

## Unraid or another container manager

Use that manager's check-for-updates and recreate/update action for Companion and its
socket proxy. Keep all existing environment variables, ports and volume mappings.
See [the Unraid guide](unraid.md) if that is how you installed Companion.

## Verify the update

Open Settings, then About, to check the installed Companion version. Your services,
owner account and encrypted credentials remain in the existing data volume.

## Release checks

Companion requests only public release metadata from GitHub. The request contains no
service addresses, credentials or installation identifier. An unavailable check is
shown as unavailable, never as proof that the installation is current.

To disable automatic release checks, set `COMPANION_UPDATE_CHECK=false` in Companion's
container environment and recreate it using the existing installation configuration.
You can still open the releases page manually. Published images carry their release
tag; source installations use the version in `package.json`.
