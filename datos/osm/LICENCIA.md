# Lugares de Vigo (OpenStreetMap) · licencia ODbL

[`lugares.json`](lugares.json) es la lista de calles y sitios de Vigo que usa el buscador de la app
**Paradiña**. Es una base de datos derivada de **OpenStreetMap**.

**© colaboradores de OpenStreetMap.** Datos disponibles bajo la
[Open Database License (ODbL) 1.0](https://opendatacommons.org/licenses/odbl/1-0/).
Esta base de datos derivada se publica bajo la misma licencia ODbL 1.0.
Más información: https://www.openstreetmap.org/copyright

## Cómo se ha hecho

1. Consulta a la API de Overpass dentro del término municipal de Vigo (`admin_level=8`):
   vías con nombre (`highway`) y elementos con nombre de tipo `amenity`, `leisure`, `tourism`,
   `shop` (centros comerciales y supermercados), `natural=beach`, `place`, `railway=station`,
   `historic` y algunos `building` (universidad, hospital, estación, estadio).
2. Se quedan solo las categorías útiles para buscar destinos, se toma el centro de cada elemento
   y se le asigna el barrio o parroquia más cercano.

Formato: `{ "generado": fecha, "l": [[nombre, latitud, longitud, categoría, zona], ...] }`.

Solo esta base de datos está bajo ODbL; el código de la app no forma parte de ella.
