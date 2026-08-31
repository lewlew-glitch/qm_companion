// Sanitize startup failures before loading application modules.

import { writeSync } from 'node:fs';

const STATE_FILE = 'qm-companion.json';
const MARKER_FILE = 'qm-companion.v1-migration-used';
const ACCESS_FILE = 'qm-docker-access-v1.json';

const SAFE_DETAIL = /^[a-z0-9][a-z0-9 ,.;:=_-]{0,140}$/i;
const SAFE_CODE = /^[A-Z][A-Z0-9_]{0,40}$/;
const SAFE_ADDRESS = /^[a-z0-9.:[\]_-]{1,64}$/i;
const STATE_DETAIL = /^Companion state is unreadable \(([^)]{1,160})\)/;
const MARKER_DETAIL = /^The one-boot v1 migration marker is unreadable \(([^)]{1,160})\)/;
const MIGRATION_SPENT = /^Companion refuses this state: v1 migration was already consumed\./;
const ACCESS_DETAIL = /^Docker access state is unreadable \(([^)]{1,160})\)/;
const ACCESS_WRITE = /^The Docker access mode could not be saved to /;
const ACCESS_WRITE_CODE = /\(([^)]{1,60})\)\. The previously selected mode is still in force/;

let reported = false;

function emit(lines) {
  const body = lines.map((line) => (line ? `  ${line}` : '')).join('\n');
  // Synchronous output is required because process.exit() may drop buffered pipe writes.
  writeSync(2, `\n${body}\n\n`);
}

function safeDetail(detail) {
  return typeof detail === 'string' && SAFE_DETAIL.test(detail) ? detail : null;
}

function safeCode(value) {
  return typeof value === 'string' && SAFE_CODE.test(value) ? value : null;
}

function withDetail(text, detail) {
  const shown = safeDetail(detail);
  return shown ? `${text} Detail: ${shown}.` : text;
}

function diagnostic(summary, fields) {
  return [
    `QM Companion could not start: ${summary}.`,
    '',
    ...fields.map(([name, value]) => `${name}: ${value}`),
  ];
}

function stateBucket(detail) {
  if (detail === 'authentication failed') return 'key';
  if (detail === 'read failed') return 'unreadable';
  if (detail === 'file is invalid JSON' || detail === 'file is too large' || detail === 'format is invalid') {
    return 'foreign';
  }
  if (/^(legacy |unsupported format|v1 migration)/.test(detail || '')) return 'migration';
  return 'contents';
}

function keyReport() {
  return {
    label: 'boot-state-key-mismatch',
    lines: diagnostic('state authentication failed', [
      ['Cause', `${STATE_FILE} did not authenticate with the configured SECRET_KEY. This cannot distinguish a changed key from a damaged or replaced state file.`],
      ['Action', 'Restore the SECRET_KEY previously used with this data directory, then restart.'],
      ['Warning', `Do not delete ${STATE_FILE}; the previous key may still recover it.`],
      ['Fallback', `If the key cannot be recovered, move ${STATE_FILE} out of DATA_DIR and restart. This creates a fresh installation and requires all accounts, services and credentials to be configured again.`],
    ]),
  };
}

function unreadableReport(cause) {
  const code = safeCode(cause && cause.code);
  const denied = code === 'EACCES' || code === 'EPERM';
  return {
    label: 'boot-state-unreadable',
    lines: diagnostic('state file read failed', [
      ['Cause', `${STATE_FILE} is present in DATA_DIR but could not be opened${code ? ` (${code})` : ''}.`],
      ['Action', denied
        ? 'Give the Companion process read and write access to DATA_DIR and its contents, verify the host volume owner and Compose user, then restart.'
        : 'Verify that the DATA_DIR volume is mounted, healthy and writable, then restart.'],
      ['Warning', `Do not delete ${STATE_FILE}; its contents have not been examined.`],
    ]),
  };
}

function foreignReport(detail) {
  return {
    label: 'boot-state-not-companion',
    lines: diagnostic('state file format was rejected', [
      ['Cause', withDetail(`${STATE_FILE} is not in the Companion state format. DATA_DIR may reference the wrong volume, or a write may have been interrupted.`, detail)],
      ['Action', 'Verify DATA_DIR and restore the state file from a backup.'],
      ['Fallback', `If the file is not Companion state, move ${STATE_FILE} aside and restart. This creates a fresh installation.`],
    ]),
  };
}

function legacyMigrationReport(detail) {
  return {
    label: 'boot-state-migration-v1',
    lines: diagnostic('legacy v1 state requires migration', [
      ['Cause', withDetail(`${STATE_FILE} is unauthenticated legacy v1 state and is not migrated automatically.`, detail)],
      ['Action', 'Back up DATA_DIR, start once with MIGRATE_V1_STATE=true, then remove that setting.'],
      ['Retry', 'An interrupted migration can be started again with the same source file.'],
    ]),
  };
}

function v1RefusedReport(detail) {
  return {
    label: 'boot-state-v1-refused',
    lines: diagnostic('legacy v1 state was rejected', [
      ['Cause', withDetail(`Migration was already enabled, but ${STATE_FILE} did not pass v1 validation. The file was not changed.`, detail)],
      ['Action', 'Restore the intended v1 source file, or the authenticated state file produced by a completed migration, then restart.'],
    ]),
  };
}

const MARKER_IMPACT = `${MARKER_FILE} contains only the single-use migration record; it contains no account, service, credential or pairing data.`;

function markerReport(detail) {
  return {
    label: 'boot-state-migration-marker',
    lines: diagnostic('v1 migration marker could not be read', [
      ['Cause', withDetail(`${MARKER_FILE} could not be read. ${STATE_FILE} was left unchanged because the previous migration status is unknown.`, detail)],
      ['Action', `Restore ${MARKER_FILE} from a backup and restart.`],
      ['Fallback', `To intentionally repeat the migration, delete ${MARKER_FILE} and start once with MIGRATE_V1_STATE=true.`],
      ['Warning', `Leave ${STATE_FILE} in place. ${MARKER_IMPACT}`],
    ]),
  };
}

function markerKeyReport() {
  return {
    label: 'boot-state-migration-marker-key',
    lines: diagnostic('v1 migration marker authentication failed', [
      ['Cause', `${MARKER_FILE} did not authenticate with SECRET_KEY. This cannot distinguish a changed key from a damaged or replaced marker.`],
      ['Action', 'Restore the SECRET_KEY previously used with this data directory, then restart.'],
      ['Fallback', `If this installation intentionally uses a new key, delete ${MARKER_FILE} and start once with MIGRATE_V1_STATE=true.`],
      ['Impact', MARKER_IMPACT],
    ]),
  };
}

function migrationSpentReport() {
  return {
    label: 'boot-state-migration-spent',
    lines: diagnostic('v1 migration has already been used', [
      ['Cause', `${STATE_FILE} is still v1 state, while ${MARKER_FILE} records a completed migration.`],
      ['Action', `If the migration previously succeeded, restore the migrated ${STATE_FILE}, unset MIGRATE_V1_STATE and restart.`],
      ['Fallback', `To intentionally migrate the current v1 file, verify that it is the correct file, delete ${MARKER_FILE}, and start once with MIGRATE_V1_STATE=true.`],
    ]),
  };
}

function contentsReport(detail) {
  return {
    label: 'boot-state-contents',
    lines: diagnostic('state contents were rejected', [
      ['Cause', withDetail(`${STATE_FILE} authenticated with SECRET_KEY, but this Companion version cannot read its contents.`, detail)],
      ['Action', 'Run the Companion version that wrote this state, or restore state created by the current version.'],
      ['Warning', `Do not delete ${STATE_FILE}.`],
    ]),
  };
}

const ACCESS_IMPACT = `Removing ${ACCESS_FILE} resets only the Docker access mode to Read only; it does not remove accounts, services, credentials, API tokens or paired phones.`;

function accessKeyReport() {
  return {
    label: 'boot-docker-access-key-mismatch',
    lines: diagnostic('Docker access authentication failed', [
      ['Cause', `${ACCESS_FILE} did not authenticate with SECRET_KEY. This cannot distinguish a changed key from a damaged or replaced file.`],
      ['Action', 'Restore the SECRET_KEY previously used with this data directory, then restart.'],
      ['Fallback', `Only if that key cannot be recovered, remove ${ACCESS_FILE} and restart. ${ACCESS_IMPACT}`],
    ]),
  };
}

function accessReport(detail) {
  return {
    label: 'boot-docker-access-unreadable',
    lines: diagnostic('Docker access state was rejected', [
      ['Cause', withDetail(`${ACCESS_FILE} could not be loaded.`, detail)],
      ['Action', 'Verify DATA_DIR and SECRET_KEY, then restore the file from a backup.'],
      ['Fallback', `If no backup is available, remove ${ACCESS_FILE} and restart. ${ACCESS_IMPACT}`],
    ]),
  };
}

function accessWriteReport(detail) {
  return {
    label: 'boot-docker-access-write-failed',
    lines: diagnostic('Docker access mode could not be saved', [
      ['Cause', withDetail(`${ACCESS_FILE} could not be written. The existing file is unchanged and no partial file was left behind.`, detail)],
      ['Action', 'Make DATA_DIR writable, check available space, then restart.'],
      ['Warning', `Restoring or removing ${ACCESS_FILE} will not fix the failed write.`],
      ['Note', 'When DOCKER_ACCESS_MAX is lowered, startup remains blocked until the lower mode can be saved.'],
    ]),
  };
}

function accessUnclassifiedReport() {
  return {
    label: 'boot-docker-access-unclassified',
    lines: diagnostic('Docker access state could not be classified', [
      ['Cause', `The failure for ${ACCESS_FILE} cannot be printed safely, so the key, file and volume remain possible causes.`],
      ['Action', 'Verify that SECRET_KEY belongs to DATA_DIR and that DATA_DIR references the intended volume.'],
      ['Debug', 'Set QM_BOOT_DEBUG=true for one start to print the full error. Treat that output as sensitive.'],
      ['Impact', ACCESS_IMPACT],
    ]),
  };
}

function unclassifiedReport() {
  return {
    label: 'boot-state-unclassified',
    lines: diagnostic('state failure could not be classified', [
      ['Cause', `The failure for ${STATE_FILE} cannot be printed safely.`],
      ['Action', 'Verify that SECRET_KEY belongs to DATA_DIR and that DATA_DIR references the intended volume. Restore a backup before considering any deletion.'],
      ['Debug', 'Set QM_BOOT_DEBUG=true for one start to print the full error. Treat that output as sensitive because it may contain state data.'],
    ]),
  };
}

function addressReport(error, code, label, summary, advice) {
  const address = typeof error.address === 'string' && SAFE_ADDRESS.test(error.address) ? error.address : null;
  const port = Number.isInteger(error.port) ? String(error.port) : null;
  const where = address && port ? `${address}:${port}` : port ? `port ${port}` : 'the configured address';
  return {
    code,
    label,
    lines: diagnostic(summary, [
      ['Cause', `The Companion could not bind ${where}.`],
      ['Action', advice],
    ]),
  };
}

function describe(error) {
  const raw = error instanceof Error ? error : null;
  const code = safeCode(raw && raw.code);
  if (code === 'QM_STATE_INVALID') {
    const message = (raw && raw.message) || '';
    const markerDetail = (MARKER_DETAIL.exec(message) || [])[1];
    if (markerDetail) {
      return { code, ...(markerDetail === 'authentication failed' ? markerKeyReport() : markerReport(markerDetail)) };
    }
    if (MIGRATION_SPENT.test(message)) return { code, ...migrationSpentReport() };
    const detail = (STATE_DETAIL.exec(message) || [])[1];
    if (!detail) return { code, ...unclassifiedReport() };
    const bucket = stateBucket(detail);
    const report = bucket === 'key' ? keyReport()
      : bucket === 'unreadable' ? unreadableReport(raw.cause)
        : bucket === 'foreign' ? foreignReport(detail)
          : bucket === 'migration' ? (detail.startsWith('legacy v1 is unauthenticated') ? legacyMigrationReport(detail) : v1RefusedReport(detail))
            : contentsReport(detail);
    return { code, ...report };
  }
  if (code === 'QM_DOCKER_ACCESS_INVALID') {
    const message = (raw && raw.message) || '';
    if (ACCESS_WRITE.test(message)) {
      return { code, ...accessWriteReport((ACCESS_WRITE_CODE.exec(message) || [])[1]) };
    }
    const detail = (ACCESS_DETAIL.exec(message) || [])[1];
    if (detail === 'authentication failed') return { code, ...accessKeyReport() };
    return { code, ...(detail ? accessReport(detail) : accessUnclassifiedReport()) };
  }
  if (code === 'EADDRINUSE') {
    return addressReport(
      raw,
      code,
      'boot-port-in-use',
      'configured address is already in use',
      'Set PORT to a free port, or stop the process using it. Under Docker, check for a duplicate published host port.',
    );
  }
  if (code === 'EACCES' && raw.syscall === 'listen') {
    return addressReport(
      raw,
      code,
      'boot-port-denied',
      'configured address cannot be bound',
      'Use PORT 1024 or above and publish a lower Docker host port if needed, or correct BIND_ADDRESS.',
    );
  }
  return {
    code: code || (raw && safeCode(raw.name)) || 'UNKNOWN',
    label: 'boot-unexpected',
    lines: diagnostic('unexpected internal error', [
      ['Cause', 'The error details were suppressed because they may contain state data or credentials.'],
      ['Action', 'Restart the Companion. If the failure repeats, set QM_BOOT_DEBUG=true for one start and report the error identifier below.'],
      ['Warning', 'Debug output may contain state data or credentials; treat it as sensitive.'],
    ]),
  };
}

function report(error) {
  if (reported) return;
  reported = true;
  const { code, label, lines } = describe(error);
  emit([...lines, '', `code ${code}, label ${label}`]);
  if (process.env.QM_BOOT_DEBUG === 'true') {
    writeSync(2, `  QM_BOOT_DEBUG output follows, treat as sensitive\n${String(error && error.stack || error)}\n\n`);
  }
  process.exit(1);
}

process.on('uncaughtException', report);
process.on('unhandledRejection', report);
