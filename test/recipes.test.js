import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.LEANLING_HOME = mkdtempSync(join(tmpdir(), 'leanling-test-'));

// Test recipe with a list (like a list of disabled modules) and a single value
const fixture = {
  name: 'sample', title: 'Sample', type: 'image', image: 'example/sample', tag: 'latest',
  discover: { listEnv: 'DISABLED_MODULES' },
  test: { port: 80, checks: [{ path: '/', ok: true }] },
  container: { name: 'sample', ports: [], volumes: [], env: { BASE: '1' } },
  options: [
    { id: 'a', group: 'G', label: 'A', default: true, list: { DISABLED_MODULES: 'a' } },
    { id: 'b', group: 'G', label: 'B', default: true, list: { DISABLED_MODULES: 'b' } },
    { id: 'c', group: 'G', label: 'C', default: false, list: { DISABLED_MODULES: 'c' } },
    { id: 'tele', group: 'T', label: 'Telemetry', default: true, env: { TELEMETRY: 'false' } },
  ],
};
mkdirSync(join(process.env.LEANLING_HOME, 'recipes', 'sample'), { recursive: true });
writeFileSync(join(process.env.LEANLING_HOME, 'recipes', 'sample', 'recipe.json'), JSON.stringify(fixture));

const { buildEnv, containerArgs, getRecipe, listRecipes, namedVolumes, parseNetworks, resolveOptions } = await import('../src/recipes.js');
const { parseVerdict } = await import('../src/agent.js');
const { cleanOptions, isGit, nameFrom, parseDockerfile } = await import('../src/add.js');
const settings = (over = {}) => ({ choices: {}, container: {}, extraOptions: [], ...over });

test('user recipes load next to the bundled ones', () => {
  const names = listRecipes().map((r) => r.name);
  assert.ok(names.includes('sample'));
  assert.ok(names.includes('uptime-kuma'));
  assert.equal(getRecipe('sample').user, true);
  assert.equal(getRecipe('uptime-kuma').user, false);
});

test('default options become a list and a single value', () => {
  const env = buildEnv(getRecipe('sample'), settings(), null);
  assert.equal(env.DISABLED_MODULES, 'a,b');
  assert.equal(env.TELEMETRY, 'false');
  assert.equal(env.BASE, '1');
});

test('user choices win over the defaults', () => {
  const env = buildEnv(getRecipe('sample'), settings({ choices: { a: false, c: true, tele: false } }), null);
  assert.equal(env.DISABLED_MODULES, 'b,c');
  assert.equal(env.TELEMETRY, undefined);
});

test('an item gone from the new version is not passed', () => {
  const env = buildEnv(getRecipe('sample'), settings(), ['b', 'z']);
  assert.equal(env.DISABLED_MODULES, 'b');
});

test('options added by the user', () => {
  const extra = [{ id: 'fresh', label: 'fresh', list: { DISABLED_MODULES: 'fresh' } }];
  const opts = resolveOptions(getRecipe('sample'), settings({ extraOptions: extra, choices: { fresh: true } }));
  assert.ok(opts.find((o) => o.id === 'fresh').remove);
});

test('agent verdict', () => {
  assert.equal(parseVerdict('all good\nVERDICT: OK').ok, true);
  assert.equal(parseVerdict('VERDICT: SUSPICIOUS - new postinstall').ok, false);
  assert.equal(parseVerdict('no conclusion').ok, false, 'no verdict, no install');
  assert.equal(parseVerdict('first VERDICT: OK then\nVERDICT: SUSPICIOUS - x').ok, false, 'the last one counts');
});

test('add: recognises repos and images and derives the name', () => {
  assert.equal(isGit('https://github.com/owner/My_Project.git'), true);
  assert.equal(isGit('ghcr.io/owner/image:1.2'), false);
  assert.equal(nameFrom('https://github.com/owner/My_Project.git'), 'my-project');
  assert.equal(nameFrom('ghcr.io/owner/image:1.2'), 'image');
  assert.equal(nameFrom('louislam/uptime-kuma:1'), 'uptime-kuma');
});

test('add: reads port, health check and volumes from the Dockerfile', () => {
  const d = parseDockerfile('FROM node\nEXPOSE 8080\nVOLUME ["/data", "/cache"]\nHEALTHCHECK --interval=30s CMD wget -qO- http://127.0.0.1:8080/api/health || exit 1\nCMD ["node"]');
  assert.deepEqual(d, { port: 8080, path: '/api/health', volumes: ['/data', '/cache'] });
  assert.deepEqual(parseDockerfile('FROM alpine'), { port: null, path: null, volumes: [] });
});

test('add: options proposed by the agent are filtered', () => {
  const notes = [];
  const out = cleanOptions([
    { id: 'tele', label: 'Telemetry', default: true, env: { DO_NOT_TRACK: '1' } },
    { id: 'broken', env: { 'NOT VALID': 'x' } },
    { id: 'number', env: { PORT: 3000 } },
    { id: 'tele', env: { DUPLICATE: '1' } },
    { id: '../evil', env: { X: '1' } },
  ], notes);
  assert.deepEqual(out.map((o) => o.id), ['tele']);
  assert.equal(notes.length, 4);
});

test('networks: several networks with aliases, no duplicates, and the legacy single entry still works', () => {
  assert.deepEqual(parseNetworks({ networks: ['a:one,two', ' b ', 'a'], network: 'c' }), [
    { name: 'a', aliases: ['one', 'two'] },
    { name: 'b', aliases: [] },
    { name: 'c', aliases: [] },
  ]);
  assert.deepEqual(parseNetworks({}), []);
});

test('volumes: only named ones are copied for the data test', () => {
  assert.deepEqual(namedVolumes({ volumes: ['data:/app/data', '/srv/x:/x', './y:/y', 'cfg:/etc/app:ro'] }), [
    { src: 'data', dest: '/app/data' },
    { src: 'cfg', dest: '/etc/app:ro' },
  ]);
});

test('container: limits and extra hosts; the data test publishes no ports and mounts no real volumes', () => {
  const spec = { ports: ['127.0.0.1:80:80'], volumes: ['data:/d'], memory: '1g', cpus: '2', extraHosts: ['h:host-gateway'] };
  assert.deepEqual(containerArgs(spec, { A: '1' }, { l: 'x' }), ['-p', '127.0.0.1:80:80', '-v', 'data:/d', '-e', 'A=1', '--label', 'l=x', '--memory', '1g', '--cpus', '2', '--add-host', 'h:host-gateway']);
  assert.deepEqual(containerArgs(spec, {}, {}, { ports: false, volumes: false, hosts: false }), ['--memory', '1g', '--cpus', '2']);
});

test('guarddog: the score warns, clear-cut rules block, and the summary names the packages', async () => {
  const { guarddogVerdict } = await import('../src/scan.js');
  const pkg = (name, score, rules = []) =>
    (rules.length ? `Scanning ${name}, found ${rules.length} risks.\n` : `No risks found in ${name}\n`) +
    rules.map((r) => `│ * ${r}\n│   description\n`).join('') +
    `\x1b[1mAssessment:\x1b[0m  label  (${score}/10)\n`;
  assert.equal(guarddogVerdict(pkg('a', '0.0') + pkg('b', '0.0')).status, 'ok');
  assert.equal(guarddogVerdict(pkg('a', '0.0') + pkg('b', '4.3', ['threat.filesystem.read'])).status, 'warning');
  // a large healthy library: high score but generic heuristics only
  const big = guarddogVerdict(pkg('flask', '4.3', ['threat.filesystem.read']) + pkg('torch', '9.4', ['threat.process.spawn', 'threat.runtime.obfuscation']));
  assert.equal(big.status, 'warning');
  assert.match(big.summary, /torch 9\.4/);
  assert.doesNotMatch(big.summary, /flask 4\.3/);
  // clear-cut rules: enough even with a low score
  const bad = guarddogVerdict(pkg('torch', '9.4', ['threat.process.spawn']) + pkg('reqeusts', '3.0', ['typosquatting', 'threat.setup.network-in-install']));
  assert.equal(bad.status, 'blocking');
  assert.match(bad.summary, /To block: reqeusts \(typosquatting, threat\.setup\.network-in-install\)/);
  assert.equal(guarddogVerdict(pkg('x', '2.0', ['threat.network.reverse-shell'])).status, 'blocking');
  assert.equal(guarddogVerdict('Found 0 potentially malicious indicators').status, 'ok');
  assert.equal(guarddogVerdict('Found 3 potentially malicious indicators in x').status, 'blocking');
});

test('runs saved with the old Italian codes are read with the current ones', async () => {
  const { getRun, recentRuns } = await import('../src/pipeline.js');
  const old = { id: 'abc-sample-aggiorna', recipe: 'sample', kind: 'aggiorna', status: 'pronto', startedAt: '2026-01-01T00:00:00Z', steps: [{ name: 'x', status: 'avviso' }, { name: 'y', status: 'ok' }], log: [], report: { scans: [{ id: 'osv', status: 'saltato' }] } };
  writeFileSync(join(process.env.LEANLING_HOME, 'runs', `${old.id}.json`), JSON.stringify(old));
  const r = getRun(old.id);
  assert.deepEqual([r.kind, r.status, r.steps[0].status, r.steps[1].status, r.report.scans[0].status], ['update', 'ready', 'warning', 'ok', 'skipped']);
  assert.deepEqual((await recentRuns()).map((x) => [x.kind, x.status]), [['update', 'ready']]);
});

test('dashboard texts: every language has the same keys and placeholders as English', async () => {
  const { readFileSync } = await import('node:fs');
  const texts = JSON.parse(readFileSync(new URL('../public/i18n.json', import.meta.url), 'utf8'));
  const vars = (s) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
  for (const [lang, table] of Object.entries(texts)) {
    assert.deepEqual(Object.keys(table).sort(), Object.keys(texts.en).sort(), lang);
    for (const [k, v] of Object.entries(table)) assert.deepEqual(vars(v), vars(texts.en[k]), `${lang}: ${k}`);
  }
});
