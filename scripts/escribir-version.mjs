// Escribe datos/version.json a partir de los horarios recién compilados y comprueba que son válidos.
// Uso: node scripts/escribir-version.mjs <sha256 del GTFS>
import { readFileSync, statSync, writeFileSync } from 'node:fs';

const hashGtfs = process.argv[2] ?? '';
const horarios = JSON.parse(readFileSync('datos/horarios.json', 'utf8'));
const formas = JSON.parse(readFileSync('datos/formas.json', 'utf8'));

const fechas = Object.keys(horarios.fechas).sort();
const hoy = new Date().toISOString().slice(0, 10).replace(/-/g, '');

// Comprobaciones: si algo no cuadra, el robot falla y NO publica (la app sigue con los anteriores).
const errores = [];
if (horarios.paradas.length < 500) errores.push(`muy pocas paradas (${horarios.paradas.length})`);
if (horarios.patrones.length < 100) errores.push(`muy pocos recorridos (${horarios.patrones.length})`);
if (!fechas.length) errores.push('no hay fechas de servicio');
if (fechas.length && fechas[fechas.length - 1] < hoy) errores.push(`los horarios ya han caducado (hasta ${fechas.at(-1)})`);
if (formas.generado !== horarios.generado) errores.push('horarios y trazados no son de la misma compilación');
if (formas.formas.length !== horarios.patrones.length) errores.push('número de trazados distinto al de recorridos');
if (errores.length) {
  console.error('Horarios NO válidos:\n - ' + errores.join('\n - '));
  process.exit(1);
}

const version = {
  formato: 1,
  generado: horarios.generado,
  hashGtfs,
  desde: fechas[0],
  hasta: fechas[fechas.length - 1],
  archivos: {
    horarios: { nombre: 'horarios.json', bytes: statSync('datos/horarios.json').size },
    formas: { nombre: 'formas.json', bytes: statSync('datos/formas.json').size },
  },
  fuente: 'GTFS de Vitrasa · Concello de Vigo (Open Data Commons Attribution License)',
};
writeFileSync('datos/version.json', JSON.stringify(version, null, 2) + '\n');
console.log(`version.json: ${version.desde} → ${version.hasta} · generado ${version.generado}`);
