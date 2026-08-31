// Check access denial and response redaction on selected routes.
//   node prove_secure.mjs            (defaults to http://127.0.0.1:8787)
//   QM_URL=http://nas:8787 node prove_secure.mjs
//
// Optional session checks cover CSRF and Docker access mode:
//   QM_SESSION=<qm_sess value> node prove_secure.mjs

const H = process.env.QM_URL || 'http://127.0.0.1:8787';
const fails = [];
const SECRET_RX = /apikey|api_key|"secret"|"password"|BEGIN [A-Z ]*PRIVATE KEY/i;

async function probe(method, path, opts = {}) {
  const res = await fetch(H + path, { method, redirect: 'manual', ...opts });
  return { status: res.status, body: await res.text() };
}

// Protected routes reject unauthenticated requests.
const PROTECTED = [
  '/', '/pair', `/pair/file/${'a'.repeat(24)}`, '/containers', '/logs', '/stacks', '/images', '/volumes',
  '/networks', '/activity', '/settings', '/api/services', '/api/docker/stats',
  '/api/containers/stats', '/api/logs?id=abcdef123456',
];

for (const p of PROTECTED) {
  const r = await probe('GET', p);
  if (![401, 403, 404].includes(r.status)) fails.push(`GET ${p} unauth -> ${r.status} (want 401/403/404)`);
  if (SECRET_RX.test(r.body)) fails.push(`GET ${p} leaked a secret-looking value`);
}

// Unknown transfer capabilities return an opaque response.
{
  const path = `/pair/redeem/${'a'.repeat(43)}`;
  const missing = await probe('GET', path);
  if (missing.status !== 404 || missing.body !== 'Pairing transfer unavailable.') {
    fails.push(`GET ${path} unknown capability -> ${missing.status} (want opaque 404)`);
  }
  const wrongVerb = await probe('POST', path);
  if (wrongVerb.status !== 401) fails.push(`POST ${path} unauth -> ${wrongVerb.status} (want 401)`);
  if (SECRET_RX.test(missing.body + wrongVerb.body)) fails.push('QMC1 unknown-capability probes leaked a secret-looking value');
}

// Write routes require authentication.
const WRITES = [
  ['POST', '/images/pull'], ['POST', '/images/prune'], ['POST', '/images/remove'],
  ['POST', '/networks/create'], ['POST', '/networks/remove'], ['POST', '/networks/prune'],
  ['POST', '/containers/prune'], ['POST', '/containers/abcdef123456/update'],
  ['POST', '/stacks/deploy'],
  ['POST', '/settings/docker-mode'],
  ['POST', '/pair/keys/read'], ['POST', '/pair/keys/manual'],
  ['POST', '/cron/new'], ['POST', '/cron/edit'], ['POST', '/cron/delete'],
  ['POST', '/cron/clear-history'], ['POST', '/cron/toggle'], ['POST', '/cron/run'],
];

for (const [m, p] of [...WRITES, ['GET', '/api/updates'], ['GET', '/cron']]) {
  const r = await probe(m, p, { headers: { 'content-type': 'application/json' }, body: m === 'GET' ? undefined : '{}' });
  if (r.status !== 401) fails.push(`${m} ${p} unauth -> ${r.status} (want 401)`);
  if (SECRET_RX.test(r.body)) fails.push(`${m} ${p} leaked a secret-looking value`);
}

// setup cannot be re-armed once an owner exists.
{
  const r = await probe('POST', '/setup', { headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'password=attacker-owns-you' });
  if (r.status !== 404) fails.push(`POST /setup re-arm -> ${r.status} (want 404)`);
}

// spoofed forwarding headers must not grant access.
for (const h of [{ 'x-forwarded-for': '127.0.0.1' }, { 'x-real-ip': '127.0.0.1' }, { forwarded: 'for=127.0.0.1' }]) {
  const r = await probe('GET', '/api/services', { headers: h });
  if (r.status !== 401) fails.push(`XFF-spoof ${JSON.stringify(h)} -> ${r.status} (want 401)`);
}

// Docker management denied without a session (and the active mode starts Read only anyway).
{
  const r = await probe('POST', '/containers/abcdef123456/start');
  if (![401, 403].includes(r.status)) fails.push(`POST container action unauth -> ${r.status} (want 401/403)`);
}

// Shell access requires authentication and CSRF validation.
{
  const r = await probe('POST', '/api/exec', {
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: 'abcdef123456', cmd: 'id' }),
  });
  if (r.status !== 401) fails.push(`POST /api/exec unauth -> ${r.status} (want 401)`);
  if (/uid=|root/.test(r.body)) fails.push('POST /api/exec unauth appears to have run the command');
}

// substring / path-confusion must not slip past the exact-match gate.
for (const p of ['/api/x/setup', '/api/services/../setup', '/api/user/2fa/setup', '/anything/ping']) {
  const r = await probe('GET', p);
  if (![401, 403, 404].includes(r.status)) fails.push(`GET ${p} -> ${r.status} (want 401/403/404)`);
}

// State-changing verbs reject unauthenticated requests.
for (const m of ['POST', 'PUT', 'PATCH', 'DELETE']) {
  const r = await probe(m, '/');
  if (![401, 403, 404].includes(r.status)) fails.push(`${m} / unauth -> ${r.status}`);
}

// Optional session checks use inert request bodies.
const SESSION = process.env.QM_SESSION || '';
let deep = 'session probes skipped (set QM_SESSION to run them)';

const cookie = { cookie: `qm_sess=${SESSION}` };
const page = SESSION ? await probe('GET', '/containers', { headers: cookie }) : null;
const csrf = page && (page.body.match(/name="csrf" content="([a-f0-9]+)"/) || [])[1];
const dockerMode = page && (page.body.match(/aria-label="Docker access: ([^"]+)"/) || [])[1];
if (SESSION && !csrf) {
  // Stop if the session cookie is invalid.
  fails.push('QM_SESSION did not open a page with a csrf token - is the cookie current?');
}

if (csrf) {
  for (const [m, p] of WRITES) {
    // Missing CSRF token.
    const bare = await probe(m, p, { headers: { ...cookie, 'content-type': 'application/json' }, body: '{}' });
    if (bare.status !== 403) fails.push(`${m} ${p} session-without-csrf -> ${bare.status} (want 403)`);
    // Incorrect CSRF token.
    const wrong = await probe(m, p, {
      headers: { ...cookie, 'content-type': 'application/json', 'x-csrf-token': '0'.repeat(csrf.length), 'sec-fetch-site': 'cross-site' },
      body: '{}',
    });
    if (wrong.status !== 403) fails.push(`${m} ${p} wrong-csrf -> ${wrong.status} (want 403)`);
    if (SECRET_RX.test(bare.body + wrong.body)) fails.push(`${m} ${p} leaked a secret-looking value`);
  }

  // Probe the active Docker access gate with inert request bodies.
  const DOCKER_WRITES = [
    ['/images/pull', '{}'], ['/images/prune', '{}'], ['/images/remove', '{}'],
    ['/networks/create', '{}'], ['/networks/remove', '{}'], ['/networks/prune', '{}'],
    ['/containers/prune', '{}'], ['/containers/abcdef123456/update', '{}'],
    ['/containers/abcdef123456/restart', '{}'],
    ['/stacks/deploy', '{}'],
    ['/api/exec', JSON.stringify({ id: 'abcdef123456', cmd: 'id' })],
  ];
  if (dockerMode === 'Read only') {
    for (const [p, body] of DOCKER_WRITES) {
      const r = await probe('POST', p, {
        headers: { ...cookie, 'content-type': 'application/json', 'x-csrf-token': csrf, 'sec-fetch-site': 'same-origin' },
        body,
      });
      if (r.status !== 403 || !/Docker (?:access is read only|shell access is off)/.test(r.body)) {
        fails.push(`POST ${p} in Read only -> ${r.status} ${r.body.slice(0, 60)} (want the Docker access gate)`);
      }
    }
    deep = 'session probes ran: writes need the session csrf token, and Docker writes were blocked in Read only';
  } else if (dockerMode === 'Management') {
    for (const p of ['/api/exec', '/pair/keys/read']) {
      const r = await probe('POST', p, {
        headers: { ...cookie, 'content-type': 'application/json', 'x-csrf-token': csrf, 'sec-fetch-site': 'same-origin' },
        body: '{}',
      });
      if (r.status !== 403 || !/Docker shell access is off/.test(r.body)) {
        fails.push(`POST ${p} in Management -> ${r.status} ${r.body.slice(0, 60)} (want the Docker shell gate)`);
      }
    }
    deep = 'session probes ran: writes need the session csrf token, and shell routes were blocked in Management';
  } else if (dockerMode === 'Management + shell') {
    deep = 'session probes ran; Docker action probes skipped because Management + shell is active';
  } else {
    fails.push('could not determine the active Docker access mode from the signed-in page');
  }
}

if (fails.length) {
  console.error('FAIL:\n' + fails.map((f) => '  - ' + f).join('\n'));
  process.exit(1);
}
console.log('PASS: selected unauthenticated probes were denied without secret-looking output; setup cannot be re-armed; forwarded-header spoof ignored.');
console.log('      ' + deep + '.');
