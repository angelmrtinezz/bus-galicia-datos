# Bus Galicia · datos

Horarios de Vitrasa (Vigo) ya preparados para la app **Bus Galicia**. Se actualizan solos
cada día con un robot de GitHub Actions ([actualizar-horarios.yml](.github/workflows/actualizar-horarios.yml)).

| Archivo | Contenido |
|---|---|
| [`datos/version.json`](datos/version.json) | Versión, fechas que cubre y huella del GTFS de origen |
| [`datos/horarios.json`](datos/horarios.json) | Paradas, recorridos y horarios compactos para el motor de rutas |
| [`datos/formas.json`](datos/formas.json) | Trazados simplificados de cada recorrido (para el mapa) |

Se publican en GitHub Pages: `https://angelmrtinezz.github.io/bus-galicia-datos/datos/…`

## Fuente y licencia

Datos de origen: **GTFS de Vitrasa. Autobús público urbano**, publicado por el
**Concello de Vigo** en su portal de datos abiertos (https://datos.vigo.org) bajo la
**Open Data Commons Attribution License (ODC-BY)**. Estos archivos son una transformación
(cambio de formato y simplificación de trazados) de esos datos.
