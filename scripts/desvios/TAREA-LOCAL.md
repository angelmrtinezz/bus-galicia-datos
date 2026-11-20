# Leer los avisos pendientes (tarea local de Claude Code, sin clave de la API)

Se hace en la carpeta `bus-galicia-datos`. Si no hay nada por leer, no se toca nada.

1. `git pull --rebase` (el robot de GitHub sube cambios cada 3 horas).
2. `node scripts/desvios/pendientes.mjs`. Si dice «0 avisos por leer», has terminado.
3. Lee `pendientes/instrucciones.md` entero: son las reglas de lectura y el formato del JSON.
4. Para cada aviso de `pendientes/lista.json`:
   - lee su texto (`pendientes/<id>.txt`) y su PDF (`pendientes/<id>.pdf`, si lo hay) completos;
   - escribe la lectura en `pendientes/lecturas/<id>.json` siguiendo las reglas al pie de la letra.
     Ante la duda, déjalo fuera: es mejor «desvío sin dibujar» que un recorrido falso;
   - `node scripts/desvios/guardar-lectura.mjs <id> pendientes/lecturas/<id>.json`. Si da error de
     formato, corrige el JSON y repite.
5. `node scripts/desvios/pendientes.mjs` otra vez: debe decir «0 avisos por leer».
6. Sube solo las lecturas:
   `git add datos/desvios/extracciones.json`, luego
   `git commit -m "Avisos leídos: <ids>"` y `git push` (si el push falla porque el robot subió algo,
   `git pull --rebase` y otra vez `git push`).
7. `gh workflow run actualizar-horarios.yml` para que el robot dibuje los desvíos ya, sin esperar.
8. Resume en 2-3 líneas qué avisos has leído y qué cambia en cada uno.

No toques ningún otro archivo ni nada fuera de esta carpeta.
