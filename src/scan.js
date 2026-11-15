// Scanners before installing. Every scanner is optional: when it is not installed it is skipped, and reported as such.
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { has, run } from './sh.js';

export const SCANNERS = {
  osv: { bin: 'osv-scanner', label: 'OSV-Scanner', what: 'dependencies with known vulnerabilities', install: 'https://google.github.io/osv-scanner/installation/' },
  guarddog: { bin: 'guarddog', label: 'GuardDog', what: 'malicious npm/PyPI packages', install: 'pipx install guarddog' },
  gitleaks: { bin: 'gitleaks', label: 'Gitleaks', what: 'keys and passwords in the code', install: 'https://github.com/gitleaks/gitleaks#installing' },
  clamav: { bin: 'clamscan', label: 'ClamAV', what: 'malware in the files of the final image', install: 'apt install clamav' },
};

export const scannerStatus = (cfg) =>
  Object.fromEntries(Object.entries(SCANNERS).map(([id, s]) => [id, { ...s, enabled: cfg.scanners[id] !== false, installed: has(s.bin) }]));

/**
 * Scans the downloaded source. `range` = "old..new" for Gitleaks (new commits only).
 * Returns the list of results; status `blocking` = the update must not go on.
 */
export async function scanSource(cfg, { dir, range, manifests = [], log }) {
  const st = scannerStatus(cfg);
  const results = [];
  const skip = (id) => {
    if (!st[id].enabled) return true;
    if (!st[id].installed) {
      results.push({ id, status: 'skipped', detail: `${st[id].bin} is not installed (${st[id].install})` });
      return true;
    }
    return false;
  };

  if (!skip('osv')) {
    log(`scanner: ${SCANNERS.osv.label}`);
    const r = await run('osv-scanner', ['scan', 'source', '-r', dir], { timeout: 600 });
    // 0 = clean, 1 = vulnerabilities found, anything else = scanner error
    results.push({ id: 'osv', status: r.code === 0 ? 'ok' : r.code === 1 ? 'warning' : 'error', detail: tail(r.out || r.err) });
  }

  if (!skip('guarddog')) {
    for (const m of manifests) {
      const file = join(dir, m);
      if (!existsSync(file)) continue;
      const eco = m.endsWith('package.json') || m.endsWith('package-lock.json') ? 'npm' : 'pypi';
      log(`scanner: ${SCANNERS.guarddog.label} on ${m}`);
      const r = await run('guarddog', [eco, 'verify', file], { timeout: 900 });
      const v = guarddogVerdict(r.out);
      results.push({ id: 'guarddog', status: r.code !== 0 ? 'error' : v.status, detail: r.code !== 0 || !v.summary ? [v.summary, tail(r.out || r.err)].filter(Boolean).join('\n') : v.summary });
    }
  }

  if (!skip('gitleaks') && range) {
    log(`scanner: ${SCANNERS.gitleaks.label} on the new commits`);
    const r = await run('gitleaks', ['git', '--no-banner', `--log-opts=${range}`, dir], { timeout: 600 });
    results.push({ id: 'gitleaks', status: r.code === 0 ? 'ok' : r.code === 1 ? 'warning' : 'error', detail: tail(r.out || r.err) });
  }
  return results;
}

/** ClamAV on the files of the final image (exported to a temporary folder, then deleted) */
export async function scanImage(cfg, image, log) {
  const st = scannerStatus(cfg).clamav;
  if (!st.enabled) return [];
  if (!st.installed) return [{ id: 'clamav', status: 'skipped', detail: `clamscan is not installed (${st.install})` }];
  log('scanner: ClamAV on the image');
  const dir = mkdtempSync(join(tmpdir(), 'leanling-img-'));
  try {
    const cid = (await run('docker', ['create', image])).out.trim();
    const tar = join(dir, 'fs.tar');
    await run('docker', ['export', '-o', tar, cid]);
    await run('docker', ['rm', cid]);
    await run('tar', ['-xf', tar, '-C', dir, '--exclude=dev/*']);
    rmSync(tar);
    const r = await run('clamscan', ['-r', '-i', '--no-summary', dir], { timeout: 3600 });
    return [{ id: 'clamav', status: r.code === 0 ? 'ok' : r.code === 1 ? 'blocking' : 'error', detail: tail(r.out || r.err) || 'no infected files' }];
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * GuardDog rules that are enough on their own to stop the update: a name imitating a famous package,
 * a maintainer account at risk, code running at install time, and behaviours a healthy library does
 * not have. The others (reading files, spawning processes, using the network) also fire on torch or
 * pandas, so they only count as a warning.
 */
const GUARDDOG_BLOCKING = /typosquatting|compromised[._-]email[._-]domain|unclaimed[._-]maintainer[._-]email[._-]domain|threat[.-]setup[.-]|npm[.-]preinstall[.-]script|npm[.-]dependency[.-]confusion|reverse[.-]shell|cryptomining|self[.-]propagation|dns[.-]exfil|exfil[.-]messenger|obfuscation[.-]pyarmor/i;

/**
 * GuardDog outcome. Since version 3 every package gets a 0-10 score that grows with the number of
 * indicators: large healthy libraries easily exceed 7, so the score alone only warns and blocking
 * happens only on the clear-cut rules above. The summary always says which packages and why.
 * Versions before 3 printed "Found N potentially malicious indicators".
 */
export function guarddogVerdict(out) {
  const text = clean(out);
  const packages = [];
  let cur = { name: '?', rules: [] };
  for (const line of text.split('\n')) {
    const start = line.match(/^(?:Scanning (\S+?),|No risks found in (\S+))/);
    if (start) cur = { name: start[1] ?? start[2], rules: [] };
    const rule = line.match(/^│ \* (\S+)/);
    if (rule) cur.rules.push(rule[1]);
    const score = line.match(/Assessment:\s*[^(]+?\s*\((\d+(?:\.\d+)?)\/10\)/);
    if (score) {
      packages.push({ ...cur, score: Number(score[1]), blocking: [...new Set(cur.rules.filter((x) => GUARDDOG_BLOCKING.test(x)))] });
      cur = { name: '?', rules: [] };
    }
  }
  if (packages.length) {
    const max = Math.max(...packages.map((p) => p.score));
    const flagged = packages.filter((p) => p.score > 0);
    const blocked = packages.filter((p) => p.blocking.length);
    const high = packages.filter((p) => p.score >= 7 && !p.blocking.length).sort((x, y) => y.score - x.score);
    const lines = [`${packages.length} packages checked, ${flagged.length} flagged, highest score ${max}/10`];
    if (blocked.length) lines.push(`To block: ${blocked.map((p) => `${p.name} (${p.blocking.join(', ')})`).join('; ')}`);
    if (high.length) lines.push(`High score but generic heuristics only, worth a look: ${high.map((p) => `${p.name} ${p.score}`).join(', ')}`);
    return { status: blocked.length ? 'blocking' : max > 0 ? 'warning' : 'ok', summary: lines.join('\n'), packages };
  }
  const old = [...text.matchAll(/Found (\d+) potentially malicious/gi)].some((m) => Number(m[1]) > 0);
  return { status: old ? 'blocking' : 'ok', summary: '', packages };
}

// Without terminal colour codes and links, which turn into garbage in the dashboard
const clean = (s) => s.replace(/\x1b\[[0-9;]*m|\x1b\]8;;[^\x1b]*\x1b\\/g, '');
const tail = (s) => clean(s).trim().split('\n').slice(-15).join('\n');
