// Calles de Vigo (OpenStreetMap) y rutas DE AUTOBÚS por calles reales.
//
// datos/osm/calles.json: la red de calles de Vigo con lo que importa a un bus (si puede pasar y en
// qué sentido, contando carriles bus, calles solo para buses y sentidos únicos con excepción para
// buses). Se renueva cada semana con `node scripts/desvios/descargar-calles.mjs`.
// Datos © colaboradores de OpenStreetMap (ODbL).
//
// Las rutas se calculan aquí mismo (Dijkstra sobre esa red): un servicio de rutas para coches no
// vale, porque no deja pasar por calles solo para buses ni a contramano por un carril bus.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';

import { aPolilineas, codificar, decodificar, metros, nucleo, parecido, sinAcentos, tipoVia } from './comun.mjs';

export const RUTA_CALLES = 'datos/osm/calles.json';
const AGENTE = 'Paradina-datos/1.0 (robot de desvios de bus; github.com/angelmrtinezz/bus-galicia-datos)';

const SERVIDORES_OVERPASS = [
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
  'https://overpass-api.de/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
];
const CONSULTA_CALLES =
  '[out:json][timeout:180];way["highway"~"^(motorway|trunk|primary|secondary|tertiary|unclassified|residential|' +
  'living_street|busway|service|road|pedestrian|motorway_link|trunk_link|primary_link|secondary_link|tertiary_link)$"]' +
  '(42.155,-8.83,42.27,-8.62);out tags geom;';

const SI = new Set(['yes', 'designated', 'permissive', '1', 'true']);
const NO = new Set(['no', 'private', 'agricultural', 'forestry', 'delivery']);

/** ¿Puede pasar un autobús? Y en qué sentido: 1 = solo a favor, -1 = solo en contra, 0 = ambos. */
function paraBus(tags) {
  const hw = tags.highway;
  let puede = true;
  if (hw === 'pedestrian') puede = false;
  if (hw === 'service' && ['parking_aisle', 'driveway', 'drive-through', 'emergency_access'].includes(tags.service)) puede = false;
  for (const k of ['access', 'vehicle', 'motor_vehicle']) if (NO.has(tags[k])) puede = false;
  if (SI.has(tags.bus) || SI.has(tags.psv) || hw === 'busway') puede = true;
  if (NO.has(tags.bus) || NO.has(tags.psv) && !SI.has(tags.bus)) puede = false;

  let sentido = 0;
  const ow = tags['oneway:bus'] ?? tags['oneway:psv'] ?? tags.oneway;
  if (ow === 'yes' || ow === '1' || ow === 'true') sentido = 1;
  else if (ow === '-1' || ow === 'reverse') sentido = -1;
  else if (ow === undefined && (tags.junction === 'roundabout' || tags.junction === 'circular' || hw === 'motorway')) sentido = 1;
  if (tags['oneway:bus'] === undefined && tags['oneway:psv'] === undefined && /opposite/.test(tags.busway ?? '')) sentido = 0;
  return { puede, sentido };
}

/** Descarga la red de Overpass (probando varios servidores) y la guarda compacta. */
export async function descargarCalles(ruta = RUTA_CALLES) {
  let ultimoError = '';
  for (const url of SERVIDORES_OVERPASS) {
    try {
      const r = await fetch(url, {
        method: 'POST',
        body: 'data=' + encodeURIComponent(CONSULTA_CALLES),
        headers: { 'User-Agent': AGENTE, 'Content-Type': 'application/x-www-form-urlencoded' },
        signal: AbortSignal.timeout(240_000),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const n = guardarRed(await r.json(), ruta);
      console.log(`calles.json: ${n} tramos (${url})`);
      return true;
    } catch (e) {
      ultimoError = `${url}: ${e.message}`;
      console.warn('Overpass falló:', ultimoError);
    }
  }
  console.warn('No se pudieron descargar las calles; se usan las guardadas.', ultimoError);
  return false;
}

/** Respuesta de Overpass → calles.json. Devuelve el número de tramos. */
export function guardarRed(j, ruta = RUTA_CALLES) {
  const nombres = [];
  const idxNombre = new Map();
  const vias = [];
  for (const e of j.elements ?? []) {
    if (e.type !== 'way' || !e.geometry?.length) continue;
    const tags = e.tags ?? {};
    const { puede, sentido } = paraBus(tags);
    if (!puede && !tags.name) continue;
    let i = -1;
    if (tags.name) {
      i = idxNombre.get(tags.name);
      if (i === undefined) {
        i = nombres.length;
        nombres.push(tags.name);
        idxNombre.set(tags.name, i);
      }
    }
    // [nombre, bus puede (0/1), sentido (-1/0/1), servicio (0/1), coords]
    vias.push([i, puede ? 1 : 0, sentido, tags.highway === 'service' ? 1 : 0, codificar(e.geometry.map((g) => [g.lat, g.lon]))]);
  }
  if (vias.length < 5000) throw new Error(`muy pocas calles (${vias.length})`);
  writeFileSync(ruta, JSON.stringify({ generado: new Date().toISOString(), fuente: '© OpenStreetMap (ODbL)', nombres, vias }));
  return vias.length;
}

let red = null;
const claveNodo = (p) => `${p[0].toFixed(6)},${p[1].toFixed(6)}`;

/** Carga la red en memoria: calles por nombre y grafo para buses. */
function cargar() {
  if (red) return red;
  if (!existsSync(RUTA_CALLES)) throw new Error(`Falta ${RUTA_CALLES} (ejecuta descargar-calles.mjs)`);
  const j = JSON.parse(readFileSync(RUTA_CALLES, 'utf8'));
  const porNombre = new Map();
  const idNodo = new Map();
  const nodos = []; // [lat, lon]
  const ady = []; // por nodo: [[destino, metros, coste, nombreIdx], ...]
  const nodo = (p) => {
    const k = claveNodo(p);
    let id = idNodo.get(k);
    if (id === undefined) {
      id = nodos.length;
      idNodo.set(k, id);
      nodos.push(p);
      ady.push([]);
    }
    return id;
  };
  for (const [ni, puede, sentido, servicio, c] of j.vias) {
    const pts = decodificar(c);
    if (ni >= 0) {
      const nombre = j.nombres[ni];
      let lista = porNombre.get(nombre);
      if (!lista) porNombre.set(nombre, (lista = []));
      lista.push(pts);
    }
    if (!puede) continue;
    const ids = pts.map(nodo);
    for (let k = 0; k < ids.length - 1; k++) {
      const m = metros(pts[k], pts[k + 1]);
      const coste = m * (servicio ? 3 : 1);
      if (sentido >= 0) ady[ids[k]].push([ids[k + 1], m, coste, ni]);
      if (sentido <= 0) ady[ids[k + 1]].push([ids[k], m, coste, ni]);
    }
  }
  red = {
    idNodo,
    nombres: j.nombres,
    porNombre,
    nodos,
    ady,
    entradas: [...porNombre.keys()].map((n) => ({ nombre: n, nucleo: nucleo(n), completo: sinAcentos(n), tipo: tipoVia(n) })),
  };
  return red;
}

/**
 * Busca una calle por su nombre (como lo escribe el aviso: «Marqués de Valladares», «Rúa Areal»…)
 * y devuelve sus tramos cercanos a `cerca` (dentro de `radio` metros). null si no hay ninguna
 * que se parezca lo bastante.
 */
export function buscarCalle(nombre, cerca, radio = 2500) {
  const { porNombre, entradas } = cargar();
  const n = nucleo(nombre);
  const tipo = tipoVia(nombre);
  if (!n) return null;
  const mejores = [];
  for (const e of entradas) {
    let p = parecido(n, e.nucleo);
    if (p < 0.82) continue;
    if (tipo && e.tipo && tipo !== e.tipo) p -= 0.1; // «Rúa de Pontevedra» ≠ «Praza de Pontevedra»
    const lineas = porNombre.get(e.nombre).filter((l) => !cerca || aPolilineas(cerca, [l]) <= radio);
    if (!lineas.length) continue;
    mejores.push({ p, nombre: e.nombre, lineas });
  }
  if (!mejores.length) return null;
  mejores.sort((a, b) => b.p - a.p);
  const tope = mejores[0].p;
  const elegidas = mejores.filter((m) => m.p >= tope - 0.001);
  return { nombre: elegidas[0].nombre, parecido: tope, lineas: elegidas.flatMap((m) => m.lineas) };
}

// ---------- Rutas de autobús ----------

/**
 * Nodo de la red (por donde puede ir un bus) más cercano a un punto; -1 si no hay a < 40 m.
 * Con `lineas` (los tramos de una calle), solo vale un nodo de esa calle.
 */
function nodoCercano(p, lineas) {
  const { nodos, ady, idNodo } = cargar();
  if (lineas) {
    let mejor = -1, mejorD = 40;
    for (const l of lineas) for (const q of l) {
      const id = idNodo.get(claveNodo(q));
      if (id === undefined || !ady[id].length) continue;
      const d = metros(q, p);
      if (d < mejorD) { mejorD = d; mejor = id; }
    }
    if (mejor >= 0) return mejor;
  }
  let mejor = -1, mejorD = 40;
  for (let i = 0; i < nodos.length; i++) {
    if (!ady[i].length) continue;
    const dy = Math.abs(nodos[i][0] - p[0]);
    if (dy > 0.0005) continue;
    const d = metros(nodos[i], p);
    if (d < mejorD) { mejorD = d; mejor = i; }
  }
  return mejor;
}

/** Dijkstra entre dos nodos (con montículo binario). Devuelve la lista de aristas o null. */
function camino(origen, destino) {
  const { ady } = cargar();
  const dist = new Map([[origen, 0]]);
  const previo = new Map();
  const monton = [[0, origen]];
  const sacar = () => {
    const top = monton[0];
    const ultimo = monton.pop();
    if (monton.length) {
      monton[0] = ultimo;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < monton.length && monton[l][0] < monton[m][0]) m = l;
        if (r < monton.length && monton[r][0] < monton[m][0]) m = r;
        if (m === i) break;
        [monton[i], monton[m]] = [monton[m], monton[i]];
        i = m;
      }
    }
    return top;
  };
  const meter = (x) => {
    monton.push(x);
    let i = monton.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (monton[p][0] <= monton[i][0]) break;
      [monton[p], monton[i]] = [monton[i], monton[p]];
      i = p;
    }
  };
  while (monton.length) {
    const [d, u] = sacar();
    if (u === destino) break;
    if (d > (dist.get(u) ?? Infinity) || d > 20000) continue;
    for (const arista of ady[u]) {
      const nd = d + arista[2];
      if (nd < (dist.get(arista[0]) ?? Infinity)) {
        dist.set(arista[0], nd);
        previo.set(arista[0], [u, arista]);
        meter([nd, arista[0]]);
      }
    }
  }
  if (!previo.has(destino) && origen !== destino) return null;
  const aristas = [];
  for (let v = destino; v !== origen; ) {
    const [u, a] = previo.get(v);
    aristas.push([u, a]);
    v = u;
  }
  return aristas.reverse();
}

/**
 * Ruta de autobús que pasa por los puntos dados, en orden. `callesDePaso[k]` (opcional) es la calle
 * en la que tiene que caer el punto k.
 * Devuelve { pts, metros, calles: [{ nombre, metros }] } o null.
 */
export async function ruta(puntos, callesDePaso = []) {
  const { nodos, nombres } = cargar();
  const ids = puntos.map((p, k) => nodoCercano(p, callesDePaso[k]?.lineas));
  if (ids.some((i) => i < 0)) return null;
  const pts = [nodos[ids[0]]];
  const calles = [];
  let total = 0;
  for (let k = 0; k < ids.length - 1; k++) {
    if (ids[k] === ids[k + 1]) continue;
    const c = camino(ids[k], ids[k + 1]);
    if (!c) return null;
    for (const [, [v, m, , ni]] of c) {
      pts.push(nodos[v]);
      total += m;
      const nombre = ni >= 0 ? nombres[ni] : '';
      const ultima = calles[calles.length - 1];
      if (ultima && ultima.nombre === nombre) ultima.metros += m;
      else calles.push({ nombre, metros: m });
    }
  }
  return { pts, metros: total, calles };
}
