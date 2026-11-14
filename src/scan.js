// Scanner prima dell'installazione. Ogni scanner e' facoltativo: se non e' installato si salta e lo si dice.
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { has, run } from './sh.js';

export const SCANNERS = {
  osv: { bin: 'osv-scanner', label: 'OSV-Scanner', what: 'dipendenze con vulnerabilità note', install: 'https://google.github.io/osv-scanner/installation/' },
  guarddog: { bin: 'guarddog', label: 'GuardDog', what: 'pacchetti npm/PyPI malevoli', install: 'pipx install guarddog' },
  gitleaks: { bin: 'gitleaks', label: 'Gitleaks', what: 'chiavi e password nel codice', install: 'https://github.com/gitleaks/gitleaks#installing' },
  clamav: { bin: 'clamscan', label: 'ClamAV', what: 'malware nei file dell\'immagine finale', install: 'apt install clamav' },
};

export const scannerStatus = (cfg) =>
  Object.fromEntries(Object.entries(SCANNERS).map(([id, s]) => [id, { ...s, enabled: cfg.scanners[id] !== false, installed: has(s.bin) }]));

/**
 * Scansione del sorgente scaricato. `range` = "vecchio..nuovo" per Gitleaks (solo i commit nuovi).
 * Ritorna l'elenco dei risultati; `blocking` = l'aggiornamento non deve proseguire.
 */
export async function scanSource(cfg, { dir, range, manifests = [], log }) {
  const st = scannerStatus(cfg);
  const results = [];
  const skip = (id) => {
    if (!st[id].enabled) return true;
    if (!st[id].installed) {
      results.push({ id, status: 'saltato', detail: `${st[id].bin} non installato (${st[id].install})` });
      return true;
    }
    return false;
  };

  if (!skip('osv')) {
    log(`scanner: ${SCANNERS.osv.label}`);
    const r = await run('osv-scanner', ['scan', 'source', '-r', dir], { timeout: 600 });
    // 0 = pulito, 1 = vulnerabilita' trovate, altro = errore dello scanner
    results.push({ id: 'osv', status: r.code === 0 ? 'ok' : r.code === 1 ? 'avviso' : 'errore', detail: tail(r.out || r.err) });
  }

  if (!skip('guarddog')) {
    for (const m of manifests) {
      const file = join(dir, m);
      if (!existsSync(file)) continue;
      const eco = m.endsWith('package.json') || m.endsWith('package-lock.json') ? 'npm' : 'pypi';
      log(`scanner: ${SCANNERS.guarddog.label} su ${m}`);
      const r = await run('guarddog', [eco, 'verify', file], { timeout: 900 });
      const v = guarddogVerdict(r.out);
      results.push({ id: 'guarddog', status: r.code !== 0 ? 'errore' : v.status, detail: r.code !== 0 || !v.summary ? [v.summary, tail(r.out || r.err)].filter(Boolean).join('\n') : v.summary });
    }
  }

  if (!skip('gitleaks') && range) {
    log(`scanner: ${SCANNERS.gitleaks.label} sui commit nuovi`);
    const r = await run('gitleaks', ['git', '--no-banner', `--log-opts=${range}`, dir], { timeout: 600 });
    results.push({ id: 'gitleaks', status: r.code === 0 ? 'ok' : r.code === 1 ? 'avviso' : 'errore', detail: tail(r.out || r.err) });
  }
  return results;
}

/** ClamAV sui file dell'immagine finale (esportata in una cartella temporanea e poi cancellata) */
export async function scanImage(cfg, image, log) {
  const st = scannerStatus(cfg).clamav;
  if (!st.enabled) return [];
  if (!st.installed) return [{ id: 'clamav', status: 'saltato', detail: `clamscan non installato (${st.install})` }];
  log('scanner: ClamAV sull\'immagine');
  const dir = mkdtempSync(join(tmpdir(), 'leanling-img-'));
  try {
    const cid = (await run('docker', ['create', image])).out.trim();
    const tar = join(dir, 'fs.tar');
    await run('docker', ['export', '-o', tar, cid]);
    await run('docker', ['rm', cid]);
    await run('tar', ['-xf', tar, '-C', dir, '--exclude=dev/*']);
    rmSync(tar);
    const r = await run('clamscan', ['-r', '-i', '--no-summary', dir], { timeout: 3600 });
    return [{ id: 'clamav', status: r.code === 0 ? 'ok' : r.code === 1 ? 'bloccante' : 'errore', detail: tail(r.out || r.err) || 'nessun file infetto' }];
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Regole di GuardDog che da sole bastano a fermare l'aggiornamento: nome che imita un pacchetto famoso,
 * account del manutentore a rischio, codice che gira durante l'installazione, e comportamenti che una
 * libreria sana non ha. Le altre (leggere file, avviare processi, chiamare la rete) scattano anche su
 * torch o pandas, quindi valgono solo come avviso.
 */
const GUARDDOG_BLOCKING = /typosquatting|compromised[._-]email[._-]domain|unclaimed[._-]maintainer[._-]email[._-]domain|threat[.-]setup[.-]|npm[.-]preinstall[.-]script|npm[.-]dependency[.-]confusion|reverse[.-]shell|cryptomining|self[.-]propagation|dns[.-]exfil|exfil[.-]messenger|obfuscation[.-]pyarmor/i;

/**
 * Esito di GuardDog. Dalla 3 ogni pacchetto ha un punteggio da 0 a 10 che cresce con il numero di
 * indicatori: le librerie grandi e sane superano facilmente 7, quindi il punteggio da solo avvisa e
 * si blocca soltanto sulle regole nette qui sopra. Il riepilogo dice sempre quali pacchetti e perché.
 * Le versioni prima della 3 scrivevano "Found N potentially malicious indicators".
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
    const lines = [`${packages.length} pacchetti controllati, ${flagged.length} con segnalazioni, punteggio più alto ${max}/10`];
    if (blocked.length) lines.push(`Da fermare: ${blocked.map((p) => `${p.name} (${p.blocking.join(', ')})`).join('; ')}`);
    if (high.length) lines.push(`Punteggio alto ma solo euristiche generiche, da guardare: ${high.map((p) => `${p.name} ${p.score}`).join(', ')}`);
    return { status: blocked.length ? 'bloccante' : max > 0 ? 'avviso' : 'ok', summary: lines.join('\n'), packages };
  }
  const old = [...text.matchAll(/Found (\d+) potentially malicious/gi)].some((m) => Number(m[1]) > 0);
  return { status: old ? 'bloccante' : 'ok', summary: '', packages };
}

// Senza codici colore e link del terminale, che nella dashboard diventano spazzatura
const clean = (s) => s.replace(/\x1b\[[0-9;]*m|\x1b\]8;;[^\x1b]*\x1b\\/g, '');
const tail = (s) => clean(s).trim().split('\n').slice(-15).join('\n');
