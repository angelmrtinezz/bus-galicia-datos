// Prueba local del motor de desvíos con extracciones escritas a mano (sin IA).
// Uso (desde la raíz del repo): node scripts/desvios/prueba/probar.mjs <carpeta de salida>
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { aplicarDesvios } from '../aplicar.mjs';

const salida = process.argv[2] ?? 'prueba-salida';
mkdirSync(salida, { recursive: true });
const horarios = JSON.parse(readFileSync('datos/horarios.json', 'utf8'));
const formas = JSON.parse(readFileSync('datos/formas.json', 'utf8'));
const avisos = await (await fetch('https://datos.vigo.org/data/avisos/avisos_transporte_es.json')).json();
const paradasConcello = await (await fetch('https://datos.vigo.org/data/transporte/paradas.json')).json();
const extracciones = {
  4033: { datos: JSON.parse(readFileSync('scripts/desvios/prueba/extraccion-4033.json', 'utf8')) },
};
const t0 = Date.now();
const r = await aplicarDesvios({ horarios, formas, avisos: avisos.filter((a) => a.id === 4033), extracciones, paradasConcello });
console.log(r.informe.join('\n'));
console.log(`(${((Date.now() - t0) / 1000).toFixed(1)} s) patrones ${horarios.patrones.length} → ${r.horarios.patrones.length}`);
writeFileSync(join(salida, 'horarios.json'), JSON.stringify(r.horarios));
writeFileSync(join(salida, 'formas.json'), JSON.stringify(r.formas));
