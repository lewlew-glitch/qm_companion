// Maintenance jobs on daily, weekly, or fixed-hour schedules.

import { randomBytes } from 'node:crypto';
import { getCron, setCron } from './store.js';
import { prune, pruneContainersGuarded, protectedContainerReason, pullImage, execInContainer, inspectContainer, containerAction } from './docker.js';
import { runUpdateCheck } from './updates.js';
import { canManageDocker, canUseDockerShell, dockerModeAllows } from './docker-access.js';

const BUILTINS = [
  { id: 'prune-images', name: 'Prune dangling images', does: 'Removes untagged image layers nothing references.', action: 'images', schedule: { type: 'weekly', day: 0, hour: 3, minute: 0 }, enabled: false },
  { id: 'prune-containers', name: 'Prune stopped containers', does: 'Removes containers that have exited and stayed.', action: 'containers', schedule: { type: 'weekly', day: 0, hour: 3, minute: 30 }, enabled: false },
  { id: 'prune-networks', name: 'Prune unused networks', does: 'Removes networks no container is attached to.', action: 'networks', schedule: { type: 'weekly', day: 0, hour: 4, minute: 0 }, enabled: false },
  { id: 'prune-build', name: 'Prune build cache', does: 'Clears docker build cache.', action: 'build', schedule: { type: 'weekly', day: 0, hour: 4, minute: 30 }, enabled: false },
  { id: 'updates-check', name: 'Check for image updates', does: 'Refreshes registry digests so update flags stay current.', action: 'updates.check', schedule: { type: 'daily', hour: 5, minute: 0 }, enabled: false },
];

const HEX = /^[a-f0-9]{6,64}$/i;
const PRUNE_WHATS = new Set(['images', 'images-all', 'containers', 'networks', 'volumes', 'build']);
const OPS = new Set(['restart', 'stop', 'start']);
const HISTORY_CAP = 12;

// Serialize maintenance jobs and deduplicate concurrent runs by job ID.
export function createSerialJobRunner(execute) {
  let tail = Promise.resolve();
  const pending = new Map();
  return (id, ...args) => {
    const key = String(id);
    const existing = pending.get(key);
    if (existing) return existing;
    const task = tail.then(() => execute(id, ...args));
    // Keep the queue usable after a rejected task.
    tail = task.catch(() => undefined);
    pending.set(key, task);
    const clear = () => { if (pending.get(key) === task) pending.delete(key); };
    task.then(clear, clear);
    return task;
  };
}

// Serialize interval callbacks and consume their rejections.
export function createGuardedTrigger(task, onError = () => {}) {
  let running = false;
  return () => {
    if (running) return false;
    running = true;
    Promise.resolve()
      .then(task)
      .catch(async (error) => {
        try { await onError(error); } catch { /* error reporting must not take down the process */ }
      })
      .then(() => { running = false; });
    return true;
  };
}

/** Return saved jobs or in-memory defaults without writing. */
function seeded() {
  const saved = getCron();
  if (!saved) return BUILTINS.map((b) => ({ ...b }));
  // Keep saved state and include any missing built-ins.
  for (const b of BUILTINS) if (!saved.find((j) => j.id === b.id)) saved.push({ ...b });
  return saved;
}

/** Persist default jobs before the first mutation. */
function seededForWrite() {
  const jobs = seeded();
  if (!getCron()) setCron(jobs);
  return jobs;
}

// Return the next run after `from`, using server-local time.
export function nextRun(job, from = Date.now()) {
  if (!job.enabled) return null;
  const s = job.schedule;
  const d = new Date(from);
  if (s.type === 'every') {
    // Legacy interval jobs without a baseline are due immediately.
    const base = job.lastRunAt || job.enabledAt;
    if (!base) return from;
    return base + Math.max(1, s.hours) * 3600 * 1000;
  }
  const cand = new Date(d.getFullYear(), d.getMonth(), d.getDate(), s.hour, s.minute, 0, 0);
  if (s.type === 'daily') {
    if (cand.getTime() <= from) cand.setDate(cand.getDate() + 1);
    return cand.getTime();
  }
  // Weekly schedule.
  let delta = (s.day - cand.getDay() + 7) % 7;
  if (delta === 0 && cand.getTime() <= from) delta = 7;
  cand.setDate(cand.getDate() + delta);
  return cand.getTime();
}

// Normalize an incoming schedule or return null when it is invalid.
function cleanSchedule(schedule) {
  const t = schedule && schedule.type;
  if (t === 'every') return { type: 'every', hours: Math.min(168, Math.max(1, Number(schedule.hours) || 24)) };
  if (t !== 'daily' && t !== 'weekly') return null;
  const hour = Math.min(23, Math.max(0, Number(schedule.hour) || 0));
  const minute = Math.min(59, Math.max(0, Number(schedule.minute) || 0));
  return t === 'daily'
    ? { type: 'daily', hour, minute }
    : { type: 'weekly', day: Math.min(6, Math.max(0, Number(schedule.day) || 0)), hour, minute };
}

// Validate actions and restrict references to container IDs.
function cleanAction(a) {
  if (!a || typeof a !== 'object') return null;
  if (a.type === 'prune') return PRUNE_WHATS.has(a.what) ? { type: 'prune', what: a.what } : null;
  const ref = String(a.ref || '');
  if (!HEX.test(ref)) return null;
  if (a.type === 'container') return OPS.has(a.op) ? { type: 'container', op: a.op, ref } : null;
  if (a.type === 'pull') return { type: 'pull', ref };
  if (a.type === 'exec') {
    const cmd = typeof a.cmd === 'string' ? a.cmd.trim() : '';
    return cmd && cmd.length <= 4000 ? { type: 'exec', ref, cmd } : null;
  }
  return null;
}

export function listJobs() {
  return seeded().map((j) => ({ ...j, nextRunAt: nextRun(j) }));
}

export function setJobEnabled(id, enabled) {
  const jobs = seededForWrite();
  const j = jobs.find((x) => x.id === id);
  if (!j) return false;
  j.enabled = !!enabled;
  if (j.enabled) j.enabledAt = Date.now(); // what an interval schedule counts from before its first run
  setCron(jobs);
  return true;
}

export function setJobSchedule(id, schedule) {
  const jobs = seededForWrite();
  const j = jobs.find((x) => x.id === id);
  const s = j && cleanSchedule(schedule);
  if (!s) return false;
  j.schedule = s;
  setCron(jobs);
  return true;
}

export function addJob(name, action, schedule) {
  const jobs = seededForWrite();
  const n = String(name || '').trim().slice(0, 40);
  const a = cleanAction(action);
  const s = cleanSchedule(schedule);
  if (!n || !a || !s) return false;
  jobs.push({ id: 'custom-' + randomBytes(4).toString('hex'), kind: 'custom', name: n, action: a, schedule: s, enabled: true, enabledAt: Date.now(), history: [] });
  setCron(jobs);
  return true;
}

export function updateJob(id, name, action, schedule) {
  const jobs = seededForWrite();
  const j = jobs.find((x) => x.id === id);
  const s = j && cleanSchedule(schedule);
  if (!s) return false;
  if (j.kind === 'custom') {
    // Built-in jobs retain their name and action. Custom jobs accept both edits.
    const n = String(name || '').trim().slice(0, 40);
    const a = cleanAction(action);
    if (!n || !a) return false;
    j.name = n;
    j.action = a;
  }
  j.schedule = s;
  setCron(jobs);
  return true;
}

export function deleteJob(id) {
  const jobs = seededForWrite();
  const j = jobs.find((x) => x.id === id);
  if (!j || j.kind !== 'custom') return false;
  setCron(jobs.filter((x) => x.id !== id));
  return true;
}

export function clearHistory(id) {
  const jobs = seededForWrite();
  const j = jobs.find((x) => x.id === id);
  if (!j) return false;
  j.history = [];
  setCron(jobs);
  return true;
}

function jobRequiredMode(job) {
  if (job.kind !== 'custom') return job.action === 'updates.check' ? 'read' : 'manage';
  return job.action && job.action.type === 'exec' ? 'shell' : 'manage';
}

// Keep route and scheduler capability classification aligned.
export function requiredDockerModeForAction(action) {
  const clean = cleanAction(action);
  if (!clean) return null;
  return clean.type === 'exec' ? 'shell' : 'manage';
}

export function requiredDockerModeForJob(id) {
  const job = seeded().find((candidate) => candidate.id === id);
  return job ? jobRequiredMode(job) : null;
}

// Capability checks apply when a custom action changes.
export function requiredDockerModeForJobEdit(id, action) {
  const job = seeded().find((candidate) => candidate.id === id);
  if (!job) return null;
  if (job.kind !== 'custom') return 'read';
  const clean = cleanAction(action);
  const existing = cleanAction(job.action);
  if (!clean) return null;
  return existing && JSON.stringify(clean) === JSON.stringify(existing)
    ? 'read'
    : requiredDockerModeForAction(clean);
}

// Disable jobs above a lowered access mode; dispatch also rechecks live access.
export function suspendJobsAboveMode(mode) {
  const jobs = seededForWrite();
  let suspended = 0;
  for (const job of jobs) {
    if (job.enabled && !dockerModeAllows(mode, jobRequiredMode(job))) {
      job.enabled = false;
      suspended += 1;
    }
  }
  if (suspended) setCron(jobs);
  return suspended;
}

// Dispatch built-in and custom jobs through the Docker access gate.
async function dispatch(j) {
  const a = j.kind === 'custom' ? j.action
    : j.action === 'updates.check' ? { type: 'updates.check' }
      : { type: 'prune', what: j.action };
  // Registry digest checks do not require Docker write access.
  if (a.type === 'updates.check') return runUpdateCheck();
  if (a.type === 'exec' && !canUseDockerShell()) return { ok: false, note: 'Docker shell access is off' };
  if (!canManageDocker()) return { ok: false, note: 'Docker access is read only' };
  // Recheck control-plane protection at dispatch time.
  if (a.type === 'prune') return a.what === 'containers' ? pruneContainersGuarded() : prune(a.what);
  if (a.type === 'container') {
    const shielded = await protectedContainerReason(a.ref);
    if (shielded) return { ok: false, note: shielded };
    const ok = await containerAction(a.ref, a.op);
    return { ok, note: ok ? a.op + ' done' : 'could not ' + a.op + ' - container gone, or the proxy blocks this (needs POST: 1)' };
  }
  if (a.type === 'pull') {
    const info = await inspectContainer(a.ref);
    const image = info && info.Config && info.Config.Image;
    if (!image) return { ok: false, note: 'container not found' };
    return pullImage(image);
  }
  if (a.type === 'exec') {
    const shielded = await protectedContainerReason(a.ref);
    if (shielded) return { ok: false, note: shielded };
    const r = await execInContainer(a.ref, a.cmd);
    const out = String(r.output || '').trim().replace(/\s+/g, ' ').slice(0, 200);
    if (!r.ok) return { ok: false, note: out || 'exec failed' };
    if (r.code) return { ok: false, note: 'exit ' + r.code + (out ? ' - ' + out : '') };
    return { ok: true, note: out || 'done' };
  }
  return { ok: false, note: 'unknown action' };
}

async function executeJob(id, trigger = 'manual') {
  const jobs = seededForWrite();
  const j = jobs.find((x) => x.id === id);
  if (!j) return { ok: false, note: 'no such job' };
  const started = Date.now();
  // Persist the run claim before dispatch to prevent replay after interruption.
  j.lastRunAt = started;
  setCron(jobs);

  let result;
  try {
    result = await dispatch(j);
  } catch {
    result = { ok: false, note: 'job failed unexpectedly' };
  }
  if (!result || typeof result !== 'object') result = { ok: false, note: 'job returned no result' };
  result = { ok: result.ok === true, note: String(result.note || (result.ok ? 'done' : 'job failed')).slice(0, 500) };
  const ms = Date.now() - started;
  const latest = seeded();
  const current = latest.find((row) => row.id === id);
  if (current) {
    current.lastRunAt = started;
    current.lastResult = { ok: result.ok, note: result.note, ms };
    current.history = [{ at: started, ms, ok: result.ok, note: result.note, trigger }, ...(current.history || [])].slice(0, HISTORY_CAP);
    setCron(latest);
  }
  return result;
}

const serialRunJob = createSerialJobRunner(executeJob);

export function runJob(id, trigger = 'manual') {
  return serialRunJob(id, trigger);
}

// Run jobs due since the previous accepted tick without replaying downtime.
let timer = null;
let lastTick = Date.now();

async function runDueJobs() {
  const now = Date.now();
  const windowStart = lastTick;
  // Advance the due window before awaiting jobs.
  lastTick = now;
  for (const j of seeded()) {
    if (!j.enabled) continue;
    const due = nextRun(j, windowStart);
    if (due !== null && due <= now) {
      try {
        await runJob(j.id, 'schedule');
      } catch {
        // A failed run claim skips only that job.
      }
    }
  }
}

const triggerCronTick = createGuardedTrigger(runDueJobs, () => {
  process.stderr.write('cron tick failed; no overlapping retry was started\n');
});

export function startCron() {
  if (timer) return;
  timer = setInterval(triggerCronTick, 60 * 1000);
  timer.unref();
}
