// The agent (Claude Code or OpenCode) steps in only when needed: reading what changed and redoing patches.
import { has, run } from './sh.js';

export function agentStatus(cfg) {
  const a = cfg.agent;
  if (a.type === 'none') return { ready: false, reason: 'No agent selected' };
  const bin = a.type === 'claude' ? 'claude' : 'opencode';
  if (!has(bin)) return { ready: false, reason: `${bin} is not installed` };
  if (a.type === 'claude' && a.auth === 'api' && !a.apiKey) return { ready: false, reason: 'API key missing' };
  return { ready: true, reason: a.type === 'claude' ? `Claude Code (${a.auth === 'api' ? 'API key' : 'subscription'})` : 'OpenCode' };
}

/** mode: 'read' (read-only) or 'edit' (may change files in cwd) */
export async function askAgent(cfg, prompt, { cwd, mode = 'read', log }) {
  const a = cfg.agent;
  const status = agentStatus(cfg);
  if (!status.ready) throw new Error(status.reason);

  if (a.type === 'claude') {
    const tools = mode === 'edit' ? 'Read,Grep,Glob,Edit,Write' : 'Read,Grep,Glob';
    const args = ['-p', prompt, '--allowedTools', tools, '--output-format', 'text'];
    if (a.model) args.push('--model', a.model);
    const env = { ...process.env };
    // With a subscription, a key in the environment would silently switch to pay-as-you-go billing
    if (a.auth === 'api') env.ANTHROPIC_API_KEY = a.apiKey;
    else delete env.ANTHROPIC_API_KEY;
    const r = await runClean('claude', args, { cwd, env, log });
    return r;
  }
  const args = ['run'];
  if (a.model) args.push('--model', a.model);
  args.push(prompt);
  return runClean('opencode', args, { cwd, log });
}

async function runClean(cmd, args, { cwd, env, log }) {
  log?.(`agent: ${cmd} working…`);
  const r = await run(cmd, args, { cwd, env: env ?? {}, timeout: 900 });
  if (r.code !== 0) throw new Error(`The agent returned an error: ${(r.err || r.out).slice(-400)}`);
  return r.out.trim();
}

/** Last "VERDICT: OK|SUSPICIOUS ..." line of the review */
export function parseVerdict(text) {
  const m = [...text.matchAll(/VERDICT:\s*(OK|SUSPICIOUS)\b[^\n]*/gi)].pop();
  if (!m) return { ok: false, line: 'No clear verdict from the agent: a manual check is needed' };
  return { ok: m[1].toUpperCase() === 'OK', line: m[0] };
}
