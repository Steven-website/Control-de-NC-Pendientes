// ============================================================
//  Control de NC Pendientes — App principal
// ============================================================
import {
  COLUMNS, COLUMN_KEYS, ALL_COLUMNS, DERIVED, withDerived, parseDate, PATHS,
} from './schema.js';
import { readParquet, writeParquet } from './parquet.js';
import * as gh from './github.js';

// ---------- Helpers DOM ----------
const $  = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const pad = n => String(n).padStart(2, '0');

function toast(msg, type = '') {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'toast ' + type;
  t.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { t.hidden = true; }, 3200);
}

// Formatea fecha (Date/serial/ISO) a YYYY-MM-DD (en UTC, para serial de Excel)
function isoDate(v) {
  const d = parseDate(v);
  if (!d) return v == null ? '' : String(v);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

function fmtCell(value, col) {
  if (value === null || value === undefined || value === '') return '';
  if (col.type === 'date') return isoDate(value);
  if (col.type === 'number') {
    const n = Number(value);
    return isFinite(n) ? n.toLocaleString('es-CR', { maximumFractionDigits: 2 }) : String(value);
  }
  return String(value);
}

// ---------- Estado global ----------
const state = {
  session: null,    // { user, name, role }
  data: [],         // filas consolidadas (columnas base)
  users: [],        // usuarios
  pending: null,    // filas pendientes de confirmar carga
};

// ---------- Persistencia local (respaldo sin token) ----------
const LS = {
  get(k) { try { return JSON.parse(localStorage.getItem('ncpend_' + k)); } catch { return null; } },
  set(k, v) { try { localStorage.setItem('ncpend_' + k, JSON.stringify(v)); return true; } catch { return false; } },
};

// ---------- Hash de contraseña ----------
async function hashPassword(pw) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(pw));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

// ============================================================
//  USUARIOS
// ============================================================
async function defaultUsers() {
  return [{
    user: 'master', name: 'Administrador Master', role: 'master',
    active: true, hash: await hashPassword('master123'),
  }];
}

async function loadUsers() {
  let txt = null;
  try {
    if (gh.hasToken()) { const f = await gh.getFile(PATHS.usuarios, false); txt = f && f.content; }
    if (!txt) { const r = await fetch(PATHS.usuarios + '?t=' + Date.now()); if (r.ok) txt = await r.text(); }
  } catch { /* ignora */ }

  let users = null;
  if (txt) { try { users = JSON.parse(txt); } catch { users = null; } }
  if (!users || !users.length) users = LS.get('users');
  if (!users || !users.length) users = await defaultUsers();
  state.users = users;
}

async function saveUsers() {
  LS.set('users', state.users);
  if (gh.hasToken()) {
    await gh.putFile(PATHS.usuarios, JSON.stringify(state.users, null, 2), 'Actualizar usuarios');
    return 'github';
  }
  return 'local';
}

// ============================================================
//  DATOS CONSOLIDADOS
// ============================================================
async function loadConsolidado() {
  let buf = null;
  try {
    if (gh.hasToken()) { const f = await gh.getFile(PATHS.consolidado, true); buf = f && f.content; }
    if (!buf) { const r = await fetch(PATHS.consolidado + '?t=' + Date.now()); if (r.ok) buf = await r.arrayBuffer(); }
  } catch { /* ignora */ }

  if (buf && buf.byteLength) {
    try { state.data = await readParquet(buf); }
    catch (e) { console.error(e); state.data = LS.get('data') || []; }
  } else {
    state.data = LS.get('data') || [];
  }
}

async function saveConsolidado(rows, msg) {
  state.data = rows;
  LS.set('data', rows);
  if (gh.hasToken()) {
    const buf = await writeParquet(rows);            // guarda solo columnas base
    await gh.putFile(PATHS.consolidado, buf, msg || 'Actualizar consolidado');
    return 'github';
  }
  return 'local';
}

// ============================================================
//  CONSOLIDACIÓN (merge por clave)
// ============================================================
function rowKey(r) {
  return [r['NO_DOCU'], r['NO_LINEA'], r['PK_ARTICULOS']].join('|');
}

function mergeRows(existing, incoming, replace) {
  if (replace) return incoming.slice();
  const map = new Map();
  for (const r of existing) map.set(rowKey(r), r);
  for (const r of incoming) map.set(rowKey(r), { ...map.get(rowKey(r)), ...r });
  return [...map.values()];
}

// ============================================================
//  EXCEL (plantilla, importación, exportación)
// ============================================================
function downloadTemplate() {
  // Encabezados = columnas creadas + base (incluye ANTIGÜEDAD calculada vacía)
  const headers = ALL_COLUMNS.map(c => c.key);
  const ws = XLSX.utils.aoa_to_sheet([headers]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'NC');
  XLSX.writeFile(wb, 'Plantilla_Control_NC.xlsx');
  toast('Plantilla descargada', 'ok');
}

function parseExcel(arrayBuffer) {
  const wb = XLSX.read(arrayBuffer, { type: 'array', cellDates: true });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const json = XLSX.utils.sheet_to_json(ws, { defval: null, raw: true });
  return json.map(raw => {
    const row = {};
    for (const col of COLUMNS) {
      let v = raw[col.key];
      if (v === undefined) v = null;
      if (col.type === 'date' && v != null && v !== '') v = isoDate(v);
      if ((v == null || v === '') && col.default !== undefined) v = col.default;
      row[col.key] = v;
    }
    return row;
  }).filter(r => r['NO_DOCU'] != null || r['NO_ARTI'] != null); // descarta filas vacías
}

function exportExcel() {
  const rows = state.data.map(withDerived);
  const headers = ALL_COLUMNS.map(c => c.key);
  const aoa = [headers, ...rows.map(r => headers.map(h => {
    const col = ALL_COLUMNS.find(c => c.key === h);
    return col.type === 'date' ? isoDate(r[h]) : r[h];
  }))];
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Consolidado');
  XLSX.writeFile(wb, `Consolidado_NC_${isoDate(new Date())}.xlsx`);
  toast('Consolidado exportado a Excel', 'ok');
}

async function exportParquet() {
  try {
    const rows = state.data.map(withDerived);            // incluye ANTIGÜEDAD recalculada hoy
    const keys = ALL_COLUMNS.map(c => c.key);
    const buf = await writeParquet(rows, keys);
    const blob = new Blob([buf], { type: 'application/octet-stream' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `Consolidado_NC_${isoDate(new Date())}.parquet`;
    a.click();
    URL.revokeObjectURL(a.href);
    toast('Consolidado exportado a Parquet', 'ok');
  } catch (e) { toast('Error al generar Parquet: ' + e.message, 'err'); }
}

// ============================================================
//  RENDER — Dashboard
// ============================================================
function groupCount(rows, key) {
  const m = new Map();
  for (const r of rows) {
    const k = r[key] || '(sin dato)';
    m.set(k, (m.get(k) || 0) + 1);
  }
  return [...m.entries()].sort((a, b) => b[1] - a[1]);
}

function renderBars(el, entries, max) {
  const top = entries.slice(0, 6);
  const maxVal = Math.max(1, ...top.map(e => e[1]));
  el.innerHTML = top.map(([label, val]) => `
    <div class="bar-row">
      <span title="${label}">${String(label).length > 18 ? String(label).slice(0, 18) + '…' : label}</span>
      <div class="bar-track"><div class="bar-fill" style="width:${(val / maxVal) * 100}%"></div></div>
      <span class="bar-val">${val}</span>
    </div>`).join('') || '<p class="muted">Sin datos</p>';
}

function renderDashboard() {
  const d = state.data;
  const pend = d.filter(r => (r['ENVIADO_CXP'] || 'Pendiente') === 'Pendiente').length;
  const env  = d.filter(r => r['ENVIADO_CXP'] === 'Enviado').length;
  const costo = d.reduce((s, r) => s + (Number(r['COST_TOTAL']) || 0), 0);
  const docs = new Set(d.map(r => r['NO_DOCU'])).size;

  $('#kpi-total').textContent = d.length.toLocaleString('es-CR');
  $('#kpi-pend').textContent  = pend.toLocaleString('es-CR');
  $('#kpi-env').textContent   = env.toLocaleString('es-CR');
  $('#kpi-costo').textContent = '₡' + costo.toLocaleString('es-CR', { maximumFractionDigits: 0 });
  $('#kpi-docs').textContent  = docs.toLocaleString('es-CR');

  renderBars($('#chart-tipo'), groupCount(d, 'TIPO DOC'));
  renderBars($('#chart-familia'), groupCount(d, 'FAMILIA'));

  // Movimientos recientes (por fecha desc)
  const recientes = [...d].sort((a, b) => {
    const da = parseDate(a['FECHA_MOVIMIENTO']), db = parseDate(b['FECHA_MOVIMIENTO']);
    return (db ? db.getTime() : 0) - (da ? da.getTime() : 0);
  }).slice(0, 8);
  $('#proximas-body').innerHTML = recientes.map(r => `
    <tr>
      <td>${r['NO_DOCU'] ?? ''}</td>
      <td>${isoDate(r['FECHA_MOVIMIENTO'])}</td>
      <td>${r['TIPO DOC'] ?? ''}</td>
      <td>${r['PROVEEDOR'] ?? ''}</td>
      <td>${r['DESCRIPCION'] ?? ''}</td>
      <td>₡${(Number(r['COST_TOTAL']) || 0).toLocaleString('es-CR')}</td>
    </tr>`).join('') || '<tr><td colspan="6" class="muted" style="text-align:center">Sin datos</td></tr>';
}

// ============================================================
//  RENDER — Consolidado
// ============================================================
let consFilter = { q: '', tipo: '' };

function renderConsolidado() {
  const head = $('#consolidado-head');
  const body = $('#consolidado-body');
  head.innerHTML = '<tr>' + ALL_COLUMNS.map(c => `<th>${c.label}</th>`).join('') + '</tr>';

  // poblar filtro de tipo doc
  const sel = $('#filter-tipo');
  const tipos = [...new Set(state.data.map(r => r['TIPO DOC']).filter(Boolean))].sort();
  sel.innerHTML = '<option value="">Todos los tipos de doc</option>' +
    tipos.map(t => `<option value="${t}">${t}</option>`).join('');
  sel.value = consFilter.tipo;

  const q = consFilter.q.toLowerCase();
  let rows = state.data.map(withDerived);
  if (consFilter.tipo) rows = rows.filter(r => r['TIPO DOC'] === consFilter.tipo);
  if (q) rows = rows.filter(r => ALL_COLUMNS.some(c => String(r[c.key] ?? '').toLowerCase().includes(q)));

  $('#consolidado-empty').hidden = state.data.length > 0;
  body.innerHTML = rows.slice(0, 500).map(r => '<tr>' +
    ALL_COLUMNS.map(c => `<td>${fmtCell(r[c.key], c)}</td>`).join('') + '</tr>').join('');
  if (rows.length > 500) {
    body.innerHTML += `<tr><td colspan="${ALL_COLUMNS.length}" class="muted" style="text-align:center">Mostrando 500 de ${rows.length} filas. Usa búsqueda/filtros o exporta el archivo completo.</td></tr>`;
  }
}

// ============================================================
//  RENDER — Usuarios
// ============================================================
function renderUsuarios() {
  const body = $('#usuarios-body');
  body.innerHTML = state.users.map((u, i) => `
    <tr>
      <td><b>${u.user}</b></td>
      <td>${u.name}</td>
      <td><span class="badge ${u.role === 'master' ? 'badge-master' : 'badge-user'}">${u.role}</span></td>
      <td><span class="badge ${u.active ? 'badge-on' : 'badge-off'}">${u.active ? 'Activo' : 'Inactivo'}</span></td>
      <td>
        <button class="icon-btn" data-edit="${i}" title="Editar">✏️</button>
        ${u.user === 'master' ? '' : `<button class="icon-btn" data-del="${i}" title="Eliminar">🗑️</button>`}
      </td>
    </tr>`).join('');
}

// ============================================================
//  NAVEGACIÓN / VISTAS
// ============================================================
const TITLES = { dashboard: 'Tablero', consolidado: 'Consolidado', cargar: 'Cargar / Plantilla', usuarios: 'Control de Usuarios', config: 'Configuración' };

function showView(name) {
  $$('.nav-item').forEach(b => b.classList.toggle('active', b.dataset.view === name));
  $$('.view').forEach(v => v.hidden = v.dataset.view !== name);
  $('#page-title').textContent = TITLES[name] || name;
  if (name === 'dashboard') renderDashboard();
  if (name === 'consolidado') renderConsolidado();
  if (name === 'usuarios') renderUsuarios();
  if (name === 'config') loadConfigForm();
}

function applyRole() {
  const isMaster = state.session && state.session.role === 'master';
  $$('.admin-only').forEach(el => el.hidden = !isMaster);
  $('#user-name').textContent = state.session.name;
  $('#user-role').textContent = state.session.role;
  $('#user-avatar').textContent = (state.session.name || '?').charAt(0).toUpperCase();
}

// ============================================================
//  CONFIG (GitHub)
// ============================================================
function loadConfigForm() {
  const c = gh.getConfig();
  $('#cfg-owner').value = c.owner || 'Steven-website';
  $('#cfg-repo').value = c.repo || 'Control-de-NC-Pendientes';
  $('#cfg-branch').value = c.branch || 'main';
  $('#cfg-token').value = c.token || '';
}

function updateSyncPill() {
  const pill = $('#sync-status');
  if (gh.hasToken()) { pill.textContent = '● GitHub'; pill.className = 'sync-pill ok'; }
  else { pill.textContent = '● Local'; pill.className = 'sync-pill'; }
}

// ============================================================
//  EVENTOS
// ============================================================
function bindEvents() {
  // Login
  $('#login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const u = $('#login-user').value.trim();
    const p = $('#login-pass').value;
    const err = $('#login-error');
    err.hidden = true;
    try {
      const user = state.users.find(x => x.user.toLowerCase() === u.toLowerCase());
      if (!user || !user.active) throw new Error('Usuario no válido o inactivo.');
      if ((await hashPassword(p)) !== user.hash) throw new Error('Contraseña incorrecta.');
      state.session = { user: user.user, name: user.name, role: user.role };
      sessionStorage.setItem('ncpend_session', JSON.stringify(state.session));
      enterApp();
    } catch (ex) { err.textContent = ex.message; err.hidden = false; }
  });

  // Logout
  $('#logout-btn').addEventListener('click', () => {
    sessionStorage.removeItem('ncpend_session');
    state.session = null;
    $('#app-view').hidden = true;
    $('#login-view').hidden = false;
    $('#login-form').reset();
  });

  // Navegación
  $$('.nav-item').forEach(b => b.addEventListener('click', () => showView(b.dataset.view)));

  // Plantilla / export
  $('#download-template').addEventListener('click', downloadTemplate);
  $('#export-excel').addEventListener('click', exportExcel);
  $('#export-parquet').addEventListener('click', exportParquet);

  // Filtros consolidado
  $('#search-input').addEventListener('input', e => { consFilter.q = e.target.value; renderConsolidado(); });
  $('#filter-tipo').addEventListener('change', e => { consFilter.tipo = e.target.value; renderConsolidado(); });

  // Carga de archivo
  const dz = $('#dropzone'), fi = $('#file-input');
  dz.addEventListener('dragover', e => { e.preventDefault(); dz.classList.add('drag'); });
  dz.addEventListener('dragleave', () => dz.classList.remove('drag'));
  dz.addEventListener('drop', e => { e.preventDefault(); dz.classList.remove('drag'); if (e.dataTransfer.files[0]) handleFile(e.dataTransfer.files[0]); });
  fi.addEventListener('change', e => { if (e.target.files[0]) handleFile(e.target.files[0]); });
  $('#confirm-upload').addEventListener('click', confirmUpload);

  // Usuarios
  $('#add-user-btn').addEventListener('click', () => openUserModal());
  $('#usuarios-body').addEventListener('click', (e) => {
    const ed = e.target.closest('[data-edit]'); const dl = e.target.closest('[data-del]');
    if (ed) openUserModal(Number(ed.dataset.edit));
    if (dl) deleteUser(Number(dl.dataset.del));
  });
  $('#user-form').addEventListener('submit', saveUserForm);
  $$('[data-close]').forEach(b => b.addEventListener('click', () => { $('#user-modal').hidden = true; }));

  // Config
  $('#config-form').addEventListener('submit', (e) => {
    e.preventDefault();
    gh.setConfig({
      owner: $('#cfg-owner').value.trim(),
      repo: $('#cfg-repo').value.trim(),
      branch: $('#cfg-branch').value.trim() || 'main',
      token: $('#cfg-token').value.trim(),
    });
    updateSyncPill();
    toast('Configuración guardada', 'ok');
  });
  $('#test-conn').addEventListener('click', async () => {
    const st = $('#config-status'); st.textContent = 'Probando...';
    try {
      gh.setConfig({
        owner: $('#cfg-owner').value.trim(), repo: $('#cfg-repo').value.trim(),
        branch: $('#cfg-branch').value.trim() || 'main', token: $('#cfg-token').value.trim(),
      });
      const name = await gh.testConnection();
      st.textContent = '✓ Conectado a ' + name;
      updateSyncPill();
    } catch (ex) { st.textContent = '✗ ' + ex.message; }
  });
}

// ---------- Carga de archivo ----------
function handleFile(file) {
  const reader = new FileReader();
  reader.onload = (e) => {
    try {
      const rows = parseExcel(e.target.result);
      state.pending = rows;
      const sum = $('#upload-summary');
      sum.className = 'upload-summary';
      sum.hidden = false;
      sum.innerHTML = `<b>${file.name}</b><br>${rows.length} filas detectadas y validadas.`;
      $('#confirm-upload').disabled = rows.length === 0;
    } catch (ex) {
      const sum = $('#upload-summary');
      sum.className = 'upload-summary err'; sum.hidden = false;
      sum.textContent = 'Error al leer el archivo: ' + ex.message;
      $('#confirm-upload').disabled = true;
    }
  };
  reader.readAsArrayBuffer(file);
}

async function confirmUpload() {
  if (!state.pending) return;
  const replace = $('#replace-mode').checked;
  const btn = $('#confirm-upload');
  btn.disabled = true; btn.textContent = 'Consolidando...';
  try {
    const merged = mergeRows(state.data, state.pending, replace);
    const where = await saveConsolidado(merged, `Carga consolidada (${state.pending.length} filas)`);
    state.pending = null;
    $('#upload-summary').hidden = true;
    $('#file-input').value = '';
    toast(where === 'github' ? 'Consolidado guardado en GitHub ✓' : 'Consolidado guardado localmente (sin token)', where === 'github' ? 'ok' : '');
    showView('dashboard');
  } catch (ex) {
    toast('Error al guardar: ' + ex.message, 'err');
  } finally {
    btn.disabled = false; btn.textContent = 'Consolidar y guardar';
  }
}

// ---------- Usuarios modal ----------
function openUserModal(index) {
  const isEdit = index !== undefined;
  const u = isEdit ? state.users[index] : null;
  $('#user-modal-title').textContent = isEdit ? 'Editar usuario' : 'Nuevo usuario';
  $('#uf-original').value = isEdit ? u.user : '';
  $('#uf-user').value = isEdit ? u.user : '';
  $('#uf-user').disabled = isEdit;
  $('#uf-name').value = isEdit ? u.name : '';
  $('#uf-role').value = isEdit ? u.role : 'usuario';
  $('#uf-pass').value = '';
  $('#uf-pass-hint').textContent = isEdit ? '(dejar vacío para no cambiar)' : '';
  $('#uf-active').checked = isEdit ? u.active : true;
  $('#user-modal').hidden = false;
}

async function saveUserForm(e) {
  e.preventDefault();
  const orig = $('#uf-original').value;
  const userName = $('#uf-user').value.trim();
  const name = $('#uf-name').value.trim();
  const role = $('#uf-role').value;
  const pass = $('#uf-pass').value;
  const active = $('#uf-active').checked;

  if (orig) {
    const u = state.users.find(x => x.user === orig);
    u.name = name; u.role = role; u.active = active;
    if (pass) u.hash = await hashPassword(pass);
  } else {
    if (state.users.some(x => x.user.toLowerCase() === userName.toLowerCase())) { toast('Ese usuario ya existe', 'err'); return; }
    if (!pass) { toast('La contraseña es obligatoria', 'err'); return; }
    state.users.push({ user: userName, name, role, active, hash: await hashPassword(pass) });
  }
  try {
    const where = await saveUsers();
    $('#user-modal').hidden = true;
    renderUsuarios();
    toast(where === 'github' ? 'Usuario guardado en GitHub ✓' : 'Usuario guardado localmente', where === 'github' ? 'ok' : '');
  } catch (ex) { toast('Error al guardar usuario: ' + ex.message, 'err'); }
}

async function deleteUser(index) {
  const u = state.users[index];
  if (u.user === 'master') { toast('No se puede eliminar el master principal', 'err'); return; }
  if (!confirm(`¿Eliminar al usuario "${u.user}"?`)) return;
  state.users.splice(index, 1);
  try { await saveUsers(); renderUsuarios(); toast('Usuario eliminado', 'ok'); }
  catch (ex) { toast('Error: ' + ex.message, 'err'); }
}

// ============================================================
//  ARRANQUE
// ============================================================
async function enterApp() {
  $('#login-view').hidden = true;
  $('#app-view').hidden = false;
  applyRole();
  updateSyncPill();
  showView('dashboard');
  await loadConsolidado();
  showView('dashboard');
}

async function init() {
  $('#year').textContent = new Date().getFullYear();
  bindEvents();
  await loadUsers();

  // restaurar sesión
  const saved = sessionStorage.getItem('ncpend_session');
  if (saved) {
    try {
      state.session = JSON.parse(saved);
      const u = state.users.find(x => x.user === state.session.user);
      if (u && u.active) { await enterApp(); return; }
    } catch { /* nada */ }
  }
  $('#login-view').hidden = false;
}

init();
