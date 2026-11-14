// Ricette: quelle incluse in recipes/ piu' quelle dell'utente in ~/.leanling/recipes.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HOME } from './config.js';

const BUILTIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'recipes');
export const NAME = /^[a-z0-9][a-z0-9-]*$/;
export const USER = join(HOME, 'recipes');

export function listRecipes() {
  const out = new Map();
  for (const base of [BUILTIN, USER]) {
    if (!existsSync(base)) continue;
    for (const name of readdirSync(base)) {
      const file = join(base, name, 'recipe.json');
      if (!NAME.test(name) || !existsSync(file)) continue;
      const recipe = JSON.parse(readFileSync(file, 'utf8'));
      out.set(name, { ...recipe, name, dir: join(base, name), user: base === USER });
    }
  }
  return [...out.values()];
}

export function getRecipe(name) {
  const r = listRecipes().find((x) => x.name === name);
  if (!r) throw new Error(`Ricetta sconosciuta: ${name}`);
  return r;
}

/** Opzioni della ricetta + quelle aggiunte dall'utente, con la scelta attuale (true = togli) */
export function resolveOptions(recipe, settings) {
  return [...(recipe.options ?? []), ...settings.extraOptions].map((o) => ({
    ...o,
    remove: settings.choices[o.id] ?? o.default ?? false,
  }));
}

/** Patch attive: una patch corretta dall'agente (in ~/.leanling/patches) ha la precedenza su quella della ricetta */
export function resolvePatches(recipe, settings) {
  return (recipe.patches ?? [])
    .map((p) => {
      const override = join(HOME, 'patches', recipe.name, p.file);
      return { ...p, path: existsSync(override) ? override : join(recipe.dir, 'patches', p.file), overridden: existsSync(override), enabled: settings.choices[`patch:${p.file}`] ?? p.default ?? true };
    });
}

/**
 * Variabili d'ambiente del figlio: base del contenitore + opzioni scelte.
 * Le voci `list` si uniscono con la virgola; `available` (se noto) scarta i nomi che la versione non ha piu',
 * cosi' un modulo rimosso dagli autori non impedisce l'avvio.
 */
export function buildEnv(recipe, settings, available) {
  const env = { ...(recipe.container?.env ?? {}), ...(settings.container.env ?? {}) };
  const lists = {};
  for (const o of resolveOptions(recipe, settings)) {
    if (!o.remove) continue;
    Object.assign(env, o.env ?? {});
    for (const [k, v] of Object.entries(o.list ?? {})) {
      if (available && k === recipe.discover?.listEnv && !available.includes(v)) continue;
      (lists[k] ??= []).push(v);
    }
  }
  for (const [k, v] of Object.entries(lists)) env[k] = [...new Set(v)].join(',');
  return env;
}

export function containerSpec(recipe, settings) {
  return { ...recipe.container, ...Object.fromEntries(Object.entries(settings.container).filter(([k]) => k !== 'env')) };
}

/** Reti del container: `networks` (una o piu', "rete" oppure "rete:alias1,alias2") piu' la vecchia voce singola `network` */
export function parseNetworks(spec) {
  const seen = new Set();
  return [...(spec.networks ?? []), ...(spec.network ? [spec.network] : [])]
    .map((n) => String(n).trim())
    .filter(Boolean)
    .map((n) => {
      const [name, aliases = ''] = n.split(':');
      return { name: name.trim(), aliases: aliases.split(',').map((a) => a.trim()).filter(Boolean) };
    })
    .filter((n) => n.name && !seen.has(n.name) && seen.add(n.name));
}

/** Volumi con nome ("dati:/percorso"); i percorsi della macchina ("/srv/x:/percorso") restano fuori */
export function namedVolumes(spec) {
  return (spec.volumes ?? [])
    .map((v) => String(v).split(':'))
    .filter(([src, dest]) => src && dest && !/^[./~]/.test(src))
    .map(([src, ...rest]) => ({ src, dest: rest.join(':') }));
}

/** Argomenti di `docker create/run` che non dipendono dalla rete: porte, volumi, variabili, etichette, limiti */
export function containerArgs(spec, env, labels = {}, { ports = true, volumes = true, hosts = true } = {}) {
  const args = [];
  if (ports) for (const p of spec.ports ?? []) args.push('-p', p);
  if (volumes) for (const v of spec.volumes ?? []) args.push('-v', v);
  for (const [k, v] of Object.entries(env)) args.push('-e', `${k}=${v}`);
  for (const [k, v] of Object.entries(labels)) args.push('--label', `${k}=${v}`);
  if (spec.memory) args.push('--memory', String(spec.memory));
  if (spec.cpus) args.push('--cpus', String(spec.cpus));
  if (hosts) for (const h of spec.extraHosts ?? []) args.push('--add-host', h);
  return args;
}

/** Salva una ricetta dell'utente in ~/.leanling/recipes/<nome> */
export function writeRecipe(recipe) {
  const dir = join(USER, recipe.name);
  mkdirSync(join(dir, 'patches'), { recursive: true });
  const { dir: _d, user: _u, ...data } = recipe;
  writeFileSync(join(dir, 'recipe.json'), JSON.stringify(data, null, 2));
  return dir;
}

/** Toglie una ricetta dell'utente (quelle incluse in Leanling non si cancellano) */
export function removeRecipe(name) {
  const r = getRecipe(name);
  if (!r.user) throw new Error('Le ricette incluse in Leanling non si possono togliere');
  rmSync(r.dir, { recursive: true, force: true });
}
