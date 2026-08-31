// Authenticated atomic state with separately encrypted service credentials.

import {
  chmodSync,
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { join } from 'node:path';

import { config } from './config.js';
import { seal, open } from './secrets.js';

const FILE = join(config.dataDir, 'qm-companion.json');
const V1_MIGRATION_FILE = join(config.dataDir, 'qm-companion.v1-migration-used');
const FORMAT = 2;
const MAC_CONTEXT = 'qm-companion:state:v2\0';
const V1_MIGRATION_CONTEXT = 'qm-companion:state:v1-migration-consumed\0';
const CRON_CONTEXT = 'qm-companion:cron:v1:';
const STACKS_CONTEXT = 'qm-companion:stacks:v1:';
const MINTED_CONTEXT = 'qm-companion:minted:v1:';
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SEALED_RE = /^[0-9a-f]{24}:[0-9a-f]{32}:[0-9a-f]+$/i;
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/u;

let cache = null;
// Fail-stop after a committed rename with uncertain directory durability.
let poisoned = false;

// Recovery distinguishes structural damage from a key mismatch.
const KEY_LENGTH_CHECK = 'docker compose run --rm --no-deps --entrypoint node companion -e "process.stdout.write(String((process.env.SECRET_KEY || \'\').length))"';
const STATE_LOSS = 'the owner account and password, every configured service and its stored credentials, '
  + 'every API token, all cron jobs, saved stacks, template sources and the activity trail';
// Named without importing mobile/store.js to avoid a dependency cycle.
const MOBILE_STATE_FILE_NAME = join(config.dataDir, 'qm-mobile-v1.json');

function typedStateError(message, cause) {
  const error = new Error(message);
  error.code = 'QM_STATE_INVALID';
  if (cause) error.cause = cause;
  return error;
}

// Structural damage requires backup recovery.
function stateError(detail, cause) {
  return typedStateError([
    `Companion state is unreadable (${detail}).`,
    `File: ${FILE}.`,
    `Check: ${KEY_LENGTH_CHECK} prints 64 for a complete SECRET_KEY and 0 when unset.`,
    `Action: Confirm the key belongs to this data directory, then restore ${FILE} from backup.`,
    `Warning: Removing ${FILE} creates a new installation and loses ${STATE_LOSS}. Paired-phone`,
    `records are stored separately in ${MOBILE_STATE_FILE_NAME} and are not deleted.`,
  ].join(' '), cause);
}

// Authentication failure normally indicates a changed SECRET_KEY.
function stateKeyMismatchError() {
  return typedStateError([
    'Companion state is unreadable (authentication failed).',
    `File: ${FILE}. The file and configured SECRET_KEY do not authenticate together. This cannot`,
    'distinguish a changed key from a damaged or replaced file; a changed or regenerated key is the usual cause.',
    'Action: Restore the SECRET_KEY previously used with this data directory, then restart.',
    `Check: ${KEY_LENGTH_CHECK} prints 64 for a complete key and 0 when unset.`,
    `Warning: Do not remove ${FILE} while the original key may be recoverable. If it cannot be recovered,`,
    `removing ${FILE} creates a new installation and loses ${STATE_LOSS}. Paired-phone records in`,
    `${MOBILE_STATE_FILE_NAME} are not deleted.`,
  ].join(' '));
}

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function finiteTime(value) {
  return Number.isFinite(value) && value >= 0;
}

function normaliseOwner(value) {
  if (value === null) return null;
  if (!plainObject(value)) throw stateError('owner record is invalid');
  if (!/^[0-9a-f]{32}$/i.test(value.saltHex || '') || !/^[0-9a-f]{128}$/i.test(value.hashHex || '')) {
    throw stateError('owner password record is invalid');
  }
  const owner = {
    saltHex: value.saltHex.toLowerCase(),
    hashHex: value.hashHex.toLowerCase(),
  };
  if (value.createdAt !== undefined) {
    if (!finiteTime(value.createdAt)) throw stateError('owner creation time is invalid');
    owner.createdAt = value.createdAt;
  }
  if (value.lastLoginAt !== undefined && value.lastLoginAt !== null) {
    if (!finiteTime(value.lastLoginAt)) throw stateError('owner login time is invalid');
    owner.lastLoginAt = value.lastLoginAt;
  } else if (value.lastLoginAt === null) {
    owner.lastLoginAt = null;
  }
  if (value.name !== undefined) {
    if (typeof value.name !== 'string' || value.name.length > 200) throw stateError('owner name is invalid');
    owner.name = value.name;
  }
  if (value.mfaEnc !== undefined) {
    if (typeof value.mfaEnc !== 'string' || !SEALED_RE.test(value.mfaEnc)) throw stateError('owner MFA record is invalid');
    owner.mfaEnc = value.mfaEnc.toLowerCase();
  }
  return owner;
}

function normaliseServices(value) {
  if (!Array.isArray(value) || value.length > 1000) throw stateError('services list is invalid');
  const ids = new Set();
  return value.map((row) => {
    if (!plainObject(row)) throw stateError('service record is invalid');
    for (const field of ['id', 'kind', 'baseUrl']) {
      if (typeof row[field] !== 'string' || !row[field] || row[field].length > 2048) {
        throw stateError(`service ${field} is invalid`);
      }
    }
    if (ids.has(row.id)) throw stateError('service ids are not unique');
    ids.add(row.id);
    if (row.label !== undefined && (typeof row.label !== 'string' || row.label.length > 200)) {
      throw stateError('service label is invalid');
    }
    if (row.remoteBaseUrl !== undefined && (typeof row.remoteBaseUrl !== 'string' || row.remoteBaseUrl.length > 2048)) {
      throw stateError('service remote address is invalid');
    }
    if (row.secretsEnc !== undefined && (typeof row.secretsEnc !== 'string' || !SEALED_RE.test(row.secretsEnc))) {
      throw stateError('service secret record is invalid');
    }
    const clean = {
      id: row.id,
      kind: row.kind,
      label: row.label === undefined ? row.kind : row.label,
      baseUrl: row.baseUrl,
    };
    if (row.remoteBaseUrl) clean.remoteBaseUrl = row.remoteBaseUrl;
    if (row.secretsEnc) clean.secretsEnc = row.secretsEnc.toLowerCase();
    return clean;
  });
}

function normalisePrefs(value) {
  if (!plainObject(value)) throw stateError('preferences are invalid');
  const out = {};
  if (value.theme === 'dark' || value.theme === 'light') out.theme = value.theme;
  if (value.clock === '24h' || value.clock === '12h') out.clock = value.clock;
  if (value.dateFormat === 'dd.mm.yyyy' || value.dateFormat === 'yyyy-mm-dd') out.dateFormat = value.dateFormat;
  if (typeof value.confirmActions === 'boolean') out.confirmActions = value.confirmActions;
  if (['200', '500', '1000', '2000'].includes(value.logTail)) out.logTail = value.logTail;
  if (['1', '6', '24', '72'].includes(value.activityRange)) out.activityRange = value.activityRange;
  return out;
}

function normaliseApiTokens(value) {
  if (!Array.isArray(value) || value.length > 1000) throw stateError('API token list is invalid');
  const ids = new Set();
  return value.map((row) => {
    if (!plainObject(row)
      || typeof row.id !== 'string' || !/^[a-z0-9_-]{1,128}$/i.test(row.id)
      || typeof row.name !== 'string' || row.name.length > 200
      || typeof row.prefix !== 'string' || !/^qmc_[0-9a-f]{6}$/i.test(row.prefix)
      || typeof row.hashHex !== 'string' || !/^[0-9a-f]{64}$/i.test(row.hashHex)
      || !finiteTime(row.createdAt)
      || (row.lastUsedAt !== null && row.lastUsedAt !== undefined && !finiteTime(row.lastUsedAt))) {
      throw stateError('API token record is invalid');
    }
    if (ids.has(row.id)) throw stateError('API token ids are not unique');
    ids.add(row.id);
    return {
      id: row.id,
      name: row.name,
      prefix: row.prefix,
      hashHex: row.hashHex.toLowerCase(),
      createdAt: row.createdAt,
      lastUsedAt: row.lastUsedAt == null ? null : row.lastUsedAt,
    };
  });
}

// Dismissed update digests are authenticated but not encrypted.
const MAX_DISMISSED_UPDATES = 500;
const DIGEST_RE = /^[a-z0-9+._-]+:[0-9a-f]{6,128}$/i;

function normaliseUpdates(value) {
  if (!plainObject(value) || Object.keys(value).some((key) => key !== 'dismissed')) {
    throw stateError('update state is invalid');
  }
  const rows = value.dismissed === undefined ? [] : value.dismissed;
  if (!Array.isArray(rows) || rows.length > MAX_DISMISSED_UPDATES) throw stateError('update dismissals are invalid');
  const refs = new Set();
  return {
    dismissed: rows.map((row) => {
      if (!plainObject(row)
        || typeof row.ref !== 'string' || !row.ref || row.ref.length > 300
        || typeof row.digest !== 'string' || !DIGEST_RE.test(row.digest)
        || !finiteTime(row.at)) {
        throw stateError('update dismissal record is invalid');
      }
      if (refs.has(row.ref)) throw stateError('update dismissals are not unique');
      refs.add(row.ref);
      return { ref: row.ref, digest: row.digest.toLowerCase(), at: row.at };
    }),
  };
}

// Template source metadata is authenticated; fetched entries use separate cache files.
const MAX_TEMPLATE_SOURCES = 20;
const TEMPLATE_SOURCE_ID_RE = /^[0-9a-f]{16}$/;

export function validTemplateSourceUrl(value) {
  if (typeof value !== 'string' || !value || value.length > 2048) return false;
  let url;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return url.protocol === 'https:' && !url.username && !url.password && !url.hash;
}

function normaliseTemplatesSection(value) {
  if (!plainObject(value) || Object.keys(value).some((key) => key !== 'sources') || value.sources === undefined) {
    throw stateError('template state is invalid');
  }
  const rows = value.sources;
  if (!Array.isArray(rows) || rows.length > MAX_TEMPLATE_SOURCES) throw stateError('template source list is invalid');
  const ids = new Set();
  const urls = new Set();
  return {
    sources: rows.map((row) => {
      if (!plainObject(row)
        || typeof row.id !== 'string' || !TEMPLATE_SOURCE_ID_RE.test(row.id)
        || typeof row.name !== 'string' || !row.name.trim() || row.name.length > 60
        || !validTemplateSourceUrl(row.url)
        || !finiteTime(row.addedAt)) {
        throw stateError('template source record is invalid');
      }
      if (ids.has(row.id) || urls.has(row.url)) throw stateError('template sources are not unique');
      ids.add(row.id);
      urls.add(row.url);
      return { id: row.id, name: row.name, url: row.url, addedAt: row.addedAt };
    }),
  };
}

// Seal managed Compose files because YAML may contain environment secrets.
const MAX_MANAGED_STACKS = 100;
const MANAGED_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,40}$/i;

function managedRows(value) {
  if (!Array.isArray(value) || value.length > MAX_MANAGED_STACKS) throw stateError('managed stack list is invalid');
  const names = new Set();
  return value.map((row) => {
    if (!plainObject(row)
      || typeof row.name !== 'string' || !MANAGED_NAME_RE.test(row.name)
      || typeof row.yaml !== 'string' || !row.yaml || row.yaml.length > 20000
      || !finiteTime(row.savedAt)) {
      throw stateError('managed stack record is invalid');
    }
    if (names.has(row.name)) throw stateError('managed stack names are not unique');
    names.add(row.name);
    return { name: row.name, yaml: row.yaml, savedAt: row.savedAt };
  });
}

function normaliseStacksSection(value) {
  if (!plainObject(value) || Object.keys(value).some((key) => key !== 'managed') || value.managed === undefined) {
    throw stateError('stack state is invalid');
  }
  const managed = value.managed;
  if (!plainObject(managed) || Object.keys(managed).length !== 1
    || typeof managed.sealed !== 'string' || !SEALED_RE.test(managed.sealed)
    || managed.sealed.length > MAX_FILE_BYTES) {
    throw stateError('managed stack state is invalid');
  }
  return { managed: { sealed: managed.sealed.toLowerCase() } };
}

function stacksAad(installationId) {
  return STACKS_CONTEXT + installationId;
}

function openManagedStacks(record, installationId) {
  if (!record) return [];
  const plaintext = open(record.managed.sealed, stacksAad(installationId));
  if (plaintext === null) throw stateError('managed stack state could not be decrypted');
  let parsed;
  try {
    parsed = JSON.parse(plaintext);
  } catch (error) {
    throw stateError('managed stack state contains invalid JSON', error);
  }
  return managedRows(parsed);
}

// Store acquired API keys sealed and bound to their service instance.
const MAX_MINTED_KEYS = 200;
const MAX_MINTED_KEY_CHARS = 16_384;
const MINTED_INSTANCE_RE = /^[a-z0-9-]{1,80}$/;
const MINTED_KIND_RE = /^[a-z0-9]{1,40}$/;
const MINTED_BY_MAX = 200;

function mintedAad(installationId, instanceId) {
  return `${MINTED_CONTEXT}${installationId}\0${instanceId}`;
}

function normaliseMintedKeys(value) {
  if (!plainObject(value) || Object.keys(value).some((key) => key !== 'keys') || value.keys === undefined) {
    throw stateError('minted key state is invalid');
  }
  const keys = value.keys;
  if (!plainObject(keys)) throw stateError('minted key state is invalid');
  const ids = Object.keys(keys);
  if (ids.length > MAX_MINTED_KEYS) throw stateError('minted key state is invalid');
  const out = {};
  // Sort keys for deterministic payloads.
  for (const id of ids.slice().sort()) {
    const row = keys[id];
    if (!MINTED_INSTANCE_RE.test(id)
      || !plainObject(row)
      || typeof row.kind !== 'string' || !MINTED_KIND_RE.test(row.kind)
      || row.name !== 'Quartermaster'
      || typeof row.sealed !== 'string' || !SEALED_RE.test(row.sealed) || row.sealed.length > MAX_FILE_BYTES
      || typeof row.createdBy !== 'string' || row.createdBy.length > MINTED_BY_MAX || CONTROL.test(row.createdBy)
      || !finiteTime(row.createdAt)) {
      throw stateError('minted key record is invalid');
    }
    out[id] = {
      kind: row.kind,
      name: 'Quartermaster',
      sealed: row.sealed.toLowerCase(),
      createdAt: row.createdAt,
      createdBy: row.createdBy,
    };
  }
  return { keys: out };
}

// Setup activity metadata contains no credential values.
const MAX_AUDIT = 200;
const AUDIT_LINE_MAX = 300;

function normaliseAudit(value) {
  if (!Array.isArray(value) || value.length > MAX_AUDIT) throw stateError('audit log is invalid');
  return value.map((row) => {
    if (!plainObject(row)
      || typeof row.line !== 'string' || !row.line || row.line.length > AUDIT_LINE_MAX || CONTROL.test(row.line)
      || !finiteTime(row.at)) {
      throw stateError('audit record is invalid');
    }
    return { at: row.at, line: row.line };
  });
}

function safeJson(value, depth = 0) {
  if (depth > 20) return false;
  if (value === null || typeof value === 'boolean') return true;
  if (typeof value === 'string') return value.length <= 16_384;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.length <= 5000 && value.every((item) => safeJson(item, depth + 1));
  if (!plainObject(value) || Object.keys(value).length > 200) return false;
  return Object.entries(value).every(([key, item]) => (
    key !== '__proto__' && key !== 'constructor' && key !== 'prototype'
    && key.length <= 200 && safeJson(item, depth + 1)
  ));
}

function normaliseCron(value) {
  if (value === null) return null;
  // Accept legacy plaintext cron state only for atomic resealing on load.
  if (Array.isArray(value)) {
    if (value.length > 1000 || !safeJson(value)) throw stateError('cron state is invalid');
    return structuredClone(value);
  }
  if (!plainObject(value) || Object.keys(value).length !== 1
    || typeof value.sealed !== 'string' || !SEALED_RE.test(value.sealed)
    || value.sealed.length > MAX_FILE_BYTES) {
    throw stateError('cron state is invalid');
  }
  return { sealed: value.sealed.toLowerCase() };
}

function cronAad(installationId) {
  return CRON_CONTEXT + installationId;
}

function sealCron(jobs, installationId) {
  const clean = normaliseCron(jobs);
  if (!Array.isArray(clean)) return clean;
  return { sealed: seal(JSON.stringify(clean), cronAad(installationId)) };
}

function openCron(record, installationId) {
  if (record === null) return null;
  if (Array.isArray(record)) return structuredClone(record); // only reachable while migrating
  const plaintext = open(record.sealed, cronAad(installationId));
  if (plaintext === null) throw stateError('cron state could not be decrypted');
  let parsed;
  try {
    parsed = JSON.parse(plaintext);
  } catch (error) {
    throw stateError('cron state contains invalid JSON', error);
  }
  if (!Array.isArray(parsed)) throw stateError('cron state is invalid');
  return normaliseCron(parsed);
}

function normaliseState(value, { migration = false } = {}) {
  if (!plainObject(value)) throw stateError('state payload is invalid');
  const installationId = value.installationId || (migration ? randomUUID() : '');
  if (!UUID_RE.test(installationId)) throw stateError('installation id is invalid');
  const state = {
    installationId: installationId.toLowerCase(),
    owner: normaliseOwner(value.owner === undefined ? null : value.owner),
    services: normaliseServices(value.services === undefined ? [] : value.services),
    prefs: normalisePrefs(value.prefs === undefined ? {} : value.prefs),
    apiTokens: normaliseApiTokens(value.apiTokens === undefined ? [] : value.apiTokens),
    cron: normaliseCron(value.cron === undefined ? null : value.cron),
  };
  // Preserve absent optional sections when decoding older files.
  if (value.updates !== undefined) state.updates = normaliseUpdates(value.updates);
  if (value.stacks !== undefined) state.stacks = normaliseStacksSection(value.stacks);
  if (value.templates !== undefined) state.templates = normaliseTemplatesSection(value.templates);
  if (value.mintedKeys !== undefined) state.mintedKeys = normaliseMintedKeys(value.mintedKeys);
  if (value.auditLog !== undefined) state.auditLog = normaliseAudit(value.auditLog);
  return state;
}

function macFor(payload) {
  return createHmac('sha256', config.stateKey).update(MAC_CONTEXT).update(payload, 'utf8').digest('hex');
}

function encode(state) {
  const payload = JSON.stringify(normaliseState(state));
  return `${JSON.stringify({ version: FORMAT, payload, mac: macFor(payload) }, null, 2)}\n`;
}

function ensureDataDir() {
  mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
  chmodSync(config.dataDir, 0o700);
}

function syncDirectory() {
  const fd = openSync(config.dataDir, 'r');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

// Rename commits the state; a later directory-fsync failure enters fail-stop mode.
function atomicWriteFile(target, contents) {
  ensureDataDir();
  const temp = join(config.dataDir, `.qm-companion.${process.pid}.${randomBytes(8).toString('hex')}.tmp`);
  let fd;
  let renamed = false;
  try {
    fd = openSync(temp, 'wx', 0o600);
    writeFileSync(fd, contents, 'utf8');
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    chmodSync(temp, 0o600);
    renameSync(temp, target);
    renamed = true;
  } finally {
    if (fd !== undefined) closeSync(fd);
    if (!renamed) {
      try {
        unlinkSync(temp);
      } catch (error) {
        if (error && error.code !== 'ENOENT') throw error;
      }
    }
  }
  // Confirm directory durability after the committed rename.
  try {
    syncDirectory();
  } catch (error) {
    return { durable: false, cause: error };
  }
  return { durable: true };
}

function atomicWrite(state) {
  return atomicWriteFile(FILE, encode(state));
}

// Reject further operations after a committed write with uncertain durability.
function durabilityUncertainError(cause) {
  return typedStateError([
    'Companion state was committed, but its durability is uncertain (the directory fsync failed).',
    'The change is in force and visible to every reader; what is not known is whether it would',
    'survive a power loss right now.',
    'Further state writes are refused until Companion is restarted.',
    `The file is ${FILE}. Check the volume for a full or read-only filesystem, then restart.`,
  ].join(' '), cause);
}

function stateFailStoppedError() {
  return typedStateError([
    'Companion state is fail-stopped after a write whose durability could not be confirmed.',
    'Restart Companion to continue; the committed state is intact and is what will load.',
  ].join(' '));
}

function assertStateUsable() {
  if (poisoned) throw stateFailStoppedError();
}

function migrationMarker() {
  return `${createHmac('sha256', config.stateKey).update(V1_MIGRATION_CONTEXT).digest('hex')}\n`;
}

// The authenticated marker records use of the one-time legacy migration.
function markerError(detail, cause) {
  return typedStateError([
    `The one-boot v1 migration marker is unreadable (${detail}).`,
    `The file is ${V1_MIGRATION_FILE}.`,
    `Companion will not migrate ${FILE} while that marker cannot be read.`,
    `Restore ${V1_MIGRATION_FILE} from a backup. To repeat the migration intentionally, delete the`,
    'marker and start Companion once with MIGRATE_V1_STATE=true. The marker contains no credentials.',
  ].join(' '), cause);
}

// Marker authentication failure may indicate a changed key or copied marker.
function markerKeyMismatchError() {
  return typedStateError([
    'The one-boot v1 migration marker is unreadable (authentication failed).',
    `File: ${V1_MIGRATION_FILE}. The marker and configured SECRET_KEY do not authenticate together.`,
    'Restore the SECRET_KEY previously used with this data directory, then restart.',
    `Check: ${KEY_LENGTH_CHECK} prints 64 for a complete key and 0 when unset.`,
    `If this installation intentionally uses a new key, delete ${V1_MIGRATION_FILE} to permit one`,
    `more migration of ${FILE}. The marker contains no account or credential data.`,
  ].join(' '));
}

// Legacy v1 state is unauthenticated and requires an explicit one-boot migration.
function legacyV1Error() {
  return typedStateError([
    'Companion state is unreadable (legacy v1 is unauthenticated; set MIGRATE_V1_STATE=true for one boot to migrate it).',
    `${FILE} is in legacy v1 format and has no MAC. Back up the data directory, start Companion once`,
    'with MIGRATE_V1_STATE=true, confirm the file is authenticated v2, then remove the flag.',
  ].join(' '));
}

// Handle legacy v1 state with an already-consumed migration marker.
function migrationAlreadyConsumedError() {
  return typedStateError([
    'Companion refuses this state: v1 migration was already consumed.',
    `${FILE} is unauthenticated legacy v1 state, and ${V1_MIGRATION_FILE} records a completed migration.`,
    `Restore the authenticated v2 ${FILE} from backup, unset MIGRATE_V1_STATE, and restart.`,
    `To migrate the current v1 file intentionally, delete ${V1_MIGRATION_FILE} and start once with`,
    'MIGRATE_V1_STATE=true.',
  ].join(' '));
}

function migrationWasConsumed() {
  let value;
  try {
    value = readFileSync(V1_MIGRATION_FILE, 'utf8');
  } catch (error) {
    if (error && error.code === 'ENOENT') return false;
    throw markerError('it could not be read', error);
  }
  const expected = Buffer.from(migrationMarker().trim(), 'hex');
  const suppliedText = value.trim();
  if (!/^[0-9a-f]{64}$/i.test(suppliedText)) throw markerError('it is not one 64 character hexadecimal line');
  const supplied = Buffer.from(suppliedText, 'hex');
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
    throw markerKeyMismatchError();
  }
  return true;
}

function consumeV1Migration() {
  atomicWriteFile(V1_MIGRATION_FILE, migrationMarker());
}

// Write the single-use marker only after the migrated state is durable.
function recordV1MigrationConsumed() {
  try {
    consumeV1Migration();
    return true;
  } catch (error) {
    process.stderr.write([
      '',
      `  The v1 migration completed and ${FILE} is now authenticated v2, but the single-use marker`,
      `  ${V1_MIGRATION_FILE} could not be written (${(error && error.code) || 'write failed'}).`,
      '  Nothing is lost and Companion is running on the migrated state.',
      '  Until that marker exists, restoring an old v1 file here and booting with MIGRATE_V1_STATE=true',
      '  would migrate again, so unset MIGRATE_V1_STATE now and make the data directory writable.',
      '',
      '',
    ].join('\n'));
    return false;
  }
}

function newState() {
  return {
    installationId: randomUUID(),
    owner: null,
    services: [],
    prefs: {},
    apiTokens: [],
    cron: null,
  };
}

function decodeV2(envelope) {
  if (!plainObject(envelope) || envelope.version !== FORMAT
    || typeof envelope.payload !== 'string' || typeof envelope.mac !== 'string'
    || !/^[0-9a-f]{64}$/i.test(envelope.mac)) {
    throw stateError('format is invalid');
  }
  const expected = Buffer.from(macFor(envelope.payload), 'hex');
  const supplied = Buffer.from(envelope.mac, 'hex');
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
    throw stateKeyMismatchError();
  }
  let parsed;
  try {
    parsed = JSON.parse(envelope.payload);
  } catch (error) {
    throw stateError('payload is invalid JSON', error);
  }
  const state = normaliseState(parsed);
  if (JSON.stringify(state) !== envelope.payload) throw stateError('payload has an invalid structure');
  return state;
}

function decodeV1(parsed) {
  if (!plainObject(parsed) || parsed.version !== 1) throw stateError('unsupported format');
  const allowed = new Set(['version', 'installationId', 'owner', 'services', 'prefs', 'apiTokens', 'cron']);
  if (Object.keys(parsed).some((key) => !allowed.has(key))) throw stateError('legacy format has unknown fields');
  return normaliseState(parsed, { migration: true });
}

function load() {
  // Cached state is invalid while durability is uncertain.
  assertStateUsable();
  if (cache) return cache;
  // Read paths do not modify the data directory.
  let raw;
  try {
    raw = readFileSync(FILE);
  } catch (error) {
    if (!error || error.code !== 'ENOENT') throw stateError('read failed', error);
    // First-run creation uses the normal atomic commit path.
    ensureDataDir();
    commit(newState());
    return cache;
  }
  if (raw.length > MAX_FILE_BYTES) throw stateError('file is too large');
  let parsed;
  try {
    parsed = JSON.parse(raw.toString('utf8'));
  } catch (error) {
    throw stateError('file is invalid JSON', error);
  }
  if (parsed && parsed.version === 1) {
    if (!config.migrateV1State) throw legacyV1Error();
    if (migrationWasConsumed()) throw migrationAlreadyConsumedError();
    const migrated = decodeV1(parsed);
    // Commit v2 before consuming the migration permission.
    commit(migrated);
    recordV1MigrationConsumed();
    return cache;
  }
  const authenticated = decodeV2(parsed);
  if (Array.isArray(authenticated.cron)) {
    // Reseal legacy cron state through the atomic write path.
    commit(authenticated);
    return cache;
  }
  cache = authenticated;
  return cache;
}

function commit(next) {
  assertStateUsable();
  const clean = normaliseState(next);
  clean.cron = sealCron(clean.cron, clean.installationId);
  const outcome = atomicWrite(clean); // throws only in the pre-rename controlled zone
  // Keep memory aligned with the committed rename.
  cache = clean;
  if (!outcome.durable) {
    poisoned = true;
    throw durabilityUncertainError(outcome.cause);
  }
  return clean;
}

function mutate(change) {
  const next = structuredClone(load());
  const result = change(next);
  commit(next);
  return result;
}

export function getInstallationId() {
  return load().installationId;
}

export function hasOwner() {
  return load().owner !== null;
}

export function getOwner() {
  const owner = load().owner;
  return owner ? structuredClone(owner) : null;
}

export function setOwner(record) {
  if (load().owner === null) throw new Error('owner must be claimed before it can be updated');
  if (record === null) throw new Error('owner cannot be cleared through the update API');
  mutate((next) => {
    next.owner = record;
  });
}

// Atomically claim the empty owner slot during first-run setup.
export function claimOwner(record) {
  if (record === null) throw new TypeError('owner record is required');
  if (load().owner !== null) return false;
  mutate((next) => {
    if (next.owner !== null) throw stateError('owner was already claimed');
    next.owner = record;
  });
  return true;
}

const PREF_DEFAULTS = {
  theme: 'dark',
  clock: '24h',
  dateFormat: 'dd.mm.yyyy',
  confirmActions: true,
  logTail: '200',
  activityRange: '24',
};

export function getPrefs() {
  return { ...PREF_DEFAULTS, ...load().prefs };
}

export function setPrefs(patch) {
  const clean = {};
  if (patch.theme === 'dark' || patch.theme === 'light') clean.theme = patch.theme;
  if (patch.clock === '24h' || patch.clock === '12h') clean.clock = patch.clock;
  if (patch.dateFormat === 'dd.mm.yyyy' || patch.dateFormat === 'yyyy-mm-dd') clean.dateFormat = patch.dateFormat;
  if (patch.confirmActions !== undefined) clean.confirmActions = patch.confirmActions === true || patch.confirmActions === 'true';
  if (['200', '500', '1000', '2000'].includes(patch.logTail)) clean.logTail = patch.logTail;
  if (['1', '6', '24', '72'].includes(patch.activityRange)) clean.activityRange = patch.activityRange;
  mutate((next) => {
    next.prefs = { ...next.prefs, ...clean };
  });
  return getPrefs();
}

export function listApiTokens() {
  return load().apiTokens.map(({ id, name, prefix, createdAt, lastUsedAt }) => (
    { id, name, prefix, createdAt, lastUsedAt }
  ));
}

export function addApiToken(row) {
  mutate((next) => {
    next.apiTokens.push(row);
  });
}

export function removeApiToken(id) {
  mutate((next) => {
    next.apiTokens = next.apiTokens.filter((token) => token.id !== id);
  });
}

export function findApiToken(hashHex) {
  const at = load().apiTokens.findIndex((token) => token.hashHex === hashHex);
  if (at === -1) return null;
  let found;
  mutate((next) => {
    next.apiTokens[at].lastUsedAt = Date.now();
    found = structuredClone(next.apiTokens[at]);
  });
  return found;
}

export function getCron() {
  const state = load();
  return openCron(state.cron, state.installationId);
}

export function setCron(jobs) {
  mutate((next) => {
    next.cron = sealCron(jobs, next.installationId);
  });
}

export function getDismissedUpdates() {
  const updates = load().updates;
  return updates ? structuredClone(updates.dismissed) : [];
}

// Merge capped update dismissals by reference and assign server timestamps.
export function addDismissedUpdates(rows) {
  const now = Date.now();
  mutate((next) => {
    const current = next.updates && Array.isArray(next.updates.dismissed) ? next.updates.dismissed : [];
    const byRef = new Map(current.map((row) => [row.ref, row]));
    for (const row of Array.isArray(rows) ? rows : []) {
      if (!row || typeof row.ref !== 'string' || !row.ref || row.ref.length > 300) continue;
      if (typeof row.digest !== 'string' || !DIGEST_RE.test(row.digest)) continue;
      byRef.set(row.ref, { ref: row.ref, digest: row.digest.toLowerCase(), at: now });
    }
    next.updates = {
      dismissed: [...byRef.values()].sort((a, b) => b.at - a.at).slice(0, MAX_DISMISSED_UPDATES),
    };
  });
  return getDismissedUpdates();
}

export function getManagedStacks() {
  const state = load();
  return openManagedStacks(state.stacks, state.installationId);
}

// Store managed Compose text without deploying it.
export function saveManagedStack(name, yaml) {
  if (typeof name !== 'string' || !MANAGED_NAME_RE.test(name)) return false;
  if (typeof yaml !== 'string' || !yaml.trim() || yaml.length > 20000) return false;
  mutate((next) => {
    const rows = openManagedStacks(next.stacks, next.installationId).filter((row) => row.name !== name);
    rows.push({ name, yaml, savedAt: Date.now() });
    if (rows.length > MAX_MANAGED_STACKS) rows.splice(0, rows.length - MAX_MANAGED_STACKS);
    next.stacks = { managed: { sealed: seal(JSON.stringify(rows), stacksAad(next.installationId)) } };
  });
  return true;
}

export function getTemplateSources() {
  const templates = load().templates;
  return templates ? structuredClone(templates.sources) : [];
}

// Apply the same template-source validation on read and write.
export function addTemplateSource(name, url) {
  const cleanName = String(name || '').trim().replace(/\s+/g, ' ').slice(0, 60);
  if (!cleanName) return { ok: false, error: 'give the source a name' };
  if (!validTemplateSourceUrl(url)) return { ok: false, error: 'template sources are plain https URLs without credentials' };
  const rows = getTemplateSources();
  if (rows.length >= MAX_TEMPLATE_SOURCES) return { ok: false, error: `${MAX_TEMPLATE_SOURCES} sources is the cap` };
  if (rows.some((row) => row.url === url)) return { ok: false, error: 'that URL is already a source' };
  const row = { id: randomBytes(8).toString('hex'), name: cleanName, url, addedAt: Date.now() };
  mutate((next) => {
    const current = next.templates && Array.isArray(next.templates.sources) ? next.templates.sources : [];
    next.templates = { sources: [...current, row] };
  });
  return { ok: true, source: row };
}

// Return the removed source so its cache can be deleted.
export function removeTemplateSource(id) {
  const row = getTemplateSources().find((source) => source.id === id) || null;
  if (!row) return null;
  mutate((next) => {
    const current = next.templates && Array.isArray(next.templates.sources) ? next.templates.sources : [];
    next.templates = { sources: current.filter((source) => source.id !== id) };
  });
  return row;
}

export function listSavedServices() {
  return load().services.map(({ id, kind, label, baseUrl, remoteBaseUrl }) => (
    { id, kind, label, baseUrl, remoteBaseUrl }
  ));
}

export function saveService(svc, secrets) {
  if (!plainObject(svc) || typeof svc.id !== 'string' || !svc.id) throw new TypeError('service id is required');
  const secretsEnc = secrets ? seal(JSON.stringify(secrets), svc.id) : undefined;
  const row = { ...svc, secretsEnc };
  mutate((next) => {
    const at = next.services.findIndex((service) => service.id === svc.id);
    if (at === -1) next.services.push(row);
    else next.services[at] = row;
  });
}

export function readServiceSecrets(id) {
  const row = load().services.find((service) => service.id === id);
  if (!row || !row.secretsEnc) return {};
  const json = open(row.secretsEnc, id);
  if (!json) return {};
  try {
    const value = JSON.parse(json);
    return plainObject(value) ? value : {};
  } catch {
    return {};
  }
}

// Return decrypted minted keys keyed by service instance.
export function getMintedKeys() {
  const state = load();
  if (!state.mintedKeys) return {};
  const out = {};
  for (const [id, row] of Object.entries(state.mintedKeys.keys)) {
    const apiKey = open(row.sealed, mintedAad(state.installationId, id));
    if (apiKey === null) throw stateError('minted key state could not be decrypted');
    out[id] = { kind: row.kind, name: row.name, apiKey, createdAt: row.createdAt, createdBy: row.createdBy };
  }
  return out;
}

// Seal a minted key with its service-instance binding.
export function setMintedKey(instanceId, { kind, apiKey, createdBy } = {}) {
  if (typeof instanceId !== 'string' || !MINTED_INSTANCE_RE.test(instanceId)) return false;
  if (typeof kind !== 'string' || !MINTED_KIND_RE.test(kind)) return false;
  if (typeof apiKey !== 'string' || !apiKey || apiKey.length > MAX_MINTED_KEY_CHARS) return false;
  const by = String(createdBy || '').replace(CONTROL, '').slice(0, MINTED_BY_MAX);
  mutate((next) => {
    const current = next.mintedKeys && plainObject(next.mintedKeys.keys) ? { ...next.mintedKeys.keys } : {};
    current[instanceId] = {
      kind,
      name: 'Quartermaster',
      sealed: seal(apiKey, mintedAad(next.installationId, instanceId)),
      createdAt: Date.now(),
      createdBy: by,
    };
    const ids = Object.keys(current);
    if (ids.length > MAX_MINTED_KEYS) {
      ids.sort((a, b) => current[a].createdAt - current[b].createdAt);
      for (const id of ids.slice(0, ids.length - MAX_MINTED_KEYS)) delete current[id];
    }
    next.mintedKeys = { keys: current };
  });
  return true;
}

export function forgetMintedKey(instanceId) {
  mutate((next) => {
    if (next.mintedKeys && plainObject(next.mintedKeys.keys) && Object.hasOwn(next.mintedKeys.keys, instanceId)) {
      const keys = { ...next.mintedKeys.keys };
      delete keys[instanceId];
      next.mintedKeys = { keys };
    }
  });
}

export function getAuditLog() {
  return structuredClone(load().auditLog || []);
}

// Store capped audit lines with server timestamps and stripped control characters.
export function addAudit(line) {
  const clean = String(line || '').replace(CONTROL, ' ').replace(/\s+/g, ' ').trim().slice(0, AUDIT_LINE_MAX);
  if (!clean) return;
  mutate((next) => {
    const current = Array.isArray(next.auditLog) ? next.auditLog : [];
    next.auditLog = [{ at: Date.now(), line: clean }, ...current].slice(0, MAX_AUDIT);
  });
}
