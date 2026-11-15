// Leanling dashboard: no framework, one page talking to /api.
const token = new URLSearchParams(location.search).get('token') ?? sessionStorage.getItem('leanling-token') ?? '';
if (token) sessionStorage.setItem('leanling-token', token);

const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// Interface language: the one picked in Settings, otherwise the browser's, otherwise English
const texts = await fetch('i18n.json').then((r) => r.json());
const LANGS = Object.keys(texts);
const chosen = localStorage.getItem('leanling-lang');
const lang = LANGS.includes(chosen) ? chosen : (navigator.languages ?? [navigator.language]).map((l) => l.toLowerCase().split('-')[0]).find((l) => LANGS.includes(l)) ?? 'en';
const t = (k, vars = {}) => String(texts[lang][k] ?? texts.en[k] ?? k).replace(/\{(\w+)\}/g, (_, v) => (vars[v] !== undefined ? String(vars[v]) : `{${v}}`));
/** Translates the texts of a piece of page: data-t = content, data-t-placeholder = placeholder */
const localize = (root) => {
  for (const el of root.querySelectorAll('[data-t]')) el.textContent = t(el.dataset.t);
  for (const el of root.querySelectorAll('[data-t-placeholder]')) el.placeholder = t(el.dataset.tPlaceholder);
};
document.documentElement.lang = lang;
localize(document);
$('#recipes').setAttribute('aria-label', t('recipesNav'));
$('#footer').innerHTML = esc(t('footer')).replace('{agicloud}', '<a href="https://agicloud.dev">AgiCloud</a>');

const when = (iso) => (iso ? new Intl.DateTimeFormat(lang, { dateStyle: 'short', timeStyle: 'short' }).format(new Date(iso)) : '');
/** Status badge: the code (running, ok, error…) picks the colour, the label is translated */
const badge = (code, label = texts[lang][`st.${code}`] ?? texts.en[`st.${code}`] ?? code) => `<span class="badge ${esc(String(code).replace(/\s/g, '-'))}">${esc(label)}</span>`;
const kindLabel = (k) => texts[lang][`kind.${k}`] ?? texts.en[`kind.${k}`] ?? k;

let data = null;
let selected = location.hash.slice(1) || null;
let tab = 'choices';
let watchedRun = null; // run shown in "Activity"

async function api(path, body) {
  const res = await fetch(path, {
    method: body ? 'POST' : 'GET',
    headers: { 'content-type': 'application/json', 'x-leanling-token': token, 'x-leanling-lang': lang },
    body: body ? JSON.stringify(body) : undefined,
  });
  const out = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(out.error ?? res.statusText);
  return out;
}

function toast(msg) {
  const t = Object.assign(document.createElement('div'), { className: 'toast', role: 'status', textContent: msg });
  document.body.append(t);
  setTimeout(() => t.remove(), 3500);
}

async function load() {
  try {
    data = await api('/api/overview');
  } catch (e) {
    $('#main').innerHTML = `<p class="empty">${esc(e.message)}</p>`;
    return;
  }
  if (!selected || !data.recipes.some((r) => r.name === selected)) selected = data.recipes[0]?.name;
  renderNav();
  renderRecipe();
}

function renderNav() {
  $('#recipes').innerHTML = data.recipes
    .map((r) => {
      const v = r.state.current?.version ?? t('nonInstallato');
      const extra = r.running ? badge('running') : r.state.candidate ? badge('ready') : '';
      return `<button data-name="${esc(r.name)}" aria-current="${r.name === selected}"><strong>${esc(r.title)}</strong><small>${esc(v)} ${extra}</small></button>`;
    })
    .join('');
}

$('#recipes').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-name]');
  if (!b) return;
  selected = b.dataset.name;
  location.hash = selected;
  watchedRun = null;
  renderNav();
  renderRecipe();
});

function renderRecipe() {
  const r = data.recipes.find((x) => x.name === selected);
  if (!r) return void ($('#main').innerHTML = `<p class="empty">${esc(t('nessunaRicetta'))}</p>`);
  const el = $('#tpl-recipe').content.firstElementChild.cloneNode(true);
  localize(el);
  $('h1', el).textContent = r.title;
  $('.desc', el).textContent = r.description;

  const s = r.state;
  const card = (title, v, sub) => `<div class="card"><h3>${esc(title)}</h3><div class="v">${esc(v?.version ?? '—')}</div><small>${esc(sub ?? '')}</small></div>`;
  $('.versions', el).innerHTML =
    card(t('vInUso'), s.current, s.current ? t('installatoIl', { when: when(s.current.installedAt) }) : t('nonAncoraInstallato')) +
    card(t('vPronto'), s.candidate, s.candidate ? t('provatoIl', { when: when(s.candidate.at) }) : t('preparaAgg')) +
    card(t('vPrecedente'), s.previous, s.previous ? t('perTornareIndietro') : '');

  for (const b of el.querySelectorAll('.actions button')) {
    const act = b.dataset.act;
    b.disabled = !!r.running || (act === 'install' && !s.candidate) || (act === 'rollback' && !s.previous);
    b.addEventListener('click', () => action(r, act));
  }

  for (const t of el.querySelectorAll('[role=tab]')) {
    t.setAttribute('aria-selected', t.dataset.tab === tab);
    t.addEventListener('click', () => {
      tab = t.dataset.tab;
      renderRecipe();
    });
  }
  for (const p of el.querySelectorAll('.tab')) p.hidden = p.dataset.panel !== tab;

  $('[data-panel=choices]', el).append(choicesPanel(r));
  $('[data-panel=container]', el).append(containerPanel(r));
  $('[data-panel=activity]', el).append(activityPanel(r));
  $('[data-panel=info]', el).innerHTML = `
    <p><strong>${esc(t('licenza'))}:</strong> ${esc(r.license)}</p>
    <p><strong>${esc(t('origine'))}:</strong> <a href="${esc(r.upstream)}" rel="noopener" target="_blank">${esc(r.upstream)}</a></p>
    <p><strong>${esc(t('tipoRicetta'))}:</strong> ${esc(r.type === 'build' ? t('tipoBuild') : t('tipoImage'))}</p>
    ${r.notes ? `<h4>${esc(t('noteAnalisi'))}</h4><div class="notes">${esc(r.notes)}</div>` : ''}
    ${r.user ? `<p class="hint">${esc(t('ricettaTua'))}</p><button class="ghost" data-remove>${esc(t('togliRicetta'))}</button>` : ''}
    <p class="hint">${esc(t('notaLegale'))}</p>`;

  $('[data-remove]', el)?.addEventListener('click', async () => {
    if (!confirm(t('confermaTogli', { title: r.title }))) return;
    try {
      await api(`/api/recipes/${r.name}/remove`, {});
      selected = null;
      location.hash = '';
      await load();
    } catch (e) {
      toast(e.message);
    }
  });

  $('#main').replaceChildren(el);
}

/* -------- add app */
const addDlg = $('#add');
const addForm = $('#add-form');
$('#open-add').addEventListener('click', () => {
  addForm.reset();
  $('#add-agent').textContent = data?.agent.ready ? t('agentePronto', { reason: data.agent.reason }) : t('agenteNonAttivo', { reason: data?.agent.reason ?? '?' });
  addDlg.showModal();
});
addDlg.addEventListener('close', async () => {
  if (addDlg.returnValue !== 'add') return;
  try {
    const { name, id } = await api('/api/recipes', { source: addForm.source.value, name: addForm.name.value, analyze: addForm.analyze.checked });
    toast(t('msgAnalisi'));
    selected = name;
    location.hash = name;
    watchedRun = id;
    tab = 'activity';
    await load();
  } catch (e) {
    toast(e.message);
  }
});

const groupOf = (o) => o.group ?? t('altro');

function choicesPanel(r) {
  const wrap = document.createElement('div');
  const lastReport = r.state.candidate?.report ?? {};
  const fresh = (lastReport.newItems ?? []).filter((m) => !r.options.some((o) => o.id === m));
  let html = '';
  if (fresh.length) {
    html += `<div class="new-items"><strong>${esc(t('novitaTitolo'))}</strong>
      <p class="hint">${esc(t('novitaHint'))}</p>
      ${fresh.map((m) => `<button class="ghost" data-add="${esc(m)}">+ ${esc(m)}</button>`).join('')}</div>`;
  }
  if (r.options.length) {
    html += `<p class="legend">${esc(t('legendaScelte'))}</p>`;
    const groups = r.options.reduce((m, o) => m.set(groupOf(o), [...(m.get(groupOf(o)) ?? []), o]), new Map());
    for (const [g, opts] of groups) {
      html += `<div class="group"><h4>${esc(g)} <button class="ghost" data-all="${esc(g)}">${esc(t('togliTutti'))}</button><button class="ghost" data-none="${esc(g)}">${esc(t('tieniTutti'))}</button></h4><div class="opts">
        ${opts.map((o) => `<label class="check"><input type="checkbox" data-opt="${esc(o.id)}" ${o.remove ? 'checked' : ''}><span>${esc(o.label)}<small>${esc(o.id)}</small></span></label>`).join('')}
      </div></div>`;
    }
  }
  if (r.patches.length) {
    html += `<div class="group"><h4>${esc(t('patchTitolo'))}</h4>`;
    html += r.patches.map((p) => `<label class="check"><input type="checkbox" data-patch="${esc(p.file)}" ${p.enabled ? 'checked' : ''}><span>${esc(p.label)}<small>${esc(p.file)}${p.overridden ? esc(t('patchRifatta')) : ''}</small></span></label>`).join('');
    html += '</div>';
  }
  if (!r.options.length && !r.patches.length) html += `<p class="empty">${esc(t('nessunaScelta'))}</p>`;
  html += `<details><summary>${esc(t('variabiliFiglio'))}</summary><pre class="log">${esc(Object.entries(r.env).map(([k, v]) => `${k}=${v}`).join('\n') || t('nessunaVar'))}</pre></details>`;
  wrap.innerHTML = html;

  const save = async (choices, extraOptions) => {
    await api(`/api/recipes/${r.name}/settings`, { choices, extraOptions });
    await load();
  };
  wrap.addEventListener('change', (e) => {
    const t = e.target;
    if (t.dataset.opt) save({ [t.dataset.opt]: t.checked });
    if (t.dataset.patch) save({ [`patch:${t.dataset.patch}`]: t.checked });
  });
  wrap.addEventListener('click', (e) => {
    const t = e.target.closest('button');
    if (!t) return;
    const g = t.dataset.all ?? t.dataset.none;
    if (g) save(Object.fromEntries(r.options.filter((o) => groupOf(o) === g).map((o) => [o.id, t.dataset.all !== undefined])));
    if (t.dataset.add) {
      const listEnv = Object.keys(r.options.find((o) => o.list)?.list ?? {})[0];
      const extra = (data.config.recipes?.[r.name]?.extraOptions ?? []).concat({ id: t.dataset.add, group: t('addedByYou'), label: t.dataset.add, default: false, ...(listEnv ? { list: { [listEnv]: t.dataset.add } } : {}) });
      save({}, extra);
    }
  });
  return wrap;
}

function containerPanel(r) {
  const c = r.container;
  const f = document.createElement('form');
  f.className = 'form';
  f.innerHTML = `
    <p class="hint">${esc(t('contHint'))}</p>
    <label class="field">${esc(t('contNome'))} <input name="name" value="${esc(c.name)}" required pattern="[a-zA-Z0-9][a-zA-Z0-9_.-]*"></label>
    <label class="field">${esc(t('contPorte'))} <textarea name="ports">${esc((c.ports ?? []).join('\n'))}</textarea></label>
    <label class="field">${esc(t('contVolumi'))} <textarea name="volumes">${esc((c.volumes ?? []).join('\n'))}</textarea></label>
    <label class="field">${esc(t('contMem'))} <input name="memory" value="${esc(c.memory ?? '')}"></label>
    <label class="field">${esc(t('contCpu'))} <input name="cpus" value="${esc(c.cpus ?? '')}"></label>
    <label class="field">${esc(t('contReti'))} <textarea name="networks">${esc([...(c.networks ?? []), ...(c.network ? [c.network] : [])].join('\n'))}</textarea></label>
    <label class="field">${esc(t('contHosts'))} <textarea name="extraHosts">${esc((c.extraHosts ?? []).join('\n'))}</textarea></label>
    <label class="field">${esc(t('contEnv'))} <textarea name="env">${esc(Object.entries(r.containerEnv).map(([k, v]) => `${k}=${v}`).join('\n'))}</textarea></label>
    <label class="check"><input type="checkbox" name="deploy" ${r.deploy ? 'checked' : ''}><span>${esc(t('contDeploy'))}<small>${esc(t('contDeployHint'))}</small></span></label>
    <label class="check"><input type="checkbox" name="adopt" ${r.adopt ? 'checked' : ''}><span>${esc(t('contAdopt'))}<small>${esc(t('contAdoptHint'))}</small></span></label>
    <label class="field">${esc(t('contReplaces'))}<input name="replaces" value="${esc(r.replaces)}" placeholder="${esc(t('replacesPh'))}"><small>${esc(t('contReplacesHint'))}</small></label>
    <label class="check"><input type="checkbox" name="dataTest" ${r.dataTest ? 'checked' : ''}><span>${esc(t('contDataTest'))}<small>${esc(t('contDataTestHint'))}</small></span></label>
    <label class="field">${esc(t('contPublish'))} <input name="publishAs" value="${esc(r.publishAs)}" placeholder="ghcr.io/user/name"></label>
    <div><button>${esc(t('salvaBtn'))}</button></div>`;
  f.addEventListener('submit', async (e) => {
    e.preventDefault();
    const v = Object.fromEntries(new FormData(f));
    const lines = (s) => s.split('\n').map((x) => x.trim()).filter(Boolean);
    const env = Object.fromEntries(lines(v.env).filter((l) => l.includes('=')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
    try {
      await api(`/api/recipes/${r.name}/settings`, {
        container: { name: v.name, ports: lines(v.ports), volumes: lines(v.volumes), memory: v.memory || undefined, cpus: v.cpus || undefined, networks: lines(v.networks), extraHosts: lines(v.extraHosts), env },
        deploy: !!v.deploy, adopt: !!v.adopt, replaces: v.replaces.trim(), dataTest: !!v.dataTest, publishAs: v.publishAs.trim(),
      });
      toast(t('salvatoMsg'));
      await load();
    } catch (err) {
      toast(err.message);
    }
  });
  return f;
}

function activityPanel(r) {
  const wrap = document.createElement('div');
  const id = watchedRun ?? r.running ?? data.runs.find((x) => x.recipe === r.name)?.id;
  wrap.innerHTML = `<div id="run-view"><p class="empty">${esc(t('nessunaAttivita'))}</p></div>`;
  if (id) showRun(id, wrap);
  const mine = data.runs.filter((x) => x.recipe === r.name);
  if (mine.length) {
    wrap.insertAdjacentHTML('beforeend', `<h4>${esc(t('storico'))}</h4><table class="history"><tbody>${mine
      .map((x) => `<tr><td>${when(x.startedAt)}</td><td>${esc(kindLabel(x.kind))}</td><td>${badge(x.status)}</td><td>${esc(x.message ?? '')}</td><td><button class="ghost" data-run="${esc(x.id)}">${esc(t('apriBtn'))}</button></td></tr>`)
      .join('')}</tbody></table>`);
  }
  wrap.addEventListener('click', (e) => {
    const b = e.target.closest('[data-run]');
    if (b) {
      watchedRun = b.dataset.run;
      showRun(watchedRun, wrap);
    }
  });
  return wrap;
}

async function showRun(id, wrap = document) {
  const box = $('#run-view', wrap);
  if (!box) return;
  const run = await api(`/api/runs/${id}`).catch(() => null);
  if (!run) return;
  box.dataset.id = run.id;
  const rep = run.report ?? {};
  box.innerHTML = `
    <h4>${esc(kindLabel(run.kind))} · ${when(run.startedAt)} ${badge(run.status)}</h4>
    ${run.message ? `<p>${esc(run.message)}</p>` : ''}
    <ul class="steps">${run.steps.map((s) => `<li>${badge(s.status)}<div>${esc(s.name)}${s.detail ? `<pre>${esc(s.detail)}</pre>` : ''}</div></li>`).join('')}</ul>
    ${rep.review ? `<h4>${esc(t('revAgente'))}</h4><div class="review">${esc(rep.review)}</div>` : ''}
    ${rep.changelog ? `<details><summary>${esc(t('commitNuovi', { n: rep.newCommits ?? 0 }))}</summary><pre class="log">${esc(rep.changelog)}</pre></details>` : ''}
    ${rep.releaseNotes ? `<details><summary>${esc(t('releaseNotes'))}</summary><pre class="log">${esc(rep.releaseNotes)}</pre></details>` : ''}
    <details ${run.status === 'running' ? 'open' : ''}><summary>${esc(t('registro'))}</summary><pre class="log" id="log">${esc(run.log.join('\n'))}</pre></details>`;
  const log = $('#log', box);
  log.scrollTop = log.scrollHeight;
}

async function action(r, act) {
  const labels = { update: t('msgUpdate'), install: t('msgInstall'), rollback: t('msgRollback'), clean: t('msgClean') };
  if (act === 'install' && !confirm(t('confermaInstalla', { name: r.container.name, version: r.state.candidate.version }))) return;
  if (act === 'rollback' && !confirm(t('confermaRollback', { version: r.state.previous.version }))) return;
  const body = act === 'clean' ? { buildCache: confirm(t('confermaBuildCache')) } : {};
  try {
    const { id } = await api(`/api/recipes/${r.name}/${act}`, body);
    toast(labels[act]);
    watchedRun = id;
    tab = 'activity';
    await load();
  } catch (e) {
    toast(e.message);
  }
}

/* -------- global settings */
const dlg = $('#settings');
const form = $('#settings-form');
$('#open-settings').addEventListener('click', () => {
  const c = data.config;
  form.agentType.value = c.agent.type;
  form.agentAuth.value = c.agent.auth;
  form.apiKey.value = c.agent.apiKey;
  form.model.value = c.agent.model;
  form.review.checked = c.agent.review;
  form.fixPatches.checked = c.agent.fixPatches;
  form.keepVersions.value = c.keepVersions;
  $('#agent-status').textContent = t('statoPrefix', { reason: data.agent.reason });
  form.language.innerHTML = `<option value="">${esc(t('langAuto'))}</option>` + LANGS.map((l) => `<option value="${l}">${esc(new Intl.DisplayNames([l], { type: 'language' }).of(l))}</option>`).join('');
  form.language.value = LANGS.includes(chosen) ? chosen : '';
  $('#scanners').innerHTML = Object.entries(data.scanners)
    .map(([id, s]) => `<label class="check"><input type="checkbox" name="scan-${id}" ${s.enabled ? 'checked' : ''}><span>${esc(s.label)} ${s.installed ? badge('ok') : badge('missing', t('scannerMissing'))}<small>${esc(texts[lang][`scan.${id}`] ?? texts.en[`scan.${id}`] ?? s.what)}${s.installed ? '' : ` · ${esc(s.install)}`}</small></span></label>`)
    .join('');
  syncAgentFields();
  dlg.showModal();
});
form.addEventListener('change', syncAgentFields);
function syncAgentFields() {
  $('.when-claude', form).hidden = form.agentType.value !== 'claude';
  $('.when-api', form).hidden = form.agentAuth.value !== 'api';
}
dlg.addEventListener('close', async () => {
  if (dlg.returnValue !== 'save') return;
  try {
    await api('/api/settings', {
      agent: { type: form.agentType.value, auth: form.agentAuth.value, apiKey: form.apiKey.value, model: form.model.value.trim(), review: form.review.checked, fixPatches: form.fixPatches.checked },
      scanners: Object.fromEntries(Object.keys(data.scanners).map((id) => [id, form[`scan-${id}`].checked])),
      keepVersions: form.keepVersions.value,
    });
    // A different language reloads the page, so every text is drawn again in the new one
    if (form.language.value !== (LANGS.includes(chosen) ? chosen : '')) {
      if (form.language.value) localStorage.setItem('leanling-lang', form.language.value);
      else localStorage.removeItem('leanling-lang');
      return location.reload();
    }
    toast(t('msgImpostazioni'));
    await load();
  } catch (e) {
    toast(e.message);
  }
});

/* -------- live updates */
let pending = null;
const es = new EventSource(`/api/events${token ? `?token=${encodeURIComponent(token)}` : ''}`);
es.addEventListener('log', (e) => {
  const { id, line } = JSON.parse(e.data);
  const box = $('#run-view');
  if (box?.dataset.id !== id) return;
  const log = $('#log', box);
  log.textContent += `\n${line}`;
  log.scrollTop = log.scrollHeight;
});
es.addEventListener('run', () => {
  // Many events close together during a job: a single reload every now and then
  clearTimeout(pending);
  pending = setTimeout(async () => {
    const open = [...document.querySelectorAll('details[open] summary')].map((s) => s.textContent);
    await load();
    for (const s of document.querySelectorAll('details summary')) if (open.includes(s.textContent)) s.parentElement.open = true;
  }, 400);
});

// Jobs started from the terminal send no events: while something is in progress, check again every 3 s
setInterval(async () => {
  if (!data?.recipes.some((r) => r.running) || document.hidden) return;
  await load();
}, 3000);

window.addEventListener('hashchange', () => {
  selected = location.hash.slice(1);
  load();
});
load();
