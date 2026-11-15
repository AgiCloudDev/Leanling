// The real work: prepare the child of a new version, test it, install it, roll back, clean up.
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { askAgent, agentStatus, parseVerdict } from './agent.js';
import { HOME, languageName, loadConfig, loadState, recipeSettings, saveState } from './config.js';
import { buildEnv, containerArgs, containerSpec, getRecipe, namedVolumes, parseNetworks, resolveOptions, resolvePatches } from './recipes.js';
import { scanImage, scanSource } from './scan.js';
import { freePort, run, sleep } from './sh.js';

export const events = new EventEmitter();
const active = new Map(); // recipe name -> run in progress

/* ------------------------------------------------------------------ record of a run */

// Lock across processes (CLI and dashboard): a file with the pid of whoever is working on the recipe
const lockFile = (recipe) => join(HOME, 'work', `${recipe}.lock`);
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

export function lockedBy(recipe) {
  try {
    const { pid, run } = JSON.parse(readFileSync(lockFile(recipe), 'utf8'));
    return alive(pid) ? run : null;
  } catch {
    return null;
  }
}

export function newRun(recipe, kind) {
  if (active.has(recipe) || lockedBy(recipe)) throw new Error(`A job is already in progress on ${recipe}`);
  const r = { id: `${Date.now().toString(36)}-${recipe}-${kind}`, recipe, kind, status: 'running', startedAt: new Date().toISOString(), steps: [], log: [], report: {} };
  active.set(recipe, r);
  writeFileSync(lockFile(recipe), JSON.stringify({ pid: process.pid, run: r.id }));
  persist(r);
  events.emit('run', r);
  return r;
}

/** Saves progress to a file (at most every 2 s): this way the dashboard also sees jobs started from the terminal */
const lastSave = new Map();
function persist(r, force = false) {
  const now = Date.now();
  if (!force && now - (lastSave.get(r.id) ?? 0) < 2000) return;
  lastSave.set(r.id, now);
  writeFileSync(join(HOME, 'runs', `${r.id}.json`), JSON.stringify(r, null, 2));
}

export function logger(r, echo) {
  return (line) => {
    const l = `${new Date().toTimeString().slice(0, 8)} ${line}`;
    r.log.push(l);
    if (r.log.length > 2000) r.log.splice(0, r.log.length - 2000);
    if (echo) console.log(l);
    persist(r);
    events.emit('log', { id: r.id, line: l });
  };
}

export async function step(r, log, name, fn) {
  const s = { name, status: 'running' };
  r.steps.push(s);
  events.emit('run', r);
  log(`▶ ${name}`);
  try {
    const out = await fn();
    s.status = out?.status ?? 'ok';
    if (out?.detail) s.detail = out.detail;
    return out;
  } catch (e) {
    s.status = 'error';
    s.detail = e.message;
    throw e;
  } finally {
    persist(r, true);
    events.emit('run', r);
  }
}

export function finish(r, status, message) {
  r.status = status;
  r.message = message;
  r.endedAt = new Date().toISOString();
  active.delete(r.recipe);
  rmSync(lockFile(r.recipe), { force: true });
  persist(r, true);
  lastSave.delete(r.id);
  events.emit('run', r);
  return r;
}

export const activeRuns = () => [...active.values()];
/** Recipe -> id of the job in progress, in this process or another one */
export const runningId = (recipe) => active.get(recipe)?.id ?? lockedBy(recipe);

/* ------------------------------------------------------------------ docker */

const docker = (args, opts) => run('docker', args, opts);
const imageId = async (ref) => (await docker(['image', 'inspect', '-f', '{{.Id}}', ref])).out.trim() || null;
const imageSizeMB = async (ref) => Math.round(Number((await docker(['image', 'inspect', '-f', '{{.Size}}', ref])).out.trim()) / 1e6);

/**
 * Creates and starts the installed container. Docker attaches a single network at creation:
 * the others are added before start, so the app boots with every network already in place.
 */
async function launch(spec, image, env, labels) {
  const [first, ...others] = parseNetworks(spec);
  const args = ['create', '--name', spec.name, '--restart', spec.restart ?? 'unless-stopped', ...containerArgs(spec, env, labels)];
  if (first) args.push('--network', first.name, ...first.aliases.flatMap((a) => ['--network-alias', a]));
  const c = await docker([...args, image]);
  if (c.code !== 0) throw new Error(c.err.trim());
  for (const n of others) {
    const x = await docker(['network', 'connect', ...n.aliases.flatMap((a) => ['--alias', a]), n.name, spec.name]);
    if (x.code !== 0) {
      await docker(['rm', '-f', spec.name]);
      throw new Error(`Network ${n.name}: ${x.err.trim()}`);
    }
  }
  const s = await docker(['start', spec.name]);
  if (s.code !== 0) {
    await docker(['rm', '-f', spec.name]);
    throw new Error(s.err.trim());
  }
  return c.out.trim();
}

/** HTTP request from the host to a port published on 127.0.0.1 */
const hostRequest = (port) => async (c) => {
  const res = await fetch(`http://127.0.0.1:${port}${c.path}`, {
    method: c.method ?? 'GET',
    headers: c.body ? { 'content-type': 'application/json' } : {},
    body: c.body ? JSON.stringify(c.body) : undefined,
    signal: AbortSignal.timeout(60_000),
  });
  return { status: res.status, text: await res.text() };
};

// Helper image for the data tests: copies the volumes and queries the isolated container
const HELPER = process.env.LEANLING_HELPER_IMAGE ?? 'curlimages/curl:latest';

/** HTTP request made from inside the network of a container with no network: nothing gets out and nothing gets in */
const containerRequest = (name, port) => async (c) => {
  const args = ['run', '--rm', '--network', `container:${name}`, '--entrypoint', 'curl', HELPER, '-s', '-m', '60', '-X', c.method ?? 'GET', '-w', '\n%{http_code}'];
  if (c.body) args.push('-H', 'content-type: application/json', '-d', JSON.stringify(c.body));
  const r = await docker([...args, `http://127.0.0.1:${port}${c.path}`]);
  if (r.code !== 0) throw new Error('not responding');
  const cut = r.out.lastIndexOf('\n');
  return { status: Number(r.out.slice(cut + 1)), text: r.out.slice(0, cut) };
};

/** HTTP checks of the test: status, expected JSON fields, expected text */
async function httpChecks(request, checks) {
  for (const c of checks) {
    const { status, text } = await request(c);
    if (c.status && status !== c.status) return `${c.path}: status ${status}, expected ${c.status}`;
    if (c.ok && !(status >= 200 && status < 300)) return `${c.path}: status ${status}`;
    if (c.contains && !text.includes(c.contains)) return `${c.path}: "${c.contains}" missing from the response`;
    if (c.json) {
      const body = JSON.parse(text);
      for (const [k, v] of Object.entries(c.json)) if (body[k] !== v) return `${c.path}: ${k}=${JSON.stringify(body[k])}, expected ${JSON.stringify(v)}`;
    }
  }
  return null;
}

async function waitHealthy(request, test, log, checks = test.checks) {
  const deadline = Date.now() + (test.startTimeout ?? 120) * 1000;
  let last = 'not responding';
  while (Date.now() < deadline) {
    try {
      last = await httpChecks(request, checks.slice(0, 1));
      if (!last) break;
    } catch (e) {
      last = e.cause?.code ?? e.message;
    }
    await sleep(2000);
  }
  if (last) return `Not ready within ${test.startTimeout ?? 120}s: ${last}`;
  log('ready, running the checks');
  return httpChecks(request, checks);
}

/** Starts the child in a throwaway container (free port, no volumes) and puts it to the test */
async function testImage(recipe, image, env, log) {
  const port = await freePort();
  const name = `leanling-test-${recipe.name}-${port}`;
  const started = Date.now();
  const r = await docker(['run', '-d', '--name', name, '-p', `127.0.0.1:${port}:${recipe.test.port}`, ...Object.entries(env).flatMap(([k, v]) => ['-e', `${k}=${v}`]), '--label', 'leanling.test=1', image]);
  if (r.code !== 0) throw new Error(`The test container does not start: ${r.err.trim()}`);
  try {
    const fail = await waitHealthy(hostRequest(port), recipe.test, log);
    if (fail) {
      const logs = await docker(['logs', '--tail', '30', name]);
      throw new Error(`${fail}\n--- last lines of the container ---\n${(logs.out + logs.err).trim()}`);
    }
    const ram = (await docker(['stats', '--no-stream', '--format', '{{.MemUsage}}', name])).out.trim().split(' / ')[0];
    return { status: 'ok', detail: `ready in ${Math.round((Date.now() - started) / 1000)}s, RAM ${ram}` };
  } finally {
    await docker(['rm', '-f', name]);
  }
}

/**
 * Test with the real data: copies the volumes of the installation in use and starts the child on
 * the copy, with the same variables as production but no network. This way migrations run on real
 * data, and automations, webhooks and outgoing messages cannot reach anyone. The installation in
 * use is paused only for the seconds the copy takes, to get consistent files.
 */
async function testWithData(recipe, settings, image, env, log) {
  if (settings.dataTest === false) return { status: 'ok', detail: 'turned off in the settings' };
  const spec = containerSpec(recipe, settings);
  const sources = [];
  for (const v of namedVolumes(spec)) if ((await docker(['volume', 'inspect', v.src])).code === 0) sources.push(v);
  if (!sources.length) return { status: 'ok', detail: 'no volume with existing data: test skipped' };

  const name = `leanling-test-${recipe.name}-data-${Date.now().toString(36)}`;
  const copies = sources.map((v, i) => ({ ...v, copy: `${name}-${i}` }));
  try {
    const users = new Set();
    for (const v of sources) {
      const ids = (await docker(['ps', '-q', '--filter', `volume=${v.src}`, '--filter', 'status=running'])).out.trim().split('\n').filter(Boolean);
      ids.forEach((id) => users.add(id));
    }
    const pull = await docker(['pull', '-q', HELPER]);
    if (pull.code !== 0 && (await docker(['image', 'inspect', HELPER])).code !== 0) throw new Error(`Cannot pull ${HELPER}: ${pull.err.trim()}`);
    for (const c of copies) {
      const v = await docker(['volume', 'create', '--label', 'leanling.test=1', c.copy]);
      if (v.code !== 0) throw new Error(v.err.trim());
    }
    const paused = [];
    const pausedAt = Date.now();
    try {
      for (const id of users) if ((await docker(['pause', id])).code === 0) paused.push(id);
      for (const c of copies) {
        const cp = await docker(['run', '--rm', '--user', '0', '--network', 'none', '--entrypoint', 'cp', '-v', `${c.src}:/from:ro`, '-v', `${c.copy}:/to`, HELPER, '-a', '/from/.', '/to/']);
        if (cp.code !== 0) throw new Error(`Copy of ${c.src} failed: ${cp.err.trim()}`);
      }
    } finally {
      for (const id of paused) await docker(['unpause', id]);
    }
    log(`volumes copied: ${copies.length}${paused.length ? ` (installation paused for ${Math.round((Date.now() - pausedAt) / 1000)}s)` : ''}`);

    const args = ['run', '-d', '--name', name, '--network', 'none', ...containerArgs(spec, env, { 'leanling.test': '1' }, { ports: false, volumes: false, hosts: false })];
    for (const c of copies) args.push('-v', `${c.copy}:${c.dest}`);
    const run0 = await docker([...args, image]);
    if (run0.code !== 0) throw new Error(`The test container does not start: ${run0.err.trim()}`);
    const t0 = Date.now();
    const fail = await waitHealthy(containerRequest(name, recipe.test.port), recipe.test, log, recipe.test.dataChecks ?? recipe.test.checks);
    if (fail) {
      const logs = await docker(['logs', '--tail', '40', name]);
      throw new Error(`With the real data: ${fail}\n--- last lines of the container ---\n${(logs.out + logs.err).trim()}`);
    }
    const state = (await docker(['inspect', '-f', '{{.State.Status}} {{.RestartCount}}', name])).out.trim();
    if (state !== 'running 0') throw new Error(`With the real data the container does not stay up (${state})`);
    return { status: 'ok', detail: `${copies.map((c) => c.src).join(', ')}: ready in ${Math.round((Date.now() - t0) / 1000)}s on the copy of the data` };
  } finally {
    await docker(['rm', '-f', name]);
    for (const c of copies) await docker(['volume', 'rm', '-f', c.copy]);
  }
}

/* ------------------------------------------------------------------ preparing the child */

/**
 * Prepares the candidate: downloads, checks, applies the recipe, builds and tests.
 * With `deploy` it installs it right away if everything went well.
 */
export async function update(name, { force = false, deploy = false, echo = false } = {}) {
  const recipe = getRecipe(name);
  const r = newRun(name, 'update');
  const log = logger(r, echo);
  try {
    const cfg = loadConfig();
    const settings = recipeSettings(cfg, name);
    const prep = recipe.type === 'build' ? prepareBuild : prepareImage;
    const candidate = await prep(recipe, cfg, settings, r, log, force);
    if (!candidate) return finish(r, 'ok', 'Already up to date: no new version');
    const state = loadState();
    state[name] = { ...state[name], candidate: { ...candidate, report: r.report, at: new Date().toISOString() } };
    saveState(state);
    if (deploy || settings.deploy) {
      active.delete(name);
      const d = await promote(name, { echo, parent: r });
      return finish(r, d.status, d.message);
    }
    return finish(r, 'ready', `Child ${candidate.version} ready and tested: install it whenever you want`);
  } catch (e) {
    log(`✖ ${e.message}`);
    return finish(r, 'error', e.message.split('\n')[0]);
  }
}

async function prepareImage(recipe, cfg, settings, r, log, force) {
  const ref = `${recipe.image}:${recipe.tag ?? 'latest'}`;
  const prev = loadState()[recipe.name]?.current;

  const pulled = await step(r, log, `Pulling ${ref}`, async () => {
    const p = await docker(['pull', '-q', ref]);
    if (p.code !== 0) throw new Error(p.err.trim());
    const id = await imageId(ref);
    // Version: recipe command, then the OCI label of the image, then a piece of the id
    const label = (await docker(['image', 'inspect', '-f', '{{index .Config.Labels "org.opencontainers.image.version"}}', ref])).out.trim();
    const v = recipe.versionCmd ? (await docker(['run', '--rm', '--entrypoint', 'sh', ref, '-c', recipe.versionCmd])).out.trim().split('\n').pop() : '';
    const version = v || (label && label !== '<no value>' ? label : id.slice(7, 19));
    return { status: 'ok', id, version, detail: `version ${version}` };
  });
  if (!force && prev?.imageId === pulled.id) {
    r.steps.push({ name: 'Comparison', status: 'ok', detail: `${pulled.version} is already the one in use` });
    return null;
  }

  // What this version offers: new names = to be decided, missing names = no longer passed
  let available = null;
  if (recipe.discover) {
    await step(r, log, recipe.discover.description, async () => {
      const d = await docker(['run', '--rm', '--entrypoint', 'sh', ref, '-c', recipe.discover.cmd]);
      available = JSON.parse(d.out.trim().split('\n').pop());
      // `keep` = core parts the recipe always leaves on: the user is not asked about them
      const known = new Set([...resolveOptions(recipe, settings).flatMap((o) => Object.values(o.list ?? {})), ...(recipe.discover.keep ?? [])]);
      const fresh = available.filter((m) => !known.has(m));
      const gone = [...known].filter((m) => !available.includes(m));
      r.report.newItems = fresh;
      r.report.goneItems = gone;
      return { status: fresh.length ? 'warning' : 'ok', detail: `${available.length} found${fresh.length ? `; new, to be decided: ${fresh.join(', ')}` : ''}${gone.length ? `; no longer present: ${gone.join(', ')}` : ''}` };
    });
  }

  if (recipe.upstream?.includes('github.com')) {
    await step(r, log, 'Release notes', async () => {
      const notes = await releaseNotes(recipe.upstream, prev?.version, pulled.version);
      r.report.releaseNotes = notes;
      return { status: 'ok', detail: notes ? `${notes.split('\n## ').length} releases read` : 'no notes found' };
    });
  }

  if (cfg.agent.review && agentStatus(cfg).ready && (r.report.newItems?.length || r.report.releaseNotes)) {
    await step(r, log, 'Agent review', async () => {
      const prompt = [
        `You are the Leanling reviewer. We are updating ${recipe.title} from ${prev?.version ?? '(first installation)'} to ${pulled.version}, self-hosted without an enterprise licence.`,
        r.report.newItems?.length ? `New items in this version: ${r.report.newItems.join(', ')}. For each one say whether it is free, enterprise/paid or experimental, and whether it is worth turning off.` : '',
        r.report.releaseNotes ? `Release notes:\n${r.report.releaseNotes.slice(0, 30_000)}` : '',
        'Flag changes that can break an existing installation or that look suspicious (new telemetry, connections to external services, licence changes).',
        `Answer briefly, in ${languageName(cfg)}. Last line exactly: "VERDICT: OK" or "VERDICT: SUSPICIOUS - reason" (these keywords stay in English).`,
      ].filter(Boolean).join('\n\n');
      const text = await askAgent(cfg, prompt, { cwd: HOME, log });
      const v = parseVerdict(text);
      r.report.review = text;
      if (!v.ok) throw new Error(`Review: ${v.line}`);
      return { status: 'ok', detail: v.line };
    });
  }

  const tag = `leanling/${recipe.name}:${safeTag(pulled.version)}`;
  await docker(['tag', ref, tag]);
  const env = buildEnv(recipe, settings, available);
  await scanAndGate(cfg, r, log, () => scanImage(cfg, tag, log), 'Image scan');
  await step(r, log, 'Child test', () => testImage(recipe, tag, env, log));
  if (recipe.test) await step(r, log, 'Test on a copy of the data', () => testWithData(recipe, settings, tag, env, log));
  return { image: tag, imageId: pulled.id, version: pulled.version, env };
}

async function prepareBuild(recipe, cfg, settings, r, log, force) {
  const base = join(HOME, 'work', recipe.name);
  const repo = join(base, 'repo');
  mkdirSync(base, { recursive: true });
  const git = (args, cwd = repo) => run('git', args, { cwd });
  const prev = loadState()[recipe.name]?.current;

  const head = await step(r, log, 'Downloading the latest version', async () => {
    if (!existsSync(join(repo, '.git'))) {
      const c = await run('git', ['clone', '--filter=blob:none', '--no-checkout', recipe.repo, repo]);
      if (c.code !== 0) throw new Error(c.err.trim());
    }
    const f = await git(['fetch', '--quiet', 'origin', recipe.ref ?? 'main']);
    if (f.code !== 0) throw new Error(f.err.trim());
    const sha = (await git(['rev-parse', 'FETCH_HEAD'])).out.trim();
    const subject = (await git(['log', '-1', '--format=%s (%cd)', '--date=short', sha])).out.trim();
    return { status: 'ok', sha, detail: `${sha.slice(0, 8)} ${subject}` };
  });
  if (!force && prev?.commit === head.sha) {
    r.steps.push({ name: 'Comparison', status: 'ok', detail: 'no new commits' });
    return null;
  }

  const tmp = join(base, `tmp-${r.id}`);
  await git(['worktree', 'add', '--detach', tmp, head.sha]);
  try {
    const range = prev?.commit ? `${prev.commit}..${head.sha}` : null;
    if (range) {
      const count = (await git(['rev-list', '--count', range])).out.trim();
      r.report.newCommits = Number(count);
      r.report.changelog = (await git(['log', '--format=- %h %s', range])).out.trim();
    }

    await scanAndGate(cfg, r, log, () => scanSource(cfg, { dir: tmp, range, manifests: recipe.manifests, log }), 'Source scanners');

    if (range && cfg.agent.review && agentStatus(cfg).ready) {
      await step(r, log, 'Review of the changes (agent)', async () => {
        const stat = (await git(['diff', '--stat', range])).out;
        const diff = (await git(['diff', range, '--', '.', ':(exclude)*.lock', ':(exclude)*.png', ':(exclude)*.svg'])).out;
        const prompt = [
          `You are the Leanling security reviewer. The project ${recipe.title} (${recipe.upstream}) went from ${prev.commit.slice(0, 8)} to ${head.sha.slice(0, 8)}. The new source is in the current folder.`,
          `New commits:\n${r.report.changelog}`,
          `Changed files:\n${stat}`,
          diff.length < 150_000 ? `Diff:\n${diff}` : 'The diff is too long to paste: read the most relevant changed files yourself (Dockerfile, install scripts, dependencies, network code).',
          'Look for signs of a supply-chain attack: new install scripts, curl|sh, obfuscated or base64 code, downloads or connections to new domains, dependencies just added or named like well-known ones, harvesting of environment variables or keys.',
          `Answer briefly, in ${languageName(cfg)}: what changes for whoever installs it. Last line exactly: "VERDICT: OK" or "VERDICT: SUSPICIOUS - reason" (these keywords stay in English).`,
        ].join('\n\n');
        const text = await askAgent(cfg, prompt, { cwd: tmp, log });
        const v = parseVerdict(text);
        r.report.review = text;
        if (!v.ok) throw new Error(`Review: ${v.line}`);
        return { status: 'ok', detail: v.line };
      });
    }

    for (const p of resolvePatches(recipe, settings).filter((x) => x.enabled)) {
      await step(r, log, `Recipe: ${p.label}`, () => applyPatch(recipe, cfg, p, tmp, log));
    }

    const tag = `leanling/${recipe.name}:${head.sha.slice(0, 12)}`;
    await step(r, log, 'Building the image', async () => {
      let lines = 0;
      const b = await docker(['build', '-t', tag, '-f', recipe.dockerfile ?? 'Dockerfile', '--label', `leanling.recipe=${recipe.name}`, '--label', `leanling.commit=${head.sha}`, '.'], {
        cwd: tmp,
        env: { DOCKER_BUILDKIT: '1' },
        onLine: (l) => ++lines % 20 === 0 && log(`build: ${l.slice(0, 160)}`),
      });
      if (b.code !== 0) throw new Error(`Build failed:\n${b.err.split('\n').slice(-20).join('\n')}`);
      const mb = await imageSizeMB(tag);
      r.report.sizeMB = mb;
      if (recipe.maxSizeMB && mb > recipe.maxSizeMB) throw new Error(`Image is ${mb} MB, over the ${recipe.maxSizeMB} MB limit: the recipe is no longer working`);
      return { status: 'ok', detail: `${tag}, ${(mb / 1000).toFixed(2)} GB` };
    });

    await scanAndGate(cfg, r, log, () => scanImage(cfg, tag, log), 'Image scan');
    const env = buildEnv(recipe, settings, null);
    await step(r, log, 'Child test', () => testImage(recipe, tag, env, log));
    if (recipe.test) await step(r, log, 'Test on a copy of the data', () => testWithData(recipe, settings, tag, env, log));
    return { image: tag, imageId: await imageId(tag), version: head.sha.slice(0, 8), commit: head.sha, env };
  } finally {
    await git(['worktree', 'remove', '--force', tmp]);
  }
}

/** Applies a patch; skips it if upstream already has it, asks the agent to redo it if it no longer applies */
async function applyPatch(recipe, cfg, p, dir, log) {
  const git = (args) => run('git', args, { cwd: dir });
  if ((await git(['apply', '--check', p.path])).code === 0) {
    await git(['apply', p.path]);
    return { status: 'ok', detail: p.overridden ? 'applied (version redone by the agent)' : 'applied' };
  }
  if ((await git(['apply', '--reverse', '--check', p.path])).code === 0) {
    return { status: 'warning', detail: 'already present upstream: this patch can be removed from the recipe' };
  }
  const three = await git(['apply', '--3way', p.path]);
  if (three.code === 0) return { status: 'ok', detail: 'applied with a three-way merge' };
  await git(['checkout', '--', '.']);

  if (!cfg.agent.fixPatches || !agentStatus(cfg).ready) throw new Error(`Patch ${p.file} no longer applies and no agent is active to redo it`);
  log(`patch ${p.file} no longer applies: the agent redoes it`);
  const prompt = [
    `The current folder holds the new version of ${recipe.title}. A change we used to make no longer applies because the original file changed.`,
    `Purpose of the change: ${p.intent ?? p.label}`,
    `Old patch, for reference only:\n${readFileSync(p.path, 'utf8')}`,
    'Apply the same change to the current code by editing the files directly. Do not change anything else. At the end write in one line what you did.',
  ].join('\n\n');
  await askAgent(cfg, prompt, { cwd: dir, mode: 'edit', log });
  const diff = (await git(['diff'])).out;
  if (!diff.trim()) throw new Error('The agent did not change anything');
  const out = join(HOME, 'patches', recipe.name);
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, p.file), diff);
  return { status: 'warning', detail: `redone by the agent and saved in ${join(out, p.file)}: check it` };
}

async function scanAndGate(cfg, r, log, fn, label) {
  await step(r, log, label, async () => {
    const res = await fn();
    r.report.scans = [...(r.report.scans ?? []), ...res];
    if (!res.length) return { status: 'ok', detail: 'no active scanner' };
    const bad = res.filter((x) => x.status === 'blocking');
    if (bad.length) throw new Error(`Blocked by ${bad.map((b) => b.id).join(', ')}:\n${bad.map((b) => b.detail).join('\n')}`);
    const warn = res.some((x) => ['warning', 'error', 'skipped'].includes(x.status));
    return { status: warn ? 'warning' : 'ok', detail: res.map((x) => `${x.id}: ${x.status}`).join(', ') };
  });
}

/* ------------------------------------------------------------------ install, rollback, cleanup */

const LABEL = 'leanling.recipe';

/** Installs the candidate in place of the version in use; if it does not respond it goes back to the previous one */
export async function promote(name, { echo = false, target = 'candidate', parent = null } = {}) {
  const recipe = getRecipe(name);
  const r = parent ?? newRun(name, target === 'previous' ? 'rollback' : 'install');
  if (parent) active.set(name, r);
  const log = logger(r, echo);
  try {
    const cfg = loadConfig();
    const settings = recipeSettings(cfg, name);
    const state = loadState();
    const s = state[name] ?? {};
    const next = s[target];
    if (!next) throw new Error(target === 'previous' ? 'There is no previous version' : 'No child ready: run "update" first');
    const spec = containerSpec(recipe, settings);
    // The variables are the ones the child was tested with: if the choices change, it has to be prepared again
    const env = next.env ?? {};

    // "Replaces": a container made by hand or with compose that has to be stopped (not deleted) to make room for the child
    let replaced = null;
    const restoreReplaced = async () => {
      if (!replaced) return '';
      await docker(['rm', '-f', spec.name]);
      await docker(['update', '--restart', replaced.restart, replaced.name]);
      const st = await docker(['start', replaced.name]);
      return st.code === 0 ? ` Restarted "${replaced.name}" as it was before.` : ` Cannot restart "${replaced.name}": ${st.err.trim()}`;
    };

    try {
      await step(r, log, `Installing ${next.version} as "${spec.name}"`, async () => {
        const owner = (await docker(['inspect', '-f', `{{index .Config.Labels "${LABEL}"}}`, spec.name])).out.trim();
        const exists = (await docker(['inspect', spec.name])).code === 0;
        if (exists && owner !== name && !settings.adopt) {
          throw new Error(`A container named "${spec.name}" already exists and Leanling did not create it. Pick another name in the Container tab or turn on "Adopt existing container".`);
        }
        const old = settings.replaces?.trim();
        if (old && old !== spec.name) {
          const info = (await docker(['inspect', '-f', '{{.State.Running}} {{.HostConfig.RestartPolicy.Name}}', old])).out.trim().split(' ');
          if (info[0] === 'true') {
            replaced = { name: old, restart: info[1] || 'no' };
            // Without this Docker would restart it when the host reboots, on the same port as the child
            await docker(['update', '--restart', 'no', old]);
            const st = await docker(['stop', old]);
            if (st.code !== 0) throw new Error(`Cannot stop "${old}": ${st.err.trim()}`);
            log(`stopped "${old}" (it stays on disk, it is not deleted)`);
          }
        }
        if (exists) await docker(['rm', '-f', spec.name]);
        const id = await launch(spec, next.image, env, { [LABEL]: name, 'leanling.version': next.version });
        return { status: 'ok', detail: id.slice(0, 12) };
      });
    } catch (e) {
      throw new Error(`${e.message}${await restoreReplaced()}`);
    }

    const hostPort = Number((spec.ports?.[0] ?? '').split(':').at(-2));
    if (hostPort && recipe.test) {
      try {
        await step(r, log, 'Check after installing', async () => {
          // If data already existed (replacement or update) it also checks that the child can see it
          const fail = await waitHealthy(hostRequest(hostPort), recipe.test, log, (replaced || s.current) && recipe.test.dataChecks ? recipe.test.dataChecks : recipe.test.checks);
          if (fail) throw new Error(fail);
          return { status: 'ok', detail: `responding on ${hostPort}` };
        });
      } catch (e) {
        if (replaced) {
          log(`not responding: putting "${replaced.name}" back`);
          throw new Error(`${e.message}.${await restoreReplaced()}`);
        }
        if (target !== 'candidate' || !s.current) throw e;
        log('not responding: going back to the previous version');
        await docker(['rm', '-f', spec.name]);
        await launch(spec, s.current.image, s.current.env ?? {}, { [LABEL]: name, 'leanling.version': s.current.version });
        throw new Error(`${e.message}. Version ${s.current.version} put back.`);
      }
    }

    const fresh = loadState();
    const cur = fresh[name] ?? {};
    fresh[name] = target === 'previous'
      ? { ...cur, current: cur.previous, previous: cur.current }
      : { ...cur, previous: cur.current ?? null, current: { ...next, env, installedAt: new Date().toISOString() }, candidate: null };
    saveState(fresh);
    if (cfg.keepVersions > 0) await cleanup(name, log);
    if (settings.publishAs && target === 'candidate') await publish(next.image, settings.publishAs, next.version, log);
    return parent ? { status: 'ok', message: `Installed ${next.version}` } : finish(r, 'ok', `Installed ${next.version}`);
  } catch (e) {
    log(`✖ ${e.message}`);
    if (parent) return { status: 'error', message: e.message.split('\n')[0] };
    return finish(r, 'error', e.message.split('\n')[0]);
  }
}

export const rollback = (name, opts) => promote(name, { ...opts, target: 'previous' });

/** Keeps only the images in use (current, previous, candidate) and removes the other ones of this recipe */
async function cleanup(name, log) {
  const s = loadState()[name] ?? {};
  const keep = new Set([s.current?.image, s.previous?.image, s.candidate?.image].filter(Boolean));
  const list = (await docker(['images', `leanling/${name}`, '--format', '{{.Repository}}:{{.Tag}}|{{.Size}}'])).out.trim().split('\n').filter(Boolean);
  const removed = [];
  for (const line of list) {
    const [ref, size] = line.split('|');
    if (keep.has(ref)) continue;
    const d = await docker(['rmi', ref]);
    if (d.code === 0) removed.push(`${ref} (${size})`);
  }
  log(removed.length ? `removed: ${removed.join(', ')}` : 'nothing to remove');
  return removed;
}

export async function clean(name, { echo = false, buildCache = false } = {}) {
  const r = newRun(name, 'clean');
  const log = logger(r, echo);
  try {
    const removed = await step(r, log, 'Old images', async () => {
      const x = await cleanup(name, log);
      return { status: 'ok', detail: x.length ? `${x.length} removed` : 'nothing to remove', x };
    });
    await step(r, log, 'Leftover test containers', async () => {
      const ids = (await docker(['ps', '-aq', '--filter', 'label=leanling.test=1'])).out.trim().split('\n').filter(Boolean);
      if (ids.length) await docker(['rm', '-f', ...ids]);
      return { status: 'ok', detail: `${ids.length} removed` };
    });
    if (buildCache) {
      await step(r, log, 'Docker build cache', async () => {
        const p = await docker(['builder', 'prune', '-f']);
        return { status: 'ok', detail: p.out.trim().split('\n').pop() };
      });
    }
    return finish(r, 'ok', `Cleanup done${removed.x?.length ? `: ${removed.x.length} images removed` : ''}`);
  } catch (e) {
    return finish(r, 'error', e.message);
  }
}

async function publish(image, target, version, log) {
  for (const t of [`${target}:${safeTag(version)}`, `${target}:latest`]) {
    await docker(['tag', image, t]);
    const p = await docker(['push', t]);
    log(p.code === 0 ? `published ${t}` : `publishing ${t} failed: ${p.err.trim()}`);
  }
}

/* ------------------------------------------------------------------ utilities */

const safeTag = (v) => String(v).replace(/[^\w.-]/g, '-').slice(0, 120);

const vnum = (v) => (String(v).match(/\d+/g) ?? []).map(Number);
const vcmp = (a, b) => {
  const x = vnum(a);
  const y = vnum(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) - (y[i] ?? 0);
  return 0;
};

/** GitHub release notes between the version in use (excluded) and the new one (included) */
async function releaseNotes(upstream, from, to) {
  const repo = upstream.replace(/^https:\/\/github\.com\//, '').replace(/\/$/, '');
  try {
    const res = await fetch(`https://api.github.com/repos/${repo}/releases?per_page=40`, { headers: { accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(20_000) });
    if (!res.ok) return '';
    const list = await res.json();
    return list
      .filter((x) => !x.prerelease && vcmp(x.tag_name, to) <= 0 && (!from || vcmp(x.tag_name, from) > 0))
      .slice(0, 15)
      .map((x) => `## ${x.tag_name}\n${(x.body ?? '').slice(0, 6000)}`)
      .join('\n\n');
  } catch {
    return '';
  }
}

// Runs saved by earlier versions used Italian status and kind codes: read them as the current ones
const LEGACY = {
  status: { 'in corso': 'running', errore: 'error', pronto: 'ready', avviso: 'warning', saltato: 'skipped', bloccante: 'blocking' },
  kind: { aggiorna: 'update', installa: 'install', ripristina: 'rollback', pulisci: 'clean', aggiungi: 'add' },
};
function modernize(x) {
  const status = (v) => LEGACY.status[v] ?? v;
  return {
    ...x,
    kind: LEGACY.kind[x.kind] ?? x.kind,
    status: status(x.status),
    ...(x.steps ? { steps: x.steps.map((s) => ({ ...s, status: status(s.status) })) } : {}),
    ...(x.report?.scans ? { report: { ...x.report, scans: x.report.scans.map((s) => ({ ...s, status: status(s.status) })) } } : {}),
  };
}

export function recentRuns(limit = 30) {
  const dir = join(HOME, 'runs');
  return run('ls', ['-1t', dir]).then(({ out }) =>
    out.split('\n').filter((f) => f.endsWith('.json')).slice(0, limit).map((f) => {
      const x = modernize(JSON.parse(readFileSync(join(dir, f), 'utf8')));
      return { id: x.id, recipe: x.recipe, kind: x.kind, status: x.status, message: x.message, startedAt: x.startedAt, endedAt: x.endedAt };
    }),
  );
}

export function getRun(id) {
  for (const r of active.values()) if (r.id === id) return r;
  const file = join(HOME, 'runs', `${id.replace(/[^\w-]/g, '')}.json`);
  return existsSync(file) ? modernize(JSON.parse(readFileSync(file, 'utf8'))) : null;
}
