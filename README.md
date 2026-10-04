# Latino Streams ⚡ — Stremio Addon

Addon de Stremio que encuentra las **mejores fuentes en español latino** y las
reproduce **al instante** usando tu cuenta de [TorBox](https://torbox.app).

## Cómo funciona

1. **Busca** en múltiples fuentes en paralelo (todo-en-uno con fallbacks):
   - **Torrentio** — agregador principal (decenas de indexadores).
   - **EZTV** — respaldo directo para series.
   - **Torznab (Prowlarr/Jackett)** — cientos de indexadores, incluyendo
     trackers en español. La forma más potente de sumar fuentes latinas.
   - **Addons extra** — pega las URLs de manifest de tus otros addons de streams
     (ej. tu MediaFusion o Comet ya configurado con debrid) y sus resultados
     se mezclan con los demás.
   
   Si una fuente falla o tarda demasiado, las demás igual responden.
   Los resultados se deduplican por infoHash.
2. **Filtra** solo los que tienen audio latino (o dual), ordenados por calidad
   (2160p → 1080p → 720p) y seeders.
3. **Verifica** con la API de TorBox cuáles ya están en su caché.
4. **Genera** enlaces de descarga directa de TorBox → reproducción instantánea,
   sin esperar descargas.

Sin API key de TorBox también funciona: devuelve los torrents latino para que
Stremio los reproduzca con su motor integrado.

## Requisitos

- Node.js 18+
- (Recomendado) Cuenta de TorBox + API key → `torbox.app → Settings → API`

## Uso local

```bash
npm install
npm start
# Addon disponible en http://127.0.0.1:7000/manifest.json
```

En Stremio (app de escritorio): **Add-ons → Pegar URL del addon**.

> Stremio Web bloquea `http://` local por contenido mixto: para pruebas locales
> usa la app de escritorio.

## Configuración

Abre `/configure` en tu navegador, pega tu **TorBox API Key** y guarda.
Opciones:

| Opción | Descripción |
|---|---|
| TorBox API Key | Para reproducción instantánea (recomendado) |
| Solo fuentes instantáneas | Oculta lo que TorBox no tiene en caché |
| Máximo de resultados | 4–12 por título |
| Fuente: Torrentio | Agregador principal (activado por defecto) |
| Fuente: EZTV | Respaldo para series (activado por defecto) |
| Addons extra | URLs de manifest de otros addons de streams, una por línea |
| URL Torznab | URL de tu Prowlarr/Jackett (ver abajo) |
| API Key Torznab | API key de tu Prowlarr/Jackett |

⚠️ La URL de tu manifest contiene tu API key codificada: **no la compartas**.

### Fuentes en español con Prowlarr/Jackett (recomendado)

Las páginas de torrents en español cambian de dominio constantemente y usan
protección anti-bots, por eso el addon no las scrapea directamente: se rompería
cada mes. En su lugar, usa **Prowlarr** (o Jackett), que mantiene cientos de
indexadores actualizados — incluyendo trackers en español:

1. Instala [Prowlarr](https://prowlarr.com) (gratis, corre en tu PC o un servidor).
2. En Prowlarr agrega los indexadores en español que quieras
   (busca nombres como los de sitios de torrents en español en su lista).
3. Copia tu **URL Torznab** (`http://tu-servidor:9696/api`) y tu **API key**
   (Settings → General en Prowlarr).
4. Pégalos en la configuración del addon. ¡Listo! Todas esas fuentes se suman
   a la búsqueda, con el filtro latino aplicado automáticamente.

## Despliegue (para usarlo en todos tus dispositivos)

### Opción A — Render (gratis)

1. Sube este proyecto a un repo de GitHub.
2. En [render.com](https://render.com) crea un **Web Service** desde ese repo.
3. Render detecta el `render.yaml` automáticamente. ¡Listo!
4. Tu addon quedará en `https://tu-addon.onrender.com/manifest.json`.

### Opción B — Railway / Fly.io / VPS

Cualquier host que corra Node.js sirve:

```bash
npm install --production
PORT=7000 node index.js
```

También hay un `Dockerfile` incluido:

```bash
docker build -t latino-streams .
docker run -p 7000:7000 latino-streams
```

## Notas técnicas

- **Fuentes:** el addon consulta varias fuentes en paralelo: Torrentio (agrega
  muchos indexadores de torrents), EZTV (respaldo para series), Torznab vía
  Prowlarr/Jackett (cientos de indexadores, incluyendo en español) y los
  addons extra que configures. No es literalmente "todo internet", pero es la
  cobertura práctica más amplia disponible, con fallback automático si alguna
  falla.
- **Límites de TorBox:** el endpoint `requestdl` tiene un presupuesto de ~100
  llamadas; el addon cachea los enlaces generados por 6 horas y limita los
  resultados para no agotarlo.
- **Series:** en packs de temporada completa, el addon elige automáticamente el
  archivo del episodio correcto.
- **Legalidad:** Stremio y este addon son software neutro. El contenido al que
  accedas depende de las fuentes; úsalo bajo tu responsabilidad y según las
  leyes de tu país.
