// Convierte el GTFS de Vitrasa en un archivo compacto para el motor de rutas.
//
// Uso:  node scripts/compilar-gtfs.mjs <carpeta GTFS descomprimida> [salida.json]
// Por defecto escribe src/data/horarios.json
//
// Fuente: Concello de Vigo / Vitrasa, datos abiertos (licencia ODC-BY).
//
// Formato de salida (todo en índices para ocupar poco):
// {
//   v: 1, generado: ISO, fechas: { "20261110": [idxServicio, ...] },
//   paradas: [[numeroVitrasa, nombre, lat, lon], ...],
//   transbordos: [[idxParada, segundos, idxParada, segundos, ...], ...]  // a pie, por parada
//   patrones: [{ l: linea, d: destino, p: [idxParada...], v: [[idxServicio, t0, d1, d2, ...], ...] }]
//     // t0 = salida en la 1ª parada (s desde medianoche, puede pasar de 86400), dN = incrementos
// }

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const carpeta = process.argv[2];
if (!carpeta) {
  console.error('Uso: node scripts/compilar-gtfs.mjs <carpeta GTFS> [salida.json]');
  process.exit(1);
}
const raiz = join(dirname(fileURLToPath(import.meta.url)), '..');
const salida = process.argv[3] ?? join(raiz, 'src', 'data', 'horarios.json');

// Distancia máxima a pie para un transbordo entre paradas, y velocidad al caminar.
const TRANSBORDO_MAX_M = 400;
const VELOCIDAD_PIE = 1.2; // m/s ≈ 4,3 km/h
const FACTOR_RODEO = 1.3; // las calles no son línea recta

// --- CSV mínimo con soporte de comillas ---
function leerCsv(nombre) {
  const texto = readFileSync(join(carpeta, nombre), 'utf8').replace(/^﻿/, '');
  const filas = [];
  let campo = '';
  let fila = [];
  let comillas = false;
  for (let i = 0; i < texto.length; i++) {
    const c = texto[i];
    if (comillas) {
      if (c === '"') {
        if (texto[i + 1] === '"') {
          campo += '"';
          i++;
        } else comillas = false;
      } else campo += c;
    } else if (c === '"') comillas = true;
    else if (c === ',') {
      fila.push(campo);
      campo = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && texto[i + 1] === '\n') i++;
      fila.push(campo);
      filas.push(fila);
      fila = [];
      campo = '';
    } else campo += c;
  }
  if (campo || fila.length) {
    fila.push(campo);
    filas.push(fila);
  }
  const cabecera = filas.shift().map((h) => h.trim());
  return filas
    .filter((f) => f.length > 1 || (f[0] ?? '').trim())
    .map((f) => Object.fromEntries(cabecera.map((h, i) => [h, (f[i] ?? '').trim()])));
}

const limpiar = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const segundos = (hms) => {
  const [h, m, s] = hms.split(':').map(Number);
  return h * 3600 + m * 60 + (s || 0);
};
function distancia(a, b) {
  const R = 6371000;
  const rad = Math.PI / 180;
  const dLat = (b[1] - a[1]) * rad;
  const dLon = (b[2] - a[2]) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[1] * rad) * Math.cos(b[1] * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// --- Paradas: el número de Vitrasa sale de stop_code ("P006930" → 6930) ---
const stops = leerCsv('stops.txt');
const paradas = []; // [numero, nombre, lat, lon]
const idxPorStopId = new Map();
for (const s of stops) {
  const numero = Number((s.stop_code || '').replace(/\D/g, '')) || Number(s.stop_id);
  idxPorStopId.set(s.stop_id, paradas.length);
  paradas.push([
    numero,
    limpiar(s.stop_name),
    Math.round(Number(s.stop_lat) * 1e6) / 1e6,
    Math.round(Number(s.stop_lon) * 1e6) / 1e6,
  ]);
}

// --- Servicios por fecha ---
const servicios = new Map(); // service_id → idx
const idxServicio = (id) => {
  if (!servicios.has(id)) servicios.set(id, servicios.size);
  return servicios.get(id);
};
const fechas = {};
const diasSemana = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
for (const c of leerCsv('calendar.txt')) {
  if (!c.service_id) continue;
  const ini = c.start_date;
  const fin = c.end_date;
  const d = new Date(`${ini.slice(0, 4)}-${ini.slice(4, 6)}-${ini.slice(6, 8)}T12:00:00Z`);
  for (;;) {
    const f = d.toISOString().slice(0, 10).replace(/-/g, '');
    if (f > fin) break;
    if (c[diasSemana[d.getUTCDay()]] === '1') (fechas[f] ??= new Set()).add(idxServicio(c.service_id));
    d.setUTCDate(d.getUTCDate() + 1);
  }
}
for (const cd of leerCsv('calendar_dates.txt')) {
  const set = (fechas[cd.date] ??= new Set());
  if (cd.exception_type === '1') set.add(idxServicio(cd.service_id));
  else if (cd.exception_type === '2' && servicios.has(cd.service_id)) set.delete(servicios.get(cd.service_id));
}

// --- Días de reserva, por si el Concello tarda en publicar el GTFS nuevo ---
// El GTFS solo trae ~7 días y a veces el Concello lo renueva tarde: el 26-11-2026 los horarios se
// acababan ese mismo día y la app se habría quedado sin rutas. Por eso alargamos DIAS_RESERVA días
// repitiendo el mismo día de la semana anterior. En cuanto llega el GTFS nuevo, manda el oficial
// (estos días se vuelven a calcular en cada compilación y nunca pisan un día que traiga el GTFS).
const DIAS_RESERVA = 7;
const claveDia = (d) => d.toISOString().slice(0, 10).replace(/-/g, '');
const diaUTC = (f) => new Date(`${f.slice(0, 4)}-${f.slice(4, 6)}-${f.slice(6, 8)}T12:00:00Z`);
const conServicio = Object.keys(fechas)
  .filter((f) => fechas[f].size)
  .sort();
// Un laborable con muchos menos servicios que lo normal es un festivo: no lo copiamos a otro laborable.
const laborables = conServicio.filter((f) => [1, 2, 3, 4, 5].includes(diaUTC(f).getUTCDay()));
const tamLaborable = laborables.map((f) => fechas[f].size).sort((a, b) => a - b)[Math.floor(laborables.length / 2)] ?? 0;
const pareceFestivo = (f) => [1, 2, 3, 4, 5].includes(diaUTC(f).getUTCDay()) && fechas[f].size < tamLaborable * 0.8;
const laborableTipo = laborables.filter((f) => !pareceFestivo(f)).at(-1);
const diasReserva = [];
if (conServicio.length) {
  const d = diaUTC(conServicio.at(-1));
  for (let k = 0; k < DIAS_RESERVA; k++) {
    d.setUTCDate(d.getUTCDate() + 1);
    const f = claveDia(d);
    if (fechas[f]?.size) continue;
    const semanaAntes = new Date(d);
    semanaAntes.setUTCDate(semanaAntes.getUTCDate() - 7);
    let ref = claveDia(semanaAntes);
    if (fechas[ref]?.size && pareceFestivo(ref) && laborableTipo) ref = laborableTipo;
    if (!fechas[ref]?.size) continue;
    fechas[f] = new Set(fechas[ref]);
    diasReserva.push(f);
  }
}
if (diasReserva.length) console.log(`Días de reserva (copiados de la semana anterior): ${diasReserva.join(', ')}`);

// --- Líneas y viajes ---
const rutasGtfs = leerCsv('routes.txt');
const lineas = new Map(rutasGtfs.map((r) => [r.route_id, limpiar(r.route_short_name)]));
// Nombre largo de cada línea ("C1" → "CIRCULAR CENTRO"), para la pestaña Líneas.
const nombresLineas = {};
for (const r of rutasGtfs) {
  const corto = limpiar(r.route_short_name);
  if (corto && !(corto in nombresLineas)) nombresLineas[corto] = limpiar(r.route_long_name);
}
const viajes = new Map(); // trip_id → { linea, destino, servicio, paradas:[], horas:[] }
for (const t of leerCsv('trips.txt')) {
  viajes.set(t.trip_id, {
    linea: lineas.get(t.route_id) ?? '?',
    destino: limpiar(t.trip_headsign),
    servicio: idxServicio(t.service_id),
    // Trazados (shape_id) que recorre, en orden: normalmente uno (ver lanzaderas más abajo).
    formas: [t.shape_id],
    tiempos: [],
  });
}
for (const st of leerCsv('stop_times.txt')) {
  const v = viajes.get(st.trip_id);
  const idx = idxPorStopId.get(st.stop_id);
  if (!v || idx === undefined) continue;
  const hora = st.departure_time || st.arrival_time;
  if (!hora) continue;
  v.tiempos.push([Number(st.stop_sequence), idx, segundos(hora)]);
}
for (const v of viajes.values()) v.tiempos.sort((a, b) => a[0] - b[0]);

// --- Lanzaderas de la universidad (U1, U2) ---
// Lo que el GTFS no cuenta y nos dijeron los usuarios (27-11-2026):
//  1. Los viajes hacia la universidad acaban en Humanidades, pero el MISMO bus sigue dando la vuelta
//     al campus (Económicas… Enxeñeiros, Telecomunicacións), que en el GTFS es el principio del viaje
//     de vuelta. Sin esto, para ir a Teleco la app mandaba «transbordar» a otro U1 en Humanidades.
//     Así que a cada viaje que acaba en Humanidades le añadimos esa vuelta, con las horas del viaje
//     de vuelta que sale justo después.
//  2. El U2 hacia la universidad solo deja gente en el CEU (Maxisterio, Avda. de Madrid 110,
//     junto al Alcampo) y en el campus; en el resto de paradas solo recoge.
const LANZADERAS = new Set(['U1', 'U2']);
const HUMANIDADES = 8720;
const CEU = 1990;
const esCampus = (idx) => paradas[idx][1].includes('(CUVI)');
const numeroDe = (idx) => paradas[idx][0];
{
  const lanz = [...viajes.values()].filter((v) => LANZADERAS.has(v.linea) && v.tiempos.length >= 2);
  const salenDeHumanidades = lanz.filter((v) => numeroDe(v.tiempos[0][1]) === HUMANIDADES);
  const usados = new Set();
  let unidos = 0;
  for (const v of lanz) {
    const ultima = v.tiempos[v.tiempos.length - 1];
    if (numeroDe(ultima[1]) !== HUMANIDADES) continue;
    // El viaje de vuelta del mismo día que sale de Humanidades en los 10 minutos siguientes.
    let w = null;
    for (const c of salenDeHumanidades) {
      if (usados.has(c) || c.servicio !== v.servicio) continue;
      const espera = c.tiempos[0][2] - ultima[2];
      if (espera < 0 || espera > 600) continue;
      if (!w || c.tiempos[0][2] < w.tiempos[0][2]) w = c;
    }
    if (!w) continue;
    // Su tramo por el campus, sin Humanidades (ya está) y hasta la última parada del campus.
    const vuelta = [];
    for (const t of w.tiempos.slice(1)) {
      if (!esCampus(t[1])) break;
      vuelta.push(t);
    }
    if (!vuelta.length) continue;
    usados.add(w);
    const seq = ultima[0];
    vuelta.forEach((t, k) => v.tiempos.push([seq + k + 1, t[1], t[2]]));
    v.formas.push(w.formas[0]);
    unidos++;
  }
  console.log(`Lanzaderas: ${unidos} viajes a la universidad siguen la vuelta al campus.`);
}
/**
 * Paradas (índices de `paradas`) de este viaje donde no se puede bajar, o undefined si se puede en todas.
 * Van por parada y no por posición para que sigan valiendo si un desvío quita paradas al recorrido.
 */
function sinBajada(v) {
  if (v.linea !== 'U2' || !v.tiempos.some((t) => esCampus(t[1]))) return undefined;
  // Solo hacia la universidad: el viaje acaba en el campus (el de vuelta empieza en él).
  if (!esCampus(v.tiempos[v.tiempos.length - 1][1]) || esCampus(v.tiempos[0][1])) return undefined;
  const nb = new Set();
  v.tiempos.forEach((t, pos) => {
    if (pos > 0 && !esCampus(t[1]) && numeroDe(t[1]) !== CEU) nb.add(t[1]);
  });
  return nb.size ? [...nb] : undefined;
}

// --- Agrupar viajes con la misma secuencia de paradas en "patrones" ---
const patrones = new Map();
const formaDePatron = new Map(); // patrón → shape_ids (para los trazados del mapa)
for (const v of viajes.values()) {
  if (v.tiempos.length < 2) continue;
  const ps = v.tiempos.map((t) => t[1]);
  const hs = v.tiempos.map((t) => t[2]);
  const clave = `${v.linea}|${v.destino}|${ps.join(',')}`;
  let p = patrones.get(clave);
  if (!p) {
    p = { l: v.linea, d: v.destino, p: ps, v: [] };
    // nb = paradas donde no se puede bajar (la app no las ofrece como bajada al buscar rutas).
    const nb = sinBajada(v);
    if (nb) p.nb = nb;
    patrones.set(clave, p);
    formaDePatron.set(p, v.formas);
  }
  const fila = [v.servicio, hs[0]];
  for (let i = 1; i < hs.length; i++) fila.push(Math.max(0, hs[i] - hs[i - 1]));
  p.v.push(fila);
}
for (const p of patrones.values()) p.v.sort((a, b) => a[1] - b[1]);

// --- Transbordos a pie entre paradas cercanas ---
const transbordos = paradas.map((a, i) => {
  const lista = [];
  paradas.forEach((b, j) => {
    if (i === j) return;
    const m = distancia(a, b);
    if (m <= TRANSBORDO_MAX_M) lista.push(j, Math.round((m * FACTOR_RODEO) / VELOCIDAD_PIE));
  });
  return lista;
});

const resultado = {
  v: 1,
  generado: new Date().toISOString(),
  fechas: Object.fromEntries(
    Object.entries(fechas)
      .sort()
      .map(([f, s]) => [f, [...s].sort((a, b) => a - b)]),
  ),
  // Días que no trae el GTFS y hemos copiado de la semana anterior (ver «Días de reserva»).
  reserva: diasReserva,
  paradas,
  transbordos,
  patrones: [...patrones.values()],
  nombresLineas,
};
const json = JSON.stringify(resultado);
writeFileSync(salida, json);

// --- Trazados para el mapa (formas.json, mismo orden de patrones) ---
// Por cada patrón: puntos simplificados (cada ~8 m de error como mucho) codificados
// como enteros de 1e-5 grados en incrementos, y la posición de cada parada en ellos.
const puntosForma = new Map();
for (const s of leerCsv('shapes.txt')) {
  let lista = puntosForma.get(s.shape_id);
  if (!lista) puntosForma.set(s.shape_id, (lista = []));
  lista.push([Number(s.shape_pt_sequence), Number(s.shape_pt_lat), Number(s.shape_pt_lon)]);
}
for (const lista of puntosForma.values()) lista.sort((a, b) => a[0] - b[0]);

const COS_LAT = Math.cos((42.23 * Math.PI) / 180);
const TOLERANCIA_GRADOS = 8 / 111320; // ~8 m

function distPlano(a, b) {
  return Math.hypot(a[1] - b[1], (a[2] - b[2]) * COS_LAT);
}
function distSegmento(p, a, b) {
  const ax = a[2] * COS_LAT, ay = a[1], bx = b[2] * COS_LAT, by = b[1], px = p[2] * COS_LAT, py = p[1];
  const dx = bx - ax, dy = by - ay;
  const l2 = dx * dx + dy * dy;
  const t = l2 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / l2)) : 0;
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}
function simplificar(pts) {
  // Douglas-Peucker iterativo
  if (pts.length <= 2) return pts;
  const conservar = new Uint8Array(pts.length);
  conservar[0] = conservar[pts.length - 1] = 1;
  const pila = [[0, pts.length - 1]];
  while (pila.length) {
    const [i, j] = pila.pop();
    let max = 0, idx = -1;
    for (let k = i + 1; k < j; k++) {
      const d = distSegmento(pts[k], pts[i], pts[j]);
      if (d > max) { max = d; idx = k; }
    }
    if (max > TOLERANCIA_GRADOS && idx > 0) {
      conservar[idx] = 1;
      pila.push([i, idx], [idx, j]);
    }
  }
  return pts.filter((_, k) => conservar[k]);
}

let totalPuntos = 0;
const formas = resultado.patrones.map((p) => {
  // Varios trazados seguidos (lanzaderas que siguen la vuelta al campus): se ponen uno tras otro.
  const pts = formaDePatron.get(p).flatMap((id) => puntosForma.get(id) ?? []);
  if (pts.length < 2) return null;
  // Posición de cada parada en el trazado (avanzando siempre hacia delante).
  const posParadas = [];
  const malas = [];
  let desde = 0;
  for (const s of p.p) {
    const parada = [0, paradas[s][2], paradas[s][3]];
    let mejor = desde, mejorD = Infinity;
    const hasta = Math.min(pts.length, desde + 600);
    for (let k = desde; k < hasta; k++) {
      const d = distPlano(pts[k], parada);
      if (d < mejorD) { mejorD = d; mejor = k; }
    }
    // En líneas circulares la primera y la última parada coinciden: nos quedamos con el PRIMER
    // punto del trazado que esté casi tan cerca como el mejor, para no saltar al final de la vuelta.
    for (let k = desde; k < mejor; k++) {
      if (distPlano(pts[k], parada) <= mejorD + 15 / 111320) { mejor = k; break; }
    }
    posParadas.push(mejor);
    malas.push(mejorD * 111320 > 80); // la parada no cae sobre el trazado: no nos fiamos
    desde = mejor;
  }
  // Simplificamos tramo a tramo para que cada parada siga siendo un punto del trazado.
  const salidaPts = [pts[posParadas[0]]];
  const indices = [0];
  for (let i = 1; i < posParadas.length; i++) {
    const tramo = simplificar(pts.slice(posParadas[i - 1], posParadas[i] + 1));
    for (let k = 1; k < tramo.length; k++) salidaPts.push(tramo[k]);
    indices.push(salidaPts.length - 1);
  }
  totalPuntos += salidaPts.length;
  const c = [];
  let pLat = 0, pLon = 0;
  for (const [, lat, lon] of salidaPts) {
    const iLat = Math.round(lat * 1e5), iLon = Math.round(lon * 1e5);
    c.push(iLat - pLat, iLon - pLon);
    pLat = iLat;
    pLon = iLon;
  }
  // -1 = parada que no encaja con el trazado (la app unirá paradas en línea recta en ese tramo).
  return { c, i: indices.map((ix, k) => (malas[k] ? -1 : ix)) };
});
const salidaFormas = join(dirname(salida), 'formas.json');
const jsonFormas = JSON.stringify({ generado: resultado.generado, formas });
writeFileSync(salidaFormas, jsonFormas);
console.log(
  `formas.json: ${(jsonFormas.length / 1024 / 1024).toFixed(2)} MB · ${totalPuntos} puntos · ` +
    `${formas.filter(Boolean).length}/${formas.length} patrones con trazado`,
);

const nViajes = resultado.patrones.reduce((n, p) => n + p.v.length, 0);
console.log(
  `horarios.json: ${(json.length / 1024 / 1024).toFixed(2)} MB · ${paradas.length} paradas · ` +
    `${resultado.patrones.length} patrones · ${nViajes} viajes · fechas ${Object.keys(resultado.fechas).join(', ')}`,
);
