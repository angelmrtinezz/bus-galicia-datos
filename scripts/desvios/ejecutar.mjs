// Robot de desvíos: horarios recién compilados del GTFS + avisos del Concello → datos/ publicados.
//
// Uso: node scripts/desvios/ejecutar.mjs <carpeta con horarios.json y formas.json compilados> <hashGtfs>
//
// 1. Lee los avisos activos y, con IA, los que son nuevos o han cambiado (leer-avisos.mjs).
// 2. Aplica los desvíos a los horarios y trazados (aplicar.mjs), comprobando cada desvío con las
//    calles reales y, si hay buses circulando, con el tiempo real de Vitrasa.
// 3. Si el resultado es distinto de lo publicado, lo escribe en datos/ con su version.json.
//    Si algo falla, publica los horarios SIN desvíos (nunca deja la app sin horarios).

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { aplicarDesvios } from './aplicar.mjs';
import { descargarAvisos, extraerAvisos } from './leer-avisos.mjs';

const [carpeta, hashGtfs = ''] = process.argv.slice(2);
if (!carpeta) {
  console.error('Uso: node scripts/desvios/ejecutar.mjs <carpeta compilada> <hashGtfs>');
  process.exit(1);
}
const SERVIDOR = 'https://paradina-api.paradina-servidor.workers.dev';
const AGENTE = 'Paradina-datos/1.0 (github.com/angelmrtinezz/bus-galicia-datos)';
mkdirSync('datos/desvios', { recursive: true });

const horarios = JSON.parse(readFileSync(join(carpeta, 'horarios.json'), 'utf8'));
const formas = JSON.parse(readFileSync(join(carpeta, 'formas.json'), 'utf8'));

let extraccionesActuales = {};
let resultado = { horarios, formas: formas, informe: ['Sin desvíos aplicados.'] };
try {
  const avisos = await descargarAvisos();
  const extracciones = await extraerAvisos(avisos);
  extraccionesActuales = extracciones;
  const paradasConcello = await (
    await fetch('https://datos.vigo.org/data/transporte/paradas.json', { headers: { 'User-Agent': AGENTE } })
  ).json();
  const hoy = new Date().toISOString().slice(0, 10);
  resultado = await aplicarDesvios({
    horarios,
    formas,
    avisos: avisos.filter((a) => !a.fecha_fin || a.fecha_fin >= hoy),
    extracciones,
    paradasConcello: Array.isArray(paradasConcello) ? paradasConcello : [],
    comprobar: comprobarConTiempoReal,
  });
} catch (e) {
  console.error('Los desvíos han fallado; se publican los horarios sin ellos:', e);
  resultado.informe = [`Error: ${e.message}`];
}
console.log(resultado.informe.join('\n'));

// ¿Ha cambiado algo de verdad? (sin contar la hora de compilación)
const { generado: _g, ...sinFecha } = resultado.horarios;
const huella = createHash('sha256')
  .update(JSON.stringify(sinFecha))
  .update(JSON.stringify(resultado.formas.formas))
  .digest('hex');
const anterior = existsSync('datos/version.json') ? JSON.parse(readFileSync('datos/version.json', 'utf8')) : {};
// Informe legible (qué se ha dibujado y qué no, y por qué). Solo se reescribe si cambia.
const informe = { desvios: resultado.horarios.desvios ?? [], informe: resultado.informe };
const informeViejo = existsSync('datos/desvios/informe.json')
  ? JSON.parse(readFileSync('datos/desvios/informe.json', 'utf8'))
  : {};
if (JSON.stringify({ desvios: informeViejo.desvios, informe: informeViejo.informe }) !== JSON.stringify(informe)) {
  writeFileSync('datos/desvios/informe.json', JSON.stringify({ comprobado: new Date().toISOString(), ...informe }, null, 1) + '\n');
}
if (anterior.hashContenido === huella && anterior.hashGtfs === hashGtfs) {
  console.log('Nada nuevo que publicar.');
  process.exit(0);
}
const generado = new Date().toISOString();
writeFileSync('datos/horarios.json', JSON.stringify({ ...resultado.horarios, generado }));
writeFileSync('datos/formas.json', JSON.stringify({ ...resultado.formas, generado }));
execFileSync(process.execPath, ['scripts/escribir-version.mjs', hashGtfs, huella], { stdio: 'inherit' });

/**
 * Contrasta los desvíos con el tiempo real de Vitrasa (pocas paradas, por nuestro servidor con
 * caché; nunca se barren todas, que lo prohíbe el Concello). Devuelve [[línea, motivo]] de las
 * líneas que lo contradicen: un bus de esa línea llegando a una parada anulada para ella.
 * Sin datos (de noche, sin buses) no se contradice nada.
 */
async function comprobarConTiempoReal({ aviso, lineas, anuladas }) {
  // Lo que el tiempo real ya contradijo antes se recuerda mientras el aviso no cambie
  // (si no, la línea cambiaría de una vez a otra según hubiera buses o no en ese momento).
  const RUTA = 'datos/desvios/contradicciones.json';
  const guardadas = existsSync(RUTA) ? JSON.parse(readFileSync(RUTA, 'utf8')) : {};
  const huellaAviso = extraccionesActuales[aviso.id]?.huella ?? '';
  const previas = guardadas[aviso.id]?.huella === huellaAviso ? guardadas[aviso.id].lineas : {};
  const malas = new Map(Object.entries(previas).filter(([l]) => lineas.includes(l)));
  const consultar = async (num) => {
    try {
      const r = await fetch(`${SERVIDOR}/v1/parada/${num}`, { headers: { 'User-Agent': AGENTE }, signal: AbortSignal.timeout(15_000) });
      if (!r.ok) return null;
      return await r.json();
    } catch {
      return null;
    }
  };
  for (const a of anuladas.slice(0, 12)) {
    for (const num of [...a.nums].slice(0, 3)) {
      const datos = await consultar(num);
      for (const l of datos?.lineas ?? []) {
        const linea = lineas.find((x) => x.toUpperCase() === String(l.linea).toUpperCase());
        if (!linea || !a.deLinea(linea) || malas.has(linea)) continue;
        if ((l.llegadas ?? []).some((ll) => ll.minutos <= 15)) {
          malas.set(linea, `el tiempo real da buses de la ${linea} en la parada anulada ${num}`);
        }
      }
      await new Promise((ok) => setTimeout(ok, 300));
    }
  }
  if (malas.size) {
    guardadas[aviso.id] = { huella: huellaAviso, lineas: Object.fromEntries(malas) };
    writeFileSync(RUTA, JSON.stringify(guardadas, null, 1) + '\n');
  }
  return [...malas];
}
