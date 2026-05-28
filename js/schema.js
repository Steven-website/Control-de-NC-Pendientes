// Esquema real basado en SQL_CONTROL_DE_NC.xlsx
// La clave (key) coincide EXACTAMENTE con el encabezado del Excel del usuario,
// para que sus archivos carguen sin problemas.

export const COLUMNS = [
  // --- Columnas creadas por el sistema, editables por el usuario ---
  { key: 'ENVIADO_CXP',       label: 'Enviado CxP',        type: 'select', options: ['Pendiente', 'Enviado'], default: 'Pendiente', created: true, input: true },
  { key: 'FECHA_ENVIADO_CXP', label: 'Fecha Enviado CxP',  type: 'date',   created: true, input: true },
  { key: 'APLICADO_CXP',      label: 'Aplicado CxP',       type: 'select', options: ['Pendiente', 'Aplicado'], default: 'Pendiente', created: true, input: true },
  { key: 'FECHA_APLICACION_CXP', label: 'Fecha Aplicación CxP', type: 'date', created: true, input: true },
  // --- Columnas provenientes del SQL ---
  { key: 'TIPO DOC',        label: 'Tipo Doc',     type: 'text' },
  { key: 'FECHA_MOVIMIENTO', label: 'Fecha Mov.',  type: 'date' },
  { key: 'NO_DOCU',         label: 'No. Docu',     type: 'number' },
  { key: 'BODEGA_ORIGEN',   label: 'Bodega Origen', type: 'text' },
  { key: 'CENTRO',          label: 'Centro',       type: 'number' },
  { key: 'ALMACEN',         label: 'Almacén',      type: 'text' },
  { key: 'FAMILIA',         label: 'Familia',      type: 'text' },
  { key: 'CATEGORIA',       label: 'Categoría',    type: 'text' },
  { key: 'SUBCATEGORIA',    label: 'Subcategoría', type: 'text' },
  { key: 'NO_LINEA',        label: 'No. Línea',    type: 'number' },
  { key: 'COD_PROV',        label: 'Cód. Prov',    type: 'number' },
  { key: 'PROVEEDOR',       label: 'Proveedor',    type: 'text' },
  { key: 'PK_ARTICULOS',    label: 'PK Artículos', type: 'number' },
  { key: 'NO_ARTI',         label: 'No. Artículo', type: 'number' },
  { key: 'DESCRIPCION',     label: 'Descripción',  type: 'text' },
  { key: 'UNIDADES',        label: 'Unidades',     type: 'number' },
  { key: 'COST_UNI',        label: 'Costo Uni.',   type: 'number' },
  { key: 'COST_TOTAL',      label: 'Costo Total',  type: 'number' },
  { key: 'OBSERV',          label: 'Observación',  type: 'text' },
];

export const COLUMN_KEYS = COLUMNS.map(c => c.key);

// Columnas de seguimiento que mantiene el master (Enviado/Aplicado + fechas).
// Al reconciliar una base nueva, estos valores se CONSERVAN para los registros
// que ya existían, para no perder el trabajo manual.
export const CREATED_KEYS = COLUMNS.filter(c => c.created).map(c => c.key);

// Columnas del SQL (no creadas) y columnas creadas por el sistema (objetos),
// para ordenar y dar formato a las descargas.
export const SQL_COLUMNS = COLUMNS.filter(c => !c.created);
export const CREATED_COLUMNS = COLUMNS.filter(c => c.created);

// ---- Columnas DERIVADAS (calculadas, no se almacenan) ----
// Se recalculan cada vez que el usuario visualiza o DESCARGA los datos,
// porque dependen de la fecha actual.
export const DERIVED = [
  {
    key: 'ANTIGUEDAD',
    label: 'Antigüedad (días)',
    type: 'number',
    // HOY - FECHA_MOVIMIENTO, en días
    compute: (row) => {
      const d = parseDate(row['FECHA_MOVIMIENTO']);
      if (!d) return null;
      const hoy = new Date();
      const ms = hoy.setHours(0,0,0,0) - new Date(d).setHours(0,0,0,0);
      return Math.floor(ms / 86400000);
    },
  },
];

export const DERIVED_KEYS = DERIVED.map(c => c.key);

// Orden de las descargas: primero las columnas del SQL, luego ANTIGÜEDAD y las creadas.
export const EXPORT_COLUMNS = [...SQL_COLUMNS, ...DERIVED, ...CREATED_COLUMNS];

// Convierte un valor de fecha (ISO string, Date o serial de Excel) a Date.
export function parseDate(v) {
  if (v === null || v === undefined || v === '') return null;
  if (v instanceof Date) return isNaN(v) ? null : v;
  if (typeof v === 'number') {
    // Serial de Excel (días desde 1899-12-30)
    const d = new Date(Math.round((v - 25569) * 86400 * 1000));
    return isNaN(d) ? null : d;
  }
  const d = new Date(v);
  return isNaN(d) ? null : d;
}

// Devuelve un objeto fila con las columnas derivadas calculadas.
export function withDerived(row) {
  const out = { ...row };
  for (const d of DERIVED) out[d.key] = d.compute(row);
  return out;
}

// Todas las columnas (base + derivadas) para mostrar/exportar.
export const ALL_COLUMNS = [...DERIVED, ...COLUMNS];

// Rutas de datos dentro del repositorio
export const PATHS = {
  consolidado: 'data/consolidado.parquet',
  historico: 'data/historico.parquet',
  usuarios: 'data/usuarios.json',
};

// Formatea un valor para mostrar en tabla
export function fmt(value, type) {
  if (value === null || value === undefined || value === '') return '';
  if (type === 'number') {
    const n = Number(value);
    if (!isFinite(n)) return value;
    return n.toLocaleString('es-CR', { maximumFractionDigits: 2 });
  }
  return String(value);
}
