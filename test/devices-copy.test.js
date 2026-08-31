
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dataDir = mkdtempSync(join(tmpdir(), 'qm-companion-devices-'));
process.env.SECRET_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
process.env.QM_HOST = '192.168.1.20';
process.env.DATA_DIR = dataDir;

const { devicesPage } = await import('../src/ui/pages/devices.js');

after(() => rmSync(dataDir, { recursive: true, force: true }));

const FINGERPRINT = 'cd'.repeat(32);
const ON = { ok: true, origin: 'https://192.168.1.20:8788', enrolment: true, tls: null };
const PAIRING_OFF = { ...ON, enrolment: false };

function render(overrides = {}, flash = null) {
  return devicesPage({
    plane: ON, enrolments: [], devices: [], identity: { fingerprint: FINGERPRINT }, secure: true, ...overrides,
  }, 'csrf-token', flash, null, null);
}

test('shows pairing enable instructions when pairing is off', () => {
  const html = render({ plane: PAIRING_OFF });

  assert.match(html, /MOBILE_ENROLMENT_ENABLED=true/);
  assert.match(html, /<b class="mono">\.env<\/b>/, 'and names the private file it belongs in');
  assert.match(html, /must be lowercase <b class="mono">true<\/b>/);
  assert.match(html, /Existing pairings are unaffected/);
  assert.match(html, /same <b class="mono">-f<\/b> files in the same order/);
  assert.doesNotMatch(html, /docker compose up -d/);

  assert.doesNotMatch(html, /Nothing waiting\. Create a pairing key to add a phone\./);
  assert.doesNotMatch(html, /Create pairing key/);
  assert.match(html, /No pending pairings\. Pairing is off/);

  assert.doesNotMatch(html, /Compare this with the phone as it pairs/);
  assert.match(html, /Pairing is off\. This fingerprint remains the server identity/);
  assert.match(html, new RegExp(FINGERPRINT));
});

test('pairing instructions appear only while pairing is disabled', () => {
  assert.doesNotMatch(render(), /MOBILE_ENROLMENT_ENABLED/);
  assert.match(render(), /Compare this with the phone as it pairs/);
  assert.match(render(), /Nothing waiting\. Create a pairing key to add a phone\./);

  const down = render({ plane: { ok: false, reason: 'MOBILE_API_ENABLED is not true; the mobile plane is off.' } });
  assert.doesNotMatch(down, /MOBILE_ENROLMENT_ENABLED/);
  assert.match(down, /No pending pairings\. The mobile listener is off/);
});

test('flash styling follows outcome severity', () => {
  assert.match(render({}, 'Device revoked. Its next request is refused.'), /style="color:var\(--ok\)">Device revoked/);

  for (const refusal of ['No such pairing.', 'Pairing is not enabled.', 'The mobile plane is off.', 'MOBILE_API_ENABLED is not true; the mobile plane is off.']) {
    const html = render({}, refusal);
    assert.doesNotMatch(html, new RegExp(`color:var\\(--ok\\)">${refusal.slice(0, 12)}`), `${refusal} is not a success`);
    assert.match(html, /style="color:var\(--bad\)"/, `${refusal} reads as a refusal`);
  }
});

const BASE = {
  enrolmentId: 'Zm9vYmFyMTIzNDU2Nzg5MGFi',
  createdAt: Date.UTC(2026, 7, 23, 21, 23),
  expiresAt: Date.UTC(2026, 7, 23, 21, 33),
  transcript: null,
  sasWords: null,
};

test('completed pairing uses past-tense copy', () => {
  const html = render({ enrolments: [{ ...BASE, state: 'expired' }] });

  assert.doesNotMatch(html, /Enter the pairing key on the phone/, 'it cannot be entered any more');
  assert.doesNotMatch(html, /Expires /, 'and it is not going to expire, it did');
  assert.match(html, /The key was never entered on a phone, so nothing was granted/);
  assert.match(html, /Expired <span data-when="\d+">23\.08\.2026/);
  assert.match(html, /Remove clears this row\. It does not touch any paired phone\./);
  assert.match(html, /Create a new pairing key to try this phone again/);
  assert.doesNotMatch(html, /Server identity <span class="mono"><\/span>/);

  assert.match(render({ enrolments: [{ ...BASE, state: 'rejected' }] }), /You rejected it\. Nothing was granted/);
  assert.match(render({ enrolments: [{ ...BASE, state: 'cancelled' }] }), /Cancelled before it finished\. Nothing was granted/);

  const offHtml = render({ plane: PAIRING_OFF, enrolments: [{ ...BASE, state: 'expired' }] });
  assert.doesNotMatch(offHtml, /Create a new pairing key/);
});

test('an expired pairing record drops its comparison words', () => {
  const html = render({
    enrolments: [{
      ...BASE,
      state: 'expired',
      transcript: {
        deviceName: 'Test iPhone', origin: 'https://192.168.1.20:8788',
        serverSigningFingerprint: FINGERPRINT, tlsLeafFingerprint: FINGERPRINT,
        requestedScopes: ['summary.read'],
      },
      sasWords: ['anchor', 'beacon', 'cargo', 'dock', 'ensign'],
    }],
  });

  assert.match(html, /Test iPhone/);
  assert.match(html, /Expired <span data-when="\d+">23\.08\.2026 [0-9:]+[^<]*<\/span>, before you approved it\. Nothing was granted/);
  assert.doesNotMatch(html, /Compare these words with the phone/, 'there is no active pairing to compare');
  assert.doesNotMatch(html, /anchor · beacon/);
});

test('active pairing retains instructions and identity', () => {
  const live = render({
    enrolments: [{
      ...BASE,
      state: 'awaiting_owner_approval',
      transcript: {
        deviceName: 'Test iPhone', origin: 'https://192.168.1.20:8788',
        serverSigningFingerprint: FINGERPRINT, tlsLeafFingerprint: FINGERPRINT,
        requestedScopes: ['summary.read'],
      },
      sasWords: ['anchor', 'beacon', 'cargo', 'dock', 'ensign'],
    }],
  });
  assert.match(live, /Compare these words with the phone/);
  assert.match(live, /anchor · beacon · cargo · dock · ensign/);
  assert.match(live, /Server identity <span class="mono">cdcdcdcdcdcdcdcd<\/span>/);
  assert.match(live, /Approve<\/button>/);

  const waiting = render({ enrolments: [{ ...BASE, state: 'created', expiresAt: Date.now() + 300000 }] });
  assert.match(waiting, /Enter the pairing key on the phone\. Expires /);
  assert.match(waiting, /The server identity appears here once the phone gets in touch/);
});
