// Tarea local (sin clave de la API): prepara para Claude Code los avisos que están sin leer o han
// cambiado desde que se leyeron. Deja en pendientes/ (no se sube a GitHub):
//   lista.json          → [{ id, titulo, huella, texto, pdf }] de cada aviso por leer
//   <id>.txt / <id>.pdf → lo que hay que leer de cada uno (lo mismo que recibe la IA en GitHub)
//   instrucciones.md    → las reglas de lectura y el formato de la respuesta
// Después, cada lectura se guarda con: node scripts/desvios/guardar-lectura.mjs <id> <archivo.json>
//
// Uso: node scripts/desvios/pendientes.mjs

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { bajarPdf, descargarAvisos, enlacesPdf, ESQUEMA, huella, INSTRUCCIONES, leerExtracciones, textoDelAviso } from './leer-avisos.mjs';

const CARPETA = 'pendientes';
rmSync(CARPETA, { recursive: true, force: true });
mkdirSync(CARPETA, { recursive: true });

const hoy = new Date().toISOString().slice(0, 10);
const avisos = (await descargarAvisos()).filter((a) => !a.fecha_fin || a.fecha_fin >= hoy);
const guardadas = leerExtracciones();
const pdfsPorAviso = await enlacesPdf();
const lista = [];
let problemas = 0;

for (const aviso of avisos) {
  const urls = pdfsPorAviso.get(aviso.id) ?? [];
  const pdfs = [];
  for (const u of urls.slice(0, 1)) {
    try {
      pdfs.push(await bajarPdf(u));
    } catch (e) {
      console.warn(`Aviso ${aviso.id}: no se pudo bajar el PDF (${e.message}); se deja para otra vez.`);
    }
  }
  if (urls.length && !pdfs.length) {
    problemas++;
    continue; // sin el PDF no se lee: mejor esperar que leerlo a medias
  }
  const hu = huella(aviso, pdfs);
  if (guardadas[aviso.id]?.huella === hu) continue;
  writeFileSync(join(CARPETA, `${aviso.id}.txt`), textoDelAviso(aviso, pdfs.length > 0) + '\n');
  if (pdfs.length) writeFileSync(join(CARPETA, `${aviso.id}.pdf`), pdfs[0]);
  lista.push({
    id: aviso.id,
    titulo: aviso.titulo,
    huella: hu,
    cambiado: Boolean(guardadas[aviso.id]),
    texto: join(CARPETA, `${aviso.id}.txt`),
    pdf: pdfs.length ? join(CARPETA, `${aviso.id}.pdf`) : null,
    urlPdf: urls[0] ?? null,
  });
}

writeFileSync(join(CARPETA, 'lista.json'), JSON.stringify(lista, null, 1) + '\n');
writeFileSync(
  join(CARPETA, 'instrucciones.md'),
  `# Cómo leer cada aviso\n\n${INSTRUCCIONES}\n\n# Formato de la respuesta (JSON Schema estricto)\n\n` +
    'Escribe un archivo JSON con un objeto que cumpla EXACTAMENTE este esquema (todas las claves, ninguna más):\n\n' +
    '```json\n' + JSON.stringify(ESQUEMA, null, 1) + '\n```\n',
);
console.log(`${lista.length} avisos por leer${problemas ? ` (${problemas} con el PDF sin poder bajar, para otra vez)` : ''}:`);
for (const a of lista) console.log(`- ${a.id} «${a.titulo}»${a.cambiado ? ' (ha cambiado)' : ''}`);
