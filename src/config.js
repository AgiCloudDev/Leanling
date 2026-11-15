// Leanling settings and state, all in ~/.leanling (or $LEANLING_HOME).
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const HOME = process.env.LEANLING_HOME ?? join(homedir(), '.leanling');
for (const d of ['', 'work', 'runs', 'patches']) mkdirSync(join(HOME, d), { recursive: true, mode: 0o700 });

const DEFAULTS = {
  agent: {
    type: 'none', // none | claude | opencode
    auth: 'subscription', // subscription | api (Claude Code only)
    apiKey: '',
    model: '',
    review: true, // the agent reads what changed before installing
    fixPatches: true, // the agent redoes patches that no longer apply
  },
  scanners: { osv: true, guarddog: true, gitleaks: true, clamav: false },
  keepVersions: 2, // version in use + previous one
  language: 'en', // language the agent writes in (reviews, recipe texts): follows the dashboard language
  recipes: {},
};

function readJson(file, fallback) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

// Atomic write: never a half-written file if the process stops
function writeJson(file, data, mode = 0o600) {
  writeFileSync(`${file}.tmp`, JSON.stringify(data, null, 2), { mode });
  renameSync(`${file}.tmp`, file);
}

const merge = (base, over) => {
  const out = { ...base };
  for (const [k, v] of Object.entries(over ?? {})) {
    out[k] = v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object' ? merge(base[k], v) : v;
  }
  return out;
};

const CONFIG = join(HOME, 'config.json');
const STATE = join(HOME, 'state.json');

export const loadConfig = () => merge(DEFAULTS, readJson(CONFIG, {}));
export const saveConfig = (cfg) => writeJson(CONFIG, cfg);
export const loadState = () => readJson(STATE, {});
export const saveState = (state) => writeJson(STATE, state);

/** User settings for a recipe: choices, container, what to publish */
export function recipeSettings(cfg, name) {
  return merge({ choices: {}, container: {}, extraOptions: [], publishAs: '', deploy: false }, cfg.recipes[name]);
}

/** Configuration without secrets, to show in the dashboard */
export function publicConfig(cfg) {
  return { ...cfg, agent: { ...cfg.agent, apiKey: cfg.agent.apiKey ? '••••' + cfg.agent.apiKey.slice(-4) : '' } };
}

export const exists = existsSync;

/** Interface languages; the agent is asked to write in the one the user picked */
export const LANGUAGES = { en: 'English', it: 'Italian', de: 'German', cs: 'Czech', ru: 'Russian' };
export const isLanguage = (v) => typeof v === 'string' && Object.hasOwn(LANGUAGES, v);
export const languageName = (cfg) => LANGUAGES[cfg.language] ?? LANGUAGES.en;
