// Cambios de recorrido sobre UN patrón (una línea en un sentido): desvío por otras calles,
// paradas anuladas y recortes. Trabaja sobre un «patrón de trabajo»:
//   { l, d, p: [idxParada], v: [[servicio, t0, d1, ...]], pts: [[lat, lon]] (cada ~10 m),
//     si: [posición en pts de cada parada], dv: [[ini, fin]] (tramos desviados en pts),
//     o: [[[lat, lon]...]] (trozos del recorrido normal que ya no se hacen) }
//
// Regla de oro: si algo no cuadra, NO se cambia el recorrido (se devuelve el motivo) y la app
// solo enseñará el aviso. Nunca dibujamos un recorrido que no hayamos podido comprobar.

import {
  acumulado, aPolilineas, decodificar, metros, nucleo, numeroPortal, parecido, proyectar,
} from './comun.mjs';
import { buscarCalle, ruta } from './osm.mjs';

const PASO = 10; // m entre puntos del trazado de trabajo
const CERCA_CALLE = 16; // m: el bus «va por» una calle si está a menos de esto
const MIN_TRAMO_CORTADO = 50; // m: menos que esto es cruzar la calle, no ir por ella

// ---------- Patrón de trabajo ----------

/** Pasa un patrón compilado (y su trazado) a patrón de trabajo. null si no hay trazado. */
export function aTrabajo(patron, forma, paradas) {
  if (!forma) return null;
  const orig = decodificar(forma.c);
  if (orig.length < 2) return null;
  // Densificamos recordando dónde cae cada vértice original.
  const pts = [orig[0]];
  const enVertice = [0];
  for (let k = 1; k < orig.length; k++) {
    const a = orig[k - 1], b = orig[k];
    const n = Math.max(1, Math.ceil(metros(a, b) / PASO));
    for (let j = 1; j <= n; j++) pts.push([a[0] + ((b[0] - a[0]) * j) / n, a[1] + ((b[1] - a[1]) * j) / n]);
    enVertice.push(pts.length - 1);
  }
  const acum = acumulado(pts);
  const si = [];
  let desde = 0;
  for (let s = 0; s < patron.p.length; s++) {
    let pos;
    const iv = forma.i[s];
    if (iv !== undefined && iv >= 0) pos = enVertice[iv];
    else {
      // Parada que no encajaba con el trazado: la proyectamos (sin volver atrás).
      const par = paradas[patron.p[s]];
      const trozo = pts.slice(desde);
      pos = desde + Math.round(proyectar([par[2], par[3]], trozo).pos / PASO);
    }
    pos = Math.max(desde, Math.min(pts.length - 1, pos));
    si.push(pos);
    desde = pos;
  }
  return { l: patron.l, d: patron.d, ...(patron.nb ? { nb: patron.nb } : {}), p: patron.p.slice(), v: patron.v.map((f) => f.slice()), pts, acum, si, dv: [], o: [] };
}

/** Horas (s) de llegada a cada parada de un viaje. */
function horas(fila) {
  const h = [fila[1]];
  for (let k = 2; k < fila.length; k++) h.push(h[h.length - 1] + fila[k]);
  return h;
}
function aFila(servicio, h) {
  const f = [servicio, Math.round(h[0])];
  for (let k = 1; k < h.length; k++) f.push(Math.max(0, Math.round(h[k] - h[k - 1])));
  return f;
}

// ---------- Paradas ----------

/**
 * Paradas que corresponden a una referencia del aviso («Policarpo Sanz, nº 26», «Urzáiz-Príncipe»,
 * o el número de Vitrasa si lo da). Devuelve índices en `paradas` ([número, nombre, lat, lon]).
 */
export function casarParadas(ref, paradas) {
  if (ref.numero_parada) {
    const n = Number(String(ref.numero_parada).replace(/\D/g, ''));
    const idx = paradas.findIndex((p) => p[0] === n);
    return idx >= 0 ? [idx] : [];
  }
  const calle = nucleo(ref.calle ?? '');
  const num = String(ref.numero ?? '').trim();
  const esNumero = /^\d+$/.test(num);
  const extra = esNumero ? '' : nucleo(num);
  const salida = [];
  paradas.forEach((p, idx) => {
    const nombre = p[1];
    const n = nucleo(nombre);
    if (esNumero) {
      if (numeroPortal(nombre) !== num) return;
      if (parecido(n, calle) >= 0.85 || n.startsWith(calle + ' ')) salida.push(idx);
    } else if (extra) {
      if (n.includes(calle) && n.includes(extra)) salida.push(idx);
    } else if (parecido(n, calle) >= 0.9) salida.push(idx);
  });
  return salida;
}

/** Quita una parada del patrón: su tiempo se suma al tramo siguiente. */
function quitarParada(t, s) {
  if (s <= 0 && t.p.length <= 2) return false;
  t.p.splice(s, 1);
  t.si.splice(s, 1);
  t.v = t.v.map((f) => {
    const h = horas(f);
    h.splice(s, 1);
    return aFila(f[0], h);
  });
  return true;
}

/** Anula en el patrón las paradas indicadas (índices de parada). Devuelve cuántas quitó. */
export function anularParadas(t, idxParadas) {
  let n = 0;
  for (let s = t.p.length - 1; s >= 0; s--) {
    if (idxParadas.has(t.p[s]) && t.p.length > 2 && quitarParada(t, s)) n++;
  }
  return n;
}

/** El patrón empieza en otra parada (p. ej. «la 9B comienza en Urzáiz-Príncipe»). */
export function empezarEn(t, idxParadas) {
  const s = t.p.findIndex((p) => idxParadas.has(p));
  if (s <= 0) return s === 0 ? { ok: true, cambio: false } : { ok: false, motivo: 'la parada de inicio no está en el recorrido' };
  const corte = t.si[s];
  t.o.push(t.pts.slice(0, corte + 1));
  t.v = t.v.map((f) => aFila(f[0], horas(f).slice(s)));
  t.p = t.p.slice(s);
  t.pts = t.pts.slice(corte);
  t.acum = acumulado(t.pts);
  t.si = t.si.slice(s).map((x) => x - corte);
  t.dv = t.dv.map(([a, b]) => [a - corte, b - corte]).filter(([, b]) => b > 0);
  return { ok: true, cambio: true };
}

/** El patrón termina antes, en otra parada. */
export function terminarEn(t, idxParadas) {
  let s = -1;
  for (let k = t.p.length - 1; k >= 0; k--) if (idxParadas.has(t.p[k])) { s = k; break; }
  if (s < 0) return { ok: false, motivo: 'la parada final no está en el recorrido' };
  if (s === t.p.length - 1) return { ok: true, cambio: false };
  const corte = t.si[s];
  t.o.push(t.pts.slice(corte));
  t.v = t.v.map((f) => aFila(f[0], horas(f).slice(0, s + 1)));
  t.p = t.p.slice(0, s + 1);
  t.si = t.si.slice(0, s + 1);
  t.pts = t.pts.slice(0, corte + 1);
  t.acum = acumulado(t.pts);
  t.dv = t.dv.filter(([a]) => a < corte).map(([a, b]) => [a, Math.min(b, corte)]);
  return { ok: true, cambio: true };
}

// ---------- Desvío por otras calles ----------

/** Tramos del recorrido que van POR una calle (no solo la cruzan). */
function tramosPorCalle(t, calle) {
  const cerca = t.pts.map((p) => aPolilineas(p, calle.lineas) < CERCA_CALLE);
  const tramos = [];
  for (let k = 0; k < cerca.length; k++) {
    if (!cerca[k]) continue;
    let fin = k;
    while (fin + 1 < cerca.length && cerca[fin + 1]) fin++;
    if (t.acum[fin] - t.acum[k] >= MIN_TRAMO_CORTADO) tramos.push([k, fin]);
    k = fin;
  }
  return tramos;
}

const parecidoCalle = (a, b) => parecido(nucleo(a), nucleo(b));

/**
 * ¿Cuánto antes del corte pasa este patrón por la calle de la que sale el desvío? (metros)
 * null si no pasa por la calle cortada en ese sentido o no viene de esa calle.
 * Sirve para elegir, entre varios tramos del mismo corte, el que corresponde a este patrón.
 */
export function encaje(t, tramo) {
  const cortada = buscarCalle(tramo.calle_cortada, null);
  if (!cortada) return null;
  let mejor = null;
  for (const [ini, fin] of tramosPorCalle(t, cortada)) {
    if (tramo.hacia) {
      const hacia = buscarCalle(tramo.hacia, t.pts[fin], 2500);
      if (!hacia || !(aPolilineas(t.pts[fin], hacia.lineas) < aPolilineas(t.pts[ini], hacia.lineas) - 15)) continue;
    }
    if (!tramo.desde_calle) return 0;
    const desde = buscarCalle(tramo.desde_calle, t.pts[ini], 2500);
    if (!desde) continue;
    for (let k = ini - 1; k >= 0 && t.acum[ini] - t.acum[k] <= 1500; k--) {
      if (aPolilineas(t.pts[k], desde.lineas) < CERCA_CALLE && aPolilineas(t.pts[k], cortada.lineas) >= CERCA_CALLE + 8) {
        const d = t.acum[ini] - t.acum[k];
        if (mejor === null || d < mejor) mejor = d;
        break;
      }
    }
  }
  return mejor;
}
/** ¿Va este patrón POR la calle cortada en el sentido cortado (sin mirar de dónde viene)? */
export function pasaPorCortada(t, tramo) {
  const cortada = buscarCalle(tramo.calle_cortada, null);
  if (!cortada) return false;
  return tramosPorCalle(t, cortada).some(([ini, fin]) => {
    if (!tramo.hacia) return true;
    const hacia = buscarCalle(tramo.hacia, t.pts[fin], 2500);
    return Boolean(hacia) && aPolilineas(t.pts[fin], hacia.lineas) < aPolilineas(t.pts[ini], hacia.lineas) - 15;
  });
}
/** ¿Pasa la ruta dos veces por el mismo punto (separadas por más de 150 m de recorrido)? */
function tieneVuelta(pts) {
  const acum = acumulado(pts);
  for (let i = 0; i < pts.length; i++) {
    for (let j = i + 1; j < pts.length; j++) {
      if (acum[j] - acum[i] > 150 && metros(pts[i], pts[j]) < 12) return true;
    }
  }
  return false;
}
const minimo = (lista, coste) => lista.reduce((m, x) => (m === null || coste(x) < coste(m) ? x : m), null);

/**
 * Aplica un tramo de desvío al patrón de trabajo (lo modifica).
 * Resultado: { aplica: false } si este patrón no pasa por la calle cortada en ese sentido
 * (o viene de otra calle); { aplica: true, ok: true } si se ha desviado y comprobado;
 * { aplica: true, ok: false, motivo } si debería desviarse pero no se ha podido comprobar.
 */
export async function desviar(t, tramo, ctx) {
  const ref = t.pts[Math.floor(t.pts.length / 2)];
  const cortada = buscarCalle(tramo.calle_cortada, null);
  if (!cortada) return { aplica: true, ok: false, motivo: `no encuentro la calle cortada «${tramo.calle_cortada}»` };
  const usos = tramosPorCalle(t, cortada);
  if (!usos.length) return { aplica: false };

  // Recorremos los usos de atrás adelante para que los índices de los anteriores sigan valiendo.
  let aplicado = false;
  for (const [ini, fin] of usos.reverse()) {
    // ¿Va en el sentido cortado?
    if (tramo.hacia) {
      const hacia = buscarCalle(tramo.hacia, t.pts[fin], 2500);
      if (!hacia) return { aplica: true, ok: false, motivo: `no encuentro «${tramo.hacia}»` };
      const d0 = aPolilineas(t.pts[ini], hacia.lineas);
      const d1 = aPolilineas(t.pts[fin], hacia.lineas);
      if (!(d1 < d0 - 15)) continue; // va en el otro sentido
    }
    // ¿Viene de la calle desde la que empieza el desvío? (busca hacia atrás hasta 1,5 km)
    let iDiv = -1;
    let desde = null;
    if (tramo.desde_calle) {
      desde = buscarCalle(tramo.desde_calle, t.pts[ini], 2500);
      if (!desde) return { aplica: true, ok: false, motivo: `no encuentro «${tramo.desde_calle}»` };
      // (antes de llegar a la calle cortada: el punto de la esquina misma no vale)
      for (let k = ini - 1; k >= 0 && t.acum[ini] - t.acum[k] <= 1500; k--) {
        if (aPolilineas(t.pts[k], desde.lineas) < CERCA_CALLE && aPolilineas(t.pts[k], cortada.lineas) >= CERCA_CALLE + 8) {
          iDiv = k;
          break;
        }
      }
      if (iDiv < 0) continue; // viene por otro sitio: le toca otro tramo del aviso
    } else {
      iDiv = Math.max(0, ini - 1);
    }

    // Calles del desvío, en orden.
    const calles = [];
    for (const nombre of tramo.itinerario ?? []) {
      const c = buscarCalle(nombre, t.pts[ini], 2500);
      if (!c) return { aplica: true, ok: false, motivo: `no encuentro la calle «${nombre}» del desvío` };
      calles.push(c);
    }
    if (!calles.length) return { aplica: true, ok: false, motivo: 'el desvío no dice por qué calles va' };

    // Dónde retoma el recorrido normal: primer punto después del corte que va por la última calle
    // del desvío (hasta 2,5 km más allá).
    const ultima = calles[calles.length - 1];
    let iRej = -1;
    for (let k = fin + 1; k < t.pts.length && t.acum[k] - t.acum[fin] <= 2500; k++) {
      if (aPolilineas(t.pts[k], ultima.lineas) < CERCA_CALLE && aPolilineas(t.pts[k], cortada.lineas) >= CERCA_CALLE + 8) {
        iRej = k;
        break;
      }
    }
    // La última calle puede ser donde ya termina el recorrido (fin de línea): retoma en el final.
    if (iRej < 0) return { aplica: true, ok: false, motivo: `no sé dónde vuelve al recorrido normal tras «${ultima.nombre}»` };

    // Puntos de paso: uno en cada calle del desvío, a mitad de camino entre por donde se entra
    // (lo más cerca de la calle anterior) y por donde se sale (lo más cerca de la siguiente).
    const cadena = calles;
    const paso = [t.pts[iDiv]];
    const callesPaso = [desde];
    let previo = t.pts[iDiv];
    for (let k = 0; k < cadena.length; k++) {
      const vertices = cadena[k].lineas.flatMap((l, li) => l.map((p, pi) => ({ p, li, pi })));
      const entrada = minimo(vertices, (v) => metros(v.p, previo));
      let salida;
      if (k + 1 < cadena.length) {
        const siguiente = cadena[k + 1];
        const dist = vertices.map((v) => aPolilineas(v.p, siguiente.lineas));
        const mejor = Math.min(...dist);
        salida = minimo(vertices.filter((_, j) => dist[j] <= mejor + 15), (v) => metros(v.p, entrada.p));
      } else {
        salida = minimo(vertices, (v) => metros(v.p, t.pts[iRej]));
      }
      let punto;
      if (entrada.li === salida.li && Math.abs(entrada.pi - salida.pi) >= 2) {
        punto = cadena[k].lineas[entrada.li][Math.round((entrada.pi + salida.pi) / 2)];
      } else {
        punto = [(entrada.p[0] + salida.p[0]) / 2, (entrada.p[1] + salida.p[1]) / 2];
        const v = minimo(vertices, (x) => metros(x.p, punto));
        punto = metros(v.p, punto) < 60 ? v.p : entrada.p;
      }
      paso.push(punto);
      callesPaso.push(cadena[k]);
      previo = salida.p;
    }
    paso.push(t.pts[iRej]);
    callesPaso.push(ultima);

    const r = await ruta(paso, callesPaso);
    if (process.env.DEPURAR) {
      console.log(`[${t.l} → ${t.d}] desde ${tramo.desde_calle} · paso`, paso.map((p) => p.map((x) => x.toFixed(5)).join(',')).join(' ; '));
      console.log('   calles de la ruta:', r?.calles.map((c) => `${c.nombre}(${Math.round(c.metros)})`).join(' > '));
    }
    if (!r) return { aplica: true, ok: false, motivo: 'el servicio de rutas no responde' };

    // Comprobaciones: pasa por todas las calles del desvío, en orden, y no por la cortada.
    let k = 0;
    for (const c of calles) {
      while (k < r.calles.length && parecidoCalle(r.calles[k].nombre, c.nombre) < 0.85) k++;
      if (k >= r.calles.length) return { aplica: true, ok: false, motivo: `la ruta calculada no pasa por «${c.nombre}»` };
    }
    const porCortada = r.calles.filter((c) => parecidoCalle(c.nombre, cortada.nombre) >= 0.9).reduce((s, c) => s + c.metros, 0);
    if (porCortada > 40) return { aplica: true, ok: false, motivo: `la ruta calculada sigue usando «${cortada.nombre}»` };
    if (tieneVuelta(r.pts)) return { aplica: true, ok: false, motivo: 'la ruta calculada da una vuelta sobre sí misma' };
    const largoNormal = t.acum[iRej] - t.acum[iDiv];
    if (r.metros > Math.max(largoNormal * 3.5, largoNormal + 2500)) {
      return { aplica: true, ok: false, motivo: `desvío demasiado largo (${Math.round(r.metros)} m frente a ${Math.round(largoNormal)} m)` };
    }

    aplicarRuta(t, iDiv, iRej, r.pts, tramo, ctx);
    aplicado = true;
  }
  return aplicado ? { aplica: true, ok: true } : { aplica: false };
}

/** Sustituye en el patrón el trozo [iDiv, iRej] por la ruta nueva, con sus paradas y tiempos. */
function aplicarRuta(t, iDiv, iRej, rutaPts, tramo, ctx) {
  // Ruta densificada (mismo paso que el resto).
  const nueva = [rutaPts[0]];
  for (let k = 1; k < rutaPts.length; k++) {
    const a = rutaPts[k - 1], b = rutaPts[k];
    const n = Math.max(1, Math.ceil(metros(a, b) / PASO));
    for (let j = 1; j <= n; j++) nueva.push([a[0] + ((b[0] - a[0]) * j) / n, a[1] + ((b[1] - a[1]) * j) / n]);
  }
  const acumNueva = acumulado(nueva);

  // Paradas: las de antes y después se quedan; en medio, solo las que siguen en el camino nuevo
  // (y no están anuladas) y las provisionales del aviso que caen en él.
  const antes = [], despues = [], medio = [];
  t.p.forEach((p, s) => {
    if (t.si[s] <= iDiv) antes.push(s);
    else if (t.si[s] >= iRej) despues.push(s);
    else if (!ctx.anuladas.has(p)) {
      const par = ctx.paradas[p];
      const pr = proyectar([par[2], par[3]], nueva, acumNueva);
      if (pr.d < 20) medio.push({ p, pos: pr.pos, vieja: s });
    }
  });
  if (!antes.length || !despues.length) throw new Error('el desvío empieza antes de la primera parada o acaba después de la última');
  for (const ref of tramo.paradas_provisionales ?? []) {
    for (const p of casarParadas(ref, ctx.paradas)) {
      if (medio.some((m) => m.p === p)) continue;
      const par = ctx.paradas[p];
      const pr = proyectar([par[2], par[3]], nueva, acumNueva);
      if (pr.d < 30 && pr.pos > 15 && pr.pos < acumNueva[acumNueva.length - 1] - 15) medio.push({ p, pos: pr.pos, vieja: -1 });
    }
  }
  medio.sort((a, b) => a.pos - b.pos);

  // Tiempos: el trozo nuevo tarda lo mismo que el viejo, escalado por su longitud.
  const sA = antes[antes.length - 1];
  const sB = despues[0];
  const largoViejo = t.acum[t.si[sB]] - t.acum[t.si[sA]];
  const largoNuevo =
    t.acum[iDiv] - t.acum[t.si[sA]] + acumNueva[acumNueva.length - 1] + (t.acum[t.si[sB]] - t.acum[iRej]);
  const factor = Math.max(0.8, Math.min(3, largoNuevo / Math.max(1, largoViejo)));
  const posEnNuevo = (m) => t.acum[iDiv] - t.acum[t.si[sA]] + m.pos; // m desde la parada sA

  t.v = t.v.map((f) => {
    const h = horas(f);
    const hA = h[sA], hB = h[sB];
    const dur = (hB - hA) * factor;
    const salida = antes.map((s) => h[s]);
    for (const m of medio) salida.push(hA + (dur * posEnNuevo(m)) / Math.max(1, largoNuevo));
    const extra = dur - (hB - hA);
    for (const s of despues) salida.push(h[s] + extra);
    return aFila(f[0], salida);
  });

  // Trazado y posiciones.
  const nuevoPts = [...t.pts.slice(0, iDiv), ...nueva, ...t.pts.slice(iRej + 1)];
  const desplaz = nueva.length - (iRej - iDiv + 1);
  t.o.push(t.pts.slice(iDiv, iRej + 1));
  t.p = [...antes.map((s) => t.p[s]), ...medio.map((m) => m.p), ...despues.map((s) => t.p[s])];
  const posMedio = medio.map((m) => {
    let j = 0;
    while (j < acumNueva.length - 1 && acumNueva[j] < m.pos) j++;
    return iDiv + j;
  });
  t.si = [...antes.map((s) => t.si[s]), ...posMedio, ...despues.map((s) => t.si[s] + desplaz)];
  t.dv = [...t.dv.map(([a, b]) => (a >= iRej ? [a + desplaz, b + desplaz] : [a, b])), [iDiv, iDiv + nueva.length - 1]];
  t.pts = nuevoPts;
  t.acum = acumulado(nuevoPts);
  // Posiciones crecientes (dos paradas pueden caer en el mismo punto).
  for (let s = 1; s < t.si.length; s++) t.si[s] = Math.max(t.si[s], t.si[s - 1]);
}
