// Interprocess O_EXCL lock with per-path re-entry, bounded waits, and stale-holder detection.

import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';

/** Acquisition timeout, optionally overridden with a positive integer. */
function configuredTimeout() {
  const raw = Number(process.env.QM_LOCK_TIMEOUT_MS);
  return Number.isSafeInteger(raw) && raw > 0 ? raw : 10_000;
}
export const LOCK_TIMEOUT_MS = configuredTimeout();
const LOCK_POLL_MS = 20;
/** Age threshold for locks with an unknown holder. */
const LOCK_ABANDONED_MS = 120_000;

// Callers perform synchronous filesystem work; Atomics.wait avoids a CPU spin loop.
const SLEEPER = new Int32Array(new SharedArrayBuffer(4));
function sleepSync(ms) {
  Atomics.wait(SLEEPER, 0, 0, ms);
}

export function lockError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

/** Remove an abandoned lock and report success. */
function breakAbandonedLock(lockPath) {
  let holder = null;
  // Use mtime until the holder stamp is written.
  let age = 0;
  try {
    holder = JSON.parse(readFileSync(lockPath, 'utf8'));
    age = Date.now() - Number(holder?.at ?? 0);
  } catch {
    holder = null;
    try {
      age = Date.now() - statSync(lockPath).mtimeMs;
    } catch {
      // The lock disappeared while it was inspected.
      return true;
    }
  }
  const pid = Number(holder?.pid);
  if (Number.isInteger(pid) && pid > 0 && pid !== process.pid) {
    try {
      // Signal 0 tests for existence without delivering anything.
      process.kill(pid, 0);
      return false; // A live holder retains the lock.
    } catch (error) {
      if (error?.code === 'EPERM') return false; // Alive, owned by another user.
    }
  } else if (!(age > LOCK_ABANDONED_MS)) {
    // Allow time for a new lock to receive its stamp.
    return false;
  }
  try {
    unlinkSync(lockPath);
    return true;
  } catch {
    return false;
  }
}

// Track re-entry separately for each lock path.
const depths = new Map();

/** Run `fn` under the exclusive lock. Timeout and filesystem failures retain caller-specific codes. */
export function withFileLock({ lockPath, lockDir, timeoutCode, failedCode, contendedMessage }, fn) {
  const depth = depths.get(lockPath) ?? 0;
  if (depth > 0) {
    depths.set(lockPath, depth + 1);
    try {
      return fn();
    } finally {
      depths.set(lockPath, (depths.get(lockPath) ?? 1) - 1);
    }
  }
  // Directory and lock-file failures use the same caller-specific filesystem code.
  try {
    mkdirSync(lockDir, { recursive: true, mode: 0o700 });
  } catch (error) {
    const failure = lockError(failedCode, `${error?.code || 'error'}`);
    failure.fsCode = error?.code || 'error';
    throw failure;
  }
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  let fd;
  for (;;) {
    try {
      fd = openSync(lockPath, 'wx', 0o600);
      break;
    } catch (error) {
      if (error?.code !== 'EEXIST') {
        // Creation errors other than EEXIST are filesystem failures, not contention.
        const failure = lockError(failedCode, `${error?.code || 'error'}`);
        failure.fsCode = error?.code || 'error';
        throw failure;
      }
      if (!breakAbandonedLock(lockPath) && Date.now() >= deadline) {
        throw lockError(timeoutCode, contendedMessage);
      }
      if (Date.now() < deadline) sleepSync(LOCK_POLL_MS);
    }
  }
  try {
    writeFileSync(fd, JSON.stringify({ pid: process.pid, at: Date.now() }));
    fsyncSync(fd);
  } catch {
    // O_EXCL remains authoritative if writing the holder stamp fails.
  }
  depths.set(lockPath, 1);
  try {
    return fn();
  } finally {
    depths.set(lockPath, 0);
    try { closeSync(fd); } catch { /* already closed */ }
    // If another process already removed an abandoned lock, unlink simply finds it gone.
    try { unlinkSync(lockPath); } catch { /* already gone */ }
  }
}
