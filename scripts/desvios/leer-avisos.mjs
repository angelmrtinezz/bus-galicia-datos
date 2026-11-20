// Lee los avisos de transporte del Concello y, con IA (Claude), saca de cada uno los cambios de
// recorrido en un formato que el robot entiende (ver ESQUEMA). Cada aviso se lee UNA vez: el
// resultado se guarda en datos/desvios/extracciones.json con una huella del texto y del PDF, y solo
// se vuelve a leer si Vitrasa lo cambia. Sin clave de la API (ANTHROPIC_API_KEY) no se lee nada
// nuevo: se usa lo guardado y los avisos nuevos o cambiados solo se marcan en la app (la tarea
// local de Claude Code los lee con scripts/desvios/pendientes.mjs y guardar-lectura.mjs).

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

import Anthropic from '@anthropic-ai/sdk';

const AGENTE = 'Paradina-datos/1.0 (github.com/angelmrtinezz/bus-galicia-datos)';
export const RUTA_EXTRACCIONES = 'datos/desvios/extracciones.json';
const MODELO = 'claude-opus-5-5';

export async function descargarAvisos() {
  const r = await fetch('https://datos.vigo.org/data/avisos/avisos_transporte_es.json', {
    headers: { 'User-Agent': AGENTE },
    signal: AbortSignal.timeout(30_000),
  });
  if (!r.ok) throw new Error(`avisos: HTTP ${r.status}`);
  return r.json();
}

/** PDFs de cada aviso, enlazados desde la página de avisos de Vitrasa (axenda-files.vigo.org/media/<id>/…). */
export async function enlacesPdf() {
  const enlaces = new Map();
  for (const url of ['https://www.vitrasa.es/avisos', 'https://www.vitrasa.es/gl/avisos']) {
    try {
      const r = await fetch(url, { headers: { 'User-Agent': AGENTE }, signal: AbortSignal.timeout(30_000) });
      const html = await r.text();
      for (const m of html.matchAll(/https?:\/\/axenda-files\.vigo\.org\/media\/(\d+)\/[^"'<>\s]+?\.pdf/gi)) {
        const id = Number(m[1]);
        const lista = enlaces.get(id) ?? [];
        // Preferimos el PDF en castellano si hay dos.
        if (!lista.includes(m[0])) lista.push(m[0]);
        enlaces.set(id, lista.sort((a, b) => Number(/_es\.pdf$/i.test(b)) - Number(/_es\.pdf$/i.test(a))));
      }
    } catch (e) {
      console.warn('No se pudo leer', url, e.message);
    }
  }
  return enlaces;
}

export async function bajarPdf(url) {
  const r = await fetch(url, { headers: { 'User-Agent': AGENTE }, signal: AbortSignal.timeout(60_000) });
  if (!r.ok) throw new Error(`PDF: HTTP ${r.status}`);
  const b = Buffer.from(await r.arrayBuffer());
  if (b.subarray(0, 4).toString() !== '%PDF' || b.length > 20 * 1024 * 1024) throw new Error('no es un PDF válido');
  return b;
}

export const textoPlano = (html) =>
  String(html ?? '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&([a-z]+);/gi, (m, e) => ({ aacute: 'á', eacute: 'é', iacute: 'í', oacute: 'ó', uacute: 'ú', ntilde: 'ñ', Aacute: 'Á', Eacute: 'É', Iacute: 'Í', Oacute: 'Ó', Uacute: 'Ú', Ntilde: 'Ñ', ordm: 'º', ordf: 'ª', amp: '&', quot: '"', uuml: 'ü' })[e] ?? m)
    .replace(/[ \t]+/g, ' ')
    .trim();

// ---------- Lo que tiene que devolver la IA ----------

const texto = { type: 'string' };
const textoONulo = { type: ['string', 'null'] };
const listaTexto = { type: 'array', items: texto };
const objeto = (props) => ({ type: 'object', properties: props, required: Object.keys(props), additionalProperties: false });
const refParada = objeto({
  calle: texto,
  numero: textoONulo,
  numero_parada: textoONulo,
  lineas: listaTexto,
});

export const ESQUEMA = objeto({
  afecta_recorrido: { type: 'boolean' },
  resumen: texto,
  vigencia: objeto({ desde: texto, hasta: texto, hora_inicio: textoONulo, hora_fin: textoONulo }),
  tramos: {
    type: 'array',
    items: objeto({
      lineas: listaTexto,
      lineas_excluidas: listaTexto,
      calle_cortada: texto,
      hacia: textoONulo,
      desde_calle: textoONulo,
      itinerario: listaTexto,
      paradas_provisionales: { type: 'array', items: refParada },
    }),
  },
  recortes: {
    type: 'array',
    items: objeto({ lineas: listaTexto, tipo: { type: 'string', enum: ['empieza_en', 'termina_en'] }, parada: refParada, hacia: textoONulo }),
  },
  paradas_anuladas: { type: 'array', items: refParada },
  ocasional: textoONulo,
});

export const INSTRUCCIONES = `Eres el lector de avisos de la app de autobuses Paradiña (Vigo, Vitrasa). Recibes un aviso oficial (texto y, si lo hay, su PDF, en castellano o gallego) y devuelves SOLO lo que dice, en el formato pedido, para que un programa cambie el recorrido de las líneas en el mapa. Si dudas de algo, déjalo fuera: es mejor no dibujar un desvío que dibujar uno falso.

Reglas:
- afecta_recorrido: true solo si el aviso cambia por dónde van las líneas o qué paradas usan (desvíos, cortes de calle, paradas anuladas o provisionales, líneas que empiezan o acaban en otro sitio). Servicios especiales, lanzaderas, horarios, tarjetas, etc.: false (y el resto vacío).
- vigencia: fechas AAAA-MM-DD en que se aplica (usa las del aviso; si el corte es solo un día u horas concretas, ponlas: hora_inicio/hora_fin HH:MM, si no null).
- tramos: un tramo por cada calle cortada, cada SENTIDO y cada ORIGEN distinto. Un tramo dice: las líneas que vienen por «desde_calle» (la última calle por la que van antes del corte), en vez de seguir por «calle_cortada» en dirección «hacia» (una calle o plaza hacia la que va el tráfico cortado; null si se corta en los dos sentidos), van por «itinerario» (las calles del desvío EN ORDEN, empezando por la primera calle por la que giran o siguen, y terminando en la calle donde vuelven a su recorrido normal) y luego recorrido normal.
  - Si el aviso dice «Desde X hacia Y por: A, B, C y recorrido normal», desde_calle = X, itinerario = [A, B, C].
  - Si dice «Las líneas que vienen de Z irán por R hasta A», crea otro tramo con desde_calle = Z e itinerario = [R, A, B, C] (el resto igual).
  - Si una línea concreta hace otro desvío, ponla en un tramo propio (lineas = [esa]) y añádela a lineas_excluidas del tramo general. Si una línea queda fuera de un desvío («excepto L5B e L17»), ponla en lineas_excluidas.
  - lineas = [] significa «todas las líneas afectadas del aviso».
- Escribe las calles con su tipo como en el callejero de Vigo («Rúa de Carral», «Rúa do Marqués de Valladares», «Praza de Compostela», «Avenida de Castelao»). No inventes calles que el aviso no nombra.
- paradas_provisionales (del tramo donde están) y paradas_anuladas: calle y número de portal tal como los da el aviso («Rúa Colón», «12»); numero_parada si el aviso da el número de parada de Vitrasa («nº 14245»); si no hay número de portal pon el sitio en numero («Príncipe» para «Urzáiz-Príncipe»). lineas = [] si vale para todas; si el aviso dice «solo para L5B e L17», pon esas.
- recortes: líneas que empiezan o terminan en otra parada («A liña 9B comezará o seu percorrido, dirección Candeán, en Urzáiz-Príncipe» → tipo empieza_en, parada Rúa de Urzáiz / Príncipe, hacia "Candeán").
- ocasional: lo que pasa solo a veces o en momentos puntuales (paradas que se anulan en días de mucha gente…). NO lo metas en tramos ni en paradas_anuladas.
- Nombres de líneas sin la L delante («L5A» → "5A"; «A», «C1», «C3i», «H1», «N4» tal cual).`;

/** Huella del aviso: si cambia el texto, las fechas, las líneas o el PDF, se vuelve a leer. */
export function huella(aviso, pdfs) {
  const h = createHash('sha256');
  h.update(JSON.stringify([aviso.titulo, aviso.resumen, aviso.fecha_inicio, aviso.fecha_fin, aviso.lineas_afectadas, aviso.paradas_afectadas]));
  for (const p of pdfs) h.update(p);
  return h.digest('hex').slice(0, 32);
}

export function leerExtracciones() {
  return existsSync(RUTA_EXTRACCIONES) ? JSON.parse(readFileSync(RUTA_EXTRACCIONES, 'utf8')) : {};
}

/**
 * Lee con IA los avisos nuevos o cambiados. Devuelve el mapa id → { huella, datos, fecha, pdf }.
 * Los avisos que ya no están activos se borran del archivo.
 */
export async function extraerAvisos(avisos, { hoy = new Date().toISOString().slice(0, 10) } = {}) {
  const guardadas = leerExtracciones();
  const salida = {};
  const pdfsPorAviso = await enlacesPdf();
  const cliente = process.env.ANTHROPIC_API_KEY ? new Anthropic() : null;
  if (!cliente) console.warn('Sin ANTHROPIC_API_KEY: solo se usan los avisos ya leídos.');

  for (const aviso of avisos) {
    if (aviso.fecha_fin && aviso.fecha_fin < hoy) continue;
    const urls = pdfsPorAviso.get(aviso.id) ?? [];
    const pdfs = [];
    for (const u of urls.slice(0, 1)) {
      try {
        pdfs.push(await bajarPdf(u));
      } catch (e) {
        console.warn(`Aviso ${aviso.id}: no se pudo bajar el PDF (${e.message})`);
      }
    }
    const hu = huella(aviso, pdfs);
    // Si el PDF no se ha podido bajar ahora (fallo de red), la huella saldría distinta sin que el
    // aviso haya cambiado: se mantiene lo leído.
    const pdfCaido = urls.length > 0 && pdfs.length === 0;
    if (guardadas[aviso.id] && (guardadas[aviso.id].huella === hu || pdfCaido)) {
      salida[aviso.id] = guardadas[aviso.id];
      continue;
    }
    if (!cliente) {
      if (guardadas[aviso.id]) salida[aviso.id] = { ...guardadas[aviso.id], desactualizada: true };
      continue;
    }
    try {
      const datos = await preguntar(cliente, aviso, pdfs);
      salida[aviso.id] = { huella: hu, fecha: new Date().toISOString(), modelo: MODELO, pdf: urls[0] ?? null, datos };
      console.log(`Aviso ${aviso.id} «${aviso.titulo}» leído: ${datos.afecta_recorrido ? `${datos.tramos.length} tramos, ${datos.paradas_anuladas.length} paradas anuladas` : 'no cambia recorridos'}.`);
    } catch (e) {
      console.warn(`Aviso ${aviso.id}: no se pudo leer con IA (${e.message}).`);
      if (guardadas[aviso.id]) salida[aviso.id] = { ...guardadas[aviso.id], desactualizada: true };
    }
  }
  writeFileSync(RUTA_EXTRACCIONES, JSON.stringify(salida, null, 1) + '\n');
  return salida;
}

async function preguntar(cliente, aviso, pdfs) {
  const contenido = [];
  for (const p of pdfs) {
    contenido.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: p.toString('base64') } });
  }
  contenido.push({ type: 'text', text: textoDelAviso(aviso, pdfs.length > 0) });

  const r = await cliente.beta.messages.create({
    model: MODELO,
    max_tokens: 16000,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    output_config: { effort: 'high', format: { type: 'json_schema', schema: ESQUEMA } },
    system: INSTRUCCIONES,
    messages: [{ role: 'user', content: contenido }],
  });
  if (r.stop_reason === 'refusal') throw new Error('la IA no ha querido leerlo');
  if (r.stop_reason === 'max_tokens') throw new Error('respuesta cortada');
  const txt = r.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  const datos = JSON.parse(txt);
  if (typeof datos.afecta_recorrido !== 'boolean' || !Array.isArray(datos.tramos)) throw new Error('respuesta sin el formato pedido');
  return datos;
}

/** Lo que se le da a leer a la IA de cada aviso (igual en GitHub y en la tarea local). */
export function textoDelAviso(aviso, conPdf) {
  return (
    `Aviso nº ${aviso.id}
Título: ${aviso.titulo}
Fechas del aviso: ${aviso.fecha_inicio} → ${aviso.fecha_fin}
` +
    `Líneas afectadas (según el aviso): ${aviso.lineas_afectadas ?? 'no indicadas'}
` +
    `Paradas afectadas (según el aviso): ${aviso.paradas_afectadas ?? 'no indicadas'}

` +
    `Texto del aviso:
${textoPlano(aviso.resumen)}

` +
    (conPdf ? 'El PDF adjunto tiene el detalle.' : 'No hay PDF: usa solo el texto.')
  );
}
