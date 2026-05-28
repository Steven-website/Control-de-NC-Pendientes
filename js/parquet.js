// Lectura/escritura de Parquet en el navegador usando hyparquet (+ writer).
// Cargados dinámicamente desde CDN (esm.sh). Si fallan, se lanza error
// y la app cae a un respaldo JSON local.

import { COLUMN_KEYS } from './schema.js';

let _read, _write, _compressors;

async function ensureLibs() {
  if (_read && _write) return;
  const [hp, hw, hc] = await Promise.all([
    import('https://esm.sh/hyparquet@1.17.1'),
    import('https://esm.sh/hyparquet-writer@1.10.0'),
    import('https://esm.sh/hyparquet-compressors@1.1.1').catch(() => null),
  ]);
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
