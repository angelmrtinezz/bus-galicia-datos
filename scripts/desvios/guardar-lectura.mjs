// Tarea local: guarda en datos/desvios/extracciones.json la lectura de un aviso hecha por Claude
// Code, con la huella que calculó pendientes.mjs (así el robot de GitHub la da por buena).
// Comprueba que el JSON cumple el ESQUEMA; si no, no guarda nada y sale con error.
//
// Uso: node scripts/desvios/guardar-lectura.mjs <idAviso> <archivo.json>

import { readFileSync, writeFileSync } from 'node:fs';

import { ESQUEMA, leerExtracciones, RUTA_EXTRACCIONES } from './leer-avisos.mjs';

const [id, archivo] = process.argv.slice(2);
if (!id || !archivo) {
  console.error('Uso: node scripts/desvios/guardar-lectura.mjs <idAviso> <archivo.json>');
  process.exit(1);
}
const pendiente = JSON.parse(readFileSync('pendientes/lista.json', 'utf8')).find((a) => String(a.id) === String(id));
if (!pendiente) {
  console.error(`El aviso ${id} no está en pendientes/lista.json (ejecuta antes pendientes.mjs).`);
  process.exit(1);
}
const datos = JSON.parse(readFileSync(archivo, 'utf8'));
const errores = [];
validar(datos, ESQUEMA, 'respuesta', errores);
const fecha = /^\d{4}-\d{2}-\d{2}$/;
const hora = /^\d{2}:\d{2}$/;
if (datos.vigencia) {
  for (const k of ['desde', 'hasta']) if (datos.afecta_recorrido && !fecha.test(datos.vigencia[k])) errores.push(`vigencia.${k} no es AAAA-MM-DD`);
  for (const k of ['hora_inicio', 'hora_fin']) if (datos.vigencia[k] != null && !hora.test(datos.vigencia[k])) errores.push(`vigencia.${k} no es HH:MM`);
}
if (errores.length) {
  console.error('No se guarda: la lectura no cumple el formato.\n- ' + errores.join('\n- '));
  process.exit(1);
}
const todas = leerExtracciones();
todas[id] = { huella: pendiente.huella, fecha: new Date().toISOString(), modelo: 'claude-code (tarea local)', pdf: pendiente.urlPdf, datos };
writeFileSync(RUTA_EXTRACCIONES, JSON.stringify(todas, null, 1) + '\n');
console.log(`Aviso ${id} guardado: ${datos.afecta_recorrido ? `${datos.tramos.length} tramos, ${datos.paradas_anuladas.length} paradas anuladas` : 'no cambia recorridos'}.`);

function validar(v, e, ruta, err) {
  const tipos = [].concat(e.type);
  const tipo = v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v;
  if (!tipos.includes(tipo)) return err.push(`${ruta}: debería ser ${tipos.join(' o ')}, es ${tipo}`);
  if (e.enum && !e.enum.includes(v)) err.push(`${ruta}: «${v}» no es ${e.enum.join(' / ')}`);
  if (tipo === 'array') v.forEach((x, i) => validar(x, e.items, `${ruta}[${i}]`, err));
  if (tipo === 'object') {
    for (const k of e.required ?? []) if (!(k in v)) err.push(`${ruta}: falta «${k}»`);
    for (const k of Object.keys(v)) {
      if (!e.properties[k]) err.push(`${ruta}: sobra «${k}»`);
      else validar(v[k], e.properties[k], `${ruta}.${k}`, err);
    }
  }
}
