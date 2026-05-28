// Cliente mínimo de la API de GitHub (Contents API) para leer/guardar
// archivos en el repositorio. El token se guarda solo en este navegador.

const CFG_KEY = 'ncpend_github_cfg';

export function getConfig() {
  try { return JSON.parse(localStorage.getItem(CFG_KEY)) || {}; }
  catch { return {}; }
}
export function setConfig(cfg) {
  localStorage.setItem(CFG_KEY, JSON.stringify(cfg));
}
export function hasToken() {
  const c = getConfig();
  return !!(c.token && c.owner && c.repo);
}

function api(path, opts = {}) {
  const c = getConfig();
  return fetch(`https://api.github.com${path}`, {
    ...opts,
    headers: {
      'Accept': 'application/vnd.github+json',
      'Authorization': `Bearer ${c.token}`,
      'X-GitHub-Api-Version': '2022-11-28',
      ...(opts.headers || {}),
    },
  });
}

// Convierte ArrayBuffer/Uint8Array a base64 (para subir binarios)
function toBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export async function testConnection() {
  const c = getConfig();
  if (!c.token || !c.owner || !c.repo) throw new Error('Faltan datos de configuración.');
  const res = await api(`/repos/${c.owner}/${c.repo}`);
  if (!res.ok) throw new Error(`No se pudo acceder al repo (${res.status}).`);
  const data = await res.json();
  return data.full_name;
}

// Lee un archivo del repo. Devuelve { content: ArrayBuffer|string, sha } o null si no existe.
export async function getFile(path, asBinary = false) {
  const c = getConfig();
  const branch = c.branch || 'main';
  const res = await api(`/repos/${c.owner}/${c.repo}/contents/${path}?ref=${branch}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Error al leer ${path} (${res.status}).`);
  const json = await res.json();
  const b64 = (json.content || '').replace(/\n/g, '');
  if (asBinary) {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return { content: bytes.buffer, sha: json.sha };
  }
  return { content: decodeURIComponent(escape(atob(b64))), sha: json.sha };
}

// Crea o actualiza un archivo. content puede ser string o ArrayBuffer/Uint8Array.
export async function putFile(path, content, message) {
  const c = getConfig();
  const branch = c.branch || 'main';
  const existing = await api(`/repos/${c.owner}/${c.repo}/contents/${path}?ref=${branch}`)
    .then(r => r.ok ? r.json() : null).catch(() => null);

  const b64 = (typeof content === 'string')
    ? btoa(unescape(encodeURIComponent(content)))
    : toBase64(content);

  const res = await api(`/repos/${c.owner}/${c.repo}/contents/${path}`, {
    method: 'PUT',
    body: JSON.stringify({
      message: message || `Actualizar ${path}`,
      content: b64,
      branch,
      ...(existing && existing.sha ? { sha: existing.sha } : {}),
    }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.message || `Error al guardar ${path} (${res.status}).`);
  }
  return res.json();
}
