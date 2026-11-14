import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.LEANLING_HOME = mkdtempSync(join(tmpdir(), 'leanling-test-'));

// Ricetta di prova con una lista (come una lista di moduli spenti) e un valore singolo
const fixture = {
  name: 'prova', title: 'Prova', type: 'image', image: 'esempio/prova', tag: 'latest',
  discover: { listEnv: 'MODULI_SPENTI' },
  test: { port: 80, checks: [{ path: '/', ok: true }] },
  container: { name: 'prova', ports: [], volumes: [], env: { BASE: '1' } },
  options: [
    { id: 'a', group: 'G', label: 'A', default: true, list: { MODULI_SPENTI: 'a' } },
    { id: 'b', group: 'G', label: 'B', default: true, list: { MODULI_SPENTI: 'b' } },
    { id: 'c', group: 'G', label: 'C', default: false, list: { MODULI_SPENTI: 'c' } },
    { id: 'tele', group: 'T', label: 'Telemetria', default: true, env: { TELEMETRIA: 'false' } },
  ],
};
mkdirSync(join(process.env.LEANLING_HOME, 'recipes', 'prova'), { recursive: true });
writeFileSync(join(process.env.LEANLING_HOME, 'recipes', 'prova', 'recipe.json'), JSON.stringify(fixture));

const { buildEnv, containerArgs, getRecipe, listRecipes, namedVolumes, parseNetworks, resolveOptions } = await import('../src/recipes.js');
const { parseVerdict } = await import('../src/agent.js');
const { cleanOptions, isGit, nameFrom, parseDockerfile } = await import('../src/add.js');
const settings = (over = {}) => ({ choices: {}, container: {}, extraOptions: [], ...over });

test('le ricette dell\'utente si caricano accanto a quelle incluse', () => {
  const names = listRecipes().map((r) => r.name);
  assert.ok(names.includes('prova'));
  assert.ok(names.includes('uptime-kuma'));
  assert.equal(getRecipe('prova').user, true);
  assert.equal(getRecipe('uptime-kuma').user, false);
});

test('le opzioni predefinite diventano una lista e un valore singolo', () => {
  const env = buildEnv(getRecipe('prova'), settings(), null);
  assert.equal(env.MODULI_SPENTI, 'a,b');
  assert.equal(env.TELEMETRIA, 'false');
  assert.equal(env.BASE, '1');
});

test('le scelte dell\'utente vincono sui valori predefiniti', () => {
  const env = buildEnv(getRecipe('prova'), settings({ choices: { a: false, c: true, tele: false } }), null);
  assert.equal(env.MODULI_SPENTI, 'b,c');
  assert.equal(env.TELEMETRIA, undefined);
});

test('un elemento sparito dalla nuova versione non viene passato', () => {
  const env = buildEnv(getRecipe('prova'), settings(), ['b', 'z']);
  assert.equal(env.MODULI_SPENTI, 'b');
});

test('opzioni aggiunte dall\'utente', () => {
  const extra = [{ id: 'nuovo', label: 'nuovo', list: { MODULI_SPENTI: 'nuovo' } }];
  const opts = resolveOptions(getRecipe('prova'), settings({ extraOptions: extra, choices: { nuovo: true } }));
  assert.ok(opts.find((o) => o.id === 'nuovo').remove);
});

test('verdetto dell\'agente', () => {
  assert.equal(parseVerdict('tutto bene\nVERDETTO: OK').ok, true);
  assert.equal(parseVerdict('VERDETTO: SOSPETTO - postinstall nuovo').ok, false);
  assert.equal(parseVerdict('nessuna conclusione').ok, false, 'senza verdetto non si installa');
  assert.equal(parseVerdict('prima VERDETTO: OK poi\nVERDETTO: SOSPETTO - x').ok, false, 'conta l\'ultimo');
});

test('aggiungi: riconosce repo e immagini e ne ricava il nome', () => {
  assert.equal(isGit('https://github.com/autore/Mio_Progetto.git'), true);
  assert.equal(isGit('ghcr.io/autore/immagine:1.2'), false);
  assert.equal(nameFrom('https://github.com/autore/Mio_Progetto.git'), 'mio-progetto');
  assert.equal(nameFrom('ghcr.io/autore/immagine:1.2'), 'immagine');
  assert.equal(nameFrom('louislam/uptime-kuma:1'), 'uptime-kuma');
});

test('aggiungi: legge porta, controllo di salute e volumi dal Dockerfile', () => {
  const d = parseDockerfile('FROM node\nEXPOSE 8080\nVOLUME ["/data", "/cache"]\nHEALTHCHECK --interval=30s CMD wget -qO- http://127.0.0.1:8080/api/health || exit 1\nCMD ["node"]');
  assert.deepEqual(d, { port: 8080, path: '/api/health', volumes: ['/data', '/cache'] });
  assert.deepEqual(parseDockerfile('FROM alpine'), { port: null, path: null, volumes: [] });
});

test('aggiungi: le opzioni proposte dall\'agente vengono filtrate', () => {
  const notes = [];
  const out = cleanOptions([
    { id: 'tele', label: 'Telemetria', default: true, env: { DO_NOT_TRACK: '1' } },
    { id: 'rotta', env: { 'NON VALIDA': 'x' } },
    { id: 'numero', env: { PORTA: 3000 } },
    { id: 'tele', env: { DOPPIONE: '1' } },
    { id: '../evil', env: { X: '1' } },
  ], notes);
  assert.deepEqual(out.map((o) => o.id), ['tele']);
  assert.equal(notes.length, 4);
});

test('reti: più reti con alias, senza doppioni, e la vecchia voce singola vale ancora', () => {
  assert.deepEqual(parseNetworks({ networks: ['a:uno,due', ' b ', 'a'], network: 'c' }), [
    { name: 'a', aliases: ['uno', 'due'] },
    { name: 'b', aliases: [] },
    { name: 'c', aliases: [] },
  ]);
  assert.deepEqual(parseNetworks({}), []);
});

test('volumi: solo quelli con nome si copiano per la prova con i dati', () => {
  assert.deepEqual(namedVolumes({ volumes: ['dati:/app/data', '/srv/x:/x', './y:/y', 'cfg:/etc/app:ro'] }), [
    { src: 'dati', dest: '/app/data' },
    { src: 'cfg', dest: '/etc/app:ro' },
  ]);
});

test('container: limiti e host in più; la prova con i dati non pubblica porte né monta i volumi veri', () => {
  const spec = { ports: ['127.0.0.1:80:80'], volumes: ['dati:/d'], memory: '1g', cpus: '2', extraHosts: ['h:host-gateway'] };
  assert.deepEqual(containerArgs(spec, { A: '1' }, { l: 'x' }), ['-p', '127.0.0.1:80:80', '-v', 'dati:/d', '-e', 'A=1', '--label', 'l=x', '--memory', '1g', '--cpus', '2', '--add-host', 'h:host-gateway']);
  assert.deepEqual(containerArgs(spec, {}, {}, { ports: false, volumes: false, hosts: false }), ['--memory', '1g', '--cpus', '2']);
});

test('guarddog: blocca dal rischio alto, avvisa sotto, e capisce anche il formato vecchio', async () => {
  const { guarddogVerdict } = await import('../src/scan.js');
  const pkg = (label, score) => `\x1b[1mAssessment:\x1b[0m  ${label}  (${score}/10)\n`;
  assert.equal(guarddogVerdict(pkg('No risks detected', '0.0') + pkg('No risks detected', '0.0')).status, 'ok');
  assert.equal(guarddogVerdict(pkg('No risks detected', '0.0') + pkg('Low risk', '4.3')).status, 'avviso');
  assert.equal(guarddogVerdict(pkg('Low risk', '4.3') + pkg('High risk', '8.1')).status, 'bloccante');
  assert.equal(guarddogVerdict('Found 0 potentially malicious indicators').status, 'ok');
  assert.equal(guarddogVerdict('Found 3 potentially malicious indicators in x').status, 'bloccante');
});
