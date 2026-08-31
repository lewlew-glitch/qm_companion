import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hostTemps } from '../src/docker.js';

function buildHwmon(spec) {
  const base = mkdtempSync(join(tmpdir(), 'qm-hwmon-'));
  spec.forEach((chip, i) => {
    const dir = join(base, `hwmon${i}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'name'), chip.name + '\n');
    (chip.temps || []).forEach((t, j) => {
      const n = j + 1;
      writeFileSync(join(dir, `temp${n}_input`), String(t.milli) + '\n');
      if (t.label) writeFileSync(join(dir, `temp${n}_label`), t.label + '\n');
    });
  });
  return base;
}

test('classifies sensors and reports each category maximum', (t) => {
  const base = buildHwmon([
    { name: 'acpitz', temps: [{ milli: 27800 }] },
    { name: 'nvme', temps: [{ milli: 39850, label: 'Composite' }, { milli: 31850, label: 'Sensor 2' }] },
    { name: 'nvme', temps: [{ milli: 41000, label: 'Composite' }] },
    { name: 'coretemp', temps: [
      { milli: 64000, label: 'Package id 0' },
      { milli: 62000, label: 'Core 0' },
      { milli: 68000, label: 'Core 1' },
    ] },
  ]);
  const noThermal = join(base, 'no-thermal');
  t.after(() => rmSync(base, { recursive: true, force: true }));

  const temps = hostTemps(base, noThermal);
  assert.equal(temps.cpuC, 68, 'CPU is the hottest coretemp reading');
  assert.equal(temps.driveC, 41);
  assert.equal(temps.driveCount, 2, 'both nvme composite sensors counted');
  assert.equal(temps.boardC, 28, 'acpitz rounds to the board figure');
});

test('returns null for absent or invalid sensor data', (t) => {
  const base = buildHwmon([{ name: 'acpitz', temps: [{ milli: -5000 }, { milli: 999999 }] }]);
  const noThermal = join(base, 'no-thermal');
  t.after(() => rmSync(base, { recursive: true, force: true }));
  assert.equal(hostTemps(base, noThermal), null);
  assert.equal(hostTemps(join(base, 'missing'), noThermal), null);
});

test('falls back to the thermal-zone CPU temperature', (t) => {
  const base = mkdtempSync(join(tmpdir(), 'qm-thermal-'));
  const hwmon = join(base, 'hwmon');
  mkdirSync(hwmon, { recursive: true });
  const thermal = join(base, 'thermal');
  mkdirSync(join(thermal, 'thermal_zone0'), { recursive: true });
  writeFileSync(join(thermal, 'thermal_zone0', 'type'), 'x86_pkg_temp\n');
  writeFileSync(join(thermal, 'thermal_zone0', 'temp'), '66000\n');
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const temps = hostTemps(hwmon, thermal);
  assert.equal(temps.cpuC, 66);
});
