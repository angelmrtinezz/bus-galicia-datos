// Renueva datos/osm/calles.json (calles de Vigo de OpenStreetMap) para el robot de desvíos.
// Uso: node scripts/desvios/descargar-calles.mjs   (si falla, se queda el archivo anterior)
import { descargarCalles } from './osm.mjs';
await descargarCalles();
