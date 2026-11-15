// Dashboard: JSON API + static page. Listens on 127.0.0.1 only; with LEANLING_TOKEN it also requires a token.
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { timingSafeEqual } from 'node:crypto';
import { addRecipe } from './add.js';
import { agentStatus } from './agent.js';
import { isLanguage, loadConfig, loadState, publicConfig, recipeSettings, saveConfig } from './config.js';
import { clean, events, getRun, promote, recentRuns, rollback, runningId, update } from './pipeline.js';
import { buildEnv, containerSpec, getRecipe, listRecipes, removeRecipe, resolveOptions, resolvePatches } from './recipes.js';
import { scannerStatus } from './scan.js';

const PUBLIC = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json' };

const json = (res, code, data) => res.writeHead(code, { 'content-type': 'application/json' }).end(JSON.stringify(data));

async function body(req) {
  let s = '';
  for await (const c of req) {
    s += c;
    if (s.length > 1e6) throw new Error('Request too large');
  }
  return s ? JSON.parse(s) : {};
}

function recipeView(r, cfg, state) {
  const settings = recipeSettings(cfg, r.name);
  return {
    name: r.name, title: r.title, description: r.description, type: r.type, license: r.license, upstream: r.upstream,
    image: r.image, repo: r.repo, user: !!r.user, notes: r.notes ?? '',
    options: resolveOptions(r, settings),
    patches: resolvePatches(r, settings).map(({ path, ...p }) => p),
    container: containerSpec(r, settings),
    containerEnv: settings.container.env ?? {},
    deploy: settings.deploy, adopt: !!settings.adopt, replaces: settings.replaces ?? '', dataTest: settings.dataTest !== false, publishAs: settings.publishAs,
    env: buildEnv(r, settings, null),
    state: state[r.name] ?? {},
    running: runningId(r.name),
  };
}

function authorized(req) {
  const token = process.env.LEANLING_TOKEN;
  if (!token) return true;
  const given = Buffer.from(req.headers['x-leanling-token'] ?? new URL(req.url, 'http://x').searchParams.get('token') ?? '');
  const want = Buffer.from(token);
  return given.length === want.length && timingSafeEqual(given, want);
}

export function startServer({ port = 7878, host = '127.0.0.1' } = {}) {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;
    try {
      if (!p.startsWith('/api/')) {
        const file = p === '/' ? 'index.html' : p.slice(1);
        if (!/^[\w.-]+$/.test(file)) return res.writeHead(404).end();
        try {
          return res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'text/plain', 'cache-control': 'no-cache' }).end(readFileSync(join(PUBLIC, file)));
        } catch {
          return res.writeHead(404).end();
        }
      }
      if (!authorized(req)) return json(res, 401, { error: 'Missing or wrong token' });

      // Actions start in the background: progress comes from /api/events
      const cfg = loadConfig();
      // The interface says which language it is shown in: the agent writes its reviews in that language
      const lang = req.headers['x-leanling-lang'];
      if (req.method === 'POST' && isLanguage(lang) && lang !== cfg.language) {
        cfg.language = lang;
        saveConfig(cfg);
      }
      if (req.method === 'GET' && p === '/api/overview') {
        const state = loadState();
        return json(res, 200, {
          recipes: listRecipes().map((r) => recipeView(r, cfg, state)),
          config: publicConfig(cfg),
          agent: agentStatus(cfg),
          scanners: scannerStatus(cfg),
          runs: await recentRuns(),
        });
      }
      if (req.method === 'GET' && p.startsWith('/api/runs/')) {
        const r = getRun(p.split('/').pop());
        return r ? json(res, 200, r) : json(res, 404, { error: 'Not found' });
      }
      if (req.method === 'GET' && p === '/api/events') {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
        const send = (type) => (data) => res.write(`event: ${type}\ndata: ${JSON.stringify(type === 'run' ? { ...data, log: undefined } : data)}\n\n`);
        const onRun = send('run');
        const onLog = send('log');
        events.on('run', onRun);
        events.on('log', onLog);
        const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
        req.on('close', () => {
          clearInterval(ping);
          events.off('run', onRun);
          events.off('log', onLog);
        });
        return;
      }
      if (req.method === 'POST' && p === '/api/settings') {
        const b = await body(req);
        const next = { ...cfg, agent: { ...cfg.agent, ...b.agent }, scanners: { ...cfg.scanners, ...b.scanners } };
        // The masked key coming back from the page does not overwrite the real one
        if (b.agent?.apiKey?.startsWith('••••')) next.agent.apiKey = cfg.agent.apiKey;
        if (b.keepVersions !== undefined) next.keepVersions = Math.max(1, Number(b.keepVersions) || 2);
        saveConfig(next);
        return json(res, 200, { ok: true });
      }
      if (req.method === 'POST' && p === '/api/recipes') {
        const b = await body(req);
        if (!b.source?.trim()) return json(res, 400, { error: 'Project or image address missing' });
        const { nameFrom } = await import('./add.js');
        const name = (b.name?.trim() || nameFrom(b.source.trim())).toLowerCase();
        if (listRecipes().some((r) => r.name === name)) return json(res, 409, { error: `A recipe named "${name}" already exists: pick another name` });
        addRecipe(b.source, { name, analyze: b.analyze !== false }).catch((e) => console.error(e));
        await new Promise((r) => setImmediate(r));
        return json(res, 202, { name, id: runningId(name) });
      }
      const m = p.match(/^\/api\/recipes\/([a-z0-9-]+)\/(settings|update|install|rollback|clean|remove)$/);
      if (req.method === 'POST' && m) {
        const [, name, action] = m;
        getRecipe(name);
        const b = await body(req);
        if (action === 'settings') {
          const cur = recipeSettings(cfg, name);
          cfg.recipes[name] = {
            ...cur,
            choices: { ...cur.choices, ...(b.choices ?? {}) },
            container: b.container ? { ...b.container } : cur.container,
            extraOptions: b.extraOptions ?? cur.extraOptions,
            deploy: b.deploy ?? cur.deploy,
            adopt: b.adopt ?? cur.adopt,
            replaces: b.replaces ?? cur.replaces,
            dataTest: b.dataTest ?? cur.dataTest,
            publishAs: b.publishAs ?? cur.publishAs,
          };
          saveConfig(cfg);
          return json(res, 200, { ok: true });
        }
        if (action === 'remove') {
          if (runningId(name)) return json(res, 409, { error: 'A job is in progress' });
          removeRecipe(name);
          return json(res, 200, { ok: true });
        }
        if (runningId(name)) return json(res, 409, { error: 'A job is already in progress' });
        const task =
          action === 'update' ? update(name, { force: !!b.force, deploy: !!b.deploy })
          : action === 'install' ? promote(name)
          : action === 'rollback' ? rollback(name)
          : clean(name, { buildCache: !!b.buildCache });
        task.catch((e) => console.error(e));
        await new Promise((r) => setImmediate(r));
        return json(res, 202, { id: runningId(name) });
      }
      return json(res, 404, { error: 'Not found' });
    } catch (e) {
      return json(res, 400, { error: e.message });
    }
  });
  server.listen(port, host, () => console.log(`Leanling: dashboard on http://${host}:${port}`));
  return server;
}
