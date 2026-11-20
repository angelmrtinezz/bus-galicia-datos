// Aplica los desvíos de los avisos a los horarios y trazados compilados del GTFS.
//
//   aplicarDesvios({ horarios, formas, avisos, extracciones, paradasConcello, comprobar })
//     → { horarios, formas, informe }
//
// - Solo en las FECHAS (y horas) del aviso: fuera de ellas, el recorrido de siempre. Para eso, un
//   patrón afectado se parte en dos copias con «servicios» propios (fechas de dentro / de fuera).
// - Cada patrón desviado lleva `dv: idAviso`; su trazado lleva `dv` (tramos desviados, en índices
//   de puntos) y `o` (trozos del recorrido normal que no se hacen), para pintarlos en la app.
// - horarios.desvios: resumen por aviso para la app (líneas afectadas, cuáles se han podido
//   dibujar, paradas anuladas). Las apps viejas ignoran todos estos campos y reciben igualmente
//   las paradas y trazados correctos.

import { codificar, isoAClave, metros, simplificar, sinAcentos } from './comun.mjs';
import { anularParadas, aTrabajo, casarParadas, desviar, empezarEn, encaje, pasaPorCortada, terminarEn } from './desviar.mjs';

const TRANSBORDO_MAX_M = 400;
const VELOCIDAD_PIE = 1.2;
const FACTOR_RODEO = 1.3;

/** «C1,C3i,L5A, 11» → ['C1', 'C3i', '5A', '11'] */
export function lineasDeAviso(texto) {
  return String(texto ?? '')
    .split(/[,;·•\s]+/)
    .map((s) => s.trim().replace(/^L(?=\d)/, ''))
    .filter(Boolean);
}
const mismaLinea = (a, b) => a.toUpperCase() === b.toUpperCase();

/** ¿Está el viaje (servicio + salida) dentro del aviso en la fecha `clave`? */
function dentro(vig, clave, salida) {
  if (clave < isoAClave(vig.desde) || clave > isoAClave(vig.hasta)) return false;
  if (!vig.hora_inicio && !vig.hora_fin) return true;
  const s = ((salida % 86400) + 86400) % 86400;
  const aSeg = (h) => {
    const [hh, mm] = String(h).split(':').map(Number);
    return hh * 3600 + (mm || 0) * 60;
  };
  const ini = vig.hora_inicio ? aSeg(vig.hora_inicio) - 3600 : 0; // una hora antes: el bus ya va de camino
  const fin = vig.hora_fin ? aSeg(vig.hora_fin) : 86400;
  return s >= ini && s <= fin;
}

export async function aplicarDesvios({ horarios, formas, avisos, extracciones, paradasConcello = [], comprobar }) {
  const h = structuredClone(horarios);
  const fs = structuredClone(formas.formas);
  const informe = [];
  const resumen = [];

  // Fechas → servicios, y servicios → fechas (para partir patrones por fecha).
  const fechasDeServicio = new Map();
  for (const [f, ss] of Object.entries(h.fechas)) for (const s of ss) (fechasDeServicio.get(s) ?? fechasDeServicio.set(s, []).get(s)).push(f);
  let siguienteServicio = Math.max(-1, ...fechasDeServicio.keys()) + 1;
  const virtuales = new Map(); // "fechas" → idx de servicio nuevo
  function servicioPara(fechas) {
    const clave = fechas.join(',');
    let s = virtuales.get(clave);
    if (s === undefined) {
      s = siguienteServicio++;
      virtuales.set(clave, s);
      for (const f of fechas) h.fechas[f].push(s);
      fechasDeServicio.set(s, fechas);
    }
    return s;
  }

  // Paradas del Concello que no estén en el GTFS (p. ej. provisionales): se añaden al final
  // (sin líneas propias) para poder usarlas en los desvíos.
  for (const c of paradasConcello) {
    const num = Number(c.id);
    if (!num || h.paradas.some((p) => p[0] === num)) continue;
    h.paradas.push([num, String(c.nombre ?? '').replace(/s+/g, ' ').trim(), Math.round(Number(c.lat) * 1e6) / 1e6, Math.round(Number(c.lon) * 1e6) / 1e6]);
  }
  const todasLasParadas = () => h.paradas;

  const fechasVentana = Object.keys(h.fechas).sort();
  const primera = fechasVentana[0], ultima = fechasVentana[fechasVentana.length - 1];

  for (const aviso of avisos) {
    // Una lectura de una versión vieja del aviso no vale: podría dibujar un desvío que ya no es.
    const ext = extracciones[aviso.id]?.desactualizada ? undefined : extracciones[aviso.id]?.datos;
    const lineasAviso = lineasDeAviso(aviso.lineas_afectadas);
    const entrada = {
      a: aviso.id,
      t: aviso.titulo,
      desde: ext?.vigencia?.desde ?? aviso.fecha_inicio,
      hasta: ext?.vigencia?.hasta ?? aviso.fecha_fin,
      l: lineasAviso,
      dib: [],
      sin: [],
      par: [],
    };
    if (!ext || !ext.afecta_recorrido) {
      if (ext && !ext.afecta_recorrido) continue; // informativo (servicio especial, lanzaderas…)
      informe.push(`Aviso ${aviso.id} «${aviso.titulo}»: ${extracciones[aviso.id]?.desactualizada ? 'ha cambiado y está sin volver a leer' : 'sin leer'} (solo se marcan sus líneas).`);
      if (lineasAviso.length) resumen.push({ ...entrada, sin: lineasAviso });
      continue;
    }
    const vig = { desde: entrada.desde, hasta: entrada.hasta, hora_inicio: ext.vigencia?.hora_inicio, hora_fin: ext.vigencia?.hora_fin };
    if (isoAClave(vig.hasta) < primera || isoAClave(vig.desde) > ultima) continue;

    const enAlcance = (lista, excluidas = []) => (l) =>
      (lista?.length ? lista : lineasAviso.length ? lineasAviso : [l]).some((x) => mismaLinea(x, l)) &&
      !excluidas.some((x) => mismaLinea(x, l));

    // Paradas anuladas del aviso (por línea).
    const paradasRef = todasLasParadas();
    const anuladas = (ext.paradas_anuladas ?? []).map((ref) => {
      const idx = casarParadas(ref, paradasRef).map((i) => paradasRef[i][0]);
      if (!idx.length) informe.push(`Aviso ${aviso.id}: no encuentro la parada anulada «${ref.calle} ${ref.numero ?? ''}».`);
      return { nums: new Set(idx), deLinea: enAlcance(ref.lineas) };
    });
    for (const a of anuladas) for (const n of a.nums) if (!entrada.par.includes(n)) entrada.par.push(n);

    const lineasConCambio = new Set();
    const lineasFallidas = new Map();
    const totalPatrones = h.patrones.length;
    for (let pi = 0; pi < totalPatrones; pi++) {
      const patron = h.patrones[pi];
      const afectaLinea = lineasAviso.some((x) => mismaLinea(x, patron.l)) ||
        (ext.tramos ?? []).some((tr) => tr.lineas?.some((x) => mismaLinea(x, patron.l)));
      if (!afectaLinea) continue;
      // ¿Algún viaje de este patrón cae dentro del aviso?
      const tocaAlguno = patron.v.some((f) => (fechasDeServicio.get(f[0]) ?? []).some((fe) => dentro(vig, fe, f[1])));
      if (!tocaAlguno) continue;

      const t = aTrabajo(patron, fs[pi], h.paradas);
      if (!t) continue;
      let cambio = false;
      let fallo = null;

      // Anuladas de esta línea.
      const anuladasLinea = new Set();
      for (const a of anuladas) if (a.deLinea(patron.l)) for (const n of a.nums) {
        const i = h.paradas.findIndex((p) => p[0] === n);
        if (i >= 0) anuladasLinea.add(i);
      }
      const ctx = { paradas: h.paradas, anuladas: anuladasLinea };

      // Recortes («empieza en…»).
      for (const rc of ext.recortes ?? []) {
        if (!enAlcance(rc.lineas)(patron.l)) continue;
        if (rc.hacia && !sinAcentos(patron.d).includes(sinAcentos(rc.hacia).split(' ')[0])) continue;
        const nums = new Set(casarParadas(rc.parada, h.paradas));
        if (!nums.size) { fallo = `no encuentro la parada «${rc.parada.calle} ${rc.parada.numero}»`; continue; }
        const r = rc.tipo === 'termina_en' ? terminarEn(t, nums) : empezarEn(t, nums);
        if (!r.ok) fallo = r.motivo;
        else if (r.cambio) cambio = true;
      }

      // Desvíos por otras calles. Si varios tramos son del mismo corte (misma calle y sentido),
      // solo vale el que encaja con por dónde viene este patrón (la calle de salida más cercana).
      const grupos = new Map();
      const cortesQueToca = new Set();
      for (const tramo of ext.tramos ?? []) {
        if (!enAlcance(tramo.lineas, tramo.lineas_excluidas)(patron.l)) continue;
        if (pasaPorCortada(t, tramo)) cortesQueToca.add(`${tramo.calle_cortada}|${tramo.hacia ?? ''}`);
        const d = encaje(t, tramo);
        if (d === null) continue;
        const clave = `${tramo.calle_cortada}|${tramo.hacia ?? ''}`;
        const g = grupos.get(clave);
        if (!g || d < g.d) grupos.set(clave, { d, tramo });
      }
      // Pasa por una calle cortada pero ningún tramo del aviso dice por dónde va (viene de otra
      // calle): no se puede dibujar sin inventar.
      for (const clave of cortesQueToca) {
        if (!grupos.has(clave)) fallo = `pasa por «${clave.split('|')[0]}», cortada, y el aviso no dice por dónde va viniendo de su calle`;
      }
      for (const { tramo } of grupos.values()) {
        try {
          const r = await desviar(t, tramo, ctx);
          if (r.aplica && r.ok) cambio = true;
          else if (r.aplica) fallo = r.motivo;
        } catch (e) {
          fallo = e.message;
        }
      }

      // Si un tramo de desvío ha fallado, NO dibujamos nada de este patrón (ni medio desvío).
      if (fallo) {
        lineasFallidas.set(patron.l, fallo);
        informe.push(`Aviso ${aviso.id}, línea ${patron.l} → ${patron.d}: sin dibujar (${fallo}).`);
        // Las anuladas sí se aplican: son seguras aunque no sepamos el camino nuevo.
        const t2 = aTrabajo(patron, fs[pi], h.paradas);
        if (anularParadas(t2, anuladasLinea)) partir(pi, t2, false);
        continue;
      }
      if (anularParadas(t, anuladasLinea)) cambio = true;
      if (!cambio) continue;
      lineasConCambio.add(patron.l);
      partir(pi, t, true);
    }

    // Comprobación con el tiempo real (si se ha dado): una contradicción deshace esa línea.
    // (La hace el llamador con `comprobar`, que consulta pocas paradas a nuestro servidor.)
    if (comprobar && lineasConCambio.size) {
      const malas = await comprobar({ aviso, ext, lineas: [...lineasConCambio], paradas: h.paradas, anuladas });
      for (const [l, motivo] of malas) {
        deshacer(aviso.id, l);
        lineasConCambio.delete(l);
        lineasFallidas.set(l, motivo);
        informe.push(`Aviso ${aviso.id}, línea ${l}: deshecho por el tiempo real (${motivo}).`);
      }
    }

    entrada.dib = [...lineasConCambio].filter((l) => !lineasFallidas.has(l));
    // sin = el recorrido debería cambiar pero no se ha podido comprobar (la app avisa y no dibuja);
    // las demás líneas del aviso no cambian de recorrido según lo que dice el aviso.
    entrada.sin = [...lineasFallidas.keys()].filter((l) => !entrada.dib.includes(l));
    resumen.push(entrada);
    informe.push(`Aviso ${aviso.id} «${aviso.titulo}»: cambiadas ${entrada.dib.join(', ') || '—'}; sin poder comprobar ${entrada.sin.join(', ') || '—'}; paradas anuladas ${entrada.par.join(', ') || '—'}.`);

    /** Parte el patrón pi: viajes/fechas del aviso → copia con el trabajo t; el resto se queda. */
    function partir(pi, t, dibujado) {
      const patron = h.patrones[pi];
      const filasDentro = [], filasFuera = [];
      patron.v.forEach((f, k) => {
        const fechas = fechasDeServicio.get(f[0]) ?? [];
        const dentroF = fechas.filter((fe) => dentro(vig, fe, f[1]));
        const fueraF = fechas.filter((fe) => !dentro(vig, fe, f[1]));
        if (dentroF.length) filasDentro.push([dentroF.length === fechas.length ? f[0] : servicioPara(dentroF), ...t.v[k].slice(1)]);
        if (fueraF.length) filasFuera.push([fueraF.length === fechas.length ? f[0] : servicioPara(fueraF), ...f.slice(1)]);
      });
      if (!filasDentro.length) return;
      const antes = patron.v;
      patron.v = filasFuera;
      const nuevo = { l: patron.l, d: patron.d, p: t.p, v: filasDentro, dv: aviso.id, _antes: antes };
      if (!dibujado) nuevo.dvSoloParadas = 1;
      h.patrones.push(nuevo);
      fs.push(aForma(t));
      nuevo._de = pi;
    }
  }

  /** Deshace los cambios de una línea de un aviso (devuelve los viajes al patrón original). */
  function deshacer(idAviso, linea) {
    for (let k = h.patrones.length - 1; k >= 0; k--) {
      const p = h.patrones[k];
      if (p.dv !== idAviso || !mismaLinea(p.l, linea) || p._de === undefined) continue;
      // El patrón de origen recupera los viajes que tenía antes de partirlo.
      h.patrones[p._de].v = p._antes;
      h.patrones.splice(k, 1);
      fs.splice(k, 1);
    }
  }

  // Patrones que se han quedado sin viajes: fuera (los índices cambian, así que se rehace todo junto).
  const quedan = h.patrones.map((p, k) => [p, fs[k]]).filter(([p]) => p.v.length);
  h.patrones = quedan.map(([p]) => {
    delete p._de;
    delete p._antes;
    return p;
  });
  const formasSalida = quedan.map(([, f]) => f);
  for (const p of h.patrones) p.v.sort((a, b) => a[1] - b[1]);
  for (const f of Object.keys(h.fechas)) h.fechas[f].sort((a, b) => a - b);

  // Transbordos de las paradas nuevas (y hacia ellas).
  while (h.transbordos.length < h.paradas.length) {
    const i = h.transbordos.length;
    const lista = [];
    h.paradas.forEach((b, j) => {
      if (i === j) return;
      const m = metros([h.paradas[i][2], h.paradas[i][3]], [b[2], b[3]]);
      if (m <= TRANSBORDO_MAX_M) {
        const s = Math.round((m * FACTOR_RODEO) / VELOCIDAD_PIE);
        lista.push(j, s);
        if (j < i) h.transbordos[j].push(i, s);
      }
    });
    h.transbordos.push(lista);
  }

  h.desvios = resumen;
  return { horarios: h, formas: { ...formas, formas: formasSalida }, informe };
}

/** Patrón de trabajo → trazado compacto de formas.json (paradas y extremos del desvío como vértices). */
function aForma(t) {
  const anclas = new Set(t.si);
  for (const [a, b] of t.dv) anclas.add(a).add(b);
  const orden = [...anclas].filter((x) => x >= 0 && x < t.pts.length).sort((a, b) => a - b);
  if (orden[0] !== 0) orden.unshift(0);
  const salida = [];
  const enSalida = new Map();
  for (let k = 0; k < orden.length; k++) {
    const desde = orden[k], hasta = orden[k + 1];
    if (hasta === undefined) {
      if (!enSalida.has(desde)) { enSalida.set(desde, salida.length); salida.push(t.pts[desde]); }
      break;
    }
    const tramo = simplificar(t.pts.slice(desde, hasta + 1), 8);
    if (!salida.length) { enSalida.set(desde, 0); salida.push(tramo[0]); }
    for (let j = 1; j < tramo.length; j++) salida.push(tramo[j]);
    enSalida.set(hasta, salida.length - 1);
  }
  const f = { c: codificar(salida), i: t.si.map((x) => enSalida.get(x) ?? -1) };
  if (t.dv.length) f.dv = t.dv.map(([a, b]) => [enSalida.get(a) ?? 0, enSalida.get(b) ?? 0]);
  if (t.o.length) f.o = t.o.map((trozo) => codificar(simplificar(trozo, 8)));
  return f;
}
