#!/usr/bin/env node
import { loadConfig, loadState, saveConfig } from '../src/config.js';
import { addRecipe } from '../src/add.js';
import { agentStatus } from '../src/agent.js';
import { clean, promote, rollback, update } from '../src/pipeline.js';
import { listRecipes, removeRecipe } from '../src/recipes.js';
import { scannerStatus } from '../src/scan.js';
import { startServer } from '../src/server.js';

const HELP = `Leanling: lean children of self-hosted apps

  leanling list                      available recipes and version in use
  leanling add <git-url|image>       create a new recipe (--name name, --no-agent)
  leanling remove <recipe>           remove a recipe you created
  leanling update <recipe>           prepare and test the child of the new version
        --force                      redo it even if the version has not changed
        --deploy                     if the tests pass, install it right away
  leanling install <recipe>          install the ready child
  leanling rollback <recipe>         go back to the previous version
  leanling clean <recipe>            remove old images (--build-cache: Docker build cache too)
  leanling doctor                    available agent and scanners
  leanling agent <none|claude|opencode> [--api]   pick the agent (--api: Claude Code with an API key)
  leanling dashboard [--port 7878]   open the dashboard on 127.0.0.1
`;

const [cmd, name, ...rest] = process.argv.slice(2);
const flag = (f) => rest.includes(f) || name === f;
const exitWith = (r) => process.exit(r.status === 'error' ? 1 : 0);

switch (cmd) {
  case 'list': {
    const state = loadState();
    for (const r of listRecipes()) {
      const s = state[r.name] ?? {};
      console.log(`${r.name.padEnd(14)} ${(s.current?.version ?? '-').padEnd(12)} ${s.candidate ? `ready: ${s.candidate.version}` : ''}`);
    }
    break;
  }
  case 'add': {
    const i = rest.indexOf('--name');
    exitWith(await addRecipe(need(name), { name: i >= 0 ? rest[i + 1] : undefined, analyze: !flag('--no-agent'), echo: true }));
    break;
  }
  case 'remove':
    removeRecipe(need(name));
    console.log(`Recipe ${name} removed (images stay: run leanling clean before removing it if you want to free space)`);
    break;
  case 'update':
    exitWith(await update(need(name), { force: flag('--force'), deploy: flag('--deploy'), echo: true }));
    break;
  case 'install':
    exitWith(await promote(need(name), { echo: true }));
    break;
  case 'rollback':
    exitWith(await rollback(need(name), { echo: true }));
    break;
  case 'clean':
    exitWith(await clean(need(name), { echo: true, buildCache: flag('--build-cache') }));
    break;
  case 'doctor': {
    const cfg = loadConfig();
    const a = agentStatus(cfg);
    console.log(`agent: ${a.ready ? 'ready' : 'not active'} (${a.reason})`);
    for (const [id, s] of Object.entries(scannerStatus(cfg))) {
      console.log(`${id.padEnd(9)} ${s.installed ? 'installed' : 'missing  '} ${s.enabled ? 'on ' : 'off'}  ${s.what}${s.installed ? '' : `  → ${s.install}`}`);
    }
    break;
  }
  case 'agent': {
    if (!['none', 'claude', 'opencode'].includes(name)) die('Agent: none, claude or opencode');
    const cfg = loadConfig();
    cfg.agent.type = name;
    cfg.agent.auth = flag('--api') ? 'api' : 'subscription';
    if (cfg.agent.auth === 'api' && process.env.ANTHROPIC_API_KEY) cfg.agent.apiKey = process.env.ANTHROPIC_API_KEY;
    saveConfig(cfg);
    console.log(agentStatus(cfg).reason);
    break;
  }
  case 'dashboard': {
    const i = rest.indexOf('--port');
    const port = Number(i >= 0 ? rest[i + 1] : name === '--port' ? rest[0] : process.env.LEANLING_PORT ?? 7878);
    startServer({ port });
    break;
  }
  default:
    console.log(HELP);
}

function need(n) {
  if (!n || n.startsWith('--')) die('Recipe name missing (leanling list)');
  return n;
}

function die(msg) {
  console.error(msg);
  process.exit(2);
}
