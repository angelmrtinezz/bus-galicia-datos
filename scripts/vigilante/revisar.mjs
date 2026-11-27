// Vigilante de Paradiña: comprueba que todo lo que la app necesita para funcionar responde bien.
//
// Lo ejecuta GitHub Actions cada 30 minutos (.github/workflows/vigilante.yml). Si algo falla,
// el workflow abre la incidencia «Vigilante: algo falla en Paradiña» (llega un correo) y el
// arreglador (tarea local de Claude Code en el PC) la recoge. Se cierra sola cuando vuelve a ir bien.
//
// Uso:  node scripts/vigilante/revisar.mjs [carpeta-salida]
//   → escribe <salida>/informe.json e <salida>/informe.md; código de salida 1 si hay FALLOS.
//   VIGILANTE_ESPERA_S = segundos antes de repetir lo que ha fallado (por defecto 90), para no
//   avisar por un tropiezo de un momento.
//
// Sin dependencias: solo fetch de Node (≥ 18). Las paradas se piden A TRAVÉS DEL SERVIDOR (con
// caché), nunca directas al Concello y nunca en bucle: son 4 peticiones cada media hora.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// VIGILANTE_SERVIDOR solo para probar el caso de fallo (apuntarlo a una dirección que no existe).
const SERVIDOR = process.env.VIGILANTE_SERVIDOR ?? 'https://paradina-api.paradina-servidor.workers.dev';
const PAGES = 'https://angelmrtinezz.github.io/bus-galicia-datos';
const REPO = 'angelmrtinezz/bus-galicia-datos';
const WORKFLOW_DATOS = 'actualizar-horarios.yml';

/** Paradas del centro con más líneas (Urzáiz, García Barbón, Travesía de Vigo, Urzáiz-Príncipe). */
const PARADAS_CENTRO = [8770, 5520, 8630, 14264];
/** Horas (Madrid) en las que SIEMPRE debería haber algún bus en esas paradas. */
const HORA_BUSES_DESDE = 7;
const HORA_BUSES_HASTA = 22;
/** Si el dato de una parada tiene más de esto, el Concello no está respondiendo al servidor. */
const MAX_EDAD_DATO_S = 150;
/** Días mínimos de horarios por delante de hoy. */
const MIN_DIAS_HORARIOS = 2;

const ESPERA_S = Number(process.env.VIGILANTE_ESPERA_S ?? 90);
const salida = process.argv[2] ?? 'vigilante-salida';

// ---------------------------------------------------------------- utilidades

function ahoraMadrid() {
  const partes = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Europe/Madrid', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hour12: false,
    }).formatToParts(new Date()).map((p) => [p.type, p.value]),
  );
  return { fecha: `${partes.year}${partes.month}${partes.day}`, hora: Number(partes.hour) % 24 };
}

/** AAAAMMDD + n días → AAAAMMDD */
function sumarDias(aaaammdd, n) {
  const d = new Date(Date.UTC(+aaaammdd.slice(0, 4), +aaaammdd.slice(4, 6) - 1, +aaaammdd.slice(6, 8)));
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10).replaceAll('-', '');
}

async function pedir(url, { json = true, cabeceras = {} } = {}) {
  const inicio = Date.now();
  let r;
  try {
    r = await fetch(url, {
      headers: { 'User-Agent': 'Paradina-vigilante/1.0', ...cabeceras },
      signal: AbortSignal.timeout(20000),
      cache: 'no-store',
    });
  } catch (e) {
    throw new Error(`no responde (${e.name === 'TimeoutError' ? 'más de 20 s' : e.cause?.code ?? e.message})`);
  }
  const ms = Date.now() - inicio;
  if (!r.ok) throw new Error(`responde con error HTTP ${r.status}`);
  const texto = await r.text();
  if (!json) return { datos: texto, ms };
  try {
    return { datos: JSON.parse(texto), ms };
  } catch {
    throw new Error(`no devuelve JSON válido (empieza por «${texto.slice(0, 60)}»)`);
  }
}

function asegurar(condicion, mensaje) {
  if (!condicion) throw new Error(mensaje);
}

// ---------------------------------------------------------------- comprobaciones
// Cada una devuelve un texto corto con lo que ha visto, o lanza un Error con el problema.
// nivel 'fallo' = la app va mal para la gente; 'aviso' = conviene mirarlo, pero no es urgente.

const COMPROBACIONES = [
  {
    id: 'servidor-salud',
    nombre: 'Servidor (paradina-api) encendido',
    nivel: 'fallo',
    async revisar() {
      const { datos, ms } = await pedir(`${SERVIDOR}/salud`, { json: false });
      asegurar(datos.trim() === 'ok', `/salud contesta «${datos.slice(0, 40)}» en vez de «ok»`);
      return `ok en ${ms} ms`;
    },
  },
  {
    id: 'tiempo-real',
    nombre: 'Tiempo real de las paradas',
    nivel: 'fallo',
    async revisar() {
      const { hora } = ahoraMadrid();
      const resultados = await Promise.all(
        PARADAS_CENTRO.map(async (id) => {
          try {
            const { datos } = await pedir(`${SERVIDOR}/v1/parada/${id}`);
            return { id, datos };
          } catch (e) {
            return { id, error: e.message };
          }
        }),
      );
      const conError = resultados.filter((r) => r.error);
      asegurar(
        conError.length < PARADAS_CENTRO.length,
        `ninguna parada responde: ${conError.map((r) => `${r.id} ${r.error}`).join('; ')}`,
      );
      const buenas = resultados.filter((r) => !r.error);
      const malFormato = buenas.filter((r) => typeof r.datos?.encontrada !== 'boolean' || !Array.isArray(r.datos?.lineas));
      asegurar(malFormato.length === 0, `formato inesperado en las paradas ${malFormato.map((r) => r.id).join(', ')} (¿cambió la API del Concello?)`);
      const noEncontradas = buenas.filter((r) => !r.datos.encontrada);
      asegurar(
        noEncontradas.length < buenas.length,
        `el Concello dice que no existe ninguna de las paradas ${noEncontradas.map((r) => r.id).join(', ')}`,
      );
      const edades = buenas.map((r) => (Date.now() - r.datos.actualizado) / 1000).filter(Number.isFinite);
      const edadMin = Math.min(...edades);
      asegurar(
        edadMin <= MAX_EDAD_DATO_S,
        `el servidor solo tiene datos viejos (el más nuevo tiene ${Math.round(edadMin)} s): el Concello no le está respondiendo`,
      );
      const llegadas = buenas.reduce(
        (n, r) => n + r.datos.lineas.reduce((m, l) => m + (l.llegadas?.length ?? 0), 0),
        0,
      );
      const horaPunta = hora >= HORA_BUSES_DESDE && hora < HORA_BUSES_HASTA;
      asegurar(
        !horaPunta || llegadas > 0,
        `son las ${hora} h y no sale ningún bus en ${buenas.length} paradas del centro (Urzáiz, García Barbón…): la API devuelve vacío`,
      );
      const extra = conError.length ? ` (sin respuesta: ${conError.map((r) => r.id).join(', ')})` : '';
      return `${buenas.length}/${PARADAS_CENTRO.length} paradas, ${llegadas} buses en camino${horaPunta ? '' : ' (fuera de horario, no se exige que haya buses)'}${extra}`;
    },
  },
  {
    id: 'avisos',
    nombre: 'Avisos del Concello (castellano y gallego)',
    nivel: 'aviso',
    async revisar() {
      const [es, gl] = await Promise.all([pedir(`${SERVIDOR}/v1/avisos`), pedir(`${SERVIDOR}/v1/avisos?idioma=gl`)]);
      const cuantos = (d) => (Array.isArray(d) ? d.length : Array.isArray(d?.avisos) ? d.avisos.length : '?');
      return `${cuantos(es.datos)} avisos en castellano, ${cuantos(gl.datos)} en gallego`;
    },
  },
  {
    id: 'config',
    nombre: 'Configuración remota (/v1/config)',
    nivel: 'fallo',
    async revisar() {
      const { datos } = await pedir(`${SERVIDOR}/v1/config`);
      asegurar(typeof datos.proActivo === 'boolean', 'no trae «proActivo»: la app no sabrá si enseñar PRO');
      return `proActivo = ${datos.proActivo}`;
    },
  },
  {
    id: 'horarios',
    nombre: 'Horarios publicados (GitHub Pages)',
    nivel: 'fallo',
    async revisar() {
      const { fecha } = ahoraMadrid();
      const { datos: version } = await pedir(`${PAGES}/datos/version.json`);
      asegurar(/^\d{8}$/.test(version.hasta ?? ''), 'version.json no trae «hasta»');
      asegurar(version.desde <= fecha, `los horarios empiezan el ${version.desde}, después de hoy (${fecha})`);
      const minimo = sumarDias(fecha, MIN_DIAS_HORARIOS);
      asegurar(
        version.hasta >= minimo,
        `los horarios se acaban el ${version.hasta}: el planificador se quedará sin buses (hace falta al menos hasta el ${minimo})`,
      );
      const [{ datos: horarios }, { datos: formas }] = await Promise.all([
        pedir(`${PAGES}/datos/${version.archivos?.horarios?.nombre ?? 'horarios.json'}`),
        pedir(`${PAGES}/datos/${version.archivos?.formas?.nombre ?? 'formas.json'}`),
      ]);
      asegurar(horarios.fechas && fecha in horarios.fechas, `horarios.json no tiene el día de hoy (${fecha}) aunque version.json dice que sí`);
      asegurar((horarios.paradas?.length ?? 0) > 1000, `horarios.json solo trae ${horarios.paradas?.length ?? 0} paradas`);
      asegurar((horarios.patrones?.length ?? 0) > 100, `horarios.json solo trae ${horarios.patrones?.length ?? 0} recorridos`);
      asegurar(formas && typeof formas === 'object', 'formas.json está vacío');
      const reserva = version.reservaDesde ? ` · días de reserva desde el ${version.reservaDesde}` : '';
      return `del ${version.desde} al ${version.hasta}, ${horarios.paradas.length} paradas, ${version.desvios ?? 0} desvíos${reserva}`;
    },
  },
  {
    id: 'reserva-larga',
    nombre: 'GTFS del Concello al día',
    nivel: 'aviso',
    async revisar() {
      const { fecha } = ahoraMadrid();
      const { datos: version } = await pedir(`${PAGES}/datos/version.json`);
      if (version.reservaDesde && version.reservaDesde <= fecha) {
        throw new Error(
          `desde el ${version.reservaDesde} se usan días de reserva (copia de la semana anterior) porque el Concello no ha renovado el GTFS; los festivos o cambios de horario pueden no salir bien`,
        );
      }
      return 'sin días de reserva en uso';
    },
  },
  {
    id: 'robot-datos',
    nombre: 'Robot de horarios y desvíos (GitHub Actions)',
    nivel: 'fallo',
    async revisar() {
      const token = process.env.GITHUB_TOKEN;
      const { datos } = await pedir(
        `https://api.github.com/repos/${REPO}/actions/workflows/${WORKFLOW_DATOS}/runs?status=completed&per_page=3`,
        { cabeceras: { Accept: 'application/vnd.github+json', ...(token ? { Authorization: `Bearer ${token}` } : {}) } },
      );
      const ejec = datos.workflow_runs ?? [];
      asegurar(ejec.length > 0, 'no hay ninguna ejecución terminada del robot');
      const horas = (Date.now() - new Date(ejec[0].updated_at).getTime()) / 3600000;
      asegurar(horas < 8, `el robot no termina una ejecución desde hace ${Math.round(horas)} h (debería cada 3 h)`);
      const fallidas = ejec.slice(0, 2).filter((e) => e.conclusion !== 'success');
      asegurar(
        fallidas.length < 2,
        `las 2 últimas ejecuciones del robot han fallado (${ejec[0].html_url}): no se están renovando horarios ni desvíos`,
      );
      return fallidas.length
        ? `la última falló (${ejec[0].html_url}) pero la anterior fue bien; si vuelve a fallar se avisará`
        : `última ejecución bien hace ${horas < 1 ? Math.round(horas * 60) + ' min' : Math.round(horas) + ' h'}`;
    },
  },
  {
    id: 'web-legal',
    nombre: 'Política de privacidad y términos (las piden las tiendas)',
    nivel: 'aviso',
    async revisar() {
      await Promise.all([pedir(`${PAGES}/privacidad/`, { json: false }), pedir(`${PAGES}/terminos/`, { json: false })]);
      return 'las dos páginas abren';
    },
  },
];

// ---------------------------------------------------------------- ejecución

async function pasar(c) {
  try {
    return { ok: true, detalle: await c.revisar() };
  } catch (e) {
    return { ok: false, detalle: e.message };
  }
}

const resultados = new Map();
for (const c of COMPROBACIONES) resultados.set(c.id, await pasar(c));

const fallaron = COMPROBACIONES.filter((c) => !resultados.get(c.id).ok);
if (fallaron.length && ESPERA_S > 0) {
  console.log(`${fallaron.length} comprobaciones fallaron; se repiten en ${ESPERA_S} s por si era un tropiezo…`);
  await new Promise((r) => setTimeout(r, ESPERA_S * 1000));
  for (const c of fallaron) {
    const otra = await pasar(c);
    resultados.set(c.id, otra.ok ? { ...otra, detalle: `${otra.detalle} (falló a la primera: ${resultados.get(c.id).detalle})` } : otra);
  }
}

const informe = {
  revisado: new Date().toISOString(),
  comprobaciones: COMPROBACIONES.map((c) => ({ id: c.id, nombre: c.nombre, nivel: c.nivel, ...resultados.get(c.id) })),
};
const fallos = informe.comprobaciones.filter((c) => !c.ok && c.nivel === 'fallo');
const avisos = informe.comprobaciones.filter((c) => !c.ok && c.nivel === 'aviso');
informe.estado = fallos.length ? 'fallo' : avisos.length ? 'aviso' : 'ok';

const icono = (c) => (c.ok ? '✅' : c.nivel === 'fallo' ? '❌' : '⚠️');
const md = [
  fallos.length
    ? `**${fallos.length} ${fallos.length === 1 ? 'cosa falla' : 'cosas fallan'}** y afecta${fallos.length === 1 ? '' : 'n'} a la gente que usa la app.`
    : avisos.length
      ? 'Todo lo importante funciona, pero hay algo que conviene mirar.'
      : 'Todo funciona.',
  '',
  ...informe.comprobaciones.map((c) => `- ${icono(c)} **${c.nombre}**: ${c.detalle}`),
  '',
  `_Revisado: ${new Date().toLocaleString('es-ES', { timeZone: 'Europe/Madrid' })} (hora de Madrid)._`,
].join('\n');

mkdirSync(salida, { recursive: true });
writeFileSync(join(salida, 'informe.json'), JSON.stringify(informe, null, 2));
writeFileSync(join(salida, 'informe.md'), md + '\n');
console.log(md);
process.exit(fallos.length ? 1 : 0);
