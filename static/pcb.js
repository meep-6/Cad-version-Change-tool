/* PCB module: KiCad BOM import and diff, fab spec and orders, board serials with bring-up and rework.
   Loaded before app.js; uses the helpers app.js exposes on window.CADLog. */
(function () {
'use strict';
const C = () => window.CADLog;
const $ = s => document.querySelector(s);
const esc = s => C().esc(s);
const BOARD_STATUS = ['Assembled', 'Bring-up', 'Working', 'Faulty', 'Retired'];
const BOARD_PILL = { Assembled: 'Draft', 'Bring-up': 'Review', Working: 'Pass', Faulty: 'Fail', Retired: '' };
const ORDER_STATUS = ['Quoted', 'Ordered', 'Shipped', 'Received'];
const CHECK_RESULTS = ['Pending', 'Pass', 'Fail', 'Skip'];
const DEFAULT_CHECKLIST = [
  { item: 'Visual inspection', expected: 'No bridges, correct polarity on diodes/caps/ICs' },
  { item: 'Power rails not shorted', expected: '> 1 kΩ to GND, unpowered' },
  { item: 'Current at first power-up', expected: 'Within expected idle current (current-limited supply)' },
  { item: '3V3 rail', expected: '3.30 V ±5%' },
  { item: 'Firmware flashes', expected: 'Programmer connects, flash verifies' },
  { item: 'Peripherals respond', expected: 'Sensors / comms / LEDs OK' },
];
let tabRev = null, buildN = 1, importDraft = null;

/* ================= helpers ================= */
const refKey = r => { const m = String(r).match(/^([A-Za-z_#]*)(\d*)(.*)$/) || ['', r, '', '']; return [m[1].toUpperCase(), +m[2] || 0, m[3]]; };
const refCmp = (a, b) => { const x = refKey(a), y = refKey(b); return x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : (x[1] - y[1]) || (x[2] < y[2] ? -1 : x[2] > y[2] ? 1 : 0); };
const shortFp = fp => String(fp || '').includes(':') ? String(fp).split(':').pop() : String(fp || '');
const lineKey = l => [l.value, l.footprint, l.mpn].join('|');
const pcbRevs = pid => C().revsOf(pid);
const boardsOf = pid => C().D.boards.filter(b => b.partId === pid).sort((a, b) => String(a.serial).localeCompare(String(b.serial), undefined, { numeric: true }));
const money = n => (Math.round(n * 100) / 100).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const num = v => { const n = parseFloat(String(v ?? '').replace(/[^\d.\-]/g, '')); return isNaN(n) ? null : n; };

function compress(refs) { // R1, R2, R3, R7 -> R1–R3, R7
  const s = refs.slice().sort(refCmp), out = [];
  for (let i = 0; i < s.length;) {
    const [p, n] = refKey(s[i]); let j = i;
    while (j + 1 < s.length && refKey(s[j + 1])[0] === p && refKey(s[j + 1])[1] === refKey(s[j])[1] + 1 && !refKey(s[j + 1])[2]) j++;
    out.push(j - i >= 2 ? s[i] + '–' + s[j] : s.slice(i, j + 1).join(', '));
    i = j + 1;
  }
  return out.join(', ');
}
function expandRefs(s) {
  const out = [];
  String(s || '').split(/[,;\s]+/).filter(Boolean).forEach(t => {
    const m = t.match(/^([A-Za-z_]+)(\d+)[-–]([A-Za-z_]+)?(\d+)$/);
    if (m && (!m[3] || m[3] === m[1]) && +m[4] >= +m[2] && +m[4] - +m[2] < 1000) { for (let i = +m[2]; i <= +m[4]; i++) out.push(m[1] + i); }
    else out.push(t);
  });
  return out;
}
function group(items) {
  const m = new Map();
  for (const it of items) {
    const k = [it.value, it.footprint, it.mpn, it.dnp ? 1 : 0].join('|');
    const g = m.get(k) || { refs: [], value: it.value || '', footprint: it.footprint || '', mpn: it.mpn || '', mfr: it.mfr || '', spn: it.spn || '', supplier: it.supplier || '', dnp: !!it.dnp, cost: it.cost || '' };
    for (const r of it.refs) if (!g.refs.includes(r)) g.refs.push(r);
    ['mfr', 'spn', 'supplier', 'cost'].forEach(f => { if (!g[f] && it[f]) g[f] = it[f]; });
    m.set(k, g);
  }
  const out = [...m.values()];
  out.forEach(g => { g.refs.sort(refCmp); g.qty = g.refs.length; });
  return out.sort((a, b) => refCmp(a.refs[0], b.refs[0]));
}
function bomStats(r) {
  const bom = r.pcbBom || [], costs = r.bomCosts || {};
  let placed = 0, cost = 0, priced = 0, fitted = 0;
  bom.forEach(l => {
    if (l.dnp) return;
    fitted++; placed += l.qty;
    const c = num(costs[lineKey(l)] ?? l.cost);
    if (c != null) { cost += c * l.qty; priced++; }
  });
  return { lines: bom.length, fitted, placed, cost, priced, dnp: bom.filter(l => l.dnp).reduce((s, l) => s + l.qty, 0) };
}
function prevWithBom(r) {
  const rs = pcbRevs(r.partId), i = rs.findIndex(x => x.id === r.id);
  for (let j = i - 1; j >= 0; j--) if ((rs[j].pcbBom || []).length) return rs[j];
  return null;
}
function refMap(bom) { const m = {}; (bom || []).forEach(l => l.refs.forEach(r => { m[r] = l; })); return m; }
function bomDiff(a, b) {
  const A = refMap(a), B = refMap(b), added = [], removed = [], changed = [];
  for (const r in B) {
    if (!A[r]) { added.push(r); continue; }
    const x = A[r], y = B[r], ch = [];
    if (x.value !== y.value) ch.push(['Value', x.value, y.value]);
    if (x.footprint !== y.footprint) ch.push(['Footprint', shortFp(x.footprint), shortFp(y.footprint)]);
    if ((x.mpn || '') !== (y.mpn || '')) ch.push(['MPN', x.mpn, y.mpn]);
    if (!!x.dnp !== !!y.dnp) ch.push(['DNP', x.dnp ? 'yes' : 'no', y.dnp ? 'yes' : 'no']);
    if (ch.length) changed.push({ ref: r, ch });
  }
  for (const r in A) if (!B[r]) removed.push(r);
  const byLine = (refs, map) => { const g = new Map(); refs.sort(refCmp).forEach(r => { const l = map[r]; const k = lineKey(l); (g.get(k) || g.set(k, { l, refs: [] }).get(k)).refs.push(r); }); return [...g.values()]; };
  changed.sort((p, q) => refCmp(p.ref, q.ref));
  return { added: byLine(added, B), removed: byLine(removed, A), changed, nAdded: added.length, nRemoved: removed.length, nChanged: changed.length };
}

/* ================= KiCad parsing ================= */
function parseCSV(text) {
  const first = text.split(/\r?\n/)[0] || '';
  const count = ch => (first.match(new RegExp(ch === '\t' ? '\t' : '\\' + ch, 'g')) || []).length;
  const delim = [',', ';', '\t'].sort((a, b) => count(b) - count(a))[0];
  const rows = []; let row = [], f = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c; }
    else if (c === '"') q = true;
    else if (c === delim) { row.push(f); f = ''; }
    else if (c === '\n') { row.push(f); rows.push(row); row = []; f = ''; }
    else if (c !== '\r') f += c;
  }
  if (f !== '' || row.length) { row.push(f); rows.push(row); }
  return rows.filter(r => r.some(x => x.trim()));
}
const FIELDS = [
  ['refs', /^(refs?|references?|designators?|ref ?des(ignators?)?)$/],
  ['value', /^(value|val|comment)$/],
  ['footprint', /^(footprint|package|pcb footprint)$/],
  ['mpn', /^(mpn|mfr\.? ?(part|pn|no\.?)( number)?|manufacturer part( number| no\.?)?|mfg\.? ?(part|pn)|part ?number|mfr ?#)$/],
  ['mfr', /^(manufacturer|mfr\.?|mfg\.?|manufacturer name)$/],
  ['spn', /(lcsc|digi-?key|mouser|farnell|newark|arrow|tme|supplier ?(part|pn|#)|spn)/],
  ['dnp', /^(dnp|dnf|do not (place|populate|fit)|exclude from bom|nofit)$/],
  ['cost', /^(unit )?(price|cost)( \(.*\))?$/],
];
function fieldOf(name) { const k = String(name).trim().toLowerCase().replace(/_/g, ' ').replace(/\s+/g, ' '); for (const [f, rx] of FIELDS) if (rx.test(k)) return f; return null; }
const truthy = v => /^(1|y|yes|true|x|dnp|dnf|excluded?)$/i.test(String(v || '').trim());

function fromCSV(text) {
  const rows = parseCSV(text);
  let hi = -1, map = null;
  for (let i = 0; i < Math.min(rows.length, 15); i++) {
    const m = {}; rows[i].forEach((h, j) => { const f = fieldOf(h); if (f && m[f] == null) { m[f] = j; if (f === 'spn') m.supplier = h.trim(); } });
    if (m.refs != null) { hi = i; map = m; break; }
  }
  if (hi < 0) throw new Error('No Reference/Designator column found. Export the BOM as CSV from KiCad (Symbol Fields Table → Export).');
  const items = [];
  for (const r of rows.slice(hi + 1)) {
    const g = f => map[f] != null ? String(r[map[f]] || '').trim() : '';
    const refs = expandRefs(g('refs')).filter(x => !x.startsWith('#'));
    if (!refs.length) continue;
    items.push({ refs, value: g('value'), footprint: g('footprint'), mpn: g('mpn'), mfr: g('mfr'), spn: g('spn'), supplier: map.supplier || '', dnp: truthy(g('dnp')), cost: g('cost') });
  }
  return items;
}
function sexpr(text) { // iterative S-expression reader
  const root = [], stack = [root]; let i = 0; const n = text.length;
  while (i < n) {
    const c = text[i];
    if (c === '(') { const l = []; stack[stack.length - 1].push(l); stack.push(l); i++; }
    else if (c === ')') { if (stack.length > 1) stack.pop(); i++; }
    else if (c === '"') { let s = ''; i++; while (i < n && text[i] !== '"') { if (text[i] === '\\' && i + 1 < n) { s += text[i + 1]; i += 2; } else s += text[i++]; } i++; stack[stack.length - 1].push(s); }
    else if (c <= ' ') i++;
    else { let s = ''; while (i < n && !/[\s()"]/.test(text[i])) s += text[i++]; stack[stack.length - 1].push(s); }
  }
  return root;
}
function walk(node, fn) { if (!Array.isArray(node)) return; fn(node); node.forEach(c => walk(c, fn)); }
function fromSch(text) {
  const sch = sexpr(text).find(x => Array.isArray(x) && x[0] === 'kicad_sch');
  if (!sch) throw new Error('Not a KiCad 6+ schematic (.kicad_sch).');
  const items = []; let unannotated = 0;
  for (const s of sch) {
    if (!Array.isArray(s) || s[0] !== 'symbol' || !s.some(c => Array.isArray(c) && c[0] === 'lib_id')) continue;
    const props = {}; let inBom = true, dnp = false; const inst = [];
    for (const c of s) {
      if (!Array.isArray(c)) continue;
      if (c[0] === 'property') props[c[1]] = c[2];
      else if (c[0] === 'in_bom' && c[1] === 'no') inBom = false;
      else if (c[0] === 'dnp' && c[1] === 'yes') dnp = true;
      else if (c[0] === 'instances') walk(c, x => { if (x[0] === 'reference') inst.push(x[1]); });
    }
    if (!inBom) continue;
    let refs = inst.length ? inst : props.Reference ? [props.Reference] : [];
    refs = refs.filter(r => r && !r.startsWith('#'));
    if (refs.some(r => /\?$/.test(r))) { unannotated++; continue; }
    if (!refs.length) continue;
    const it = { refs, value: props.Value || '', footprint: props.Footprint || '', mpn: '', mfr: '', spn: '', supplier: '', dnp, cost: '' };
    for (const k in props) { const f = fieldOf(k); if (f && ['mpn', 'mfr', 'spn', 'cost'].includes(f) && !it[f]) { it[f] = props[k]; if (f === 'spn') it.supplier = k; } if (f === 'dnp' && truthy(props[k])) it.dnp = true; }
    items.push(it);
  }
  return { items, unannotated };
}
async function importFiles(files) {
  let items = [], unannotated = 0, sch = 0;
  for (const f of files) {
    const text = await f.text();
    if (/\.kicad_sch$/i.test(f.name)) { const r = fromSch(text); items = items.concat(r.items); unannotated += r.unannotated; sch++; }
    else items = items.concat(fromCSV(text));
  }
  // multi-unit symbols repeat a reference: keep the first occurrence
  const seen = new Set(), uniq = [];
  for (const it of items) { const refs = it.refs.filter(r => !seen.has(r)); refs.forEach(r => seen.add(r)); if (refs.length) uniq.push({ ...it, refs }); }
  return { bom: group(uniq), unannotated, sch, files: files.map(f => f.name) };
}

/* ================= views ================= */
function revPicker(rs, id, label) {
  return `<label class="flabel" for="pcb-rev">${label || 'Revision'}</label><select id="pcb-rev" class="rowin" style="width:auto">${rs.slice().reverse().map(x => `<option value="${esc(x.id)}"${x.id === id ? ' selected' : ''}>Rev ${esc(x.rev)}: ${esc(x.title)}</option>`).join('')}</select>`;
}
let tabRevCount = 0;
function pickRev(rs) { // stays on the revision you picked, but jumps to the newest when one is added
  if (!tabRev || !rs.some(r => r.id === tabRev) || rs.length !== tabRevCount) tabRev = rs.length ? rs[rs.length - 1].id : null;
  tabRevCount = rs.length;
  return C().revById(tabRev);
}
const noRevs = what => `<div class="empty"><h2>No revisions yet</h2><p>Log a revision of this board first, then ${what}.</p><button class="btn primary" type="button" data-act="new-rev">+ Log Rev A</button></div>`;

function diffHtml(d, prev) {
  if (!prev) return '';
  if (!d.nAdded && !d.nRemoved && !d.nChanged) return `<div class="notice">No BOM changes from Rev ${esc(prev.rev)}.</div>`;
  const ln = x => `<li><span class="mono">${esc(compress(x.refs))}</span> ${esc(x.l.value)} <span class="hint">${esc(shortFp(x.l.footprint))}${x.l.mpn ? ' · ' + esc(x.l.mpn) : ''}</span></li>`;
  return `<div class="tblock" style="border-width:1px;border-color:var(--line)"><div class="tb-row"><span class="k-inline">Changes from Rev ${esc(prev.rev)}</span>
      <span class="chip" style="color:var(--ok);border-color:var(--ok)">+${d.nAdded} added</span><span class="chip" style="color:var(--danger);border-color:var(--danger)">−${d.nRemoved} removed</span><span class="chip warn">${d.nChanged} changed</span></div>
    <div class="three" style="padding:10px 16px">
      <div><div class="lbl bom-a">Added</div><ul class="dl">${d.added.map(ln).join('') || '<li class="hint">None</li>'}</ul></div>
      <div><div class="lbl bom-r">Removed</div><ul class="dl">${d.removed.map(ln).join('') || '<li class="hint">None</li>'}</ul></div>
      <div><div class="lbl bom-c">Changed</div><ul class="dl">${d.changed.map(c => `<li><span class="mono">${esc(c.ref)}</span> ${c.ch.map(([k, a, b]) => `${k}: <span class="was">${esc(a || '—')}</span> → ${esc(b || '—')}`).join('; ')}</li>`).join('') || '<li class="hint">None</li>'}</ul></div>
    </div></div>`;
}
function bomView(p, rs) {
  if (!rs.length) return noRevs('import its BOM from KiCad');
  const r = pickRev(rs), locked = C().isLocked(r), bom = r.pcbBom || [], st = bomStats(r), prev = prevWithBom(r), costs = r.bomCosts || {};
  let h = `<div class="sum">${revPicker(rs, r.id)}<span style="flex:1"></span>
    ${locked ? '<span class="chip lock" title="Released: the BOM is locked. Prices can still be edited.">Locked</span>' : `<label class="btn sm primary" for="pcb-import" style="cursor:pointer">Import from KiCad</label><input id="pcb-import" type="file" accept=".csv,.tsv,.txt,.kicad_sch" multiple hidden>`}
    ${!locked && bom.length ? '<button class="btn sm" type="button" data-act="pcb-edit-bom">Edit BOM</button>' : ''}
    ${bom.length ? '<button class="btn sm" type="button" data-act="pcb-prices">Edit prices</button><button class="btn sm" type="button" data-act="pcb-export">Export CSV</button>' : ''}</div>`;
  if (!bom.length) {
    const lastBom = rs.slice().reverse().find(x => x.id !== r.id && (x.pcbBom || []).length);
    return h + `<div class="empty"><h2>No BOM for Rev ${esc(r.rev)}</h2>
      <p>In KiCad 7 or 8, open the schematic and use <strong>Tools → Edit Symbol Fields</strong> (Symbol Fields Table) → <strong>Export</strong> to save a CSV. Or pick the project’s <code>.kicad_sch</code> files directly (select every sheet). MPN, Manufacturer and LCSC/Digi-Key fields are picked up automatically.</p>
      ${lastBom && !locked ? `<button class="btn" type="button" data-act="pcb-copy-bom" data-from="${esc(lastBom.id)}">Copy BOM from Rev ${esc(lastBom.rev)}</button>` : ''}</div>`;
  }
  h += diffHtml(bomDiff(prev ? prev.pcbBom : [], bom), prev);
  const n = Math.max(1, buildN | 0);
  h += `<div class="tblock" style="border-width:1px;border-color:var(--line)">
    <div class="tb-row"><span class="mono">${st.lines} lines · ${st.placed} parts placed${st.dnp ? ' · ' + st.dnp + ' DNP' : ''}</span>
      <span class="chip">${st.priced}/${st.fitted} lines priced</span>${st.priced ? `<span class="chip">BOM cost ${money(st.cost)} / board</span>` : ''}
      <span style="flex:1"></span><label class="flabel" for="pcb-n">Build</label><input id="pcb-n" class="rowin mono" type="number" min="1" value="${n}" style="width:70px"><span class="hint">boards${st.priced ? ' · ' + money(st.cost * n) + ' total' : ''}</span></div>
    <div class="tw"><table><thead><tr><th>Refs</th><th>Qty</th><th>Value</th><th>Footprint</th><th>MPN</th><th>Manufacturer</th><th>Supplier PN</th><th>Unit</th><th>Need ×${n}</th></tr></thead><tbody>
    ${bom.map(l => { const c = num(costs[lineKey(l)] ?? l.cost); return `<tr${l.dnp ? ' style="opacity:.55"' : ''}><td class="mono" style="max-width:220px">${esc(compress(l.refs))}</td><td class="num">${l.qty}</td><td>${esc(l.value)}${l.dnp ? ' <span class="pill Pending">DNP</span>' : ''}</td><td title="${esc(l.footprint)}">${esc(shortFp(l.footprint))}</td><td class="mono">${esc(l.mpn)}</td><td>${esc(l.mfr)}</td><td class="mono" title="${esc(l.supplier)}">${esc(l.spn)}</td><td class="num">${c != null ? money(c) : ''}</td><td class="num">${l.dnp ? '—' : l.qty * n}</td></tr>`; }).join('')}
    </tbody></table></div></div>`;
  return h;
}
const FAB_FIELDS = [['layers', 'Layers', '4'], ['thickness', 'Thickness', '1.6 mm'], ['size', 'Board size', '50 × 40 mm'], ['copper', 'Copper', '1 oz outer / 0.5 oz inner'],
  ['finish', 'Surface finish', 'ENIG, HASL lead-free'], ['mask', 'Solder mask / silk', 'Green / white'], ['track', 'Min track / space', '0.15 / 0.15 mm'], ['drill', 'Min drill / via', '0.3 mm'],
  ['impedance', 'Impedance control', 'None, or 50 Ω SE on L1'], ['assembly', 'Assembly', 'Self / fab PCBA, sides']];
function fabView(p, rs) {
  if (!rs.length) return noRevs('record its fab spec and orders');
  const r = pickRev(rs), locked = C().isLocked(r), fab = r.fab || {}, orders = r.orders || [], files = r.files || [];
  const spent = orders.reduce((s, o) => s + (num(o.cost) || 0), 0);
  let h = `<div class="sum">${revPicker(rs, r.id)}<span style="flex:1"></span>${locked ? '<span class="chip lock">Spec locked</span>' : '<button class="btn sm" type="button" data-act="pcb-edit-fab">Edit fab spec</button>'}<button class="btn sm primary" type="button" data-act="pcb-order">+ Add order</button></div>`;
  const filled = FAB_FIELDS.filter(([k]) => fab[k]);
  h += `<div class="tblock" style="border-width:1px;border-color:var(--line)"><div class="tb-row"><span class="k-inline">Fab spec · Rev ${esc(r.rev)}</span></div>
    ${filled.length ? `<div class="tb-grid" style="grid-template-columns:repeat(5,minmax(0,1fr))">${FAB_FIELDS.map(([k, l]) => `<div class="cell"><div class="k">${l}</div><div class="v">${esc(fab[k] || '—')}</div></div>`).join('')}</div>` : `<div class="tb-row"><span class="hint">No spec yet.${locked ? '' : ' Use Edit fab spec to record layers, thickness, finish and so on.'}</span></div>`}
    ${fab.notes ? `<div class="tb-notes">${esc(fab.notes)}</div>` : ''}
    <div class="tb-row"><span class="k-inline">Fab files</span>${files.length ? files.map(f => `<a class="file" href="${esc(C().fileUrl(f))}"><span class="fn">${esc(f.name)}</span><span class="hint mono">${C().fmtSize(f.size)}</span></a>`).join('') : `<span class="hint">Attach the Gerber/drill zip, pick-and-place and BOM to the revision’s Files${locked ? '' : ' (Edit on the revision)'}.</span>`}</div></div>`;
  h += `<div class="sum"><span class="lbl" style="margin:0">Orders</span>${orders.length ? `<span class="chip">${orders.length} order${orders.length > 1 ? 's' : ''} · ${money(spent)} spent</span>` : ''}</div>`;
  if (!orders.length) return h + `<div class="empty"><h2>No orders for Rev ${esc(r.rev)}</h2><p>Log each fab or assembly order: who made it, order number, quantity, cost and status.</p></div>`;
  return h + `<div class="tblock" style="border-width:1px;border-color:var(--line)"><div class="tw"><table><thead><tr><th>Fab</th><th>Order no.</th><th>Date</th><th>Qty</th><th>Cost</th><th>Status</th><th>Notes</th><th></th></tr></thead><tbody>
    ${orders.map((o, i) => `<tr><td>${esc(o.fab)}</td><td class="mono">${esc(o.orderNo)}</td><td class="num">${esc(o.date)}</td><td class="num">${esc(o.qty)}</td><td class="num">${esc(o.cost)}</td><td><span class="pill ${o.status === 'Received' ? 'Pass' : o.status === 'Quoted' ? 'Draft' : 'Review'}">${esc(o.status)}</span></td><td>${esc(o.notes)}</td>
      <td style="white-space:nowrap"><button class="btn sm" type="button" data-act="pcb-order" data-i="${i}">Edit</button> <button class="btn sm danger" type="button" data-act="pcb-del-order" data-i="${i}">Delete</button></td></tr>`).join('')}
    </tbody></table></div></div>`;
}
function boardsView(p, rs) {
  if (!rs.length) return noRevs('track assembled boards');
  const bs = boardsOf(p.id), counts = {};
  bs.forEach(b => { counts[b.status] = (counts[b.status] || 0) + 1; });
  let h = `<div class="sum">${BOARD_STATUS.filter(s => counts[s]).map(s => `<span class="pill ${BOARD_PILL[s]}">${counts[s]} ${esc(s)}</span>`).join('') || '<span class="hint">Each assembled board gets a serial, its revision, bring-up results and rework history.</span>'}
    <span style="flex:1"></span><button class="btn sm primary" type="button" data-act="pcb-board">+ New board</button></div>
    <div class="tblock" style="border-width:1px;border-color:var(--line)"><div class="tb-row"><span class="k-inline">Bring-up checklists</span>
    ${rs.slice().reverse().map(r => `<button class="chip" type="button" data-act="pcb-checklist" data-rid="${esc(r.id)}">Rev ${esc(r.rev)}: ${(r.bringup || []).length ? (r.bringup.length + ' checks') : 'set up'}</button>`).join('')}</div></div>`;
  if (!bs.length) return h + `<div class="empty"><h2>No boards yet</h2><p>Add a board when you assemble one. Its serial number is generated from the part number and revision.</p></div>`;
  return h + `<div class="tblock" style="border-width:1px;border-color:var(--line)"><div class="tw"><table><thead><tr><th>Serial</th><th>Rev</th><th>Status</th><th>Bring-up</th><th>Reworks</th><th>Built</th><th>Installed in</th></tr></thead><tbody>
    ${bs.map(b => { const r = C().revById(b.revId), res = b.results || [], pass = res.filter(x => x.result === 'Pass').length, fail = res.filter(x => x.result === 'Fail').length, tot = res.filter(x => x.result !== 'Skip').length;
      return `<tr style="cursor:pointer" data-act="pcb-board" data-id="${esc(b.id)}"><td class="mono"><strong>${esc(b.serial)}</strong></td><td class="num">${r ? esc(r.rev) : '—'}</td><td><span class="pill ${BOARD_PILL[b.status] || ''}">${esc(b.status)}</span></td>
        <td>${tot ? `<span class="mono">${pass}/${tot}</span>${fail ? ` <span class="pill Fail">${fail} fail</span>` : ''}` : '<span class="hint">—</span>'}</td><td class="num">${(b.reworks || []).length || ''}</td><td class="num">${esc(b.date)}</td><td>${esc(b.location)}</td></tr>`; }).join('')}
    </tbody></table></div></div>`;
}

/* ================= forms ================= */
function bomForm(r) {
  C().form = { kind: 'pcbbom', rid: r.id, lines: (r.pcbBom || []).map(l => ({ ...l, refs: l.refs.join(', '), dnp: l.dnp ? 'Yes' : 'No' })), redraw: drawBom };
  C().openOv(C().panel(`Edit BOM · Rev ${esc(r.rev)}`, `<span class="hint">Lines with identical value, footprint and MPN merge on save. References accept ranges like R1-R4.</span>
    <div class="sec"><div class="sec-h"><div class="lbl">Lines</div><button class="linkbtn" type="button" data-act="pcb-add-line">+ Add line</button></div><div class="rows" id="lrows"></div></div>`, 'Save BOM', { id: 'pcbbomform' }));
  drawBom();
}
function drawBom() {
  const f = C().form, el = $('#lrows'); if (!el) return;
  el.innerHTML = f.lines.map((l, i) => `<div class="lrow">${[['refs', 'R1, R2'], ['value', 'Value'], ['footprint', 'Footprint'], ['mpn', 'MPN'], ['mfr', 'Manufacturer'], ['spn', 'Supplier PN']].map(([k, ph]) => `<input class="rowin${k === 'refs' || k === 'mpn' || k === 'spn' ? ' mono' : ''}" data-l="lines" data-i="${i}" data-k="${k}" id="ll-${k}${i}" value="${esc(l[k])}" placeholder="${ph}" aria-label="${ph}">`).join('')}
    <select class="rowin" data-l="lines" data-i="${i}" data-k="dnp" id="ll-dnp${i}" aria-label="Do not place">${['No', 'Yes'].map(v => `<option value="${v}"${l.dnp === v ? ' selected' : ''}>${v === 'Yes' ? 'DNP' : 'Fit'}</option>`).join('')}</select>
    <button class="x" type="button" data-act="rm" data-l="lines" data-i="${i}" aria-label="Remove line">×</button></div>`).join('') || '<span class="hint">No lines.</span>';
}
async function saveBom() {
  const f = C().form;
  const items = f.lines.map(l => ({ ...l, refs: expandRefs(l.refs), dnp: l.dnp === 'Yes' })).filter(l => l.refs.length);
  const all = items.flatMap(l => l.refs), dup = all.find((r, i) => all.indexOf(r) !== i);
  if (dup) return C().setErr(dup + ' appears on more than one line.');
  await save(() => C().api.patch('revisions', f.rid, { pcbBom: group(items), updatedAt: Date.now() }));
}
function pricesForm(r) {
  const costs = r.bomCosts || {};
  C().form = { kind: 'pcbprice', rid: r.id, lines: (r.pcbBom || []).filter(l => !l.dnp).map(l => ({ key: lineKey(l), label: l.value, fp: shortFp(l.footprint), mpn: l.mpn, qty: l.qty, cost: costs[lineKey(l)] ?? l.cost ?? '' })), redraw: () => {} };
  C().openOv(C().panel(`Unit prices · Rev ${esc(r.rev)}`, `<span class="hint">Price per part. Prices stay editable after release.</span>
    <div class="rows">${C().form.lines.map((l, i) => `<div class="frow"><span class="fpick">${esc(l.label)} <span class="hint">${esc(l.fp)}${l.mpn ? ' · ' + esc(l.mpn) : ''} · ×${l.qty}</span></span><input class="rowin mono" style="width:110px" data-l="lines" data-i="${i}" data-k="cost" id="pc-${i}" value="${esc(l.cost)}" placeholder="0.00" inputmode="decimal" aria-label="Unit price"><span></span></div>`).join('')}</div>`, 'Save prices', { id: 'pcbpriceform', narrow: true }));
}
async function savePrices() {
  const f = C().form, out = {};
  f.lines.forEach(l => { if (String(l.cost).trim() !== '') out[l.key] = String(l.cost).trim(); });
  await save(() => C().api.patch('revisions', f.rid, { bomCosts: out, updatedAt: Date.now() }));
}
function fabForm(r) {
  const fab = r.fab || {};
  C().form = { kind: 'pcbfab', rid: r.id };
  C().openOv(C().panel(`Fab spec · Rev ${esc(r.rev)}`, `<div class="grid">${FAB_FIELDS.map(([k, l, ph]) => `<div class="f s2"><label for="fab-${k}">${l}</label><input id="fab-${k}" value="${esc(fab[k])}" placeholder="${esc(ph)}"></div>`).join('')}
    <div class="f s4"><label for="fab-notes">Notes</label><textarea id="fab-notes" placeholder="Stackup, panelisation, special requests">${esc(fab.notes)}</textarea></div></div>`, 'Save spec', { id: 'pcbfabform' }));
}
async function saveFab() {
  const f = C().form, fab = {};
  FAB_FIELDS.forEach(([k]) => { const v = $('#fab-' + k).value.trim(); if (v) fab[k] = v; });
  const n = $('#fab-notes').value.trim(); if (n) fab.notes = n;
  await save(() => C().api.patch('revisions', f.rid, { fab, updatedAt: Date.now() }));
}
function orderForm(r, i) {
  const o = i != null ? r.orders[i] : { date: C().today(), status: 'Ordered', qty: '5' };
  C().form = { kind: 'pcborder', rid: r.id, i };
  C().openOv(C().panel(`${i != null ? 'Edit' : 'New'} order · Rev ${esc(r.rev)}`, `<div class="grid">
    <div class="f s2"><label for="o-fab">Fab / assembler</label><input id="o-fab" value="${esc(o.fab)}" placeholder="JLCPCB, PCBWay, local fab"></div>
    <div class="f s2"><label for="o-no">Order no.</label><input id="o-no" class="mono" value="${esc(o.orderNo)}"></div>
    <div class="f"><label for="o-date">Date</label><input id="o-date" type="date" value="${esc(o.date)}"></div>
    <div class="f"><label for="o-qty">Qty</label><input id="o-qty" class="mono" value="${esc(o.qty)}"></div>
    <div class="f"><label for="o-cost">Cost</label><input id="o-cost" class="mono" value="${esc(o.cost)}" placeholder="incl. shipping"></div>
    <div class="f"><label for="o-st">Status</label><select id="o-st">${ORDER_STATUS.map(s => `<option${o.status === s ? ' selected' : ''}>${s}</option>`).join('')}</select></div>
    <div class="f s4"><label for="o-notes">Notes</label><input id="o-notes" value="${esc(o.notes)}" placeholder="PCB only / PCBA, stencil, colour…"></div></div>`, i != null ? 'Save order' : 'Add order', { id: 'pcborderform', narrow: true }));
}
async function saveOrder() {
  const f = C().form, r = C().revById(f.rid), orders = (r.orders || []).slice();
  const o = { fab: $('#o-fab').value.trim(), orderNo: $('#o-no').value.trim(), date: $('#o-date').value, qty: $('#o-qty').value.trim(), cost: $('#o-cost').value.trim(), status: $('#o-st').value, notes: $('#o-notes').value.trim() };
  if (!o.fab) return C().setErr('Who is making it? Enter the fab or assembler.');
  if (f.i != null) orders[f.i] = o; else orders.push(o);
  await save(() => C().api.patch('revisions', f.rid, { orders, updatedAt: Date.now() }));
}
function checklistForm(r) {
  const others = pcbRevs(r.partId).filter(x => x.id !== r.id && (x.bringup || []).length);
  C().form = { kind: 'pcbcheck', rid: r.id, items: (r.bringup || []).map(x => ({ ...x })), redraw: drawChecks };
  if (!C().form.items.length) C().form.items = DEFAULT_CHECKLIST.map(x => ({ ...x }));
  C().openOv(C().panel(`Bring-up checklist · Rev ${esc(r.rev)}`, `<span class="hint">The checks every board of this revision goes through. ${(r.bringup || []).length ? '' : 'Starting from a typical list; edit to suit.'}</span>
    <div class="sec"><div class="sec-h"><div class="lbl">Checks</div><span>${others.length ? `<select id="pcb-copy-check" class="rowin" style="width:auto;display:inline-block"><option value="">Copy from…</option>${others.map(o => `<option value="${esc(o.id)}">Rev ${esc(o.rev)}</option>`).join('')}</select> · ` : ''}<button class="linkbtn" type="button" data-act="pcb-add-check">+ Add check</button></span></div><div class="rows" id="krows"></div></div>`, 'Save checklist', { id: 'pcbcheckform' }));
  drawChecks();
}
function drawChecks() {
  const el = $('#krows'); if (!el) return;
  el.innerHTML = C().form.items.map((x, i) => `<div class="crow" style="grid-template-columns:1fr 1fr 30px">
    <input class="rowin" data-l="items" data-i="${i}" data-k="item" id="kk-i${i}" value="${esc(x.item)}" placeholder="Check" aria-label="Check">
    <input class="rowin" data-l="items" data-i="${i}" data-k="expected" id="kk-e${i}" value="${esc(x.expected)}" placeholder="Expected result" aria-label="Expected">
    <button class="x" type="button" data-act="rm" data-l="items" data-i="${i}" aria-label="Remove check">×</button></div>`).join('') || '<span class="hint">No checks.</span>';
}
async function saveChecks() {
  const f = C().form, items = f.items.filter(x => (x.item || '').trim()).map(x => ({ item: x.item.trim(), expected: (x.expected || '').trim() }));
  await save(() => C().api.patch('revisions', f.rid, { bringup: items, updatedAt: Date.now() }));
}
function nextSerial(p, r) {
  const pre = (p.partNo || 'PCB') + '-' + (r ? r.rev : '') ;
  let max = 0; boardsOf(p.id).forEach(b => { if (String(b.serial).startsWith(pre)) { const m = String(b.serial).slice(pre.length).match(/^(\d+)$/); if (m) max = Math.max(max, +m[1]); } });
  return pre + String(max + 1).padStart(2, '0');
}
function mergeResults(r, results) {
  const have = {}; (results || []).forEach(x => { have[x.item] = x; });
  const out = (r && r.bringup || []).map(c => Object.assign({ item: c.item, expected: c.expected, result: 'Pending', value: '', notes: '' }, have[c.item] || {}, { expected: c.expected }));
  (results || []).forEach(x => { if (!out.some(o => o.item === x.item)) out.push({ ...x }); });
  return out;
}
function boardForm(p, b) {
  const rs = pcbRevs(p.id), r0 = b ? C().revById(b.revId) : rs[rs.length - 1];
  b = b || { serial: nextSerial(p, r0), revId: r0.id, date: C().today(), status: 'Assembled' };
  C().form = { kind: 'pcbboard', id: b.id || null, autoSerial: !b.id, results: mergeResults(r0, b.results), reworks: (b.reworks || []).map(x => ({ ...x })), redraw: drawBoard };
  C().openOv(C().panel(b.id ? 'Board ' + esc(b.serial) : 'New board · ' + esc(p.name), `<div class="grid">
    <div class="f"><label for="b-sn">Serial</label><input id="b-sn" class="mono" value="${esc(b.serial)}"></div>
    <div class="f"><label for="b-rev">Revision</label><select id="b-rev">${rs.slice().reverse().map(r => `<option value="${esc(r.id)}"${r.id === b.revId ? ' selected' : ''}>Rev ${esc(r.rev)}</option>`).join('')}</select></div>
    <div class="f"><label for="b-date">Built</label><input id="b-date" type="date" value="${esc(b.date)}"></div>
    <div class="f"><label for="b-st">Status</label><select id="b-st">${BOARD_STATUS.map(s => `<option${b.status === s ? ' selected' : ''}>${s}</option>`).join('')}</select></div>
    <div class="f s2"><label for="b-by">Assembled by</label><input id="b-by" value="${esc(b.by)}" placeholder="Self, JLCPCB PCBA…"></div>
    <div class="f s2"><label for="b-loc">Installed in</label><input id="b-loc" value="${esc(b.location)}" placeholder="Airframe #2, test bench…"></div>
    <div class="f s4"><label for="b-notes">Notes</label><textarea id="b-notes" style="min-height:52px">${esc(b.notes)}</textarea></div></div>
    <div class="sec"><div class="sec-h"><div class="lbl">Bring-up</div><button class="linkbtn" type="button" data-act="pcb-checklist-from-board">Edit checklist</button></div><div class="rows" id="brrows"></div></div>
    <div class="sec"><div class="sec-h"><div class="lbl">Reworks &amp; bodges</div><button class="linkbtn" type="button" data-act="pcb-add-rework">+ Add rework</button></div><div class="rows" id="rwrows"></div></div>
    ${b.id ? '<div><button class="btn sm danger" type="button" data-act="pcb-del-board">Delete board</button></div>' : ''}`, b.id ? 'Save board' : 'Add board', { id: 'pcbboardform' }));
  drawBoard();
}
function drawBoard() {
  const f = C().form, br = $('#brrows'), rw = $('#rwrows'); if (!br) return;
  br.innerHTML = f.results.map((x, i) => `<div class="brrow"><div style="min-width:0"><div style="font-weight:500">${esc(x.item)}</div><div class="hint">${esc(x.expected)}</div></div>
    <select class="rowin" data-l="results" data-i="${i}" data-k="result" id="br-r${i}" aria-label="Result">${CHECK_RESULTS.map(v => `<option${x.result === v ? ' selected' : ''}>${v}</option>`).join('')}</select>
    <input class="rowin mono" data-l="results" data-i="${i}" data-k="value" id="br-v${i}" value="${esc(x.value)}" placeholder="Measured" aria-label="Measured value">
    <input class="rowin" data-l="results" data-i="${i}" data-k="notes" id="br-n${i}" value="${esc(x.notes)}" placeholder="Notes" aria-label="Notes"></div>`).join('') || '<span class="hint">No checklist for this revision yet. Use Edit checklist.</span>';
  rw.innerHTML = f.reworks.map((x, i) => `<div class="crow" style="grid-template-columns:150px 1fr 30px">
    <input class="rowin" type="date" data-l="reworks" data-i="${i}" data-k="date" id="rw-d${i}" value="${esc(x.date)}" aria-label="Date">
    <input class="rowin" data-l="reworks" data-i="${i}" data-k="description" id="rw-t${i}" value="${esc(x.description)}" placeholder="Bodge wire U3.5 → R12, swapped C7 to 10 µF…" aria-label="Rework">
    <button class="x" type="button" data-act="rm" data-l="reworks" data-i="${i}" aria-label="Remove rework">×</button></div>`).join('') || '<span class="hint">None.</span>';
}
async function saveBoard() {
  const f = C().form, sel = C().sel, serial = $('#b-sn').value.trim();
  if (!serial) return C().setErr('Give the board a serial.');
  if (boardsOf(sel).some(b => b.serial === serial && b.id !== f.id)) return C().setErr('Serial ' + serial + ' is already used.');
  const body = { partId: sel, serial, revId: $('#b-rev').value, date: $('#b-date').value, status: $('#b-st').value, by: $('#b-by').value.trim(), location: $('#b-loc').value.trim(), notes: $('#b-notes').value.trim(),
    results: f.results.map(x => ({ item: x.item, expected: x.expected, result: x.result || 'Pending', value: (x.value || '').trim(), notes: (x.notes || '').trim() })),
    reworks: f.reworks.filter(x => (x.description || '').trim()).map(x => ({ date: x.date, description: x.description.trim() })), updatedAt: Date.now() };
  await save(async () => { if (f.id) await C().api.patch('boards', f.id, body); else { body.createdAt = Date.now(); await C().api.put('boards', C().newId(), body); } });
}
async function save(fn) {
  C().busy('Saving…');
  try { await fn(); C().closeOv(); await C().refresh(); }
  catch (e) { C().unbusy('Try again'); C().setErr('Couldn’t save: ' + e.message); }
}
function importPreview(r, res) {
  const prev = prevWithBom(r) || (r.pcbBom && r.pcbBom.length ? r : null);
  const base = r.pcbBom && r.pcbBom.length ? r : prev;
  importDraft = { rid: r.id, bom: res.bom };
  C().form = { kind: 'pcbimport' };
  const st = bomStats({ pcbBom: res.bom });
  C().openOv(C().panel(`Import BOM · Rev ${esc(r.rev)}`, `<div class="notice">Read ${esc(res.files.join(', '))}: <strong>${st.lines} lines, ${st.placed} parts placed</strong>${st.dnp ? ', ' + st.dnp + ' DNP' : ''}.</div>
    ${res.unannotated ? `<div class="notice warn">${res.unannotated} symbol${res.unannotated > 1 ? 's are' : ' is'} not annotated (R?) and ${res.unannotated > 1 ? 'were' : 'was'} skipped. Annotate the schematic in KiCad and import again.</div>` : ''}
    ${res.sch === 1 ? '<div class="notice warn">Only one .kicad_sch was selected. If the design has hierarchical sheets, select all of them together.</div>' : ''}
    ${base ? diffHtml(bomDiff(base.pcbBom, res.bom), base === r ? { rev: r.rev + ' (current)' } : base) : ''}
    <div class="tw"><table><thead><tr><th>Refs</th><th>Qty</th><th>Value</th><th>Footprint</th><th>MPN</th></tr></thead><tbody>${res.bom.slice(0, 200).map(l => `<tr><td class="mono">${esc(compress(l.refs))}</td><td class="num">${l.qty}</td><td>${esc(l.value)}${l.dnp ? ' <span class="pill Pending">DNP</span>' : ''}</td><td>${esc(shortFp(l.footprint))}</td><td class="mono">${esc(l.mpn)}</td></tr>`).join('')}</tbody></table></div>`,
    r.pcbBom && r.pcbBom.length ? 'Replace BOM' : 'Save BOM', { id: 'pcbimportform' }));
}
async function saveImport() {
  const d = importDraft, costs = {};
  d.bom.forEach(l => { if (l.cost) costs[lineKey(l)] = l.cost; });
  const r = C().revById(d.rid), inherited = {};
  pcbRevs(r.partId).forEach(x => Object.assign(inherited, x.bomCosts || {})); // newer revisions win
  const keep = {};
  d.bom.forEach(l => { const k = lineKey(l), v = (r.bomCosts || {})[k] ?? costs[k] ?? inherited[k]; if (v != null && v !== '') keep[k] = v; });
  await save(() => C().api.patch('revisions', d.rid, { pcbBom: d.bom, bomCosts: keep, updatedAt: Date.now() }));
}
function exportCsv(r) {
  const costs = r.bomCosts || {}, q = v => /[",\n]/.test(v) ? '"' + String(v).replace(/"/g, '""') + '"' : String(v ?? '');
  const rows = [['Reference', 'Qty', 'Value', 'Footprint', 'MPN', 'Manufacturer', 'Supplier PN', 'DNP', 'Unit price']]
    .concat((r.pcbBom || []).map(l => [l.refs.join(', '), l.qty, l.value, l.footprint, l.mpn, l.mfr, l.spn, l.dnp ? 'DNP' : '', costs[lineKey(l)] ?? l.cost ?? '']));
  const blob = new Blob([rows.map(x => x.map(q).join(',')).join('\r\n')], { type: 'text/csv' });
  const p = C().partById(r.partId), a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = `${(p.partNo || p.name).replace(/[^\w.-]+/g, '_')}_Rev${r.rev}_BOM.csv`;
  document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
}

/* ================= hooks used by app.js ================= */
window.PCB = {
  tabs: ['bom', 'fab', 'boards'],
  view(tab, p, rs) { return tab === 'bom' ? bomView(p, rs) : tab === 'fab' ? fabView(p, rs) : boardsView(p, rs); },
  revExtra(r) {
    const st = bomStats(r), prev = prevWithBom(r), bs = C().D.boards.filter(b => b.revId === r.id), fab = r.fab || {}, ords = r.orders || [];
    const d = prev && st.lines ? bomDiff(prev.pcbBom, r.pcbBom) : null;
    const chips = [];
    chips.push(st.lines ? `<button class="chip" type="button" data-act="pcb-goto" data-ptab="bom" data-rid="${esc(r.id)}">BOM ${st.lines} lines · ${st.placed} parts${d ? ` · +${d.nAdded} −${d.nRemoved} ~${d.nChanged}` : ''}</button>`
      : `<button class="chip warn" type="button" data-act="pcb-goto" data-ptab="bom" data-rid="${esc(r.id)}">No BOM imported</button>`);
    if (fab.layers || fab.finish) chips.push(`<button class="chip" type="button" data-act="pcb-goto" data-ptab="fab" data-rid="${esc(r.id)}">${esc([fab.layers && fab.layers + 'L', fab.thickness, fab.finish].filter(Boolean).join(' · '))}</button>`);
    if (ords.length) chips.push(`<button class="chip" type="button" data-act="pcb-goto" data-ptab="fab" data-rid="${esc(r.id)}">${ords.length} order${ords.length > 1 ? 's' : ''}</button>`);
    if (bs.length) chips.push(`<button class="chip${bs.some(b => b.status === 'Faulty') ? ' warn' : ''}" type="button" data-act="pcb-goto" data-ptab="boards">${bs.length} board${bs.length > 1 ? 's' : ''}${bs.some(b => b.status === 'Faulty') ? ', ' + bs.filter(b => b.status === 'Faulty').length + ' faulty' : ''}</button>`);
    return `<div class="links">${chips.join('')}</div>`;
  },
  newRevDefaults(last) { const o = {}; if (last && last.fab) o.fab = { ...last.fab }; if (last && last.bringup) o.bringup = last.bringup.map(x => ({ ...x })); return o; },
  revText(r) { return (r.pcbBom || []).map(l => l.refs.join(' ') + ' ' + l.value + ' ' + l.mpn + ' ' + l.footprint).join(' ') + ' ' + (r.orders || []).map(o => o.fab + ' ' + o.orderNo).join(' '); },
  boardHits(pid, q) { return boardsOf(pid).filter(b => [b.serial, b.location, b.notes, (b.reworks || []).map(x => x.description).join(' ')].join(' ').toLowerCase().includes(q)).length; },
  boardsFor: rid => C().D.boards.filter(b => b.revId === rid),
  changelog(r) {
    const st = bomStats(r), prev = prevWithBom(r); let s = '';
    if (st.lines) {
      s += `\nBOM: ${st.lines} lines, ${st.placed} parts${st.priced ? `, ${money(st.cost)} per board` : ''}\n`;
      if (prev) { const d = bomDiff(prev.pcbBom, r.pcbBom);
        d.added.forEach(x => { s += `- Added ${compress(x.refs)}: ${x.l.value} ${shortFp(x.l.footprint)}\n`; });
        d.removed.forEach(x => { s += `- Removed ${compress(x.refs)}: ${x.l.value}\n`; });
        d.changed.forEach(c => { s += `- ${c.ref}: ${c.ch.map(([k, a, b]) => `${k} ${a || '—'} → ${b || '—'}`).join('; ')}\n`; }); }
    }
    const fab = r.fab || {}; if (Object.keys(fab).length) s += `\nFab: ${FAB_FIELDS.filter(([k]) => fab[k]).map(([k, l]) => l + ' ' + fab[k]).join(', ')}\n`;
    return s;
  },
  submit: { pcbbomform: saveBom, pcbpriceform: savePrices, pcbfabform: saveFab, pcborderform: saveOrder, pcbcheckform: saveChecks, pcbboardform: saveBoard, pcbimportform: saveImport },
  onClick(act, a) {
    const p = C().partById(C().sel), r = C().revById(tabRev), f = C().form;
    switch (act) {
      case 'pcb-goto': if (a.dataset.rid) tabRev = a.dataset.rid; C().setTab(a.dataset.ptab); C().render(); return true;
      case 'pcb-edit-bom': bomForm(r); return true;
      case 'pcb-prices': pricesForm(r); return true;
      case 'pcb-export': exportCsv(r); return true;
      case 'pcb-copy-bom': { const src = C().revById(a.dataset.from); C().api.patch('revisions', r.id, { pcbBom: src.pcbBom, bomCosts: src.bomCosts || {}, updatedAt: Date.now() }).then(C().refresh).catch(e => C().flash(a, e.message)); return true; }
      case 'pcb-add-line': f.lines.push({ refs: '', value: '', footprint: '', mpn: '', mfr: '', spn: '', dnp: 'No' }); drawBom(); $('#ll-refs' + (f.lines.length - 1)).focus(); return true;
      case 'pcb-edit-fab': fabForm(r); return true;
      case 'pcb-order': orderForm(r, a.dataset.i != null ? +a.dataset.i : null); return true;
      case 'pcb-del-order': C().arm(a, 'Confirm delete', () => { const o = (r.orders || []).slice(); o.splice(+a.dataset.i, 1); C().api.patch('revisions', r.id, { orders: o, updatedAt: Date.now() }).then(C().refresh); }); return true;
      case 'pcb-checklist': checklistForm(C().revById(a.dataset.rid)); return true;
      case 'pcb-checklist-from-board': { const rev = C().revById($('#b-rev').value); checklistForm(rev); return true; }
      case 'pcb-add-check': f.items.push({ item: '', expected: '' }); drawChecks(); $('#kk-i' + (f.items.length - 1)).focus(); return true;
      case 'pcb-board': boardForm(p, a.dataset.id ? C().D.boards.find(b => b.id === a.dataset.id) : null); return true;
      case 'pcb-add-rework': f.reworks.push({ date: C().today(), description: '' }); drawBoard(); $('#rw-t' + (f.reworks.length - 1)).focus(); return true;
      case 'pcb-del-board': C().arm(a, 'Confirm delete', () => { C().api.del('boards', f.id).then(() => { C().closeOv(); return C().refresh(); }); }); return true;
    }
    return false;
  },
  onChange(el) {
    if (el.id === 'pcb-rev') { tabRev = el.value; C().render(); return true; }
    if (el.id === 'pcb-n') { buildN = Math.max(1, parseInt(el.value, 10) || 1); C().render(); const n = $('#pcb-n'); if (n) n.focus(); return true; }
    if (el.id === 'pcb-import' && el.files.length) {
      const r = C().revById(tabRev), files = [...el.files]; el.value = '';
      importFiles(files).then(res => { if (!res.bom.length) throw new Error('No components found in ' + files.map(f => f.name).join(', ') + '.'); importPreview(r, res); })
        .catch(e => { const b = $('#banner'); b.hidden = false; b.textContent = 'BOM import failed: ' + e.message; setTimeout(() => { b.hidden = true; }, 8000); });
      return true;
    }
    if (el.id === 'pcb-copy-check' && el.value) { const src = C().revById(el.value); C().form.items = src.bringup.map(x => ({ ...x })); el.value = ''; drawChecks(); return true; }
    if (el.id === 'b-rev') { const f = C().form; f.results = mergeResults(C().revById(el.value), f.results.filter(x => x.result !== 'Pending' || x.value || x.notes)); if (f.autoSerial) $('#b-sn').value = nextSerial(C().partById(C().sel), C().revById(el.value)); drawBoard(); return true; }
    return false;
  },
  onInput(el) { if (el.id === 'b-sn' && C().form) C().form.autoSerial = false; return false; },
  // exposed for tests
  _parse: { fromCSV, fromSch, group, bomDiff, compress, expandRefs },
};
})();
