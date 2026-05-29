// ============================================================
//  Control de NC Pendientes — App principal
// ============================================================
import {
  COLUMNS, COLUMN_KEYS, ALL_COLUMNS, DERIVED, CREATED_KEYS, CREATED_COLUMNS, EXPORT_COLUMNS,
  withDerived, parseDate, PATHS,
} from './schema.js?v=8';
import * as gh from './github.js?v=8';

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

// Comparador para ordenar columnas: texto A→Z (con acentos), números y fechas.
function cmpVals(a, b, col) {
  const ea = (a == null || a === ''), eb = (b == null || b === '');
  if (ea && eb) return 0;
  if (ea) return 1;          // vacíos al final
  if (eb) return -1;
  if (col && col.type === 'number') return (Number(a) || 0) - (Number(b) || 0);
  if (col && col.type === 'date') {
    const da = parseDate(a), db = parseDate(b);
    return (da ? da.getTime() : 0) - (db ? db.getTime() : 0);
  }
  return String(a).localeCompare(String(b), 'es', { numeric: true, sensitivity: 'base' });
}

// ---------- Estado global ----------
const state = {
  session: null,    // { user, name, role }
  data: [],         // filas consolidadas (columnas base)
  historico: [],    // filas que salieron de la base (respaldo)
  users: [],        // usuarios
  pending: null,    // filas pendientes (Cargar/Plantilla → Guardar cambios)
  pendingBase: null, // filas pendientes (Base original → Cargar base)
};

// ---------- Persistencia local (respaldo / caché) ----------
const LS = {
  get(k) { try { return JSON.parse(localStorage.getItem('ncpend_' + k)); } catch { return null; } },
  set(k, v) { try { localStorage.setItem('ncpend_' + k, JSON.stringify(v)); return true; } catch { return false; } },
};

// ---------- Supabase (almacenamiento de datos en la nube) ----------
const SB_URL = 'https://rhxpkcltbpbzcojninbs.supabase.co';
const SB_KEY = 'sb_publishable_LpNR48o_Ue9Bp8Ufnkgz3A_l2rjZ2do';
const SB_TABLE = 'nc_pendientes';
let _sb = null;
function sb() {
  if (!_sb) {
    if (typeof supabase === 'undefined') throw new Error('No se cargó la librería de Supabase (revisa tu conexión)');
    _sb = supabase.createClient(SB_URL, SB_KEY);
  }
  return _sb;
}

// Lee filas de la tabla. archivado=false → vigentes; true → histórico.
// familias (opcional) limita a esas familias.
async function sbFetch(archivado, familias) {
  const c = sb();
  const all = [];
  let from = 0; const size = 1000;
  for (;;) {
    let q = c.from(SB_TABLE).select('data').eq('archivado', archivado);
    if (familias && familias.length) q = q.in('familia', familias);
    const { data, error } = await q.range(from, from + size - 1);
    if (error) throw new Error(error.message);
    for (const row of data) all.push(row.data);
    if (data.length < size) break;
    from += size;
  }
  return all;
}

// Inserta/actualiza filas (por clave id). archivado marca vigente/histórico.
async function sbUpsert(rows, archivado) {
  if (!rows.length) return;
  const c = sb();
  const payload = rows.map(r => ({
    id: rowKey(r), familia: r['FAMILIA'] ?? null, archivado, data: r, updated_at: new Date().toISOString(),
  }));
  for (let i = 0; i < payload.length; i += 500) {
    const { error } = await c.from(SB_TABLE).upsert(payload.slice(i, i + 500), { onConflict: 'id' });
    if (error) throw new Error(error.message);
  }
}

// ---------- Actividad de usuarios (última conexión / guardados) ----------
async function sbLogConexion(usuario) {
  try {
    await sb().from('actividad_usuarios')
      .upsert({ usuario, ultima_conexion: new Date().toISOString() }, { onConflict: 'usuario' });
  } catch (e) { console.error('actividad conexión:', e); }
}
async function sbLogGuardado(usuario, detalle) {
  try {
    const c = sb();
    const { data } = await c.from('actividad_usuarios').select('guardados').eq('usuario', usuario).maybeSingle();
    const n = (data && data.guardados) || 0;
    await c.from('actividad_usuarios')
      .upsert({ usuario, ultimo_guardado: new Date().toISOString(), guardados: n + 1, detalle: detalle || null }, { onConflict: 'usuario' });
  } catch (e) { console.error('actividad guardado:', e); }
}
async function sbActividad() {
  const { data, error } = await sb().from('actividad_usuarios').select('*');
  if (error) throw new Error(error.message);
  return data || [];
}

// ---------- Bloqueo global (modo mantenimiento: desactivar/activar usuarios) ----------
async function sbGetLock() {
  try {
    const { data } = await sb().from('config').select('bloqueado').eq('id', 1).maybeSingle();
    return !!(data && data.bloqueado);
  } catch (e) { console.error('lock get:', e); return false; }
}
async function sbSetLock(val) {
  const { error } = await sb().from('config').upsert({ id: 1, bloqueado: val }, { onConflict: 'id' });
  if (error) throw new Error(error.message);
}

// ---------- Credenciales (cambio de contraseña + vencimiento a 6 meses) ----------
const PASS_MAX_AGE = 182 * 86400000;   // ~6 meses en ms
async function sbGetCred(usuario) {
  try {
    const { data } = await sb().from('credenciales').select('hash,cambiada_en').eq('usuario', usuario).maybeSingle();
    return data || null;
  } catch (e) { console.error('cred get:', e); return null; }
}
async function sbSetCred(usuario, hash) {
  const { error } = await sb().from('credenciales').upsert(
    { usuario, hash, cambiada_en: new Date().toISOString() }, { onConflict: 'usuario' });
  if (error) throw new Error(error.message);
}
// Devuelve la credencial vigente; si no existe, la crea con el hash actual (línea base).
async function ensureCred(usuario, hashBase) {
  let cred = await sbGetCred(usuario);
  if (!cred) { try { await sbSetCred(usuario, hashBase); } catch {} cred = { hash: hashBase, cambiada_en: new Date().toISOString() }; }
  return cred;
}

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
  const s = state.session;
  // Un usuario solo carga sus familias; el master carga todo lo vigente.
  const fams = (s && s.role !== 'master' && s.familias && s.familias.length) ? s.familias : null;
  try { state.data = await sbFetch(false, fams); LS.set('data', state.data); }
  catch (e) { console.error(e); state.data = LS.get('data') || []; }
}

// ---------- Histórico (respaldo de registros que salieron de la base) ----------
async function loadHistorico() {
  // El histórico solo lo consulta el master.
  if (!state.session || state.session.role !== 'master') { state.historico = []; return; }
  try { state.historico = await sbFetch(true); LS.set('historico', state.historico); }
  catch (e) { console.error(e); state.historico = LS.get('historico') || []; }
}

// ============================================================
//  RECONCILIACIÓN (base nueva semanal vs base anterior)
// ============================================================
function rowKey(r) {
  return [r['NO_DOCU'], r['NO_LINEA'], r['PK_ARTICULOS']].join('|');
}

// ¿El valor de un campo de seguimiento está vacío / por defecto?
function isEmptyTrack(v) {
  return v == null || v === '' || v === 'Pendiente';
}

// Reconcilia la base nueva (incoming) contra la anterior (existing):
//  - La base nueva es la verdad actual.
//  - Los registros que ya existían CONSERVAN los estados marcados por el master
//    (Enviado/Aplicado + fechas) cuando la base nueva no los trae.
//  - Los registros que ya no aparecen se devuelven en `removed` (van al histórico).
function reconcileWeekly(existing, incoming) {
  const oldMap = new Map(existing.map(r => [rowKey(r), r]));
  const incomingKeys = new Set(incoming.map(rowKey));

  const result = incoming.map(r => {
    const prev = oldMap.get(rowKey(r));
    if (!prev) return { ...r };                 // registro nuevo
    const merged = { ...r };
    for (const k of CREATED_KEYS) {
      if (isEmptyTrack(r[k]) && !isEmptyTrack(prev[k])) merged[k] = prev[k];
    }
    return merged;
  });

  const removed = existing.filter(r => !incomingKeys.has(rowKey(r)));
  return { result, removed };
}

// Une el histórico actual con los registros removidos (dedupe por clave, conserva el último).
function mergeHistorico(historico, removed) {
  const map = new Map(historico.map(r => [rowKey(r), r]));
  for (const r of removed) map.set(rowKey(r), r);
  return [...map.values()];
}

// Actualización de un USUARIO: sobre la base completa, actualiza SOLO los campos de
// seguimiento (Enviado/Aplicado + fechas) de las filas que vienen en su archivo y que
// pertenecen a SUS familias. No agrega, no borra ni archiva nada de otras familias.
function patchUserRows(existing, incoming, familias) {
  const allowed = new Set(familias || []);
  const inMap = new Map(incoming.map(r => [rowKey(r), r]));
  let updated = 0, ignored = 0;
  const rows = existing.map(prev => {
    const r = inMap.get(rowKey(prev));
    if (!r) return prev;
    if (allowed.size && !allowed.has(prev['FAMILIA'])) { ignored++; return prev; }
    const merged = { ...prev };
    for (const k of CREATED_KEYS) if (r[k] !== undefined) merged[k] = r[k];
    updated++;
    return merged;
  });
  return { rows, updated, ignored };
}

// ============================================================
//  EXCEL (importación, exportación)
// ============================================================
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

// Descarga en Excel con: orden (SQL → creadas), filtros, listas desplegables en
// las columnas de selección, y bloqueo de la información existente (solo las
// columnas creadas quedan editables). Usa ExcelJS.
async function exportExcel() {
  if (typeof ExcelJS === 'undefined') {
    toast('No se pudo cargar el generador de Excel (revisa tu conexión)', 'err');
    return;
  }
  try {
    await loadConsolidado();          // trae lo último de la nube antes de descargar
    const famMap = buildFamiliaMap();
    const rows = visibleData().map(withDerived);
    const cols = [...EXPORT_COLUMNS, COMPRADOR_COL];   // SQL → ANTIGÜEDAD → creadas → Comprador
    const editable = new Set(CREATED_COLUMNS.map(c => c.key));   // solo estas se pueden editar

    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Datos');
    // Encabezados = la CLAVE de columna (igual que el Excel del SQL) para que la
    // recarga vuelva a calzar.
    ws.columns = cols.map(c => ({ header: c.key, key: c.key, width: Math.min(28, Math.max(12, c.key.length + 4)) }));
    ws.getRow(1).font = { bold: true };
    ws.views = [{ state: 'frozen', ySplit: 1 }];
    ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: cols.length } };

    rows.forEach(r => {
      const vals = {};
      cols.forEach(c => {
        if (c.key === 'COMPRADOR') { vals[c.key] = famMap.get(r['FAMILIA']) || ''; return; }
        vals[c.key] = (c.type === 'date') ? (isoDate(r[c.key]) || null) : (r[c.key] ?? null);
      });
      ws.addRow(vals);
    });

    // Bloqueo + listas desplegables (solo filas de datos, no el encabezado)
    const lastRow = ws.rowCount;
    cols.forEach((c, i) => {
      if (!editable.has(c.key)) return;                // las del SQL/Antigüedad quedan bloqueadas (default)
      const colNum = i + 1;
      const positivo = (c.type === 'select' && c.options) ? c.options.find(o => o !== 'Pendiente') : null;
      for (let rn = 2; rn <= lastRow; rn++) {
        const cell = ws.getCell(rn, colNum);
        cell.protection = { locked: false };           // editable
        if (c.type === 'select' && c.options) {
          cell.dataValidation = {
            type: 'list', allowBlank: true,
            formulae: ['"' + c.options.join(',') + '"'],
            showErrorMessage: true, errorTitle: 'Valor no válido',
            error: 'Elige una opción de la lista.',
          };
          // Color fijo según el valor actual: amarillo = Enviado/Aplicado, rojo = Pendiente/vacío.
          const v = String(cell.value == null ? '' : cell.value).trim();
          const color = (v === positivo) ? 'FFFFF2CC' : 'FFFFC7CE';
          cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: color } };
        }
      }
    });

    // Color de estado (formato condicional): amarillo claro = Enviado/Aplicado,
    // rojo claro = Pendiente. Cambia solo al elegir el valor en la lista.
    if (lastRow >= 2) {
      let prio = 1;
      cols.forEach((c, i) => {
        if (c.type !== 'select' || !c.options || !editable.has(c.key)) return;
        const letter = ws.getColumn(i + 1).letter;
        const ref = `${letter}2:${letter}${lastRow}`;
        const positivo = c.options.find(o => o !== 'Pendiente');
        ws.addConditionalFormatting({
          ref,
          rules: [
            { type: 'cellIs', operator: 'equal', priority: prio++, formulae: [`"${positivo}"`],
              style: { fill: { type: 'pattern', pattern: 'solid', bgColor: { argb: 'FFFFF2CC' } } } },
            { type: 'cellIs', operator: 'equal', priority: prio++, formulae: ['"Pendiente"'],
              style: { fill: { type: 'pattern', pattern: 'solid', bgColor: { argb: 'FFFFC7CE' } } } },
          ],
        });
      });
    }

    // Protege la hoja pero permite filtrar/ordenar, editar celdas desbloqueadas
    // y redimensionar (expandir/disminuir) columnas y filas.
    await ws.protect('', {
      selectLockedCells: true, selectUnlockedCells: true,
      autoFilter: true, sort: true,
      formatColumns: true, formatRows: true, formatCells: true,
    });

    const buf = await wb.xlsx.writeBuffer();
    const blob = new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `Control_NC_${isoDate(new Date())}.xlsx`;
    a.click();
    URL.revokeObjectURL(a.href);
    toast('Excel descargado', 'ok');
  } catch (e) {
    toast('Error al generar Excel: ' + e.message, 'err');
  }
}

// ============================================================
//  PERMISOS POR FAMILIA
// ============================================================
// Datos visibles según el rol: master ve todo; un usuario solo ve sus familias.
// familias vacío/ausente = ve todo (sin restricción).
function visibleData() {
  const s = state.session;
  if (!s || s.role === 'master' || !s.familias || !s.familias.length) return state.data;
  const set = new Set(s.familias);
  return state.data.filter(r => set.has(r['FAMILIA']));
}

// Columna derivada "Comprador": se obtiene de la FAMILIA de cada fila según los
// usuarios y sus familias asignadas. Es informativa (no se guarda ni se edita).
const COMPRADOR_COL = { key: 'COMPRADOR', label: 'Comprador', type: 'text' };
function buildFamiliaMap() {
  const m = new Map();
  for (const u of state.users) {
    if (u.role === 'master') continue;
    for (const f of (u.familias || [])) if (!m.has(f)) m.set(f, u.name || u.user);
  }
  return m;
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
  const d = visibleData();
  const pend = d.filter(r => (r['ENVIADO_CXP'] || 'Pendiente') === 'Pendiente').length;
  const env  = d.filter(r => r['ENVIADO_CXP'] === 'Enviado').length;
  const costo = d.reduce((s, r) => s + (Number(r['COST_TOTAL']) || 0), 0);
  const docs = new Set(d.map(r => r['NO_DOCU'])).size;

  $('#kpi-total').textContent = d.length.toLocaleString('es-CR');
  $('#kpi-pend').textContent  = pend.toLocaleString('es-CR');
  $('#kpi-env').textContent   = env.toLocaleString('es-CR');
  $('#kpi-costo').textContent = '₡' + costo.toLocaleString('es-CR', { maximumFractionDigits: 0 });
  $('#kpi-docs').textContent  = docs.toLocaleString('es-CR');

  renderBars($('#chart-almacen'), groupCount(d, 'ALMACEN'));
  renderBars($('#chart-tipo'), groupCount(d, 'PROVEEDOR'));
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
let consSort = { key: '', dir: 1 };

function renderConsolidado() {
  const head = $('#consolidado-head');
  const body = $('#consolidado-body');
  const cols = [...EXPORT_COLUMNS, COMPRADOR_COL];   // mismo orden que el Excel
  head.innerHTML = '<tr>' + cols.map(c => {
    const arrow = consSort.key === c.key ? (consSort.dir === 1 ? ' ▲' : ' ▼') : '';
    return `<th class="sortable" data-key="${c.key}">${c.label}${arrow}</th>`;
  }).join('') + '</tr>';

  // poblar filtro de tipo doc
  const base = visibleData();
  const sel = $('#filter-tipo');
  const tipos = [...new Set(base.map(r => r['TIPO DOC']).filter(Boolean))].sort();
  sel.innerHTML = '<option value="">Todos los tipos de doc</option>' +
    tipos.map(t => `<option value="${t}">${t}</option>`).join('');
  sel.value = consFilter.tipo;

  const famMap = buildFamiliaMap();
  const q = consFilter.q.toLowerCase();
  let rows = base.map(withDerived).map(r => ({ ...r, COMPRADOR: famMap.get(r['FAMILIA']) || '' }));
  if (consFilter.tipo) rows = rows.filter(r => r['TIPO DOC'] === consFilter.tipo);
  if (q) rows = rows.filter(r => cols.some(c => String(r[c.key] ?? '').toLowerCase().includes(q)));
  if (consSort.key) {
    const col = cols.find(c => c.key === consSort.key);
    rows.sort((a, b) => cmpVals(a[consSort.key], b[consSort.key], col) * consSort.dir);
  }

  $('#consolidado-empty').hidden = base.length > 0;
  body.innerHTML = rows.slice(0, 500).map(r => '<tr>' +
    cols.map(c => `<td>${fmtCell(r[c.key], c)}</td>`).join('') + '</tr>').join('');
  if (rows.length > 500) {
    body.innerHTML += `<tr><td colspan="${cols.length}" class="muted" style="text-align:center">Mostrando 500 de ${rows.length} filas. Usa búsqueda/filtros o exporta el archivo completo.</td></tr>`;
  }
}

// ============================================================
//  RENDER — Histórico
// ============================================================
let histFilter = { q: '' };
let histSort = { key: '', dir: 1 };

function renderHistorico() {
  const head = $('#historico-head');
  const body = $('#historico-body');
  const cols = [...EXPORT_COLUMNS, COMPRADOR_COL];   // mismo orden que el Excel
  head.innerHTML = '<tr>' + cols.map(c => {
    const arrow = histSort.key === c.key ? (histSort.dir === 1 ? ' ▲' : ' ▼') : '';
    return `<th class="sortable" data-key="${c.key}">${c.label}${arrow}</th>`;
  }).join('') + '</tr>';

  const famMap = buildFamiliaMap();
  const q = histFilter.q.toLowerCase();
  let rows = state.historico.map(withDerived).map(r => ({ ...r, COMPRADOR: famMap.get(r['FAMILIA']) || '' }));
  if (q) rows = rows.filter(r => cols.some(c => String(r[c.key] ?? '').toLowerCase().includes(q)));
  if (histSort.key) {
    const col = cols.find(c => c.key === histSort.key);
    rows.sort((a, b) => cmpVals(a[histSort.key], b[histSort.key], col) * histSort.dir);
  }

  $('#historico-count').textContent = state.historico.length.toLocaleString('es-CR');
  $('#historico-empty').hidden = state.historico.length > 0;
  body.innerHTML = rows.slice(0, 500).map(r => '<tr>' +
    cols.map(c => `<td>${fmtCell(r[c.key], c)}</td>`).join('') + '</tr>').join('');
  if (rows.length > 500) {
    body.innerHTML += `<tr><td colspan="${cols.length}" class="muted" style="text-align:center">Mostrando 500 de ${rows.length} filas. Usa la búsqueda o exporta el archivo completo.</td></tr>`;
  }
}

function exportHistoricoExcel() {
  if (!state.historico.length) { toast('El histórico está vacío', ''); return; }
  const rows = state.historico.map(withDerived);
  const headers = ALL_COLUMNS.map(c => c.key);
  const aoa = [headers, ...rows.map(r => headers.map(h => {
    const col = ALL_COLUMNS.find(c => c.key === h);
    return col.type === 'date' ? isoDate(r[h]) : r[h];
  }))];
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Historico');
  XLSX.writeFile(wb, `Historico_NC_${isoDate(new Date())}.xlsx`);
  toast('Histórico exportado a Excel', 'ok');
}

// ============================================================
//  RENDER — Actividad (historial de cambios en la base)
// ============================================================
async function renderActividad() {
  const body = $('#actividad-body');
  const empty = $('#actividad-empty');
  empty.hidden = true;
  body.innerHTML = '<tr><td colspan="8" class="muted" style="text-align:center">Cargando…</td></tr>';
  let act = [];
  try { act = await sbActividad(); }
  catch (ex) {
    body.innerHTML = '';
    empty.hidden = false;
    empty.textContent = 'No se pudo cargar la actividad: ' + ex.message;
    return;
  }
  const map = new Map(act.map(a => [a.usuario, a]));
  const now = Date.now();
  const fmtDT = (s) => {
    if (!s) return '—';
    const d = new Date(s);
    return `${d.toLocaleDateString('es-CR')} ${d.toLocaleTimeString('es-CR', { hour: '2-digit', minute: '2-digit' })}`;
  };
  body.innerHTML = state.users.map(u => {
    const a = map.get(u.user) || {};
    const conx = a.ultima_conexion ? new Date(a.ultima_conexion).getTime() : 0;
    const dias = conx ? Math.floor((now - conx) / 86400000) : null;
    const stale = !conx || dias >= 7;   // 7 días o nunca
    const rojo = stale ? ' style="color:#b91c1c;font-weight:600"' : '';
    const diasTxt = dias == null ? '— (nunca)' : (dias === 0 ? 'Hoy' : `${dias} día${dias === 1 ? '' : 's'}`);
    return `<tr>
      <td${rojo}>${u.user}</td>
      <td>${u.role}</td>
      <td>${(u.familias || []).join(', ')}</td>
      <td${rojo}>${fmtDT(a.ultima_conexion)}</td>
      <td${rojo}>${diasTxt}</td>
      <td>${fmtDT(a.ultimo_guardado)}</td>
      <td>${a.detalle || '—'}</td>
      <td>${a.guardados || 0}</td>
    </tr>`;
  }).join('');
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
        ${u.user.toLowerCase() === 'master' ? '' : `<button class="icon-btn" data-del="${i}" title="Eliminar">🗑️</button>`}
      </td>
    </tr>`).join('');
  sbGetLock().then(updateLockUI);
}

// Refleja el estado del bloqueo en los botones.
function updateLockUI(locked) {
  const l = $('#lock-users'), u = $('#unlock-users');
  if (l) l.disabled = locked;
  if (u) u.disabled = !locked;
}

// ============================================================
//  NAVEGACIÓN / VISTAS
// ============================================================
const TITLES = { dashboard: 'Tablero', consolidado: 'Consolidado', cargar: 'Cargar / Plantilla', base: 'Base original', historico: 'Histórico', actividad: 'Actividad', usuarios: 'Control de Usuarios', config: 'Configuración' };

async function showView(name) {
  $$('.nav-item').forEach(b => b.classList.toggle('active', b.dataset.view === name));
  $$('.view').forEach(v => v.hidden = v.dataset.view !== name);
  $('#page-title').textContent = TITLES[name] || name;
  // Trae lo último de la nube (incluye los ajustes que guardan los usuarios)
  if (name === 'dashboard') await loadConsolidado();
  if (name === 'historico') await loadHistorico();
  if (name === 'dashboard') renderDashboard();
  if (name === 'historico') renderHistorico();
  if (name === 'actividad') renderActividad();
  if (name === 'usuarios') renderUsuarios();
  if (name === 'config') loadConfigForm();
}

function applyRole() {
  const isMaster = state.session && state.session.role === 'master';
  $$('.admin-only').forEach(el => el.hidden = !isMaster);
  $('#user-name').textContent = state.session.name;
  $('#user-role').textContent = state.session.role;
  $('#user-avatar').textContent = (state.session.name || '?').charAt(0).toUpperCase();

  // "Cargar / Plantilla" es igual para todos: descargar + guardar cambios (editar estados).
  $('#download-mydata').hidden = false;
  $('#cargar-intro').innerHTML = '1) Descarga tu data · 2) edítala en Excel (Enviado/Aplicado/Nota) · 3) súbela con «Guardar cambios».';
  $('#upload-help').innerHTML = 'Solo actualiza estados; <b>no borra</b> ni reemplaza la base.' +
    (isMaster ? ' Para subir la base completa del SQL, usa la pestaña <b>«Base original»</b>.' : ' Se actualizan <b>solo tus familias</b>.');
  resetUploadButtons();
}

// Botón de "Guardar cambios" (Cargar/Plantilla) según haya archivo cargado.
function resetUploadButtons() {
  const isMaster = state.session && state.session.role === 'master';
  const has = !!(state.pending && state.pending.length);
  const b = $('#confirm-upload');
  b.textContent = isMaster ? 'Guardar cambios' : 'Guardar mis cambios';
  b.disabled = !has;
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
  pill.textContent = '● En línea';
  pill.className = 'sync-pill ok';
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
      if (user.role !== 'master' && await sbGetLock()) throw new Error('Acceso bloqueado por mantenimiento. Intenta más tarde.');
      const cred = await ensureCred(user.user, user.hash);   // hash vigente (cambiado por el usuario o el master)
      if ((await hashPassword(p)) !== cred.hash) throw new Error('Contraseña incorrecta.');
      state.session = { user: user.user, name: user.name, role: user.role, familias: user.familias || [] };
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

  // Descarga de data
  $('#download-mydata').addEventListener('click', exportExcel);

  // Histórico
  $('#hist-search').addEventListener('input', e => { histFilter.q = e.target.value; renderHistorico(); });
  $('#export-hist-excel').addEventListener('click', exportHistoricoExcel);
  $('#historico-head').addEventListener('click', (e) => {
    const th = e.target.closest('th[data-key]'); if (!th) return;
    const k = th.dataset.key;
    if (histSort.key === k) histSort.dir *= -1; else { histSort.key = k; histSort.dir = 1; }
    renderHistorico();
  });

  // Actividad
  $('#actividad-refresh').addEventListener('click', renderActividad);

  // Carga de archivo
  const dz = $('#dropzone'), fi = $('#file-input');
  dz.addEventListener('dragover', e => { e.preventDefault(); dz.classList.add('drag'); });
  dz.addEventListener('dragleave', () => dz.classList.remove('drag'));
  dz.addEventListener('drop', e => { e.preventDefault(); dz.classList.remove('drag'); if (e.dataTransfer.files[0]) handleFile(e.dataTransfer.files[0]); });
  fi.addEventListener('change', e => { if (e.target.files[0]) handleFile(e.target.files[0]); });
  $('#confirm-upload').addEventListener('click', confirmUpload);

  // Base original (solo master)
  const dzb = $('#dropzone-base'), fib = $('#file-base');
  dzb.addEventListener('dragover', e => { e.preventDefault(); dzb.classList.add('drag'); });
  dzb.addEventListener('dragleave', () => dzb.classList.remove('drag'));
  dzb.addEventListener('drop', e => { e.preventDefault(); dzb.classList.remove('drag'); if (e.dataTransfer.files[0]) handleFileBase(e.dataTransfer.files[0]); });
  fib.addEventListener('change', e => { if (e.target.files[0]) handleFileBase(e.target.files[0]); });
  $('#confirm-base').addEventListener('click', confirmBase);

  // Usuarios
  $('#add-user-btn').addEventListener('click', () => openUserModal());
  $('#lock-users').addEventListener('click', async () => {
    if (!confirm('¿Desactivar a TODOS los usuarios? No podrán entrar ni guardar hasta reactivarlos.')) return;
    try { await sbSetLock(true); updateLockUI(true); toast('Usuarios desactivados (mantenimiento) 🔒', 'ok'); }
    catch (e) { toast('Error: ' + e.message, 'err'); }
  });
  $('#unlock-users').addEventListener('click', async () => {
    try { await sbSetLock(false); updateLockUI(false); toast('Usuarios activados 🔓', 'ok'); }
    catch (e) { toast('Error: ' + e.message, 'err'); }
  });
  $('#usuarios-body').addEventListener('click', (e) => {
    const ed = e.target.closest('[data-edit]'); const dl = e.target.closest('[data-del]');
    if (ed) openUserModal(Number(ed.dataset.edit));
    if (dl) deleteUser(Number(dl.dataset.del));
  });
  $('#user-form').addEventListener('submit', saveUserForm);
  $('#uf-role').addEventListener('change', e => toggleFamiliasField(e.target.value));
  $$('[data-close]').forEach(b => b.addEventListener('click', () => { $('#user-modal').hidden = true; }));

  // Cambio de contraseña
  $('#change-pass-btn').addEventListener('click', () => openPassModal(false));
  $$('[data-close-pass]').forEach(b => b.addEventListener('click', () => { $('#pass-modal').hidden = true; }));
  $('#pass-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const n = $('#pf-new').value, c = $('#pf-confirm').value;
    if (n.length < 4) { toast('La contraseña debe tener al menos 4 caracteres', 'err'); return; }
    if (n !== c) { toast('Las contraseñas no coinciden', 'err'); return; }
    try {
      await sbSetCred(state.session.user, await hashPassword(n));
      $('#pass-modal').hidden = true;
      toast('Contraseña actualizada ✓', 'ok');
    } catch (ex) { toast('Error: ' + ex.message, 'err'); }
  });

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

  // Mostrar / copiar token
  $('#cfg-token-show').addEventListener('click', () => {
    const f = $('#cfg-token');
    f.type = f.type === 'password' ? 'text' : 'password';
  });
  $('#cfg-token-copy').addEventListener('click', async () => {
    const v = $('#cfg-token').value;
    if (!v) { toast('No hay token guardado en este equipo', ''); return; }
    try { await navigator.clipboard.writeText(v); toast('Token copiado', 'ok'); }
    catch { toast('No se pudo copiar (cópialo manualmente)', 'err'); }
  });
}

// ---------- Carga de archivo ----------
function handleFile(file) {
  const reader = new FileReader();
  reader.onload = (e) => {
    try {
      const rows = parseExcel(e.target.result);
      state.pending = rows.length ? rows : null;
      const sum = $('#upload-summary');
      sum.className = 'upload-summary';
      sum.hidden = false;
      sum.innerHTML = `<b>${file.name}</b><br>${rows.length} filas detectadas y validadas.`;
      resetUploadButtons();
    } catch (ex) {
      state.pending = null;
      const sum = $('#upload-summary');
      sum.className = 'upload-summary err'; sum.hidden = false;
      sum.textContent = 'Error al leer el archivo: ' + ex.message;
      resetUploadButtons();
    }
  };
  reader.readAsArrayBuffer(file);
}

// "Guardar cambios" (Cargar/Plantilla): solo actualiza estados. Nunca borra:
// si la celda viene vacía o "Pendiente", se conserva lo anterior.
// Usuario → solo sus familias. Master → cualquier familia.
async function confirmUpload() {
  if (!state.pending || !state.pending.length) return;
  const isMaster = state.session && state.session.role === 'master';
  if (!isMaster && await sbGetLock()) {
    toast('El sistema está en mantenimiento. Intenta guardar más tarde.', 'err');
    return;
  }
  const btn = $('#confirm-upload');
  btn.disabled = true; btn.textContent = 'Procesando...';
  try {
    const allowed = isMaster ? null : new Set(state.session.familias || []);
    const existing = new Map(state.data.map(r => [rowKey(r), r]));
    const changed = [];
    for (const inc of state.pending) {
      const prev = existing.get(rowKey(inc));
      if (!prev) continue;
      if (allowed && allowed.size && !allowed.has(prev['FAMILIA'])) continue;
      const merged = { ...prev };
      let touched = false;
      for (const k of CREATED_KEYS) {
        const v = inc[k];
        const meaningful = v != null && v !== '' && v !== 'Pendiente';
        if (meaningful) { merged[k] = v; touched = true; }
      }
      if (touched) changed.push(merged);
    }
    await sbUpsert(changed, false);
    const fams = [...new Set(changed.map(r => r['FAMILIA']).filter(Boolean))].join(', ');
    await sbLogGuardado(state.session.user, `Actualizó ${changed.length} fila(s)${fams ? ' · ' + fams : ''}`);
    await loadConsolidado();
    await loadHistorico();
    state.pending = null;
    $('#upload-summary').hidden = true;
    $('#file-input').value = '';
    toast(`Guardado en la nube ✓ (${changed.length} filas actualizadas)`, 'ok');
    showView('dashboard');
  } catch (ex) {
    toast('Error al guardar: ' + ex.message, 'err');
  } finally {
    resetUploadButtons();
  }
}

// ---------- Base original (solo master): reconcilia y archiva ----------
function handleFileBase(file) {
  const reader = new FileReader();
  reader.onload = (e) => {
    try {
      const rows = parseExcel(e.target.result);
      state.pendingBase = rows.length ? rows : null;
      const sum = $('#summary-base');
      sum.className = 'upload-summary'; sum.hidden = false;
      sum.innerHTML = `<b>${file.name}</b><br>${rows.length} filas detectadas y validadas.`;
      $('#confirm-base').disabled = !state.pendingBase;
    } catch (ex) {
      state.pendingBase = null;
      const sum = $('#summary-base');
      sum.className = 'upload-summary err'; sum.hidden = false;
      sum.textContent = 'Error al leer el archivo: ' + ex.message;
      $('#confirm-base').disabled = true;
    }
  };
  reader.readAsArrayBuffer(file);
}

async function confirmBase() {
  if (!state.pendingBase || !state.pendingBase.length) return;
  const btn = $('#confirm-base');
  btn.disabled = true; btn.textContent = 'Procesando...';
  try {
    await loadConsolidado();          // base vigente más reciente (conserva ajustes recientes)
    const { result, removed } = reconcileWeekly(state.data, state.pendingBase);
    await sbUpsert(result, false);
    await sbUpsert(removed, true);
    await sbLogGuardado(state.session.user, `Cargó base (${result.length} vigentes, ${removed.length} archivados)`);
    await loadConsolidado();
    await loadHistorico();
    state.pendingBase = null;
    $('#summary-base').hidden = true;
    $('#file-base').value = '';
    toast(`Base cargada en la nube ✓ (${result.length} vigentes · ${removed.length} archivados)`, 'ok');
    showView('dashboard');
  } catch (ex) {
    toast('Error al guardar: ' + ex.message, 'err');
  } finally {
    btn.disabled = false; btn.textContent = 'Cargar base original (semanal)';
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
  const role = isEdit ? u.role : 'usuario';
  $('#uf-role').value = role;
  $('#uf-pass').value = '';
  $('#uf-pass-hint').textContent = isEdit ? '(dejar vacío para no cambiar)' : '';
  $('#uf-active').checked = isEdit ? u.active : true;

  // Familias visibles para el usuario (opciones tomadas de la base + las ya asignadas)
  const assigned = (isEdit && Array.isArray(u.familias)) ? u.familias : [];
  const fams = [...new Set([...state.data.map(r => r['FAMILIA']).filter(Boolean), ...assigned])].sort();
  $('#uf-familias').innerHTML = fams.map(f =>
    `<option value="${f}"${assigned.includes(f) ? ' selected' : ''}>${f}</option>`).join('');
  toggleFamiliasField(role);

  $('#user-modal').hidden = false;
}

// Las familias solo aplican a usuarios (el master ve todo).
function toggleFamiliasField(role) {
  $('#uf-familias-wrap').hidden = (role === 'master');
}

async function saveUserForm(e) {
  e.preventDefault();
  const orig = $('#uf-original').value;
  const userName = $('#uf-user').value.trim();
  const name = $('#uf-name').value.trim();
  const role = $('#uf-role').value;
  const pass = $('#uf-pass').value;
  const active = $('#uf-active').checked;
  // master ve todo; para usuarios, las familias seleccionadas (vacío = todas)
  const familias = role === 'master' ? [] : [...$('#uf-familias').selectedOptions].map(o => o.value);
  const targetUser = orig || userName;
  const newHash = pass ? await hashPassword(pass) : null;

  if (orig) {
    const u = state.users.find(x => x.user === orig);
    u.name = name; u.role = role; u.active = active; u.familias = familias;
    if (newHash) u.hash = newHash;
  } else {
    if (state.users.some(x => x.user.toLowerCase() === userName.toLowerCase())) { toast('Ese usuario ya existe', 'err'); return; }
    if (!pass) { toast('La contraseña es obligatoria', 'err'); return; }
    state.users.push({ user: userName, name, role, active, familias, hash: newHash });
  }
  try {
    await saveUsers();
    // El master fija/reinicia la contraseña en la nube (login la usa; reinicia los 6 meses)
    if (newHash) { try { await sbSetCred(targetUser, newHash); } catch (e) { console.error(e); } }
    $('#user-modal').hidden = true;
    renderUsuarios();
    toast('Usuario guardado ✓', 'ok');
  } catch (ex) { toast('Error al guardar usuario: ' + ex.message, 'err'); }
}

// ---------- Modal de cambio de contraseña ----------
function openPassModal(forced) {
  $('#pf-new').value = ''; $('#pf-confirm').value = '';
  $('#pass-modal-title').textContent = forced ? 'Cambia tu contraseña' : 'Cambiar contraseña';
  $('#pass-msg').textContent = forced ? 'Tu contraseña venció (se cambia cada 6 meses). Debes cambiarla para continuar.' : '';
  $$('[data-close-pass]').forEach(b => b.style.display = forced ? 'none' : '');
  $('#pass-modal').hidden = false;
}

async function deleteUser(index) {
  const u = state.users[index];
  if (u.user.toLowerCase() === 'master') { toast('No se puede eliminar el master principal', 'err'); return; }
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
  sbLogConexion(state.session.user);   // registra la conexión (no bloquea)
  showView('dashboard');
  await loadConsolidado();
  await loadHistorico();
  showView('dashboard');
  checkPasswordExpiry();               // obliga a cambiar la clave si venció (6 meses)
}

// Si la contraseña tiene más de 6 meses, obliga a cambiarla.
async function checkPasswordExpiry() {
  try {
    const cred = await sbGetCred(state.session.user);
    if (cred && (Date.now() - new Date(cred.cambiada_en).getTime()) > PASS_MAX_AGE) openPassModal(true);
  } catch { /* ignora */ }
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
      if (u && u.active) {
        state.session.role = u.role;
        state.session.familias = u.familias || [];
        await enterApp(); return;
      }
    } catch { /* nada */ }
  }
  $('#login-view').hidden = false;
}

init();
