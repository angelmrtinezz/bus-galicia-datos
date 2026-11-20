// Utilidades compartidas del robot de desvíos: distancias, polilíneas y nombres de calles/paradas.
// Todas las coordenadas son [lat, lon].

const R = 6371000;
const RAD = Math.PI / 180;
const COS_LAT = Math.cos(42.23 * RAD);
const M_POR_GRADO = 111320;

/** Distancia aproximada en metros (vale de sobra dentro de una ciudad). */
export function metros(a, b) {
  const dy = (b[0] - a[0]) * M_POR_GRADO;
  const dx = (b[1] - a[1]) * M_POR_GRADO * COS_LAT;
  return Math.hypot(dx, dy);
}

/** Distancia de un punto a un segmento, y la fracción t (0..1) del punto más cercano. */
export function aSegmento(p, a, b) {
  const ax = a[1] * COS_LAT, ay = a[0], bx = b[1] * COS_LAT, by = b[0], px = p[1] * COS_LAT, py = p[0];
  const dx = bx - ax, dy = by - ay;
  const l2 = dx * dx + dy * dy;
  const t = l2 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / l2)) : 0;
  return { d: Math.hypot(px - (ax + t * dx), py - (ay + t * dy)) * M_POR_GRADO, t };
}

/** Distancia mínima (m) de un punto a un conjunto de polilíneas. */
export function aPolilineas(p, lineas) {
  let min = Infinity;
  for (const l of lineas) {
    for (let k = 0; k < l.length - 1; k++) {
      const { d } = aSegmento(p, l[k], l[k + 1]);
      if (d < min) min = d;
    }
    if (l.length === 1) min = Math.min(min, metros(p, l[0]));
  }
  return min;
}

/** Proyección de un punto sobre una polilínea: distancia y posición (metros desde el inicio). */
export function proyectar(p, linea, acum = acumulado(linea)) {
  let mejor = { d: Infinity, pos: 0, k: 0 };
  for (let k = 0; k < linea.length - 1; k++) {
    const { d, t } = aSegmento(p, linea[k], linea[k + 1]);
    if (d < mejor.d) mejor = { d, pos: acum[k] + t * (acum[k + 1] - acum[k]), k };
  }
  return mejor;
}

export function acumulado(linea) {
  const acum = [0];
  for (let k = 1; k < linea.length; k++) acum.push(acum[k - 1] + metros(linea[k - 1], linea[k]));
  return acum;
}

/** Puntos cada ~paso metros (para poder buscar tramos de calle con precisión). */
export function densificar(linea, paso = 10) {
  const salida = [linea[0]];
  for (let k = 1; k < linea.length; k++) {
    const a = linea[k - 1], b = linea[k];
    const n = Math.max(1, Math.ceil(metros(a, b) / paso));
    for (let j = 1; j <= n; j++) salida.push([a[0] + ((b[0] - a[0]) * j) / n, a[1] + ((b[1] - a[1]) * j) / n]);
  }
  return salida;
}

/** Douglas-Peucker con tolerancia en metros. */
export function simplificar(pts, tolerancia = 8) {
  if (pts.length <= 2) return pts.slice();
  const conservar = new Uint8Array(pts.length);
  conservar[0] = conservar[pts.length - 1] = 1;
  const pila = [[0, pts.length - 1]];
  while (pila.length) {
    const [i, j] = pila.pop();
    let max = 0, idx = -1;
    for (let k = i + 1; k < j; k++) {
      const { d } = aSegmento(pts[k], pts[i], pts[j]);
      if (d > max) { max = d; idx = k; }
    }
    if (max > tolerancia && idx > 0) {
      conservar[idx] = 1;
      pila.push([i, idx], [idx, j]);
    }
  }
  return pts.filter((_, k) => conservar[k]);
}

// ---------- Trazados de formas.json ----------

export function decodificar(c) {
  const pts = [];
  let lat = 0, lon = 0;
  for (let k = 0; k < c.length; k += 2) {
    lat += c[k];
    lon += c[k + 1];
    pts.push([lat / 1e5, lon / 1e5]);
  }
  return pts;
}

export function codificar(pts) {
  const c = [];
  let pLat = 0, pLon = 0;
  for (const [lat, lon] of pts) {
    const iLat = Math.round(lat * 1e5), iLon = Math.round(lon * 1e5);
    c.push(iLat - pLat, iLon - pLon);
    pLat = iLat;
    pLon = iLon;
  }
  return c;
}

// ---------- Nombres ----------

const PALABRAS_TIPO = new Set([
  'rua', 'r', 'calle', 'c', 'avenida', 'avda', 'av', 'praza', 'plaza', 'pza', 'estrada', 'carretera', 'camino',
  'camino', 'camiño', 'travesia', 'trav', 'paseo', 'rolda', 'ronda', 'glorieta', 'rotonda', 'via', 'lugar', 'alameda',
  'subida', 'baixada', 'bajada', 'costa', 'praciña', 'plazuela',
]);
const ARTICULOS = new Set(['de', 'do', 'da', 'dos', 'das', 'del', 'la', 'las', 'los', 'el', 'o', 'a', 'os', 'as', 'e', 'y']);

export function sinAcentos(s) {
  return String(s ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();
}

/** «Rúa do Marqués de Valladares» → «marques valladares». Gallego/castellano: x≈j≈g. */
export function nucleo(nombre) {
  const palabras = sinAcentos(nombre)
    .replace(/\(.*?\)/g, ' ')
    .replace(/[^a-z0-9ñ ]+/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
  let i = 0;
  while (i < palabras.length - 1 && (PALABRAS_TIPO.has(palabras[i]) || ARTICULOS.has(palabras[i]))) i++;
  return palabras
    .slice(i)
    .filter((w) => !ARTICULOS.has(w) && !/^\d+$/.test(w))
    .join(' ')
    .replace(/x/g, 'j')
    .replace(/g(?=[ei])/g, 'j');
}

/** Tipo de vía normalizado («rua», «avenida», «praza»…) o ''. */
export function tipoVia(nombre) {
  const p = sinAcentos(nombre).replace(/[^a-z ]+/g, ' ').split(/\s+/).filter(Boolean)[0] ?? '';
  if (['rua', 'calle', 'r', 'c'].includes(p)) return 'rua';
  if (['avenida', 'avda', 'av'].includes(p)) return 'avenida';
  if (['praza', 'plaza', 'pza'].includes(p)) return 'praza';
  return PALABRAS_TIPO.has(p) ? p : '';
}

export function levenshtein(a, b) {
  if (a === b) return 0;
  const m = a.length, n = b.length;
  if (!m) return n;
  if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[n];
}

/** Parecido 0..1 entre dos núcleos de nombre. */
export function parecido(a, b) {
  if (!a || !b) return 0;
  if (a === b) return 1;
  return 1 - levenshtein(a, b) / Math.max(a.length, b.length);
}

/** Número de portal de un nombre de parada: «Rúa de Colón 12» → «12»; «(fronte 19)» → «19». */
export function numeroPortal(nombre) {
  const m = String(nombre).match(/(\d+)\s*\)?\s*$/) ?? String(nombre).match(/\b(\d+)\b/);
  return m ? m[1] : '';
}

export const hoyIso = () => new Date().toISOString().slice(0, 10);
export const isoAClave = (iso) => iso.replace(/-/g, '');
