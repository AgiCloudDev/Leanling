// "Add app": from a git URL or a Docker image to a recipe ready to be reviewed.
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { agentStatus, askAgent } from './agent.js';
import { HOME, languageName, loadConfig } from './config.js';
import { finish, logger, newRun, step } from './pipeline.js';
import { listRecipes, NAME, writeRecipe } from './recipes.js';
import { run } from './sh.js';

export const isGit = (src) => /^(https?:\/\/|git@)/.test(src) || src.endsWith('.git');

/** Recipe name from the URL or the image: last segment, lowercase, without the tag */
export function nameFrom(src) {
  const last = src.replace(/\.git$/, '').replace(/\/+$/, '').split(/[/:]/).filter(Boolean);
  const base = isGit(src) ? last.at(-1) : src.replace(/[:@][^/]*$/, '').split('/').at(-1);
  return (base ?? 'app').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '') || 'app';
}

/** Port, health-check path and volumes read from a Dockerfile */
export function parseDockerfile(text) {
  const port = Number(text.match(/^\s*EXPOSE\s+(\d+)/im)?.[1]) || null;
  const hc = text.match(/^\s*HEALTHCHECK[\s\S]*?(?:\n(?!\s)|$)/im)?.[0] ?? '';
  const path = hc.match(/https?:\/\/[^/\s"'$]+(?::\d+)?(\/[^\s"'\\)]*)/)?.[1] ?? null;
  const volumes = [...text.matchAll(/^\s*VOLUME\s+(.+)$/gim)].flatMap((m) => m[1].replace(/[[\]",]/g, ' ').split(/\s+/).filter(Boolean));
  return { port, path, volumes };
}

const guessLicense = (dir) => {
  const f = readdirSync(dir).find((x) => /^licen[sc]e(\.md|\.txt)?$/i.test(x));
  if (!f) return 'Licence not found: check it before using the app';
  const t = readFileSync(join(dir, f), 'utf8').slice(0, 3000);
  for (const [re, name] of [[/Sustainable Use License/i, 'Sustainable Use License (internal or non-commercial use)'], [/GNU AFFERO/i, 'AGPL-3.0'], [/GNU GENERAL PUBLIC LICENSE/i, 'GPL'], [/GNU LESSER/i, 'LGPL'], [/Apache License/i, 'Apache-2.0'], [/MIT License|Permission is hereby granted, free of charge/i, 'MIT'], [/Business Source License/i, 'Business Source License (non open source)'], [/Elastic License/i, 'Elastic License (non open source)'], [/BSD/i, 'BSD']]) {
    if (re.test(t)) return name;
  }
  return `Licence in ${f}: read it before using the app`;
};

const MANIFESTS = ['requirements.txt', 'package.json', 'package-lock.json'];

/**
 * Creates the recipe and, when an agent is available, has it propose options and patches.
 * The recipe goes into ~/.leanling/recipes: nothing personal ends up in the Leanling repository.
 */
export async function addRecipe(src, { name, analyze = true, echo = false } = {}) {
  src = src.trim();
  name = (name || nameFrom(src)).toLowerCase();
  if (!NAME.test(name)) throw new Error(`Invalid name: ${name} (lowercase letters, numbers and hyphens)`);
  if (listRecipes().some((r) => r.name === name)) throw new Error(`A recipe named "${name}" already exists: pick another name`);

  const r = newRun(name, 'add');
  const log = logger(r, echo);
  const work = join(HOME, 'work', name, 'analysis');
  try {
    const cfg = loadConfig();
    let recipe;
    let srcDir = null; // source for the agent to read

    if (isGit(src)) {
      recipe = await step(r, log, 'Downloading the project', async () => {
        rmSync(work, { recursive: true, force: true });
        const c = await run('git', ['clone', '--depth', '1', src, work]);
        if (c.code !== 0) throw new Error(c.err.trim());
        const ref = (await run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: work })).out.trim() || 'main';
        const dockerfile = ['Dockerfile', 'docker/Dockerfile', 'Dockerfile.prod', 'deploy/Dockerfile', 'build/Dockerfile'].find((f) => existsSync(join(work, f)));
        if (!dockerfile) throw new Error('The project has no Dockerfile. For now Leanling only builds projects with a Dockerfile: if an official image exists, add that instead.');
        const d = parseDockerfile(readFileSync(join(work, dockerfile), 'utf8'));
        srcDir = work;
        return {
          status: d.port ? 'ok' : 'warning',
          detail: `branch ${ref}, ${dockerfile}${d.port ? `, port ${d.port}` : ', no declared port (EXPOSE): set it yourself'}`,
          recipe: {
            name, title: name, type: 'build', repo: src, ref, upstream: src.replace(/\.git$/, ''), dockerfile,
            license: guessLicense(work),
            manifests: MANIFESTS.filter((m) => existsSync(join(work, m))),
            ...baseParts(name, d),
          },
        };
      }).then((x) => x.recipe);
    } else {
      recipe = await step(r, log, 'Pulling the image', async () => {
        const ref = src.includes(':') && !src.endsWith(':') ? src : `${src}:latest`;
        const p = await run('docker', ['pull', '-q', ref]);
        if (p.code !== 0) throw new Error(p.err.trim());
        const info = JSON.parse((await run('docker', ['image', 'inspect', ref])).out)[0].Config;
        const port = Number(Object.keys(info.ExposedPorts ?? {})[0]?.split('/')[0]) || null;
        const hc = (info.Healthcheck?.Test ?? []).join(' ');
        const path = hc.match(/https?:\/\/[^/\s"']+(?::\d+)?(\/[^\s"'\\)]*)/)?.[1] ?? null;
        const labels = info.Labels ?? {};
        const upstream = labels['org.opencontainers.image.source'] ?? '';
        const [image, tag] = [ref.slice(0, ref.lastIndexOf(':')), ref.slice(ref.lastIndexOf(':') + 1)];
        return {
          status: port ? 'ok' : 'warning',
          detail: `${ref}${port ? `, port ${port}` : ', no declared port: set it yourself'}`,
          recipe: {
            name, title: labels['org.opencontainers.image.title'] || name, type: 'image', image, tag, upstream,
            license: labels['org.opencontainers.image.licenses'] || 'Licence not declared in the image: check it',
            ...baseParts(name, { port, path, volumes: Object.keys(info.Volumes ?? {}) }),
          },
        };
      }).then((x) => x.recipe);

      // The analysis needs the source: if the image says where it comes from, download it
      if (analyze && /^https:\/\/github\.com\//.test(recipe.upstream)) {
        rmSync(work, { recursive: true, force: true });
        const c = await run('git', ['clone', '--depth', '1', recipe.upstream, work]);
        if (c.code === 0) srcDir = work;
      }
    }

    writeRecipe(recipe);
    log(`base recipe saved in ${join(HOME, 'recipes', name)}`);

    if (analyze && agentStatus(cfg).ready && srcDir) {
      await step(r, log, 'Agent analysis', async () => {
        const proposal = await analyzeWithAgent(cfg, recipe, srcDir, log);
        const notes = [];
        recipe.description = proposal.description || recipe.description;
        recipe.title = proposal.title || recipe.title;
        recipe.notes = proposal.notes ?? '';
        recipe.options = cleanOptions(proposal.options, notes);
        if (recipe.type === 'build') recipe.patches = await savePatches(recipe, proposal.patches ?? [], srcDir, notes);
        if (proposal.test?.path && typeof proposal.test.path === 'string' && proposal.test.path.startsWith('/')) recipe.test.checks = [{ method: 'GET', path: proposal.test.path, ok: true }];
        if (Number(proposal.test?.port)) recipe.test.port = Number(proposal.test.port);
        if (notes.length) recipe.notes = [recipe.notes, ...notes].filter(Boolean).join('\n');
        writeRecipe(recipe);
        return { status: notes.length ? 'warning' : 'ok', detail: `${recipe.options.length} options, ${recipe.patches?.length ?? 0} patches proposed${notes.length ? `; ${notes.length} discarded` : ''}` };
      });
    } else if (analyze) {
      r.steps.push({ name: 'Agent analysis', status: 'skipped', detail: agentStatus(cfg).ready ? 'source not available' : agentStatus(cfg).reason });
    }
    return finish(r, 'ok', `Recipe "${name}" created: check Choices and Container, then prepare the child`);
  } catch (e) {
    log(`✖ ${e.message}`);
    return finish(r, 'error', e.message.split('\n')[0]);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

function baseParts(name, { port, path, volumes }) {
  return {
    description: 'Recipe created by Leanling: review the options before preparing the child.',
    test: { port: port ?? 80, startTimeout: 180, checks: [{ method: 'GET', path: path ?? '/', ok: true }] },
    container: {
      name,
      // Low ports (80, 443…) usually belong to the proxy already: a high one is proposed on the host
      ports: port ? [`127.0.0.1:${port < 1024 ? 8000 + port : port}:${port}`] : [],
      volumes: (volumes ?? []).map((v, i) => `${name}-data${i || ''}:${v}`),
      env: {},
    },
    options: [],
    patches: [],
  };
}

async function analyzeWithAgent(cfg, recipe, dir, log) {
  const language = languageName(cfg);
  const prompt = `You are preparing a Leanling "recipe" for ${recipe.title} (${recipe.upstream || recipe.image}), self-hosted by a single person or a freelancer, without paid licences. The source is in the current folder: read it, do not run anything.

Goal: a lean child, with only what works in free self-hosting, that can be updated without losing the changes.

Rules:
- Options must use ONLY official switches of the app (environment variables that are documented or read by the code). Give the exact variable for each one.
- Turn off (default true) telemetry, features that need a paid licence or a cloud service of the vendor, promotional banners. Leave on (default false) the useful free features.
- NEVER propose to unlock paid features, remove licence checks, change licence or copyright files, or touch code under a commercial licence ("ee", "enterprise", "premium" folders or files).
- Patches are only for the Dockerfile or the build scripts, and only when they bring a clear benefit (lighter image, duplicated layers, permissions). Every patch is a unified diff that applies with "git apply" from the project root. If no patch is needed, empty list.
- If you find no official switches, empty list: nothing is better than invented options.

Write every text meant for the user (description, labels, notes) in ${language}. Keep the option groups exactly as named below.

Reply with ONE SINGLE \`\`\`json block, shaped like this:
{
  "title": "readable name",
  "description": "one sentence: what the app does and what the child removes",
  "test": { "port": 1234, "path": "/health-path" },
  "options": [
    { "id": "short-id", "group": "Telemetry | Paid features | Optional features | Resources", "label": "short text", "default": true, "env": { "VARIABLE": "value" } }
  ],
  "patches": [
    { "file": "01-name.patch", "label": "what it does", "intent": "purpose in plain words, needed to redo it if the file changes", "diff": "diff --git a/Dockerfile b/Dockerfile\\n..." }
  ],
  "notes": "what the user must know: licence, limits, what you left out and why"
}
For variables that are comma-separated lists use "list": { "VARIABLE": "item" } instead of "env".`;
  const text = await askAgent(cfg, prompt, { cwd: dir, log });
  const block = [...text.matchAll(/```json\s*([\s\S]*?)```/g)].pop()?.[1] ?? text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1);
  try {
    return JSON.parse(block);
  } catch {
    throw new Error('The agent did not return valid JSON: try again or write the recipe by hand');
  }
}

/** Keeps only well-formed options: simple id, string values */
export function cleanOptions(list, notes) {
  const out = [];
  for (const o of Array.isArray(list) ? list : []) {
    const strMap = (m) => m && typeof m === 'object' && !Array.isArray(m) && Object.entries(m).every(([k, v]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(k) && typeof v === 'string');
    if (!o || !/^[\w.-]{1,60}$/.test(o.id ?? '') || !(strMap(o.env) || strMap(o.list)) || out.some((x) => x.id === o.id)) {
      notes.push(`option discarded: ${JSON.stringify(o).slice(0, 120)}`);
      continue;
    }
    out.push({ id: o.id, group: String(o.group ?? 'Other').slice(0, 60), label: String(o.label ?? o.id).slice(0, 120), default: o.default === true, ...(strMap(o.env) ? { env: o.env } : {}), ...(strMap(o.list) ? { list: o.list } : {}) });
  }
  return out;
}

/** Saves the proposed patches only if they really apply to the downloaded source */
async function savePatches(recipe, list, dir, notes) {
  const kept = [];
  for (const p of Array.isArray(list) ? list : []) {
    const file = /^[\w.-]+\.patch$/.test(p?.file ?? '') ? p.file : `${String(kept.length + 1).padStart(2, '0')}-proposed.patch`;
    if (typeof p?.diff !== 'string' || !p.diff.includes('@@')) {
      notes.push(`patch discarded (diff missing): ${p?.label ?? file}`);
      continue;
    }
    const path = join(HOME, 'recipes', recipe.name, 'patches', file);
    writeFileSync(path, p.diff.endsWith('\n') ? p.diff : `${p.diff}\n`);
    const check = await run('git', ['apply', '--check', path], { cwd: dir });
    if (check.code !== 0) {
      rmSync(path);
      notes.push(`patch discarded because it does not apply: ${p.label ?? file}`);
      continue;
    }
    kept.push({ file, label: String(p.label ?? file).slice(0, 120), intent: String(p.intent ?? p.label ?? ''), default: false });
  }
  return kept;
}
