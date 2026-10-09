import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const example = readFileSync(join(projectRoot, 'docker-compose.example.yml'), 'utf8');
const published = readFileSync(join(projectRoot, 'docker-compose.published.yml'), 'utf8');

function serviceImages(text) {
  const images = {};
  let service;
  for (const line of text.split('\n')) {
    const name = /^  ([a-z0-9-]+):$/.exec(line);
    if (name) service = name[1];
    const image = /^    image: (.+)$/.exec(line);
    if (image) {
      assert.equal(Object.hasOwn(images, service), false, `${service} has one image`);
      images[service] = image[1];
    }
  }
  return images;
}

function withoutImageSources(text) {
  return text.split('\n').slice(2).join('\n')
    .replace(/^ {4}build:.*\n(?: {6}.*\n)*/gm, '')
    .replace(/^ {4}image:.*\n/gm, '');
}

test('the published profile has no local build', () => {
  assert.doesNotMatch(published, /^\s*build:/m);
});

test('both published images use the same tag variable', () => {
  assert.deepEqual(serviceImages(published), {
    'socket-proxy': 'ghcr.io/lewlew-glitch/qm-companion-socket-proxy:${QM_COMPANION_TAG:-latest}',
    companion: 'ghcr.io/lewlew-glitch/qm-companion:${QM_COMPANION_TAG:-latest}',
  });
});

test('the published profile preserves every other example setting', () => {
  assert.equal(withoutImageSources(published), withoutImageSources(example));
});
