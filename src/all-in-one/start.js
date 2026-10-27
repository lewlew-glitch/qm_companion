#!/usr/bin/env node
// Entry point of the all-in-one image. Starts the Docker socket proxy as root on the loopback address,
// then Companion as the node user, and stops the container when either of them stops.

import { spawn } from 'node:child_process';
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { fileURLToPath } from 'node:url';

import {
  APP_GID,
  APP_UID,
  DOCKER_SOCKET,
  accessPlan,
  companionEnvironment,
  proxyConfig,
  proxyEnvironment,
  proxyKey,
  proxyPort,
  socketProblem,
} from './plan.js';

const TEMPLATE = '/usr/local/etc/haproxy/haproxy.cfg.template';
const CONFIG = '/tmp/haproxy.cfg';
const PROXY_WAIT_MS = 5_000;

function die(msg) {
  process.stderr.write(`\n  ${msg}\n\n`);
  process.exit(1);
}

if (process.getuid() !== 0) {
  die('The all-in-one image starts as root to run the Docker proxy, then runs Companion as the node user. Remove the user setting from this container.');
}

let access;
let port;
try {
  access = accessPlan(process.env.DOCKER_ACCESS_MAX);
  port = proxyPort(process.env.PROXY_PORT);
} catch (error) {
  die(error.message);
}

let socket = null;
try {
  socket = statSync(DOCKER_SOCKET);
} catch { /* reported below */ }
const problem = socketProblem(socket);
if (problem === 'open to companion') {
  die(
    `${DOCKER_SOCKET} lets uid ${APP_UID} or every user connect, so Companion could go around the proxy.\n` +
      '  Limit the socket to root and the docker group, or use docker-compose.published.yml, which keeps\n' +
      '  the socket in a separate container.',
  );
}
if (problem) {
  process.stderr.write(`\n  ${DOCKER_SOCKET} is ${problem}: Docker views stay unavailable until the socket is mounted\n`);
}

try {
  writeFileSync(CONFIG, proxyConfig(readFileSync(TEMPLATE, 'utf8'), port), { mode: 0o600 });
} catch (error) {
  die(`Could not write the proxy config: ${error.message}`);
}

const key = proxyKey();
const running = new Map();
let stopping = false;
let status = 0;

function stopAll() {
  stopping = true;
  for (const child of running.values()) child.kill('SIGTERM');
}

function stopped(name, detail, code) {
  running.delete(name);
  if (!stopping) {
    process.stderr.write(`\n  ${name} stopped (${detail}); stopping the container\n`);
    status = code || 1;
    stopAll();
  }
  if (running.size === 0) process.exit(status);
}

function run(name, command, args, options, hint) {
  const failed = (error) => stopped(name, hint ? `${error.code}. ${hint}` : error.message, 1);
  let child;
  try {
    // Some spawn failures, such as EPERM when the user cannot be switched, throw here instead.
    child = spawn(command, args, { stdio: 'inherit', ...options });
  } catch (error) {
    failed(error);
    return;
  }
  running.set(name, child);
  child.once('error', failed);
  child.once('exit', (code, signal) => stopped(name, signal ?? `exit ${code}`, code));
}

function listening() {
  return new Promise((resolve) => {
    const probe = connect({ host: '127.0.0.1', port });
    probe.once('connect', () => {
      probe.destroy();
      resolve(true);
    });
    probe.once('error', () => resolve(false));
  });
}

process.on('SIGTERM', stopAll);
process.on('SIGINT', stopAll);

// HAProxy 3 sizes its tables from the open file limit, so keep it at the upstream image's 10000.
run('docker proxy', '/bin/sh', [
  '-c',
  'ulimit -n 10000 2>/dev/null || true; exec haproxy -W -db -f "$1"',
  'haproxy',
  CONFIG,
], { env: proxyEnvironment({ key, access, path: process.env.PATH }) });

const deadline = Date.now() + PROXY_WAIT_MS;
while (!stopping && Date.now() < deadline && !(await listening())) {
  await new Promise((resolve) => setTimeout(resolve, 100));
}

if (!stopping) {
  process.stdout.write(`\n  docker proxy on 127.0.0.1:${port}, ${access.mode} access\n`);
  run('companion', process.execPath, [fileURLToPath(new URL('../index.js', import.meta.url))], {
    uid: APP_UID,
    gid: APP_GID,
    env: companionEnvironment(process.env, { key, access, port }),
  }, 'Keep SETUID and SETGID in cap_add so Companion can run as the node user.');
}
