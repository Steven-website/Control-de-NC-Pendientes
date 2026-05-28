// Lectura/escritura de Parquet en el navegador usando hyparquet (+ writer).
// Las librerías se cargan dinámicamente desde CDN. Para que no dependa de uno
// solo, se intentan varios (esm.sh → jsDelivr → unpkg) hasta que uno funcione.

import { COLUMN_KEYS } from './schema.js';

let _read, _write, _compressors;

// Intenta importar un módulo desde varias URLs; devuelve el primero que cargue.
async function importAny(urls) {
  let lastErr;
  for (const url of urls) {
    try { return await import(url); }
    catch (e) { lastErr = e; }
  }
  throw lastErr || new Error('No se pudo cargar el módulo');
}

async function ensureLibs() {
  if (_read && _write) return;
  const hp = await importAny([
    'https://esm.sh/hyparquet@1.17.1',
    'https://cdn.jsdelivr.net/npm/hyparquet@1.17.1/+esm',
    'https://unpkg.com/hyparquet@1.17.1?module',
  ]);
  const hw = await importAny([
    'https://esm.sh/hyparquet-writer@1.10.0',
    'https://cdn.jsdelivr.net/npm/hyparquet-writer@1.10.0/+esm',
    'https://unpkg.com/hyparquet-writer@1.10.0?module',
  ]);
  const hc = await importAny([
    'https://esm.sh/hyparquet-compressors@1.1.1',
    'https://cdn.jsdelivr.net/npm/hyparquet-compressors@1.1.1/+esm',
    'https://unpkg.com/hyparquet-compressors@1.1.1?module',
  ]).catch(() => null);
  _read = hp.parquetReadObjects;
  _write = hw.parquetWriteBuffer;
  _compressors = hc ? hc.compressors : undefined;
}

// ArrayBuffer de Parquet -> array de objetos (filas)
export async function readParquet(arrayBuffer) {
  await ensureLibs();
  const rows = await _read({ file: arrayBuffer, compressors: _compressors });
  return rows || [];
}

// Array de objetos (filas) -> ArrayBuffer de Parquet
export async function writeParquet(rows, keys = COLUMN_KEYS) {
  await ensureLibs();
  const columnData = keys.map(key => ({
    name: key,
    data: rows.map(r => {
      const v = r[key];
      return v === undefined ? null : v;
    }),
  }));
  return _write({ columnData });
}
