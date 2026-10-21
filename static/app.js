(function () {
'use strict';
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pad = n => String(n).padStart(2, '0');
const today = () => { const d = new Date(); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); };
const fmtDate = s => { if (!s) return '—'; const d = new Date(s + 'T00:00:00'); return isNaN(d) ? esc(s) : d.toLocaleDateString(undefined, { day: '2-digit', month: 'short', year: 'numeric' }); };
const fmtTime = ms => ms ? new Date(ms).toLocaleString(undefined, { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '';
const fmtSize = b => b == null ? '' : b < 1024 ? b + ' B' : b < 1048576 ? Math.round(b / 1024) + ' KB' : (b / 1048576).toFixed(1) + ' MB';
const newId = () => (crypto.randomUUID ? crypto.randomUUID().replace(/-/g, '') : Date.now().toString(36) + Math.random().toString(36).slice(2, 12));
const STAT = { Draft: 'Draft', Review: 'In review', Released: 'Released' };
const METHODS = ['Test', 'Analysis', 'Inspection', 'Demonstration'];
const RESULTS = ['Pending', 'Pass', 'Fail'];
const IMG_TAGS = ['Before', 'After', 'Section', 'Drawing', 'Other'];

/* ================= API ================= */
async function req(method, url, body, extra) {
  const h = Object.assign({ 'X-Requested-With': 'cadlog' }, extra || {});
  let b = body;
  if (body !== undefined && !(body instanceof Blob)) { h['Content-Type'] = 'application/json'; b = JSON.stringify(body); }
  const r = await fetch(url, { method, headers: h, body: b });
  if (!r.ok) { let m = 'HTTP ' + r.status; try { m = (await r.json()).error || m; } catch (_) {} throw new Error(m); }
  return r.status === 204 ? null : r.json();
}
const api = {
  put: (c, id, b) => req('PUT', `/api/${c}/${id}`, b),
  patch: (c, id, b) => req('PATCH', `/api/${c}/${id}`, b),
  del: (c, id) => req('DELETE', `/api/${c}/${id}`),
  uploadImage: f => req('POST', '/api/images', f, { 'Content-Type': f.type || 'application/octet-stream' }),
  uploadFile: f => req('POST', '/api/files', f, { 'Content-Type': 'application/octet-stream', 'X-Filename': encodeURIComponent(f.name) }),
  delImage: id => req('DELETE', '/api/images/' + encodeURIComponent(id)).catch(() => {}),
  delFile: id => req('DELETE', '/api/files/' + encodeURIComponent(id)).catch(() => {}),
};

/* ================= state ================= */
let D = { parts: [], revisions: [], ncrs: [], captures: [], boards: [] }, lastJson = '', loaded = false;
let sel = null, tab = 'revs', q = '', showAll = false, faiRev = null, form = null;

async function refresh(quiet) { // quiet: background poll, skip redraw when nothing changed
  const txt = await (await fetch('/api/data')).text();
  if (quiet && txt === lastJson && loaded) return;
  lastJson = txt; D = Object.assign({ boards: [] }, JSON.parse(txt)); loaded = true; render();
}

const partById = id => D.parts.find(p => p.id === id);
const revById = id => D.revisions.find(r => r.id === id);
const revsOf = pid => D.revisions.filter(r => r.partId === pid).sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
const latest = pid => { const r = revsOf(pid); return r[r.length - 1]; };
const ncrsOf = pid => D.ncrs.filter(n => n.partId === pid).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
const openNcrs = pid => ncrsOf(pid).filter(n => n.status !== 'Closed').length;
const usedIn = pid => D.parts.filter(a => a.type === 'assembly' && (a.components || []).some(c => c.partId === pid));
const isLocked = r => !!r && r.status === 'Released';
const partLabel = p => p ? (p.partNo ? p.partNo + ' · ' : '') + p.name : 'Missing part';
const revLabel = id => { const r = revById(id); return r ? 'Rev ' + r.rev : '—'; };
const fileUrl = f => f.url || ('/files/' + encodeURIComponent(f.id) + '?name=' + encodeURIComponent(f.name || f.id));

function lastValues(pid) { // parameter name -> latest known value across all revisions
  const m = {};
  for (const r of revsOf(pid)) for (const x of r.params || []) if (x.name) m[x.name] = { value: x.new, unit: x.unit };
  return m;
}
function staleComponents(asm) { // components revised after the assembly's latest revision
  const la = latest(asm.id);
  if (!la) return [];
  return (asm.components || []).map(c => ({ c, p: partById(c.partId), r: latest(c.partId) }))
    .filter(x => x.p && x.r && (x.r.createdAt || 0) > (la.createdAt || 0));
}

/* ---------- part numbers & revision labels ---------- */
const STOP = new Set(['OF', 'THE', 'AND', 'FOR', 'A', 'AN', 'TO', 'WITH', 'IN', 'ON']);
function abbr(s, max) {
  const w = String(s || '').trim().split(/\s+/).map(x => x.replace(/[^A-Za-z0-9]/g, '').toUpperCase()).filter(Boolean);
  if (!w.length) return '';
  if (w.length === 1) return w[0].slice(0, max);
  const k = w.filter(x => !STOP.has(x));
  return (k.length ? k : w).map(x => /^\d+$/.test(x) ? x : x[0]).join('').slice(0, max);
}
function autoPartNo(name, proj, exceptId) {
  const ini = abbr(name, 4); if (!ini) return '';
  const pre = (abbr(proj, 5) ? abbr(proj, 5) + '-' : '') + ini + '-';
  let max = 0;
  D.parts.forEach(p => {
    if (p.id === exceptId || !p.partNo || !p.partNo.toUpperCase().startsWith(pre)) return;
    const m = p.partNo.slice(pre.length).match(/^(\d+)/); if (m) max = Math.max(max, +m[1]);
  });
  return pre + String(max + 1).padStart(3, '0');
}
function nextRev(last) {
  if (!last) return 'A';
  if (/^[A-Z]$/.test(last)) return last === 'Z' ? 'AA' : String.fromCharCode(last.charCodeAt(0) + 1);
  const m = last.match(/^(.*?)(\d+)$/); if (m) return m[1] + String(+m[2] + 1).padStart(m[2].length, '0');
  return '';
}
function delta(o, n) {
  const a = parseFloat(o), b = parseFloat(n);
  if (o === '' || n === '' || isNaN(a) || isNaN(b) || !/^\s*-?[\d.]+/.test(o) || !/^\s*-?[\d.]+/.test(n)) return '';
  const d = +(b - a).toFixed(4); if (d === 0) return '<span class="hint">0</span>';
  const pct = a !== 0 ? ` <span class="hint">(${d > 0 ? '+' : ''}${(d / Math.abs(a) * 100).toFixed(1)}%)</span>` : '';
  return `<span class="${d > 0 ? 'd-up' : 'd-down'}">${d > 0 ? '+' : ''}${d}</span>${pct}`;
}
function faiResult(it) {
  const m = String(it.meas || '').trim(); if (!m) return 'Pending';
  const ml = m.toLowerCase();
  if (['ok', 'pass', 'yes', 'go'].includes(ml)) return 'Pass';
  if (['nok', 'fail', 'no', 'no-go', 'nogo'].includes(ml)) return 'Fail';
  const nom = parseFloat(it.nom), v = parseFloat(m);
  if (isNaN(nom) || isNaN(v)) return 'Pending';
  const lo = nom - Math.abs(parseFloat(it.tm) || 0), hi = nom + Math.abs(parseFloat(it.tp) || 0);
  return (v >= lo - 1e-9 && v <= hi + 1e-9) ? 'Pass' : 'Fail';
}
function faiSummary(fai) {
  const s = { Pass: 0, Fail: 0, Pending: 0 };
  ((fai && fai.items) || []).forEach(it => { s[faiResult(it)]++; });
  s.total = s.Pass + s.Fail + s.Pending; return s;
}

/* ---------- search ---------- */
function revText(r) {
  return [r.rev, r.title, r.what, r.why, r.fusionVer,
    (r.params || []).map(x => x.name + ' ' + x.old + ' ' + x.new).join(' '),
    (r.bom || []).map(b => b.item + ' ' + b.note).join(' '),
    (r.tests || []).map(t => t.description + ' ' + t.notes).join(' '),
    (r.files || []).map(f => f.name).join(' '), window.PCB ? PCB.revText(r) : ''].join(' ').toLowerCase();
}
function hitsFor(p) {
  if (!q) return { match: true, revs: [] };
  const pm = [p.name, p.partNo, p.project, p.material, p.notes, p.fusionDoc, p.kicadProject].join(' ').toLowerCase().includes(q);
  const revs = revsOf(p.id).filter(r => revText(r).includes(q)).map(r => r.id);
  const nm = ncrsOf(p.id).filter(n => [n.title, n.description, n.rootCause, n.action].join(' ').toLowerCase().includes(q)).length;
  const bm = p.type === 'pcb' && window.PCB ? PCB.boardHits(p.id, q) : 0;
  return { match: pm || revs.length > 0 || nm > 0 || bm > 0, revs, nm };
}

/* ================= sidebar ================= */
function renderSide() {
  const caps = $('#caps');
  const cs = D.captures.slice().sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  caps.hidden = !cs.length;
  caps.innerHTML = cs.length ? `<div class="caps"><div class="side-h"><span>From Fusion 360</span><span class="mono">${cs.length}</span></div>
    ${cs.map(c => `<div class="cap"><div style="min-width:0"><div class="nm">${esc(c.fusionDoc)}${c.version != null ? ' v' + esc(c.version) : ''}</div>
      <div class="hint">${fmtTime(c.createdAt)} · ${(c.params || []).length} params${c.file ? ' · STEP' : ''}</div></div>
      <button class="btn sm primary" type="button" data-act="use-cap" data-id="${esc(c.id)}">Log</button></div>`).join('')}</div>` : '';

  const list = $('#plist');
  $('#pcount').textContent = D.parts.length ? String(D.parts.length) : '';
  if (!loaded) { list.innerHTML = '<li class="hint" style="padding:8px">Loading…</li>'; return; }
  if (!D.parts.length) { list.innerHTML = '<li class="hint" style="padding:8px">Nothing yet. Use + New to add a part, assembly or PCB.</li>'; return; }
  const ps = D.parts.slice().sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)).map(p => ({ p, h: hitsFor(p) })).filter(x => x.h.match);
  if (!ps.length) { list.innerHTML = `<li class="hint" style="padding:8px">Nothing matches “${esc(q)}”.</li>`; return; }
  list.innerHTML = ps.map(({ p, h }) => {
    const l = latest(p.id), open = openNcrs(p.id);
    const hit = q && (h.revs.length || h.nm) ? `<span class="hit">${h.revs.length ? h.revs.length + ' rev' + (h.revs.length > 1 ? 's' : '') : ''}${h.revs.length && h.nm ? ', ' : ''}${h.nm ? h.nm + ' issue' + (h.nm > 1 ? 's' : '') : ''} match</span>` : '';
    return `<li><button type="button" class="pitem${p.id === sel ? ' on' : ''}" data-pid="${esc(p.id)}">
      <span class="nm">${esc(p.name)}</span>
      <span class="rv">${open ? `<span class="badge" title="${open} open issue${open > 1 ? 's' : ''}">${open}</span>` : ''}${p.type === 'assembly' ? '<span class="chip asm">ASM</span>' : p.type === 'pcb' ? '<span class="chip asm">PCB</span>' : ''}${l ? `<span class="rev">${esc(l.rev)}</span>` : '<span class="hint">—</span>'}</span>
      <span class="pn">${esc(p.partNo || 'No part no.')}${p.project ? ' · ' + esc(p.project) : ''}</span>${hit}</button></li>`;
  }).join('');
}

/* ================= main view ================= */
function render() {
  renderSide();
  document.body.classList.toggle('viewing', !!sel);
  const v = $('#view');
  const p = partById(sel);
  if (!p) {
    if (sel && loaded) sel = null;
    v.innerHTML = `<div class="empty"><span class="rev big">A</span>
      <h2>${D.parts.length ? 'Pick an item to see its history' : 'Add your first part, assembly or PCB'}</h2>
      <p>Each part gets a title block and a revision trail: what changed and why, parameter deltas, BOM edits, attached CAD files, verification results, first-article inspection and issues.</p>
      ${D.parts.length ? '' : '<button class="btn primary" type="button" data-act="new-part">+ New</button>'}</div>`;
    return;
  }
  const rs = revsOf(p.id), last = rs[rs.length - 1], open = openNcrs(p.id);
  const upd = p.updatedAt ? new Date(p.updatedAt).toLocaleDateString(undefined, { day: '2-digit', month: 'short', year: 'numeric' }) : '—';
  const hasReleased = rs.some(isLocked), isPcb = p.type === 'pcb' && !!window.PCB;
  let h = `<div><button class="btn ghost sm back" type="button" data-act="back">← All parts</button></div>
  <section class="tblock">
    <div class="tb-head">
      <span class="rev big">${last ? esc(last.rev) : '–'}</span>
      <div class="t"><h2>${esc(p.name)}</h2>
        <div class="meta">${p.type === 'assembly' ? '<span class="chip asm">Assembly</span>' : p.type === 'pcb' ? '<span class="chip asm">PCB</span>' : ''}
          ${last ? `<span class="pill ${esc(last.status)}">${esc(STAT[last.status] || last.status)}</span>` : ''}
          ${open ? `<span class="pill Fail">${open} open issue${open > 1 ? 's' : ''}</span>` : ''}
          ${p.type !== 'pcb' && p.fusionDoc ? `<span class="chip">Fusion: ${esc(p.fusionDoc)}</span>` : ''}
          ${p.type !== 'pcb' && p.fusionUrl ? `<a href="${esc(p.fusionUrl)}" target="_blank" rel="noopener">Open in Fusion ↗</a>` : ''}
          ${p.type === 'pcb' && p.link ? `<a href="${esc(p.link)}" target="_blank" rel="noopener">Open project ↗</a>` : ''}</div></div>
      <div class="acts">
        <button class="btn primary" type="button" data-act="new-rev">+ New revision</button>
        <button class="btn" type="button" data-act="edit-part">Edit ${p.type === 'pcb' ? 'PCB' : p.type === 'assembly' ? 'assembly' : 'part'}</button>
        <a class="btn" href="/report.html?part=${encodeURIComponent(p.id)}" target="_blank" rel="noopener">Report</a>
        <button class="btn" type="button" data-act="export">Copy changelog</button>
        <button class="btn danger" type="button" data-act="del-part"${hasReleased ? ' title="Parts with released revisions can’t be deleted"' : ''}>Delete</button>
      </div>
    </div>
    <div class="tb-grid">
      ${cell('Part no.', p.partNo)}${cell('Project', p.project)}${p.type === 'pcb'
        ? cell('KiCad project', p.kicadProject) + cell('Boards', String(D.boards.filter(b => b.partId === p.id).length))
        : p.type === 'assembly' ? cell('Components', String((p.components || []).length)) + cell('Units', p.units || 'mm')
        : cell('Material', p.material) + cell('Units', p.units || 'mm')}${cell('Revisions', String(rs.length))}${cell('Updated', upd)}
    </div>
    ${structure(p)}
    ${p.notes ? `<div class="tb-notes">${esc(p.notes)}</div>` : ''}
  </section>
  <nav class="tabs" role="tablist">
    ${tabBtn('revs', 'Revisions', rs.length)}${isPcb ? tabBtn('bom', 'BOM') + tabBtn('fab', 'Fab & orders') + tabBtn('boards', 'Boards', D.boards.filter(b => b.partId === p.id).length || '') : tabBtn('params', 'Parameters') + tabBtn('fai', 'Inspection')}${tabBtn('issues', 'Issues', open || '')}
  </nav>`;
  if (isPcb ? ['params', 'fai'].includes(tab) : PCB_TABS.includes(tab)) tab = 'revs';
  if (isPcb && PCB_TABS.includes(tab)) h += PCB.view(tab, p, rs);
  else if (tab === 'params') h += paramHistory(rs);
  else if (tab === 'fai') h += faiView(p, rs);
  else if (tab === 'issues') h += issuesView(p);
  else h += revsView(p, rs);
  v.innerHTML = h;
}
const cell = (k, v) => `<div class="cell"><div class="k">${k}</div><div class="v">${esc(v || '—')}</div></div>`;
const PCB_TABS = ['bom', 'fab', 'boards'];
const tabBtn = (id, label, n) => `<button class="tab${tab === id ? ' on' : ''}" type="button" data-tab="${id}">${label}${n ? ` <span class="chip">${n}</span>` : ''}</button>`;

function structure(p) {
  let h = '';
  if (p.type === 'assembly') {
    const comps = p.components || [];
    const stale = new Set(staleComponents(p).map(x => x.c.partId));
    const la = latest(p.id);
    h += `<div class="tb-row"><span class="k-inline">Components</span>${comps.length ? comps.map(c => {
      const cp = partById(c.partId), cr = latest(c.partId);
      return cp ? `<button class="chip${stale.has(c.partId) ? ' warn' : ''}" type="button" data-goto="${esc(cp.id)}" title="${stale.has(c.partId) ? 'Revised after this assembly’s Rev ' + esc(la.rev) : ''}">${esc(cp.partNo || cp.name)} ${cr ? 'Rev ' + esc(cr.rev) : ''} ×${esc(c.qty || 1)}</button>` : '<span class="chip">Missing part</span>';
    }).join('') : '<span class="hint">None yet. Add components in Edit part.</span>'}</div>`;
    if (stale.size) h += `<div class="tb-row"><span class="notice warn">${stale.size} component${stale.size > 1 ? 's were' : ' was'} revised after Rev ${esc(la.rev)} of this assembly. Check fit and log a new assembly revision if needed.</span></div>`;
  }
  const ui = usedIn(p.id);
  if (ui.length) {
    const lp = latest(p.id);
    h += `<div class="tb-row"><span class="k-inline">Used in</span>${ui.map(a => {
      const la = latest(a.id); const newer = lp && la && (lp.createdAt || 0) > (la.createdAt || 0);
      const q1 = (a.components.find(c => c.partId === p.id) || {}).qty || 1;
      return `<button class="chip${newer ? ' warn' : ''}" type="button" data-goto="${esc(a.id)}" title="${newer ? 'This part changed after the assembly’s Rev ' + esc(la.rev) : ''}">${esc(a.partNo || a.name)} ${la ? 'Rev ' + esc(la.rev) : ''} ×${esc(q1)}</button>`;
    }).join('')}</div>`;
  }
  return h;
}

/* ---------- revisions tab ---------- */
function revsView(p, rs) {
  if (!rs.length) return `<div class="empty"><h2>No revisions yet</h2><p>Log the current state as Rev A: baseline parameters, material, the exported STEP and a screenshot from Fusion.</p>
    <button class="btn primary" type="button" data-act="new-rev">+ Log Rev A</button></div>`;
  let list = rs.slice().reverse(), h = '';
  if (q && !showAll) {
    const hits = new Set(hitsFor(p).revs);
    if (hits.size && hits.size < rs.length) {
      list = list.filter(r => hits.has(r.id));
      h += `<div class="notice">Showing ${hits.size} of ${rs.length} revisions matching “${esc(q)}”. <button class="linkbtn" type="button" data-act="show-all">Show all</button></div>`;
    }
  }
  return h + list.map(r => revCard(r, p)).join('');
}
function revCard(r) {
  const params = (r.params || []).filter(x => x.name), bom = (r.bom || []).filter(x => x.item), imgs = r.images || [];
  const files = r.files || [], tests = (r.tests || []).filter(t => t.description), locked = isLocked(r);
  const fixes = D.ncrs.filter(n => n.fixedRevId === r.id), found = D.ncrs.filter(n => n.revId === r.id);
  const fs = faiSummary(r.fai);
  return `<article class="rcard${locked ? ' released' : ''}" id="r-${esc(r.id)}">
    <div class="gut"><span class="rev">${esc(r.rev)}</span></div>
    <div class="bd">
      <div class="rhead"><h3>${esc(r.title)}</h3>${locked ? '<span class="chip lock" title="Released revisions are locked. Verification and inspection results can still be added.">Locked</span>' : ''}<span class="pill ${esc(r.status)}">${esc(STAT[r.status] || r.status)}</span></div>
      <div class="meta"><span class="mono">${fmtDate(r.date)}</span>${r.fusionVer ? `<span class="chip">Fusion ${esc(r.fusionVer)}</span>` : ''}<span class="chip">Rev ${esc(r.rev)}</span>
        ${fs.total ? `<button class="chip${fs.Fail ? ' warn' : ''}" type="button" data-act="goto-fai" data-rid="${esc(r.id)}">FAI ${fs.Pass}/${fs.total} pass${fs.Fail ? ', ' + fs.Fail + ' fail' : ''}</button>` : ''}</div>
      ${(partById(r.partId) || {}).type === 'pcb' && window.PCB ? PCB.revExtra(r) : ''}
      ${(r.what || r.why) ? `<div class="two"><div><div class="lbl">What changed</div><div class="prose">${esc(r.what || '—')}</div></div>
        <div><div class="lbl">Why</div><div class="prose">${esc(r.why || '—')}</div></div></div>` : ''}
      ${fixes.length || found.length ? `<div class="links">${fixes.map(n => `<button class="chip" type="button" data-act="goto-issues">Fixes: ${esc(n.title)}</button>`).join('')}${found.map(n => `<button class="chip${n.status !== 'Closed' ? ' warn' : ''}" type="button" data-act="goto-issues">Issue found: ${esc(n.title)}</button>`).join('')}</div>` : ''}
      ${params.length ? `<div><div class="lbl">Parameters</div><div class="tw"><table>
        <thead><tr><th>Parameter</th><th>Was</th><th>Now</th><th>Δ</th></tr></thead><tbody>
        ${params.map(x => `<tr><td>${esc(x.name)}</td><td class="num was">${esc(x.old)}${x.old && x.unit ? ' ' + esc(x.unit) : ''}</td><td class="num">${esc(x.new)}${x.new && x.unit ? ' ' + esc(x.unit) : ''}</td><td class="num">${delta(x.old, x.new)}</td></tr>`).join('')}
        </tbody></table></div></div>` : ''}
      ${bom.length ? `<div><div class="lbl">BOM changes</div><div class="tw"><table>
        <thead><tr><th>Change</th><th>Item</th><th>Qty</th><th>Material / note</th></tr></thead><tbody>
        ${bom.map(b => `<tr><td class="${b.action === 'Added' ? 'bom-a' : b.action === 'Removed' ? 'bom-r' : 'bom-c'}">${esc(b.action)}</td><td>${esc(b.item)}</td><td class="num">${esc(b.qty)}</td><td>${esc(b.note)}</td></tr>`).join('')}
        </tbody></table></div></div>` : ''}
      ${tests.length ? `<div><div class="lbl">Verification</div><div class="tw"><table>
        <thead><tr><th>Method</th><th>What was checked</th><th>Result</th><th>Notes</th><th>Data</th></tr></thead><tbody>
        ${tests.map(t => `<tr${t.result === 'Fail' ? ' class="fail"' : ''}><td>${esc(t.method)}</td><td>${esc(t.description)}</td><td><span class="pill ${esc(t.result)}">${esc(t.result)}</span></td><td>${esc(t.notes)}</td><td>${t.file ? `<a href="${esc(fileUrl(t.file))}">${esc(t.file.name)}</a>` : ''}</td></tr>`).join('')}
        </tbody></table></div></div>` : ''}
      ${files.length ? `<div><div class="lbl">Files</div><div class="flist">${files.map(f => `<a class="file" href="${esc(fileUrl(f))}" title="Download ${esc(f.name)}"><span class="fn">${esc(f.name)}</span><span class="hint mono">${fmtSize(f.size)}</span></a>`).join('')}</div></div>` : ''}
      ${imgs.length ? `<div><div class="lbl">Images</div><div class="imgs">
        ${imgs.map((im, i) => `<figure class="fig" data-img="${esc(r.id)}:${i}" tabindex="0"><img src="${esc(im.url)}" alt="${esc(im.caption || im.tag || 'Revision image')}" loading="lazy"><figcaption>${im.tag ? `<span class="tag">${esc(im.tag)}</span>` : ''}<span>${esc(im.caption)}</span></figcaption></figure>`).join('')}
        </div></div>` : ''}
      <div class="racts">${locked
        ? `<button class="btn sm" type="button" data-act="edit-tests" data-rid="${esc(r.id)}">Add verification</button>`
        : `<button class="btn sm" type="button" data-act="edit-rev" data-rid="${esc(r.id)}">Edit</button>
           <button class="btn sm danger" type="button" data-act="del-rev" data-rid="${esc(r.id)}">Delete</button>`}</div>
    </div></article>`;
}

/* ---------- parameters tab ---------- */
function paramHistory(rs) {
  const names = []; rs.forEach(r => (r.params || []).forEach(x => { if (x.name && !names.includes(x.name)) names.push(x.name); }));
  if (!names.length) return `<div class="empty"><h2>No parameters logged</h2><p>Add parameter rows (wall thickness, hub bore, blade pitch…) to a revision and they line up here across every rev.</p></div>`;
  const rows = names.map(n => {
    const first = rs.find(r => (r.params || []).some(x => x.name === n)); const fx = first.params.find(x => x.name === n);
    const base = fx.old || ''; let unit = fx.unit || '', cur = base;
    const tds = rs.map(r => {
      const x = (r.params || []).find(y => y.name === n);
      if (x) { cur = x.new; if (x.unit) unit = x.unit; return `<td class="num chg">${esc(x.new)}</td>`; }
      return `<td class="num carry">${esc(cur)}</td>`;
    }).join('');
    return `<tr><td>${esc(n)}${unit ? ` <span class="hint">(${esc(unit)})</span>` : ''}</td><td class="num carry">${esc(base || '—')}</td>${tds}</tr>`;
  });
  return `<div class="tblock" style="border-width:1px;border-color:var(--line)"><div class="tw"><table class="hist">
    <thead><tr><th>Parameter</th><th>Baseline</th>${rs.map(r => `<th class="rv"><span class="rev">${esc(r.rev)}</span></th>`).join('')}</tr></thead>
    <tbody>${rows.join('')}</tbody></table></div></div>
    <p class="hint" style="margin:0">Shaded cells are values changed in that revision; grey values carry over from earlier revisions.</p>`;
}

/* ---------- inspection (FAI) tab ---------- */
function faiView(p, rs) {
  if (!rs.length) return `<div class="empty"><h2>Nothing to inspect yet</h2><p>Log a revision first. First-article inspection records measured dimensions of a made part against the drawing for that revision.</p></div>`;
  if (!faiRev || !rs.some(r => r.id === faiRev)) faiRev = rs[rs.length - 1].id;
  const r = revById(faiRev), fai = r.fai, s = faiSummary(fai);
  let h = `<div class="sum"><label class="flabel" for="fai-rev">Revision</label>
    <select id="fai-rev" class="rowin" style="width:auto">${rs.slice().reverse().map(x => `<option value="${esc(x.id)}"${x.id === faiRev ? ' selected' : ''}>Rev ${esc(x.rev)}: ${esc(x.title)}${x.fai && x.fai.items && x.fai.items.length ? ' (FAI)' : ''}</option>`).join('')}</select>
    <span class="sp" style="flex:1"></span>
    <button class="btn primary sm" type="button" data-act="edit-fai">${s.total ? 'Edit inspection' : 'Start inspection'}</button></div>`;
  if (!s.total) return h + `<div class="empty"><h2>No inspection for Rev ${esc(r.rev)}</h2><p>List each drawing characteristic (balloon number, nominal, tolerance) and the measured value. Pass or fail is worked out for you. Type OK or NOK for go/no-go checks.</p></div>`;
  h += `<div class="tblock" style="border-width:1px;border-color:var(--line)">
    <div class="tb-row"><span class="pill ${s.Fail ? 'Fail' : s.Pending ? 'Pending' : 'Pass'}">${s.Fail ? s.Fail + ' fail' : s.Pending ? s.Pending + ' pending' : 'All pass'}</span>
      <span class="mono">${s.Pass}/${s.total} pass</span>
      ${fai.serial ? `<span class="chip">S/N ${esc(fai.serial)}</span>` : ''}${fai.date ? `<span class="chip">${fmtDate(fai.date)}</span>` : ''}${fai.inspector ? `<span class="chip">By ${esc(fai.inspector)}</span>` : ''}</div>
    <div class="tw"><table><thead><tr><th>#</th><th>Characteristic</th><th>Nominal</th><th>Tol −</th><th>Tol +</th><th>Measured</th><th>Instrument</th><th>Result</th></tr></thead><tbody>
    ${fai.items.map(it => { const res = faiResult(it); return `<tr${res === 'Fail' ? ' class="fail"' : ''}><td class="num">${esc(it.n)}</td><td>${esc(it.char)}</td><td class="num">${esc(it.nom)}${it.unit ? ' ' + esc(it.unit) : ''}</td><td class="num">${it.tm ? '−' + esc(String(it.tm).replace(/^-/, '')) : ''}</td><td class="num">${it.tp ? '+' + esc(String(it.tp).replace(/^\+/, '')) : ''}</td><td class="num">${esc(it.meas)}</td><td>${esc(it.inst)}</td><td><span class="pill ${res}">${res}</span></td></tr>`; }).join('')}
    </tbody></table></div>${fai.notes ? `<div class="tb-notes">${esc(fai.notes)}</div>` : ''}</div>`;
  return h;
}

/* ---------- issues tab ---------- */
function issuesView(p) {
  const ns = ncrsOf(p.id);
  let h = `<div class="sum"><span class="hint">Problems found in testing, printing, machining or fit, with root cause and the revision that fixed them.</span><span style="flex:1"></span><button class="btn primary sm" type="button" data-act="new-ncr">+ New issue</button></div>`;
  if (!ns.length) return h + `<div class="empty"><h2>No issues logged</h2><p>When a print fails, a part is out of tolerance or a test goes wrong, log it here and link the revision that fixes it.</p></div>`;
  return h + ns.map(n => `<article class="ncr ${esc(n.status)}">
    <div class="rhead"><h3>${esc(n.title)}</h3><span class="pill ${esc(n.status)}">${esc(n.status)}</span></div>
    <div class="meta"><span class="mono">${fmtDate(n.date)}</span><span class="chip">Found in ${esc(revLabel(n.revId))}</span>${n.fixedRevId ? `<span class="chip lock">Fixed in ${esc(revLabel(n.fixedRevId))}</span>` : ''}</div>
    <div class="three"><div><div class="lbl">What happened</div><div class="prose">${esc(n.description || '—')}</div></div>
      <div><div class="lbl">Root cause</div><div class="prose">${esc(n.rootCause || '—')}</div></div>
      <div><div class="lbl">Corrective action</div><div class="prose">${esc(n.action || '—')}</div></div></div>
    <div class="racts"><button class="btn sm" type="button" data-act="edit-ncr" data-id="${esc(n.id)}">Edit</button><button class="btn sm danger" type="button" data-act="del-ncr" data-id="${esc(n.id)}">Delete</button></div>
  </article>`).join('');
}

/* ================= overlays ================= */
function openOv(html) { const o = $('#ov'); o.innerHTML = html; o.hidden = false; const f = o.querySelector('input:not([type=file]),textarea,select,button'); if (f) f.focus(); }
function closeOv() {
  const o = $('#ov'); o.hidden = true; o.innerHTML = '';
  if (form) ['imgs', 'files'].forEach(k => (form[k] || []).forEach(i => i.preview && URL.revokeObjectURL(i.preview)));
  form = null;
}
function setErr(m) { const e = $('#ov .err'); if (e) e.textContent = m || ''; }
const panel = (title, body, submit, opts = {}) => `<form class="panel${opts.narrow ? ' narrow' : ''}" id="${opts.id || 'fm'}" novalidate>
  <div class="panel-h"><h2>${title}</h2><button class="btn ghost sm" type="button" data-act="close">Close</button></div>
  <div class="panel-b">${body}</div>
  <div class="panel-f"><span class="err"></span><button class="btn" type="button" data-act="close">Cancel</button><button class="btn primary" type="submit">${submit}</button></div></form>`;
function busy(label) { const b = $('#ov button[type=submit]'); if (b) { b.disabled = true; b.textContent = label; } }
function unbusy(label) { const b = $('#ov button[type=submit]'); if (b) { b.disabled = false; b.textContent = label; } }

/* ---------- part form ---------- */
const TYPES = {
  part: { label: 'Part', title: 'part', desc: 'A Fusion 360 body or component: material, parameters, inspection.', name: 'Motor mount bracket', notes: 'Design intent, constraints, mating parts' },
  assembly: { label: 'Assembly', title: 'assembly', desc: 'Parts and quantities, with a warning when a component changes.', name: 'Propulsion pod', notes: 'What it does, how it goes together' },
  pcb: { label: 'PCB', title: 'PCB', desc: 'A KiCad board: BOM import and diff, fab orders, board serials.', name: 'Flight controller', notes: 'Function, interfaces, power budget' },
};
function partForm(p, preset) {
  p = p || Object.assign({ type: 'part' }, preset || {});
  const type = TYPES[p.type] ? p.type : 'part', fixed = !!(p.id && revsOf(p.id).length);
  form = { kind: 'part', id: p.id || null, type, autoNo: !p.id || !p.partNo, components: (p.components || []).map(c => ({ ...c })), after: preset && preset.after };
  const f = (types, cls, html) => `<div class="f ${cls}" data-types="${types}">${html}</div>`;
  openOv(panel(`<span id="p-title">${p.id ? 'Edit' : 'New'} ${TYPES[type].title}</span>`, `
    <div class="typepick" role="radiogroup" aria-label="Type">${Object.entries(TYPES).map(([k, t]) => `
      <label class="tp${k === type ? ' on' : ''}${fixed && k !== type ? ' off' : ''}"><input type="radio" name="p-type" id="p-type-${k}" value="${k}"${k === type ? ' checked' : ''}${fixed && k !== type ? ' disabled' : ''}>
        <span class="tp-l">${t.label}</span><span class="tp-d">${t.desc}</span></label>`).join('')}</div>
    ${fixed ? '<span class="hint">The type is fixed because this item already has revisions.</span>' : ''}
    <div class="grid">
      ${f('part assembly pcb', 's2', `<label for="p-name">Name</label><input id="p-name" value="${esc(p.name)}" placeholder="${esc(TYPES[type].name)}" required>`)}
      ${f('part assembly pcb', 's2', `<label for="p-no">Part no. <span id="p-auto" class="hint" style="text-transform:none;letter-spacing:0;font-weight:400">${form.autoNo ? '· auto' : ''}</span></label><input id="p-no" class="mono" value="${esc(p.partNo)}" placeholder="Fills from name and project"><button class="linkbtn" type="button" data-act="regen-no" style="align-self:flex-start;font-size:12px">Regenerate</button>`)}
      ${f('part assembly pcb', 's2', `<label for="p-proj">Project</label><input id="p-proj" value="${esc(p.project)}" placeholder="Project or programme" list="p-proj-list"><datalist id="p-proj-list">${[...new Set(D.parts.map(x => x.project).filter(Boolean))].map(x => `<option value="${esc(x)}">`).join('')}</datalist>`)}
      ${f('part', '', `<label for="p-mat">Material</label><input id="p-mat" value="${esc(p.material)}" placeholder="Al 6061-T6, PETG…">`)}
      ${f('part assembly', '', `<label for="p-units">Units</label><select id="p-units">${['mm', 'in', 'm'].map(u => `<option${(p.units || 'mm') === u ? ' selected' : ''}>${u}</option>`).join('')}</select>`)}
      ${f('part assembly', 's2', `<label for="p-doc">Fusion 360 design name</label><input id="p-doc" value="${esc(p.fusionDoc)}" placeholder="Matches captures from the Fusion add-in">`)}
      ${f('part assembly', 's2', `<label for="p-url">Fusion 360 link</label><input id="p-url" value="${esc(p.fusionUrl)}" placeholder="https://a360.co/…" inputmode="url">`)}
      ${f('pcb', 's2', `<label for="p-kicad">KiCad project</label><input id="p-kicad" value="${esc(p.kicadProject)}" placeholder="flight_controller.kicad_pro">`)}
      ${f('pcb', 's2', `<label for="p-link">Project link</label><input id="p-link" value="${esc(p.link)}" placeholder="https://github.com/… (repo or shared folder)" inputmode="url">`)}
      ${f('part assembly pcb', 's4', `<label for="p-notes">Notes</label><textarea id="p-notes" placeholder="${esc(TYPES[type].notes)}">${esc(p.notes)}</textarea>`)}
    </div>
    <div class="sec" id="comp-sec" data-types="assembly"><div class="sec-h"><div class="lbl">Components</div><button class="linkbtn" type="button" data-act="add-comp">+ Add component</button></div><div class="rows" id="crows"></div></div>`,
    p.id ? 'Save' : 'Create ' + TYPES[type].title, { id: 'pform' }));
  applyType(type, !!p.id);
  drawComps();
  if (form.autoNo) fillNo();
  setTimeout(() => { const n = $('#p-name'); if (n) n.focus(); }, 0);
}
function applyType(type, editing) {
  form.type = type;
  document.querySelectorAll('#pform [data-types]').forEach(el => { el.hidden = !el.dataset.types.split(' ').includes(type); });
  document.querySelectorAll('#pform .tp').forEach(el => el.classList.toggle('on', el.querySelector('input').value === type));
  const t = TYPES[type];
  $('#p-title').textContent = (editing ? 'Edit ' : 'New ') + t.title;
  $('#p-name').placeholder = t.name; $('#p-notes').placeholder = t.notes;
  if (!editing) $('#pform button[type=submit]').textContent = 'Create ' + t.title;
}
function drawComps() {
  const el = $('#crows'); if (!el) return;
  const opts = D.parts.filter(x => x.id !== form.id).sort((a, b) => a.name.localeCompare(b.name));
  el.innerHTML = form.components.map((c, i) => `<div class="crow">
    <select class="rowin" data-l="components" data-i="${i}" data-k="partId" id="cc-p${i}" aria-label="Component part"><option value="">Choose a part…</option>${opts.map(o => `<option value="${esc(o.id)}"${o.id === c.partId ? ' selected' : ''}>${esc(partLabel(o))}</option>`).join('')}</select>
    <input class="rowin mono" data-l="components" data-i="${i}" data-k="qty" id="cc-q${i}" value="${esc(c.qty)}" placeholder="Qty" aria-label="Quantity">
    <button class="x" type="button" data-act="rm" data-l="components" data-i="${i}" aria-label="Remove component">×</button></div>`).join('') || '<span class="hint">No components yet.</span>';
}
function fillNo() { const n = $('#p-no'); if (n && form && form.autoNo) n.value = autoPartNo($('#p-name').value, $('#p-proj').value, form.id); }
async function savePart() {
  const name = $('#p-name').value.trim(); if (!name) return setErr('Give it a name.');
  const fixUrl = v => { v = v.trim(); return v && !/^https?:\/\//i.test(v) ? 'https://' + v : v; };
  const type = form.type;
  // fields for other types are kept as they were, so switching type before saving loses nothing
  const body = { name, partNo: $('#p-no').value.trim(), type, project: $('#p-proj').value.trim(), notes: $('#p-notes').value.trim(),
    units: $('#p-units').value, material: $('#p-mat').value.trim(), fusionDoc: $('#p-doc').value.trim(), fusionUrl: fixUrl($('#p-url').value),
    kicadProject: $('#p-kicad').value.trim(), link: fixUrl($('#p-link').value),
    components: type === 'assembly' ? form.components.filter(c => c.partId).map(c => ({ partId: c.partId, qty: String(c.qty || '1').trim() || '1' })) : [],
    updatedAt: Date.now() };
  const dupNo = body.partNo && D.parts.find(x => x.id !== form.id && (x.partNo || '').toUpperCase() === body.partNo.toUpperCase());
  if (dupNo) return setErr('Part no. ' + body.partNo + ' is already used by ' + dupNo.name + '.');
  busy('Saving…');
  try {
    let id = form.id;
    if (id) await api.patch('parts', id, body);
    else { id = newId(); body.createdAt = Date.now(); await api.put('parts', id, body); sel = id; tab = 'revs'; }
    const after = form.after; closeOv(); await refresh();
    if (after) after(id);
  } catch (e) { unbusy('Save'); setErr('Couldn’t save: ' + e.message); }
}

/* ---------- revision form (full, or verification-only for released revs) ---------- */
function revForm(r, cap) {
  const p = partById(sel), rs = revsOf(sel), last = rs[rs.length - 1];
  const editing = !!(r && r.id), mode = editing && isLocked(r) ? 'tests' : 'full';
  if (!r) {
    r = { rev: nextRev(last && last.rev), date: today(), status: 'Draft', params: [], bom: [], images: [], files: [], tests: [] };
    if (cap) {
      r.fusionVer = cap.version != null ? 'v' + cap.version : '';
      const known = lastValues(sel);
      r.params = (cap.params || []).filter(cp => {
        const k = known[cp.name]; if (!k) return true;
        const a = parseFloat(k.value), b = parseFloat(cp.value);
        return !(isNaN(a) || isNaN(b) ? String(k.value) === String(cp.value) : Math.abs(a - b) < 1e-9);
      }).map(cp => ({ name: cp.name, old: known[cp.name] ? known[cp.name].value : '', new: String(cp.value), unit: cp.unit || '' }));
      if (cap.image) r.images = [{ id: cap.image.id, url: cap.image.url, tag: 'After', caption: 'Fusion capture ' + (r.fusionVer || '') }];
      if (cap.file) r.files = [cap.file];
    }
  }
  form = { kind: 'rev', mode, id: r.id || null, capId: cap ? cap.id : null, rev: r,
    params: (r.params || []).map(x => ({ ...x })), bom: (r.bom || []).map(x => ({ ...x })),
    imgs: (r.images || []).map(x => ({ ...x })), files: (r.files || []).map(x => ({ ...x })),
    tests: (r.tests || []).map(x => ({ ...x })), removedImgs: [], removedFiles: [] };
  if (mode === 'full' && !form.params.length) form.params.push({ name: '', old: '', new: '', unit: p.units || 'mm' });
  if (mode === 'tests' && !form.tests.length) form.tests.push({ method: 'Test', description: '', result: 'Pending', notes: '' });
  const testsSec = `<div class="sec"><div class="sec-h"><div class="lbl">Verification: how was this checked?</div><button class="linkbtn" type="button" data-act="add-test">+ Add check</button></div>
    <span class="hint">Thrust bench run, FEA, fit check, load test… Attach the data file if there is one.</span><div class="rows" id="trows"></div></div>`;
  if (mode === 'tests') {
    openOv(panel(`Verification · Rev ${esc(r.rev)} · ${esc(p.name)}`, `<div class="notice">Rev ${esc(r.rev)} is released, so its design content is locked. You can still record verification results.</div>${testsSec}`, 'Save verification', { id: 'rform' }));
    drawRows(); return;
  }
  openOv(panel(`${editing ? 'Edit revision ' + esc(r.rev) : 'New revision'} · ${esc(p.name)}`, `
    ${cap ? `<div class="notice">Filled from Fusion capture of ${esc(cap.fusionDoc)} ${cap.version != null ? 'v' + esc(cap.version) : ''}: ${form.params.filter(x => x.name).length} changed parameter${form.params.filter(x => x.name).length === 1 ? '' : 's'}${cap.image ? ', screenshot' : ''}${cap.file ? ', STEP file' : ''}.</div>` : ''}
    <div class="grid">
      <div class="f"><label for="r-rev">Rev</label><input id="r-rev" class="mono" value="${esc(r.rev)}" placeholder="B"></div>
      <div class="f"><label for="r-date">Date</label><input id="r-date" type="date" value="${esc(r.date)}"></div>
      <div class="f"><label for="r-fv">Fusion version</label><input id="r-fv" class="mono" value="${esc(r.fusionVer)}" placeholder="v14"></div>
      <div class="f"><label for="r-st">Status</label><select id="r-st">${Object.keys(STAT).map(k => `<option value="${k}"${r.status === k ? ' selected' : ''}>${STAT[k]}</option>`).join('')}</select></div>
      <div class="f s4"><label for="r-title">Summary</label><input id="r-title" value="${esc(r.title)}" placeholder="Thickened mounting flange, added M3 heat-set bosses"></div>
      <div class="f s2"><label for="r-what">What changed</label><textarea id="r-what" placeholder="Features added, removed or modified">${esc(r.what)}</textarea></div>
      <div class="f s2"><label for="r-why">Why</label><textarea id="r-why" placeholder="Test result, FEA, fit issue, print failure, review note">${esc(r.why)}</textarea></div>
      <div class="f s4"><label for="r-fixes">Fixes issue</label><select id="r-fixes"><option value="">None</option>${ncrsOf(sel).filter(n => n.status !== 'Closed' || n.fixedRevId === r.id).map(n => `<option value="${esc(n.id)}"${n.fixedRevId && n.fixedRevId === r.id ? ' selected' : ''}>${esc(n.title)}</option>`).join('')}</select></div>
    </div>
    <div class="notice warn" id="rel-note" hidden>Saving as Released locks this revision. Only verification and inspection results can be added afterwards.</div>
    <div class="sec" id="sec-params"${p.type === 'pcb' ? ' hidden' : ''}><div class="sec-h"><div class="lbl">Parameters</div><span>
      ${last && !editing ? '<button class="linkbtn" type="button" data-act="pull-params">Pull from Rev ' + esc(last.rev) + '</button> · ' : ''}
      <button class="linkbtn" type="button" data-act="add-param">+ Add row</button></span></div><div class="rows" id="prows"></div></div>
    <div class="sec"${p.type === 'pcb' ? ' hidden' : ''}><div class="sec-h"><div class="lbl">BOM changes</div><button class="linkbtn" type="button" data-act="add-bom">+ Add row</button></div><div class="rows" id="brows"></div></div>
    <div class="sec"><div class="sec-h"><div class="lbl">Files</div><label class="linkbtn" for="r-files" style="cursor:pointer">+ Attach files</label><input id="r-files" type="file" multiple hidden></div>
      <span class="hint">${p.type === 'pcb' ? 'KiCad project zip, Gerber/drill zip, pick-and-place, schematic PDF.' : 'STEP, F3D, STL, drawings (PDF), slicer or CAM files: whatever captures this revision.'}</span><div class="rows" id="frows"></div></div>
    ${testsSec}
    <div class="sec"><div class="sec-h"><div class="lbl">Images</div><label class="linkbtn" for="r-imgs" style="cursor:pointer">+ Add screenshots</label><input id="r-imgs" type="file" accept="image/*" multiple hidden></div>
      <span class="hint">Paste a screenshot (Ctrl/Cmd+V) or pick files.</span><div class="rows" id="irows"></div></div>`,
    editing ? 'Save revision' : 'Log revision', { id: 'rform' }));
  $('#rel-note').hidden = r.status !== 'Released';
  drawRows();
}
function drawRows() {
  const pr = $('#prows'), br = $('#brows'), ir = $('#irows'), fr = $('#frows'), tr = $('#trows');
  if (pr) pr.innerHTML = form.params.map((x, i) => `<div class="prow">
    <input class="rowin pn" data-l="params" data-i="${i}" data-k="name" value="${esc(x.name)}" placeholder="Parameter" aria-label="Parameter name" id="pp-n${i}">
    <input class="rowin mono" data-l="params" data-i="${i}" data-k="old" value="${esc(x.old)}" placeholder="Was" aria-label="Old value" id="pp-o${i}">
    <input class="rowin mono" data-l="params" data-i="${i}" data-k="new" value="${esc(x.new)}" placeholder="Now" aria-label="New value" id="pp-w${i}">
    <input class="rowin mono" data-l="params" data-i="${i}" data-k="unit" value="${esc(x.unit)}" placeholder="unit" aria-label="Unit" id="pp-u${i}">
    <button class="x" type="button" data-act="rm" data-l="params" data-i="${i}" aria-label="Remove row">×</button></div>`).join('') || '<span class="hint">No parameter rows.</span>';
  if (br) br.innerHTML = form.bom.map((x, i) => `<div class="brow">
    <select class="rowin" data-l="bom" data-i="${i}" data-k="action" aria-label="Change type" id="bb-a${i}">${['Added', 'Changed', 'Removed'].map(a => `<option${x.action === a ? ' selected' : ''}>${a}</option>`).join('')}</select>
    <input class="rowin bi" data-l="bom" data-i="${i}" data-k="item" value="${esc(x.item)}" placeholder="Item (M3x8 SHCS, 608ZZ bearing…)" aria-label="Item" id="bb-i${i}">
    <input class="rowin mono" data-l="bom" data-i="${i}" data-k="qty" value="${esc(x.qty)}" placeholder="Qty" aria-label="Quantity" id="bb-q${i}">
    <input class="rowin" data-l="bom" data-i="${i}" data-k="note" value="${esc(x.note)}" placeholder="Material / note" aria-label="Note" id="bb-n${i}">
    <button class="x" type="button" data-act="rm" data-l="bom" data-i="${i}" aria-label="Remove row">×</button></div>`).join('') || '<span class="hint">No BOM changes.</span>';
  if (fr) fr.innerHTML = form.files.map((x, i) => `<div class="frow"><span class="fpick">${esc(x.name || (x.pending && x.pending.name))}${x.pending ? ' <span class="hint">(new)</span>' : ''}</span>
    <span class="hint mono">${fmtSize(x.size != null ? x.size : x.pending && x.pending.size)}</span>
    <button class="x" type="button" data-act="rm" data-l="files" data-i="${i}" aria-label="Remove file">×</button></div>`).join('');
  if (tr) tr.innerHTML = form.tests.map((t, i) => `<div class="trow">
    <select class="rowin" data-l="tests" data-i="${i}" data-k="method" id="tt-m${i}" aria-label="Method">${METHODS.map(m => `<option${t.method === m ? ' selected' : ''}>${m}</option>`).join('')}</select>
    <input class="rowin td" data-l="tests" data-i="${i}" data-k="description" id="tt-d${i}" value="${esc(t.description)}" placeholder="What was checked (e.g. static thrust at 8000 rpm)" aria-label="What was checked">
    <select class="rowin" data-l="tests" data-i="${i}" data-k="result" id="tt-r${i}" aria-label="Result">${RESULTS.map(m => `<option${t.result === m ? ' selected' : ''}>${m}</option>`).join('')}</select>
    <input class="rowin" data-l="tests" data-i="${i}" data-k="notes" id="tt-n${i}" value="${esc(t.notes)}" placeholder="Notes / measured value" aria-label="Notes">
    ${t.file || t.pending ? `<span class="fpick" title="${esc((t.file || t.pending).name)}">${esc((t.file || t.pending).name)} <button class="linkbtn" type="button" data-act="rm-tfile" data-i="${i}">remove</button></span>`
      : `<label class="linkbtn fpick" for="tt-f${i}" style="cursor:pointer">+ Attach data</label><input type="file" id="tt-f${i}" data-tfile="${i}" hidden>`}
    <button class="x" type="button" data-act="rm" data-l="tests" data-i="${i}" aria-label="Remove check">×</button></div>`).join('') || '<span class="hint">No checks recorded.</span>';
  if (ir) ir.innerHTML = form.imgs.map((x, i) => `<div class="irow">
    <img src="${esc(x.preview || x.url)}" alt="">
    <select class="rowin" data-l="imgs" data-i="${i}" data-k="tag" aria-label="Image tag" id="ii-t${i}">${IMG_TAGS.map(a => `<option${(x.tag || 'After') === a ? ' selected' : ''}>${a}</option>`).join('')}</select>
    <input class="rowin" data-l="imgs" data-i="${i}" data-k="caption" value="${esc(x.caption)}" placeholder="Caption" aria-label="Caption" id="ii-c${i}">
    <button class="x" type="button" data-act="rm" data-l="imgs" data-i="${i}" aria-label="Remove image">×</button></div>`).join('');
}
function addImages(files) {
  for (const f of files) {
    if (!f.type.startsWith('image/')) continue;
    if (f.size > 25 * 1024 * 1024) { setErr(f.name + ' is over 25 MB; export a smaller screenshot.'); continue; }
    form.imgs.push({ file: f, preview: URL.createObjectURL(f), tag: 'After', caption: '' });
  }
  drawRows();
}
function addFiles(files) {
  for (const f of files) {
    if (f.size > 500 * 1024 * 1024) { setErr(f.name + ' is over 500 MB.'); continue; }
    form.files.push({ pending: f });
  }
  drawRows();
}
const fileRef = up => ({ id: up.id, name: up.name, size: up.size, url: up.url });
async function saveTests(b) {
  const out = [];
  for (const t of form.tests) {
    if (!(t.description || '').trim()) continue;
    let file = t.file || null;
    if (t.pending) { b.textContent = 'Uploading ' + t.pending.name + '…'; file = fileRef(await api.uploadFile(t.pending)); }
    out.push({ method: t.method || 'Test', description: t.description.trim(), result: t.result || 'Pending', notes: (t.notes || '').trim(), file });
  }
  return out;
}
async function saveRev() {
  const b = $('#rform button[type=submit]');
  if (form.mode === 'tests') {
    b.disabled = true;
    try {
      const tests = await saveTests(b);
      await api.patch('revisions', form.id, { tests, updatedAt: Date.now() });
      for (const id of form.removedFiles) await api.delFile(id);
      closeOv(); await refresh();
    } catch (e) { unbusy('Try again'); setErr('Couldn’t save: ' + e.message); }
    return;
  }
  const rev = $('#r-rev').value.trim(), title = $('#r-title').value.trim();
  if (!rev) return setErr('Enter a revision label, e.g. B or 03.');
  if (!title) return setErr('Add a one-line summary of the change.');
  if (revsOf(sel).find(r => r.rev === rev && r.id !== form.id)) return setErr('Rev ' + rev + ' already exists for this part.');
  b.disabled = true;
  try {
    const images = [], files = [];
    for (const x of form.imgs) {
      if (x.file) { b.textContent = 'Uploading images…'; const up = await api.uploadImage(x.file); images.push({ id: up.id, url: up.url, tag: x.tag || 'After', caption: x.caption || '' }); }
      else images.push({ id: x.id, url: x.url, tag: x.tag || 'After', caption: x.caption || '' });
    }
    for (const x of form.files) {
      if (x.pending) { b.textContent = 'Uploading ' + x.pending.name + '…'; files.push(fileRef(await api.uploadFile(x.pending))); }
      else files.push(fileRef(x));
    }
    const tests = await saveTests(b);
    b.textContent = 'Saving…';
    const body = { partId: sel, rev, date: $('#r-date').value, fusionVer: $('#r-fv').value.trim(), status: $('#r-st').value, title,
      what: $('#r-what').value.trim(), why: $('#r-why').value.trim(),
      params: form.params.filter(x => (x.name || '').trim()).map(x => ({ name: x.name.trim(), old: String(x.old || '').trim(), new: String(x.new || '').trim(), unit: (x.unit || '').trim() })),
      bom: form.bom.filter(x => (x.item || '').trim()).map(x => ({ action: x.action || 'Added', item: x.item.trim(), qty: (x.qty || '').trim(), note: (x.note || '').trim() })),
      images, files, tests, updatedAt: Date.now() };
    let id = form.id;
    if (id) await api.patch('revisions', id, body);
    else {
      id = newId(); body.createdAt = Date.now();
      if ((partById(sel) || {}).type === 'pcb' && window.PCB) Object.assign(body, PCB.newRevDefaults(revsOf(sel).slice(-1)[0]));
      await api.put('revisions', id, body);
    }
    const fixes = $('#r-fixes').value;
    for (const n of ncrsOf(sel)) {
      if (n.id === fixes && n.fixedRevId !== id) await api.patch('ncrs', n.id, { fixedRevId: id, status: 'Closed', updatedAt: Date.now() });
      else if (n.id !== fixes && n.fixedRevId === id) await api.patch('ncrs', n.id, { fixedRevId: '', updatedAt: Date.now() });
    }
    for (const x of form.removedImgs) await api.delImage(x);
    for (const x of form.removedFiles) await api.delFile(x);
    if (form.capId) await api.del('captures', form.capId);
    await api.patch('parts', sel, { updatedAt: Date.now() });
    tab = 'revs'; closeOv(); await refresh();
  } catch (e) { unbusy('Try again'); setErr('Couldn’t save: ' + e.message); }
}

/* ---------- FAI form ---------- */
function faiForm() {
  const r = revById(faiRev), p = partById(sel), fai = r.fai || {};
  const others = revsOf(sel).filter(x => x.id !== r.id && x.fai && (x.fai.items || []).length);
  form = { kind: 'fai', items: (fai.items || []).map(x => ({ ...x })) };
  if (!form.items.length) form.items.push({ n: '1', char: '', nom: '', tm: '', tp: '', unit: p.units || 'mm', meas: '', inst: '' });
  openOv(panel(`Inspection · Rev ${esc(r.rev)} · ${esc(p.name)}`, `<div class="grid">
      <div class="f"><label for="q-sn">Serial / part made</label><input id="q-sn" value="${esc(fai.serial)}" placeholder="SN-001, print #3"></div>
      <div class="f"><label for="q-date">Date</label><input id="q-date" type="date" value="${esc(fai.date || today())}"></div>
      <div class="f s2"><label for="q-by">Inspected by</label><input id="q-by" value="${esc(fai.inspector)}" placeholder="Name"></div>
      <div class="f s4"><label for="q-notes">Notes</label><textarea id="q-notes" style="min-height:52px" placeholder="Setup, temperature, fixture…">${esc(fai.notes)}</textarea></div></div>
    <div class="sec"><div class="sec-h"><div class="lbl">Characteristics</div><span>${others.length ? `<select id="q-copy" class="rowin" style="width:auto;display:inline-block"><option value="">Copy list from…</option>${others.map(o => `<option value="${esc(o.id)}">Rev ${esc(o.rev)}</option>`).join('')}</select> · ` : ''}<button class="linkbtn" type="button" data-act="add-fai">+ Add row</button></span></div>
      <span class="hint">Measured value inside nominal −tol/+tol passes. Type OK / NOK for go/no-go checks.</span>
      <div class="rows" id="qrows"></div></div>`, 'Save inspection', { id: 'qform' }));
  drawFai();
}
function drawFai() {
  const el = $('#qrows'); if (!el) return;
  el.innerHTML = `<div class="qrow hint" aria-hidden="true"><span>#</span><span>Characteristic</span><span>Nominal</span><span>Tol −</span><span>Tol +</span><span>Measured</span><span>Unit</span><span>Instrument</span><span>Result</span><span></span></div>` +
    form.items.map((x, i) => { const res = faiResult(x); return `<div class="qrow">
    ${['n', 'char', 'nom', 'tm', 'tp', 'meas', 'unit', 'inst'].map(k => `<input class="rowin${['n', 'nom', 'tm', 'tp', 'meas'].includes(k) ? ' mono' : ''}" data-l="items" data-i="${i}" data-k="${k}" id="qq-${k}${i}" value="${esc(x[k])}" aria-label="${k}" placeholder="${{ n: '#', char: 'Hole Ø, length…', nom: '0.00', tm: '0.1', tp: '0.1', meas: '', unit: 'mm', inst: 'Caliper' }[k]}">`).join('')}
    <span class="pill ${res}" id="qq-res${i}">${res}</span>
    <button class="x" type="button" data-act="rm" data-l="items" data-i="${i}" aria-label="Remove row">×</button></div>`; }).join('');
}
async function saveFai() {
  busy('Saving…');
  try {
    const items = form.items.filter(x => (x.char || '').trim() || (x.nom || '').trim()).map(x => {
      const o = {}; ['n', 'char', 'nom', 'tm', 'tp', 'meas', 'unit', 'inst'].forEach(k => { o[k] = String(x[k] || '').trim(); }); return o;
    });
    await api.patch('revisions', faiRev, { fai: { serial: $('#q-sn').value.trim(), date: $('#q-date').value, inspector: $('#q-by').value.trim(), notes: $('#q-notes').value.trim(), items }, updatedAt: Date.now() });
    closeOv(); await refresh();
  } catch (e) { unbusy('Try again'); setErr('Couldn’t save: ' + e.message); }
}

/* ---------- issue (NCR) form ---------- */
function ncrForm(n) {
  const rs = revsOf(sel); n = n || { date: today(), status: 'Open', revId: rs.length ? rs[rs.length - 1].id : '' };
  form = { kind: 'ncr', id: n.id || null };
  const revOpts = (v, none) => (none ? `<option value="">${none}</option>` : '') + rs.slice().reverse().map(r => `<option value="${esc(r.id)}"${r.id === v ? ' selected' : ''}>Rev ${esc(r.rev)}: ${esc(r.title)}</option>`).join('');
  openOv(panel(n.id ? 'Edit issue' : 'New issue', `<div class="grid">
    <div class="f s4"><label for="n-title">Issue</label><input id="n-title" value="${esc(n.title)}" placeholder="Blade root cracked at 6000 rpm"></div>
    <div class="f"><label for="n-date">Date</label><input id="n-date" type="date" value="${esc(n.date)}"></div>
    <div class="f"><label for="n-status">Status</label><select id="n-status">${['Open', 'Closed'].map(s => `<option${n.status === s ? ' selected' : ''}>${s}</option>`).join('')}</select></div>
    <div class="f s2"><label for="n-found">Found in</label><select id="n-found">${revOpts(n.revId, 'No revision')}</select></div>
    <div class="f s4"><label for="n-desc">What happened</label><textarea id="n-desc" placeholder="Symptoms, conditions, measurements">${esc(n.description)}</textarea></div>
    <div class="f s2"><label for="n-root">Root cause</label><textarea id="n-root" placeholder="5-Why: stress concentration at sharp fillet…">${esc(n.rootCause)}</textarea></div>
    <div class="f s2"><label for="n-action">Corrective action</label><textarea id="n-action" placeholder="Increase fillet to R2, change infill…">${esc(n.action)}</textarea></div>
    <div class="f s4"><label for="n-fixed">Fixed in</label><select id="n-fixed">${revOpts(n.fixedRevId, 'Not fixed yet')}</select></div></div>`,
    n.id ? 'Save issue' : 'Log issue', { id: 'nform', narrow: false }));
}
async function saveNcr() {
  const title = $('#n-title').value.trim(); if (!title) return setErr('Describe the issue in one line.');
  const body = { partId: sel, title, date: $('#n-date').value, status: $('#n-status').value, revId: $('#n-found').value,
    description: $('#n-desc').value.trim(), rootCause: $('#n-root').value.trim(), action: $('#n-action').value.trim(), fixedRevId: $('#n-fixed').value, updatedAt: Date.now() };
  busy('Saving…');
  try {
    if (form.id) await api.patch('ncrs', form.id, body);
    else { body.createdAt = Date.now(); await api.put('ncrs', newId(), body); }
    tab = 'issues'; closeOv(); await refresh();
  } catch (e) { unbusy('Try again'); setErr('Couldn’t save: ' + e.message); }
}

/* ---------- Fusion captures ---------- */
function useCapture(id) {
  const c = D.captures.find(x => x.id === id); if (!c) return;
  const match = D.parts.find(p => p.fusionDoc && p.fusionDoc.toLowerCase() === String(c.fusionDoc || '').toLowerCase());
  if (match) { sel = match.id; tab = 'revs'; render(); revForm(null, c); return; }
  form = { kind: 'cap', capId: id };
  openOv(panel('Log Fusion capture', `<p style="margin:0"><strong>${esc(c.fusionDoc)}</strong>${c.version != null ? ' v' + esc(c.version) : ''} isn’t linked to a part yet.</p>
    <div class="f"><label for="c-part">Log it as a revision of</label><select id="c-part"><option value="__new">New part: ${esc(c.fusionDoc)}</option>${D.parts.slice().sort((a, b) => a.name.localeCompare(b.name)).map(p => `<option value="${esc(p.id)}">${esc(partLabel(p))}</option>`).join('')}</select></div>
    <span class="hint">The part remembers this design name, so future captures go straight to it.</span>
    <div><button class="btn sm danger" type="button" data-act="discard-cap">Discard capture</button></div>`, 'Continue', { id: 'cform', narrow: true }));
}
async function continueCapture() {
  const c = D.captures.find(x => x.id === form.capId), v = $('#c-part').value;
  if (v === '__new') {
    closeOv();
    partForm(null, { name: c.fusionDoc, fusionDoc: c.fusionDoc, after: id => { sel = id; render(); revForm(null, D.captures.find(x => x.id === c.id) || c); } });
    return;
  }
  busy('Linking…');
  try { await api.patch('parts', v, { fusionDoc: c.fusionDoc, updatedAt: Date.now() }); sel = v; tab = 'revs'; closeOv(); await refresh(); revForm(null, c); }
  catch (e) { unbusy('Continue'); setErr('Couldn’t link: ' + e.message); }
}
async function discardCapture(id) {
  const c = D.captures.find(x => x.id === id); if (!c) return;
  if (c.image) await api.delImage(c.image.id);
  if (c.file) await api.delFile(c.file.id);
  await api.del('captures', id); closeOv(); await refresh();
}

/* ---------- export ---------- */
function changelog(p) {
  const rs = revsOf(p.id).slice().reverse();
  let s = `# ${p.name}${p.partNo ? ' (' + p.partNo + ')' : ''}\n`;
  if (p.project) s += `Project: ${p.project}  \n`; if (p.material) s += `Material: ${p.material}  \n`;
  if (p.fusionUrl) s += `Fusion: ${p.fusionUrl}  \n`;
  if (p.type === 'assembly' && (p.components || []).length) s += `Components: ${p.components.map(c => partLabel(partById(c.partId)) + ' ×' + c.qty).join(', ')}  \n`;
  rs.forEach(r => {
    s += `\n## Rev ${r.rev} — ${r.title}\n${r.date || ''}${r.fusionVer ? ' · Fusion ' + r.fusionVer : ''} · ${STAT[r.status] || r.status}\n`;
    if (r.what) s += `\n**What changed:** ${r.what}\n`; if (r.why) s += `\n**Why:** ${r.why}\n`;
    D.ncrs.filter(n => n.fixedRevId === r.id).forEach(n => { s += `\n**Fixes issue:** ${n.title}\n`; });
    const ps = (r.params || []).filter(x => x.name);
    if (ps.length) s += `\n| Parameter | Was | Now |\n|---|---|---|\n` + ps.map(x => `| ${x.name} | ${x.old} ${x.unit || ''} | ${x.new} ${x.unit || ''} |`).join('\n') + '\n';
    const bs = (r.bom || []).filter(x => x.item);
    if (bs.length) s += `\n| BOM | Item | Qty | Note |\n|---|---|---|---|\n` + bs.map(x => `| ${x.action} | ${x.item} | ${x.qty} | ${x.note} |`).join('\n') + '\n';
    const ts = (r.tests || []).filter(t => t.description);
    if (ts.length) s += `\n| Verification | Check | Result | Notes |\n|---|---|---|---|\n` + ts.map(t => `| ${t.method} | ${t.description} | ${t.result} | ${t.notes || ''} |`).join('\n') + '\n';
    const fs = faiSummary(r.fai); if (fs.total) s += `\nFirst-article inspection: ${fs.Pass}/${fs.total} pass${fs.Fail ? ', ' + fs.Fail + ' fail' : ''}\n`;
    if ((partById(r.partId) || {}).type === 'pcb' && window.PCB) s += PCB.changelog(r);
    if ((r.files || []).length) s += `\nFiles: ${r.files.map(f => f.name).join(', ')}\n`;
  });
  return s;
}

/* ================= events ================= */
let armed = null;
function arm(btn, label, fn) {
  if (armed === btn) { armed = null; fn(); return; }
  if (armed) { armed.classList.remove('armed'); armed.textContent = armed.dataset.orig; }
  armed = btn; btn.dataset.orig = btn.textContent; btn.classList.add('armed'); btn.textContent = label;
  setTimeout(() => { if (armed === btn) { btn.classList.remove('armed'); btn.textContent = btn.dataset.orig; armed = null; } }, 4000);
}
function flash(btn, text) { const o = btn.dataset.orig || btn.textContent; btn.classList.remove('armed'); btn.textContent = text; setTimeout(() => { btn.textContent = o; }, 2500); }
function openImg(key) {
  const [rid, i] = key.split(':'); const r = revById(rid); if (!r) return; const im = r.images[+i];
  form = null;
  openOv(`<div class="lb"><img src="${esc(im.url)}" alt="${esc(im.caption || im.tag)}"><div><strong>Rev ${esc(r.rev)} · ${esc(im.tag)}</strong> ${esc(im.caption)}</div><button class="btn sm" type="button" data-act="close">Close</button></div>`);
}

document.addEventListener('click', async e => {
  const pi = e.target.closest('.pitem'); if (pi) { sel = pi.dataset.pid; tab = 'revs'; showAll = false; render(); window.scrollTo(0, 0); return; }
  const go = e.target.closest('[data-goto]'); if (go) { sel = go.dataset.goto; tab = 'revs'; render(); window.scrollTo(0, 0); return; }
  const t = e.target.closest('[data-tab]'); if (t) { tab = t.dataset.tab; render(); return; }
  const fig = e.target.closest('[data-img]'); if (fig) { openImg(fig.dataset.img); return; }
  if (e.target.id === 'ov' && !form) { closeOv(); return; }
  const a = e.target.closest('[data-act]'); if (!a) return;
  const act = a.dataset.act, p = partById(sel);
  switch (act) {
    case 'new-part': partForm(); break;
    case 'back': sel = null; render(); break;
    case 'close': closeOv(); break;
    case 'show-all': showAll = true; render(); break;
    case 'edit-part': partForm(p); break;
    case 'new-rev': revForm(); break;
    case 'edit-rev': case 'edit-tests': revForm(revById(a.dataset.rid)); break;
    case 'goto-fai': faiRev = a.dataset.rid; tab = 'fai'; render(); break;
    case 'goto-issues': tab = 'issues'; render(); break;
    case 'edit-fai': faiForm(); break;
    case 'new-ncr': ncrForm(); break;
    case 'edit-ncr': ncrForm(D.ncrs.find(n => n.id === a.dataset.id)); break;
    case 'use-cap': useCapture(a.dataset.id); break;
    case 'discard-cap': arm(a, 'Confirm discard', () => discardCapture(form.capId)); break;
    case 'regen-no': form.autoNo = true; $('#p-auto').textContent = '· auto'; fillNo(); if (!$('#p-no').value) setErr('Type a part name first.'); break;
    case 'add-comp': form.components.push({ partId: '', qty: '1' }); drawComps(); break;
    case 'add-param': form.params.push({ name: '', old: '', new: '', unit: (p && p.units) || 'mm' }); drawRows(); $('#pp-n' + (form.params.length - 1)).focus(); break;
    case 'add-bom': form.bom.push({ action: 'Added', item: '', qty: '', note: '' }); drawRows(); $('#bb-i' + (form.bom.length - 1)).focus(); break;
    case 'add-test': form.tests.push({ method: 'Test', description: '', result: 'Pending', notes: '' }); drawRows(); $('#tt-d' + (form.tests.length - 1)).focus(); break;
    case 'add-fai': { const l = form.items[form.items.length - 1]; form.items.push({ n: String((parseInt(l && l.n, 10) || form.items.length) + 1), char: '', nom: '', tm: l ? l.tm : '', tp: l ? l.tp : '', unit: l ? l.unit : 'mm', meas: '', inst: l ? l.inst : '' }); drawFai(); $('#qq-char' + (form.items.length - 1)).focus(); break; }
    case 'pull-params': {
      const known = lastValues(sel), have = new Set(form.params.map(x => x.name));
      form.params = form.params.filter(x => x.name || x.old || x.new);
      Object.keys(known).forEach(n => { if (!have.has(n)) form.params.push({ name: n, old: known[n].value, new: known[n].value, unit: known[n].unit }); });
      if (!form.params.length) form.params.push({ name: '', old: '', new: '', unit: p.units || 'mm' });
      drawRows(); break;
    }
    case 'rm': {
      const l = a.dataset.l, i = +a.dataset.i, x = form[l][i];
      if (l === 'imgs') { if (x.preview) URL.revokeObjectURL(x.preview); if (x.id) form.removedImgs.push(x.id); } // deleted only when the form is saved
      if (l === 'files' && x.id) form.removedFiles.push(x.id);
      if (l === 'tests' && x.file) form.removedFiles.push(x.file.id);
      form[l].splice(i, 1);
      if (form.redraw) form.redraw(); else if (l === 'components') drawComps(); else if (l === 'items') drawFai(); else drawRows();
      break;
    }
    case 'rm-tfile': { const tt = form.tests[+a.dataset.i]; if (tt.file) form.removedFiles.push(tt.file.id); tt.file = null; tt.pending = null; drawRows(); break; }
    case 'del-rev': if (D.boards.some(b => b.revId === a.dataset.rid)) { flash(a, 'Has boards built'); break; }
      arm(a, 'Confirm delete', async () => {
      const r = revById(a.dataset.rid);
      try {
        await api.del('revisions', r.id);
        for (const im of r.images || []) await api.delImage(im.id);
        for (const f of r.files || []) await api.delFile(f.id);
        for (const t of r.tests || []) if (t.file) await api.delFile(t.file.id);
        await refresh();
      } catch (err) { flash(a, err.message); }
    }); break;
    case 'del-ncr': arm(a, 'Confirm delete', async () => { try { await api.del('ncrs', a.dataset.id); await refresh(); } catch (err) { flash(a, 'Couldn’t delete'); } }); break;
    case 'del-part': {
      if (revsOf(sel).some(isLocked)) { flash(a, 'Has released revisions'); break; }
      const n = revsOf(sel).length;
      arm(a, n ? `Delete part + ${n} rev${n > 1 ? 's' : ''}?` : 'Confirm delete', async () => {
        try {
          for (const r of revsOf(p.id)) {
            await api.del('revisions', r.id);
            for (const im of r.images || []) await api.delImage(im.id);
            for (const f of r.files || []) await api.delFile(f.id);
            for (const t of r.tests || []) if (t.file) await api.delFile(t.file.id);
          }
          for (const nc of ncrsOf(p.id)) await api.del('ncrs', nc.id);
          for (const bd of D.boards.filter(b => b.partId === p.id)) await api.del('boards', bd.id);
          for (const asm of usedIn(p.id)) await api.patch('parts', asm.id, { components: asm.components.filter(c => c.partId !== p.id) });
          await api.del('parts', p.id); sel = null; await refresh();
        } catch (err) { flash(a, 'Couldn’t delete'); }
      }); break;
    }
    case 'export': {
      const md = changelog(p);
      try { await navigator.clipboard.writeText(md); flash(a, 'Copied ✓'); }
      catch (_) {
        form = null;
        openOv(`<div class="panel"><div class="panel-h"><h2>Changelog (Markdown)</h2><button class="btn ghost sm" type="button" data-act="close">Close</button></div>
          <div class="panel-b"><span class="hint">Select all and copy.</span><textarea class="out" id="mdout" readonly>${esc(md)}</textarea></div></div>`);
        $('#mdout').select();
      }
      break;
    }
    default: if (window.PCB) PCB.onClick(act, a);
  }
});
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && !$('#ov').hidden) closeOv();
  if (e.key === 'Enter' && e.target.closest && e.target.closest('[data-img]')) openImg(e.target.closest('[data-img]').dataset.img);
});
function rowInput(el) {
  if (!form || !el.dataset.l || !form[el.dataset.l]) return false;
  form[el.dataset.l][+el.dataset.i][el.dataset.k] = el.value;
  if (el.dataset.l === 'items') { const i = +el.dataset.i, res = faiResult(form.items[i]), pill = $('#qq-res' + i); if (pill) { pill.className = 'pill ' + res; pill.textContent = res; } }
  return true;
}
document.addEventListener('input', e => {
  const el = e.target;
  if (el.id === 'q') { q = el.value.trim().toLowerCase(); showAll = false; render(); return; }
  if (form && form.kind === 'part') {
    if (el.id === 'p-no') { form.autoNo = false; $('#p-auto').textContent = ''; return; }
    if (el.id === 'p-name' || el.id === 'p-proj') { fillNo(); return; }
  }
  if (window.PCB && PCB.onInput(el)) return;
  rowInput(el);
});
document.addEventListener('change', e => {
  const el = e.target;
  if (el.id === 'fai-rev') { faiRev = el.value; render(); return; }
  if (el.name === 'p-type') { applyType(el.value, !!form.id); return; }
  if (el.id === 'r-st') { $('#rel-note').hidden = el.value !== 'Released'; return; }
  if (el.id === 'r-imgs') { addImages(el.files); el.value = ''; return; }
  if (el.id === 'r-files') { addFiles(el.files); el.value = ''; return; }
  if (el.dataset.tfile != null && el.files[0]) { form.tests[+el.dataset.tfile].pending = el.files[0]; drawRows(); return; }
  if (window.PCB && PCB.onChange(el)) return;
  if (el.id === 'q-copy' && el.value) { const src = revById(el.value); form.items = src.fai.items.map(x => ({ ...x, meas: '' })); el.value = ''; drawFai(); return; }
  rowInput(el);
});
document.addEventListener('submit', e => {
  e.preventDefault();
  ({ pform: savePart, rform: saveRev, qform: saveFai, nform: saveNcr, cform: continueCapture }[e.target.id] || (window.PCB && PCB.submit[e.target.id]) || (() => {}))();
});
document.addEventListener('paste', e => {
  if (!form || form.kind !== 'rev' || form.mode !== 'full') return;
  const fs = [...((e.clipboardData && e.clipboardData.files) || [])].filter(f => f.type.startsWith('image/'));
  if (fs.length) { e.preventDefault(); addImages(fs); }
});

/* ================= shared with pcb.js ================= */
window.CADLog = {
  get D() { return D; }, get sel() { return sel; }, get form() { return form; }, set form(v) { form = v; },
  setTab: t => { tab = t; }, api, esc, today, newId, fmtSize, fileUrl, partById, revById, revsOf, latest, isLocked,
  refresh, render, openOv, closeOv, setErr, panel, busy, unbusy, arm, flash,
};

/* ================= boot ================= */
render();
fetch('/api/info').then(r => r.json()).then(i => {
  const s = $('#where'); s.textContent = i.dataDir; s.title = 'Data folder: ' + i.dataDir + ' · ' + i.backups + ' launch backups';
  if (i.warning) { const b = $('#banner'); b.hidden = false; b.textContent = i.warning; }
}).catch(() => {});
const fail = err => { const b = $('#banner'); b.hidden = false; b.textContent = 'Can’t reach the local app (' + ((err && err.message) || 'error') + '). Check that app.py is still running, then reload.'; };
refresh().catch(fail);
// Picks up captures sent from the Fusion add-in, and edits from another tab.
setInterval(() => { if (document.visibilityState === 'visible' && $('#ov').hidden) refresh(true).catch(() => {}); }, 4000);
})();
