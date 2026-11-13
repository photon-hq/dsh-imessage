import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const targets = (value) => typeof value === 'string'
  ? [value]
  : value && typeof value === 'object' ? Object.values(value).flatMap(targets) : [];

const { RELEASE_CHANNEL: channel, RELEASE_VERSION: base, RELEASE_SUFFIX: suffix, PACK_DESTINATION: output } = process.env;
if (!base || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(base)) {
  throw new Error('RELEASE_VERSION must be a stable X.Y.Z version');
}
if (!((channel === 'staging' && /^-staging\.\d+\.\d+$/.test(suffix ?? '')) || (channel === 'production' && suffix === '')) || !output) {
  throw new Error('Release channel, suffix and pack destination are required');
}
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const destination = resolve(output);
const temporary = mkdtempSync(join(tmpdir(), 'dsh-imessage-pack-'));
const pack = (cwd, directory) => JSON.parse(execFileSync('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', directory], { cwd, encoding: 'utf8' }))[0].filename;
try {
  const original = pack(root, temporary);
  execFileSync('tar', ['-xzf', join(temporary, original), '-C', temporary]);
  const payload = join(temporary, 'package');
  const manifest = JSON.parse(readFileSync(join(payload, 'package.json'), 'utf8'));
  const version = `${base}${suffix}`;
  writeFileSync(join(payload, 'package.json'), `${JSON.stringify({ ...manifest, version }, null, 2)}\n`);
  mkdirSync(destination, { recursive: true });
  const filename = pack(payload, destination);
  const actual = JSON.parse(execFileSync('tar', ['-xOf', join(destination, filename), 'package/package.json'], { encoding: 'utf8' }));
  if (actual.name !== manifest.name || actual.version !== version) throw new Error('Packed manifest does not match the release');
  const files = new Set(execFileSync('tar', ['-tzf', join(destination, filename)], { encoding: 'utf8' }).trim().split('\n'));
  for (const target of [actual.exports, actual.main, actual.module, actual.types, actual.bin].flatMap(targets)) {
    if (!files.has(`package/${target.replace(/^\.\//, '')}`)) throw new Error(`Missing packed target: ${target}`);
  }
  console.log(join(destination, filename));
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
