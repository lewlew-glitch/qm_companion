import { readFileSync } from 'node:fs';

const tag = process.env.RELEASE_TAG;
const versionPattern = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
if (typeof tag !== 'string' || tag.length > 100 || !versionPattern.test(tag)) {
  throw new Error('RELEASE_TAG must contain the release version, for example v0.1.5.');
}

const expected = tag.replace(/^v/, '');
const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const lock = JSON.parse(readFileSync(new URL('../package-lock.json', import.meta.url), 'utf8'));
const versions = {
  'package.json': manifest.version,
  'package-lock.json': lock.version,
  'package-lock.json root package': lock.packages?.['']?.version,
};
for (const [source, version] of Object.entries(versions)) {
  if (version !== expected) {
    throw new Error(`${source} reports ${version ?? 'no version'} but the release tag is ${tag}. Update and commit the package versions before tagging.`);
  }
}

console.log(`Release metadata matches ${tag}.`);
