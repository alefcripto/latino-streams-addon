// ---------------------------------------------------------------------------
// alfa-http.js — Fuentes HTTP streaming estilo Alfa (Kodi) para Latino Streams
//
// Adapta canales HTTP latinos del addon Alfa (open source, GPL).
// A diferencia de alfa-torrents.js, estas fuentes devuelven URLs directas
// de video (mp4, m3u8) o reproductores embed, NO torrents.
//
// Flujo por fuente: buscar por título → página detalle →
//   extraer URLs de video → filtrar latino → devolver streams.
//
// Restricciones de velocidad:
//   - Timeout 5s por request (AT_TIMEOUT_MS)
//   - Todo en paralelo vía Promise.all en fetchAlfaHttpSource
//   - Cache en memoria 30min
//   - Cap global de 7.5s por fuente (Promise.race) para no exceder
//     el timeout de 8000ms configurado en Nuvio.
// ---------------------------------------------------------------------------

const cheerio = require("cheerio");

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const AH_TIMEOUT_MS = 5000;   // 5s max por request (genérico)
const AH_SEARCH_MS = 4000;    // búsqueda de título
const AH_DETAIL_MS = 3500;    // página detalle / episodio
const AH_PLAYER_MS = 2500;    // página de reproductor (resolución de embed)
const AH_SOURCE_CAP_MS = 7500; // cap total por fuente (Nuvio tolera 8s)

// --- Mini caché local ---
const _cache = new Map();
function cacheGet(key) {
	const e = _cache.get(key);
	if (!e) return null;
	if (Date.now() > e.exp) {
		_cache.delete(key);
		return null;
	}
	return e.val;
}
function cacheSet(key, val, ttlMs) {
	if (_cache.size > 2000) _cache.delete(_cache.keys().next().value);
	_cache.set(key, { val, exp: Date.now() + ttlMs });
}

async function fetchWithTimeout(url, ms, options = {}) {
	const ctrl = new AbortController();
	const t = setTimeout(() => ctrl.abort(), ms);
	try {
		return await fetch(url, { ...options, signal: ctrl.signal, redirect: "follow" });
	} finally {
		clearTimeout(t);
	}
}

// Fetch de HTML con timeout, UA y referer opcional. Lanza si !res.ok
async function getHtml(url, ms, referer) {
	const res = await fetchWithTimeout(url, ms, {
		headers: {
			"User-Agent": UA,
			"Accept-Language": "es-MX,es;q=0.9",
			...(referer ? { Referer: referer } : {}),
		},
	});
	if (!res.ok) throw new Error(`HTTP ${res.status}`);
	return await res.text();
}

// JSON embebido de apps Next.js (Cuevana2): <script type="application/json">...</script>
function extractNextJson(html) {
	const m = /<script[^>]*type="application\/json"[^>]*>([\s\S]*?)<\/script>/.exec(html || "");
	if (!m) return null;
	try { return JSON.parse(m[1]); } catch { return null; }
}

// Resolución ligera de páginas de reproductor: busca mp4/m3u8 o iframe final.
// Devuelve null si no encuentra nada (el caller usa el embed tal cual).
async function resolveEmbed(embedUrl, referer) {
	try {
		const data = await getHtml(embedUrl, AH_PLAYER_MS, referer);
		const file = /(?:file|src)\s*[:=]\s*["'](https?:[^"']+\.(?:m3u8|mp4)[^"']*)["']/i.exec(data);
		if (file) return file[1];
		const iframe = /<iframe[^>]+src=["'](https?:[^"']+)["']/i.exec(data);
		if (iframe && !/recaptcha|google\.com|about:blank/i.test(iframe[1])) return iframe[1];
	} catch { /* timeout u error: se usa el embed */ }
	return null;
}

// --- Título y año desde Cinemeta (compartido con alfa-torrents.js) ---
async function fetchMeta(type, id) {
	const imdb = String(id).split(":")[0];
	if (!/^tt\d+$/.test(imdb)) return null;
	const cacheKey = `ah:meta:${imdb}`;
	const hit = cacheGet(cacheKey);
	if (hit) return hit;
	try {
		const metaType = type === "series" ? "series" : "movie";
		const res = await fetchWithTimeout(`https://v3-cinemeta.strem.io/meta/${metaType}/${imdb}.json`, 5000, {
			headers: { "User-Agent": UA },
		});
		if (!res.ok) return null;
		const j = await res.json();
		const name = j?.meta?.name || null;
		let year = null;
		const rd = j?.meta?.released || j?.meta?.releaseInfo || "";
		const ym = /(\d{4})/.exec(rd);
		if (ym) year = parseInt(ym[1], 10);
		const result = name ? { name, year } : null;
		if (result) cacheSet(cacheKey, result, 24 * 60 * 60 * 1000);
		return result;
	} catch {
		return null;
	}
}

// --- Detección de latino ---
const LATINO_RE = /latin[oa]|espa[ñn]ol[\s._-]*latin|audio[\s._-]*latin|\[lat\]|\(lat\)|\blat\b|latinoam[eé]rica|dual[\s._-]*lat\b/i;
const CASTELLANO_RE = /castellano|\[esp\]|\(esp\)|espa[ñn]a/i;
// Rechazo explícito: portugués y solo-subtítulos nunca son latino
const REJECT_RE = /portugu[eê]s|\bpt[\s._-]?br\b|\bdublad[oa]\b|\blegendad[oa]\b|🇧🇷|\bbrazilian\b|\bsubtitulad[oa]\b|\bvose\b/i;
// Etiqueta genérica "español": probablemente latino si no hay marca de rechazo
const ESPANOL_RE = /espa[ñn]ol/i;

function isLatino(text) {
	if (!text) return false;
	if (LATINO_RE.test(text)) return true; // marca latina explícita gana
	if (CASTELLANO_RE.test(text)) return false;
	if (REJECT_RE.test(text)) return false;
	if (ESPANOL_RE.test(text)) return true; // "español" sin marcas de rechazo
	return false;
}

// --- Utilidades ---
function normalizeTitle(t) {
	return (t || "").toLowerCase()
		.normalize("NFD").replace(/[\u0300-\u036f]/g, "")
		.replace(/[^a-z0-9]+/g, " ").trim();
}

function titleMatch(searchTitle, resultTitle) {
	const s = normalizeTitle(searchTitle);
	const r = normalizeTitle(resultTitle);
	if (!s || !r) return false;
	// Coincidencia: todas las palabras significativas del título buscado están en el resultado
	const words = s.split(" ").filter(w => w.length > 2);
	if (!words.length) return s === r;
	const matched = words.filter(w => r.includes(w)).length;
	return matched / words.length >= 0.7;
}

function parseQuality(text) {
	if (/2160p|\b4k\b/i.test(text)) return "2160p";
	if (/1080p/i.test(text)) return "1080p";
	if (/720p/i.test(text)) return "720p";
	if (/480p/i.test(text)) return "480p";
	return "HD";
}

// --- Registro de fuentes ---
const SOURCES = {};

// Helper para crear un adaptador genérico de búsqueda HTML.
// extractTitle (opcional) permite títulos en atributos (ej. img[alt]).
function makeHtmlSource(id, name, mirrors, { searchPath, resultSelector, titleSelector, linkSelector, extractTitle, getVideoUrls }) {
	SOURCES[id] = {
		id, name, mirrors,
		async search(title, year) {
			const results = [];
			for (const mirror of mirrors) {
				try {
					const url = mirror + searchPath(encodeURIComponent(title));
					const res = await fetchWithTimeout(url, AH_SEARCH_MS, {
						headers: { "User-Agent": UA, "Accept-Language": "es-MX,es;q=0.9" },
					});
					if (!res.ok) continue;
					const html = await res.text();
					const $ = cheerio.load(html);
					$(resultSelector).each((_, el) => {
						const $el = $(el);
						const t = (extractTitle ? extractTitle($el, $) : "") ||
							$el.find(titleSelector).text().trim() || $el.attr("title") || "";
						let href = $el.find(linkSelector).attr("href") || $el.attr("href") || "";
						if (href && !href.startsWith("http")) {
							href = mirror + (href.startsWith("/") ? href : "/" + href);
						}
						if (t && href && titleMatch(title, t)) {
							results.push({ pageUrl: href, title: t });
						}
					});
					if (results.length) break; // Mirror funcionó, no probar más
				} catch (e) {
					continue; // Probar siguiente mirror
				}
			}
			return results.slice(0, 5);
		},
		getVideoUrls,
	};
}

async function resolveEmbed(embedUrl, referer) {
	try {
		const data = await getHtml(embedUrl, AH_PLAYER_MS, referer);
		const file = /(?:file|src)\s*[:=]\s*["'](https?:[^"']+\.(?:m3u8|mp4)[^"']*)["']/i.exec(data);
		if (file) return file[1];
		const iframe = /<iframe[^>]+src=["'](https?:[^"']+)["']/i.exec(data);
		if (iframe && !/recaptcha|google\.com|about:blank/i.test(iframe[1])) return iframe[1];
	} catch { /* timeout u error: se usa el embed */ }
	return null;
}

// ===========================================================================
// ADAPTADORES MVP — traducidos de plugin.video.alfa/channels/*.py
// Referencia: https://github.com/alfa-addon/addon
// ===========================================================================

// ---------------------------------------------------------------------------
// 1. Cuevana2Español — app Next.js; los players viajan en JSON embebido.
//    Peli:  pageProps.post.players    {LANG: [{cyberlocker, quality, result}]}
//    Serie: {serieUrl}/seasons/S/episodes/E → pageProps.episode.players
// ---------------------------------------------------------------------------
makeHtmlSource("cuevana2espanol", "Cuevana2Español",
	["https://www.cuevana2espanol.net"],
	{
		searchPath: (q) => `/search?q=${q}`,
		resultSelector: "a:has(h3)",
		titleSelector: "h3",
		linkSelector: "a",
		getVideoUrls: async (pageUrl, { season, episode }) => {
			const isSeries = season != null;
			let url = pageUrl;
			if (isSeries) {
				if (!/\/serie\//.test(pageUrl)) return [];
				url = `${pageUrl.replace(/\/$/, "")}/seasons/${season}/episodes/${episode ?? 1}`;
			} else if (!/\/pelicula\//.test(pageUrl)) {
				return [];
			}
			const html = await getHtml(url, AH_DETAIL_MS);
			const json = extractNextJson(html);
			const players = isSeries
				? json?.props?.pageProps?.episode?.players
				: json?.props?.pageProps?.post?.players;
			if (!players) return [];
			const out = [];
			for (const [lang, infos] of Object.entries(players)) {
				if (!isLatino(lang)) continue; // "LATINO" pasa, "CASTELLANO"/"SUBTITULADO" no
				for (const info of infos || []) {
					if (!info || !info.result) continue;
					out.push({
						url: info.result,
						quality: parseQuality(info.quality || ""),
						server: info.cyberlocker || "",
						language: "latino",
					});
				}
			}
			return out;
		},
	});

// ---------------------------------------------------------------------------
// 2. PelisPlus — pestañas de servidores en div.bg-tabs con data-server
//    (URL del servidor en base64). La página /player/{b64} revela el enlace
//    final vía "Location.href = '...'".
//    Serie: {serieUrl}/season/S/episode/E (patrón determinista, sin JSON).
// ---------------------------------------------------------------------------
makeHtmlSource("pelisplus", "PelisPlus",
	["https://ww3.pelisplus.to", "https://pelisplus.live"],
	{
		searchPath: (q) => `/search/${q}`,
		resultSelector: "article.item",
		titleSelector: "h2",
		linkSelector: "a",
		extractTitle: ($el) => ($el.find("img").attr("alt") || "").trim(),
		getVideoUrls: async (pageUrl, { season, episode }, ctx = {}) => {
			const isSeries = season != null;
			let url = pageUrl;
			if (isSeries) {
				if (!/\/serie\//.test(pageUrl)) return [];
				url = `${pageUrl.replace(/\/$/, "")}/season/${season}/episode/${episode ?? 1}`;
			} else if (!/\/pelicula\//.test(pageUrl)) {
				return [];
			}
			const mirror = new URL(pageUrl).origin; // espejo que respondió en la búsqueda
			const html = await getHtml(url, AH_DETAIL_MS);
			const $ = cheerio.load(html);
			const langAlt = ($("div.bg-tabs img[alt]").first().attr("alt") || "").trim();
			// Filtro de idioma a nivel página (la bandera aplica a las pestañas).
			// Filtro estricto: se descarta si se identifica castellano, portugués o subtitulado.
			// Sin marca de idioma se acepta (sitios latinos por defecto).
			if (CASTELLANO_RE.test(langAlt) || REJECT_RE.test(langAlt)) return [];
			const tabs = $("div.bg-tabs li[data-server]").slice(0, 6).toArray();
			const out = [];
			await Promise.all(tabs.map(async (el) => {
				const raw = $(el).attr("data-server") || "";
				if (!raw) return;
				const server = ($(el).find("span").first().text().trim().split("-")[0] || "").trim();
				const b64 = Buffer.from(raw, "utf8").toString("base64");
				const playerUrl = `${mirror}/player/${b64}`;
				try {
					const pdata = await getHtml(playerUrl, AH_PLAYER_MS, url);
					const m = /Location\.href\s*=\s*'([^']+)'/i.exec(pdata);
					const final = m && /^https?:/.test(m[1]) ? m[1] : playerUrl;
					out.push({ url: final, quality: parseQuality(server + " " + langAlt), server, language: "latino" });
				} catch {
					out.push({ url: playerUrl, quality: "HD", server, language: "latino" });
				}
			}));
			return out;
		},
	});

// ---------------------------------------------------------------------------
// 3. EntrePeliculasySeries — reproductores en div.player-frame iframe.
//    La página del iframe suele tener div.OptionsLangDisp con li[data-lang]
//    (0=LAT, 1=CAST, 2=VOSE) y el enlace en el onclick (a veces base64).
//    Serie: episodios en div#season-{S-1} div.episode-card a.
// ---------------------------------------------------------------------------
const EPS_LANGS = { "0": "lat", "1": "cast", "2": "vose" };

makeHtmlSource("entrepeliculasyseries", "EntrePeliculasySeries",
	["https://entrepeliculasyseries.nz"],
	{
		searchPath: (q) => `/search?page=1&s=${q}`,
		resultSelector: "ul.post-lst article.post",
		titleSelector: "h2",
		linkSelector: "a",
		extractTitle: ($el) => {
			const t = $el.find("h2").length ? $el.find("h2").text() : $el.find("h3").text();
			return (t || "").trim();
		},
		getVideoUrls: async (pageUrl, { season, episode }) => {
			const isSeries = season != null;
			let url = pageUrl;
			if (isSeries) {
				if (!/\/(serie|anime)\//.test(pageUrl)) return [];
				const html0 = await getHtml(pageUrl, AH_DETAIL_MS);
				const $0 = cheerio.load(html0);
				let epHref = null;
				$0(`div#season-${season - 1} div.episode-card a`).each((_, el) => {
					if (epHref) return;
					const txt = $0(el).text().replace(/\s+/g, " ").trim();
					const m = /(\d+)\s*$/.exec(txt) || /episodio\s*(\d+)/i.exec(txt);
					if (m && parseInt(m[1], 10) === (episode ?? 1)) epHref = $0(el).attr("href");
				});
				if (!epHref) return [];
				url = epHref.startsWith("http") ? epHref : new URL(epHref, pageUrl).href;
			} else if (!/\/pelicula\//.test(pageUrl)) {
				return [];
			}
			const html = await getHtml(url, AH_DETAIL_MS);
			const $ = cheerio.load(html);
			const frames = $("div.player-frame iframe").toArray()
				.map((el) => $(el).attr("src"))
				.filter(Boolean);
			const out = [];
			for (const src0 of frames.slice(0, 4)) {
				let src = src0.startsWith("http") ? src0 : new URL(src0, url).href;
				if (/\/uqlink\./.test(src)) {
					const id = /[?&]id=([A-Za-z0-9]+)/.exec(src)?.[1];
					if (id) out.push({ url: `https://uqload.io/embed-${id}.html`, quality: "HD", server: "uqload", language: "latino" });
					continue;
				}
				if (/waaw|netu|hqq/.test(src)) continue; // requieren interacción / bloqueados
				try {
					const pdata = await getHtml(src, AH_PLAYER_MS, url);
					const $p = cheerio.load(pdata);
					const opts = $p("div.OptionsLangDisp li").toArray();
					if (!opts.length) {
						// sin marcadores de idioma: embed latino por defecto del sitio
						out.push({ url: src, quality: "HD", server: "", language: "latino" });
						continue;
					}
					for (const li of opts) {
						const lang = EPS_LANGS[$p(li).attr("data-lang")] || "";
						const onclick = $p(li).attr("onclick") || "";
						let vid = /'([^']+)'/.exec(onclick)?.[1] || "";
						if (!vid) continue;
						if (!/^https?:/.test(vid)) {
							try { vid = Buffer.from(vid, "base64").toString("utf8"); } catch { /* seguir con vid crudo */ }
						}
						if (!/^https?:/.test(vid)) continue;
						out.push({
							url: vid,
							quality: "HD",
							server: $p(li).find("span").first().text().trim(),
							language: lang || "latino",
						});
					}
				} catch {
					out.push({ url: src, quality: "HD", server: "", language: "latino" });
				}
			}
			// Solo latino: "lat" aceptado, "cast"/"vose" descartados
			return out.filter((v) => !v.language || v.language === "latino" || v.language === "lat" || isLatino(v.language));
		},
	});

// ---------------------------------------------------------------------------
// 4. SoloLatino — servidores en atributos data-server-url de la página
//    detalle (película o página de episodio propia).
//    Serie: temporadas en select#season-select, episodios en
//    div[data-season-panel=S] a (cada episodio tiene su propia URL).
// ---------------------------------------------------------------------------
makeHtmlSource("sololatino", "SoloLatino",
	["https://sololatino.net"],
	{
		searchPath: (q) => `/buscar?q=${q}`,
		resultSelector: "div.movies-grid div.card",
		titleSelector: "img",
		linkSelector: "a",
		extractTitle: ($el) => ($el.find("img").attr("alt") || "").trim(),
		getVideoUrls: async (pageUrl, { season, episode }) => {
			const isSeries = season != null;
			let url = pageUrl;
			if (isSeries) {
				if (!/sololatino\.net\/(serie|anime|dorama)\//.test(pageUrl)) return [];
				const html0 = await getHtml(pageUrl, AH_DETAIL_MS);
				const $0 = cheerio.load(html0);
				let epHref = null;
				$0(`div[data-season-panel="${season}"] a`).each((_, el) => {
					if (epHref) return;
					const numTxt = $0(el).find("p.ep-num").text().trim().replace(/^E/i, "");
					if (parseInt(numTxt, 10) === (episode ?? 1)) epHref = $0(el).attr("href");
				});
				if (!epHref) return [];
				url = epHref.startsWith("http") ? epHref : new URL(epHref, pageUrl).href;
			} else if (!/sololatino\.net\/pelicula\//.test(pageUrl)) {
				return [];
			}
			const html = await getHtml(url, AH_DETAIL_MS);
			// Servidores: atributos data-server-url (canal Alfa, películas y episodios)
			const servers = [...html.matchAll(/data-server-url="([^"]+)"/g)]
				.map((m) => m[1])
				.filter(Boolean);
			// Modelo nuevo alternativo: botones con data-player-{tipo} + API
			if (!servers.length) {
				const btns = [...html.matchAll(/data-player-\w+="([^"]+)"/g)].map((m) => m[1]);
				servers.push(...btns.filter(Boolean));
			}
			const uniq = [...new Set(servers)].slice(0, 5);
			const out = [];
			await Promise.all(uniq.map(async (s) => {
				const embed = s.startsWith("http") ? s : new URL(s, url).href;
				// Página de servidor tipo xupalace: lista de idiomas por data-lang
				let vid = null;
				try {
					const pdata = await getHtml(embed, AH_PLAYER_MS, url);
					const $p = cheerio.load(pdata);
					const opts = $p("div.OptionsLangDisp li").toArray();
					if (opts.length) {
						for (const li of opts) {
							const lang = EPS_LANGS[$p(li).attr("data-lang")] || "lat";
							if (lang !== "lat") continue;
							const onclick = $p(li).attr("onclick") || "";
							let v = /'([^']+)'/.exec(onclick)?.[1] || "";
							if (v && !/^https?:/.test(v)) {
								try { v = Buffer.from(v, "base64").toString("utf8"); } catch { /* crudo */ }
							}
							if (v && /^https?:/.test(v)) vid = v;
						}
					}
				} catch { /* embed directo */ }
				out.push({
					url: vid || embed,
					quality: "HD",
					server: "",
					language: "latino",
				});
			}));
			return out;
		},
	});

makeHtmlSource("pelisflix", "PelisFlix",
	["https://pelisflix1.dog"],
	{
		searchPath: (q) => `/?s=${q}`,
		resultSelector: "div.result-item article, article.item",
		titleSelector: "h2",
		linkSelector: "a",
		extractTitle: ($el) => {
			const t = $el.find("h2, h3").first().text().trim();
			return t.replace(/\s*\(\d{4}\)\s*$/, "").trim(); // quitar año "(2018)"
		},
		getVideoUrls: async (pageUrl, { season, episode }) => {
			const isSeries = season != null;
			let url = pageUrl;
			if (isSeries) {
				if (!/\/serie\//.test(pageUrl)) return [];
				const html0 = await getHtml(pageUrl, AH_DETAIL_MS);
				const $0 = cheerio.load(html0);
				let epHref = null;
				// Patrón 1: enlaces con temporadaXepisodio en la URL (-1x05/, 1x05.html)
				$0("a[href]").each((_, el) => {
					if (epHref) return;
					const href = $0(el).attr("href") || "";
					const m = /-(\d+)x(\d+)(?:[\/.-]|$)/.exec(href) || /temporada-(\d+)-episodio-(\d+)/.exec(href);
					if (m && parseInt(m[1], 10) === season && parseInt(m[2], 10) === (episode ?? 1)) {
						epHref = href;
					}
				});
				// Patrón 2: listado por temporada (div[data-season])
				if (!epHref) {
					$0(`div[data-season="${season}"] a`).each((_, el) => {
						if (epHref) return;
						const txt = $0(el).text().replace(/\s+/g, " ").trim();
						const m = /(\d+)\s*$/.exec(txt) || /episodio\s*(\d+)/i.exec(txt);
						if (m && parseInt(m[1], 10) === (episode ?? 1)) epHref = $0(el).attr("href");
					});
				}
				if (!epHref) return [];
				url = epHref.startsWith("http") ? epHref : new URL(epHref, pageUrl).href;
			} else if (!/\/pelicula\//.test(pageUrl)) {
				return [];
			}
			const html = await getHtml(url, AH_DETAIL_MS);
			const $ = cheerio.load(html);
			const opts = $("ul#playeroptionsul li[data-url], li.dooplay_player_option[data-url]")
				.toArray().slice(0, 8);
			const out = [];
			await Promise.all(opts.map(async (li) => {
				const raw = $(li).attr("data-url") || "";
				let embed = null;
				try { embed = Buffer.from(raw, "base64").toString("utf8").trim(); } catch { return; }
				if (!/^https?:/.test(embed)) return;
				const label = $(li).text().replace(/\s+/g, " ").trim();
				if (/castellano|\bcast\b/i.test(label)) return; // solo latino
				const resolved = await resolveEmbed(embed, url);
				out.push({ url: resolved || embed, quality: parseQuality(label), server: label.slice(0, 30), language: "latino" });
			}));
			// Fallback: iframes sueltos cuyo contexto no indique castellano
			if (!out.length) {
				$("iframe[src]").each((_, el) => {
					const src = $(el).attr("src") || "";
					if (!/^https?:/.test(src)) return;
					const ctx = $(el).closest("div").text();
					if (/castellano/i.test(ctx)) return;
					out.push({ url: src, quality: "HD", server: "", language: "latino" });
				});
			}
			return out.slice(0, 8);
		},
	});

makeHtmlSource("repelishd", "RepelisHD",
	["https://repelishd.cam"],
	{
		searchPath: (q) => `/index.php?do=search&subaction=search&search_start=1&story=${q}`,
		resultSelector: "div.card",
		titleSelector: "img",
		linkSelector: "a",
		extractTitle: ($el) => ($el.find("img").attr("alt") || "").trim(),
		getVideoUrls: async (pageUrl, { season, episode }) => {
			const isSeries = season != null;
			const html = await getHtml(pageUrl, AH_DETAIL_MS);
			const $ = cheerio.load(html);
			const out = [];
			if (isSeries) {
				let section = null;
				$(`a[id="serie-${season}_${episode ?? 1}"]`).each((_, el) => { if (!section) section = $(el).parent(); });
				if (!section) return [];
				section.find("div.mirrors a[data-link]").each((_, a) => {
					let url = $(a).attr("data-link") || "";
					if (url.startsWith("//")) url = "https:" + url;
					if (/verhdlink/i.test(url)) return;
					if (url) out.push({ url, quality: "HD", server: $(a).text().trim(), language: "latino" });
				});
			} else {
				const iframe = $("div.player_contenedor iframe").first().attr("src");
				if (!iframe) return [];
				const src = iframe.startsWith("http") ? iframe : "https:" + iframe;
				try {
					const pdata = await getHtml(src, AH_PLAYER_MS, pageUrl);
					const $p = cheerio.load(pdata);
					// Solo el ul de idioma latino (class "latino" según CUSTOM_FILTER)
					$p("ul._player-mirrors.latino li, ul.latino li").each((_, li) => {
						let url = $(li).attr("data-link") || "";
						if (url.startsWith("//")) url = "https:" + url;
						if (/verhdlink/i.test(url)) return;
						if (url) out.push({ url, quality: "HD", server: $(li).text().trim(), language: "latino" });
					});
					// Si no hay marcador de idioma, todos los mirrors
					if (!out.length) {
						$p("ul._player-mirrors li").each((_, li) => {
							let url = $(li).attr("data-link") || "";
							if (url.startsWith("//")) url = "https:" + url;
							if (url && !/verhdlink/i.test(url)) out.push({ url, quality: "HD", server: $(li).text().trim(), language: "latino" });
						});
					}
				} catch {
					out.push({ url: src, quality: "HD", server: "", language: "latino" });
				}
			}
			return out;
		},
	});

makeHtmlSource("pelisforte", "PelisForte",
	["https://www2.pelisforte.se"],
	{
		searchPath: (q) => `/page/1?s=${q}`,
		resultSelector: "ul.post-lst li[class^='post-']",
		titleSelector: "h2",
		linkSelector: "a",
		getVideoUrls: async (pageUrl) => {
			const html = await getHtml(pageUrl, AH_DETAIL_MS);
			const $ = cheerio.load(html);
			const player = $("section.player");
			const iframes = player.find("iframe").toArray();
			const servers = player.find("span.server").toArray();
			const out = [];
			iframes.slice(0, 8).forEach((el, i) => {
				let url = $(el).attr("data-src") || $(el).attr("src") || "";
				if (!url) return;
				url = url.replace("?h=", "r.php?h=");
				if (url.startsWith("//")) url = "https:" + url;
				const srvTxt = servers[i] ? $(servers[i]).text().trim() : "";
				const parts = srvTxt.split("-");
				const lang = (parts[1] || "").trim();
				if (/castellano/i.test(lang)) return; // solo latino
				const resolved = null; // la página r.php redirige; el embed sirve
				out.push({ url, quality: "HD", server: (parts[0] || "").trim(), language: "latino" });
			});
			return out;
		},
	});

makeHtmlSource("homecine", "HomeCine",
	["https://www3.homecine.to"],
	{
		searchPath: (q) => `/?s=${q}`,
		resultSelector: "div.movies-list div[data-movie-id]",
		titleSelector: "h2",
		linkSelector: "a",
		getVideoUrls: async (pageUrl, { season, episode }) => {
			const isSeries = season != null;
			const html = await getHtml(pageUrl, AH_DETAIL_MS);
			const $ = cheerio.load(html);
			const out = [];
			if (isSeries) {
				if (!/\/series\//.test(pageUrl)) return [];
				const blocks = $("div.les-content").toArray();
				const block = blocks[(season ?? 1) - 1];
				if (!block) return [];
				let epUrl = null;
				$(block).find("a").each((_, a) => {
					if (epUrl) return;
					const t = $(a).text().replace("Episode", "").trim();
					if (parseInt(t, 10) === (episode ?? 1)) epUrl = $(a).attr("href");
				});
				if (!epUrl) return [];
				return SOURCES.homecine.getVideoUrls(
					epUrl.startsWith("http") ? epUrl : new URL(epUrl, pageUrl).href,
					{ season: null, episode: null });
			}
			// Película (o página de episodio): pestañas de idioma + iframes
			const tabs = $("div[id^='tab']").toArray();
			const langs = $("a[href^='#tab']").toArray()
				.map((a) => $(a).text().replace(/\s+/g, " ").trim());
			tabs.slice(0, 6).forEach((tab, i) => {
				const langTxt = langs[i] || "";
				if (/castellano/i.test(langTxt)) return;
				if (/sub|vose/i.test(langTxt) && !/lat/i.test(langTxt)) return;
				const src = $(tab).find("iframe").first().attr("src") || "";
				if (!src) return;
				const url = src.startsWith("http") ? src : new URL(src, pageUrl).href;
				out.push({ url, quality: "HD", server: langTxt.split("-").pop() || "", language: "latino" });
			});
			return out;
		},
	});

SOURCES["lamovie"] = {
	id: "lamovie",
	name: "LaMovie",
	mirrors: ["https://lamovie.org"],
	_langIds: { "58651": "latino", "58652": "ingles", "58653": "castellano", "58654": "japones", "58655": "subtitulado" },
	async _api(path) {
		const res = await fetchWithTimeout(this.mirrors[0] + path, AH_SEARCH_MS, {
			headers: { "User-Agent": UA, Referer: this.mirrors[0] },
		});
		if (!res.ok) return null;
		return await res.json().catch(() => null);
	},
	_isLatinoItem(item) {
		const langs = (item.lang || []).map((l) => this._langIds[String(l)] || "");
		if (!langs.length) return true; // default del sitio: latino
		return langs.includes("latino");
	},
	async search(title) {
		const j = await this._api(`/wp-api/v1/search?filter=%7B%7D&postType=any&q=${encodeURIComponent(title)}&postsPerPage=26`);
		const posts = j?.data?.posts || [];
		const out = [];
		for (const p of posts) {
			const t = (p.original_title || "").trim();
			if (!t || !this._isLatinoItem(p)) continue;
			if (!titleMatch(title, t)) continue;
			out.push({ pageUrl: String(p._id), title: t, kind: (p.type || "").replace(/s$/, ""), langs: p.lang });
		}
		return out.slice(0, 5);
	},
	async getVideoUrls(pageUrl, { season, episode, title }) {
		// pageUrl trae el _id; re-buscamos para saber el tipo
		const j = await this._api(`/wp-api/v1/search?filter=%7B%7D&postType=any&q=${encodeURIComponent(title || "")}&postsPerPage=26`);
		const me = (j?.data?.posts || []).find((p) => String(p._id) === String(pageUrl) && this._isLatinoItem(p));
		const kind = me ? (me.type || "").replace(/s$/, "") : "movie";
		let postId = pageUrl;
		if (kind !== "movie" && season != null) {
			const eps = await this._api(`/wp-api/v1/single/episodes/list?_id=${pageUrl}&season=${season}&page=1&postsPerPage=15`);
			const ep = (eps?.data?.posts || []).find((e) =>
				parseInt(e.season_number, 10) === season && parseInt(e.episode_number, 10) === (episode ?? 1));
			if (!ep) return [];
			postId = String(ep._id);
		}
		const links = await this._api(`/wp-api/v1/player?postId=${postId}&demo=0`);
		const vids = [...(links?.data?.embeds || []), ...(links?.data?.downloads || [])];
		const out = [];
		for (const v of vids.slice(0, 10)) {
			if (!v.url || /html\?v=1/.test(v.url)) continue;
			const lang = (v.lang || "").replace("Latino/Inglés", "DUAL");
			if (/castellano/i.test(lang) || /subtitul/i.test(lang)) continue;
			if (/ingl|japones/i.test(lang) && !/latino|dual/i.test(lang)) continue;
			out.push({ url: v.url, quality: v.quality || "HD", server: "", language: "latino" });
		}
		return out;
	},
};

SOURCES["flizzmovies"] = {
	id: "flizzmovies",
	name: "FlizzMovies",
	mirrors: ["https://flizzmovies.org"],
	async search(title) {
		for (const m of this.mirrors) {
			try {
				const res = await fetchWithTimeout(m, AH_SEARCH_MS, {
					method: "POST",
					headers: { "User-Agent": UA, "Content-Type": "application/x-www-form-urlencoded" },
					body: `s=${encodeURIComponent(title)}`,
				});
				if (!res.ok) continue;
				const $ = cheerio.load(await res.text());
				const out = [];
				$("ul.container_cards a").each((_, el) => {
					const t = ($(el).find("div.card_title p").first().text() || "").trim();
					const href = $(el).attr("href") || "";
					if (t && href && titleMatch(title, t)) {
						out.push({ pageUrl: href.startsWith("http") ? href : new URL(href, m).href, title: t });
					}
				});
				if (out.length) return out.slice(0, 5);
			} catch { /* siguiente mirror */ }
		}
		return [];
	},
	async getVideoUrls(pageUrl) {
		const html = await getHtml(pageUrl, AH_DETAIL_MS);
		const $ = cheerio.load(html);
		const btns = $("div.options a.reportbtn").toArray().slice(0, 8);
		const out = [];
		await Promise.all(btns.map(async (el) => {
			const lang = ($(el).attr("data-lang") || "").toLowerCase();
			if (/castellano|subtitul/.test(lang)) return;
			const id = $(el).attr("data-id");
			const num = $(el).attr("data-num");
			if (!id || !num) return;
			try {
				const res = await fetchWithTimeout(pageUrl, AH_PLAYER_MS, {
					method: "POST",
					headers: {
						"User-Agent": UA,
						"Content-Type": "application/x-www-form-urlencoded",
						"X-Requested-With": "XMLHttpRequest",
						Referer: pageUrl,
					},
					body: `idF=${encodeURIComponent(id)}&ajax=${encodeURIComponent(num)}`,
				});
				const j = await res.json().catch(() => null);
				if (j?.link) {
					out.push({ url: j.link, quality: "HD", server: $(el).attr("data-server") || "", language: "latino" });
				}
			} catch { /* botón roto */ }
		}));
		return out;
	},
};

makeHtmlSource("cine24h", "Cine24H",
	["https://cine24h.online"],
	{
		searchPath: (q) => `/?s=${q}`,
		resultSelector: "article",
		titleSelector: "div.Title, h3, h2",
		linkSelector: "a",
		extractTitle: ($el) => {
			const t = $el.find("div.Title").first().text().trim()
				|| $el.find("h3").first().text().trim()
				|| $el.find("h2").first().text().trim();
			return t;
		},
		getVideoUrls: async (pageUrl, { season, episode }) => {
			const isSeries = season != null;
			let url = pageUrl;
			if (isSeries) {
				if (!/series|serie/.test(pageUrl)) return [];
				const html0 = await getHtml(pageUrl, AH_DETAIL_MS);
				const $0 = cheerio.load(html0);
				const box = $0("div.AABox").toArray()[(season ?? 1) - 1];
				if (!box) return [];
				let epUrl = null;
				$0(box).find("a.MvTbImg").each((_, a) => {
					if (epUrl) return;
					const m = /x(\d+)/.exec($(a).attr("href") || "");
					if (m && parseInt(m[1], 10) === (episode ?? 1)) epUrl = $(a).attr("href");
				});
				if (!epUrl) return [];
				url = epUrl.startsWith("http") ? epUrl : new URL(epUrl, pageUrl).href;
			}
			const html = await getHtml(url, AH_DETAIL_MS);
			const $ = cheerio.load(html);
			const out = [];
			const groups = $("div.drpdn").toArray();
			await Promise.all(groups.map(async (g) => {
				const langTxt = $(g).find("span").first().text().trim();
				let lang = "";
				if (/LAT/i.test(langTxt)) lang = "lat";
				else if (/ESP/i.test(langTxt)) lang = "cast";
				else if (/SUB/i.test(langTxt)) lang = "vose";
				if (lang && lang !== "lat") return; // solo latino
				const items = $(g).find("li[data-src]").toArray().slice(0, 3);
				for (const li of items) {
					const raw = $(li).attr("data-src") || "";
					let embed = null;
					try { embed = Buffer.from(raw, "base64").toString("utf8").replace(/amp;|#038;/g, ""); } catch { continue; }
					if (!/^https?:/.test(embed)) continue;
					const vid = await resolveEmbed(embed, url);
					out.push({ url: vid || embed, quality: "HD", server: "", language: "latino" });
				}
			}));
			return out;
		},
	});

SOURCES["animejara"] = {
	id: "animejara",
	name: "AnimeJara",
	mirrors: ["https://animejara.com"],
	_lang(s) {
		s = (s || "").toLowerCase();
		if (s.includes("latino")) return "latino";
		if (s.includes("castellano")) return "castellano";
		return "vose";
	},
	async search(title) {
		for (const m of this.mirrors) {
			try {
				const res = await fetchWithTimeout(`${m}catalogo/?q=${encodeURIComponent(title)}`, AH_SEARCH_MS, {
					headers: { "User-Agent": UA },
				});
				if (!res.ok) continue;
				const $ = cheerio.load(await res.text());
				const out = [];
				$("a.anime-card").each((_, el) => {
					const t = ($(el).find("h3.card-title").first().text() || "").trim();
					if (!t || !titleMatch(title, t)) return;
					const langs = $(el).find("img.lang-icon").toArray()
						.map((i) => this._lang($(i).attr("alt"))).filter((l) => l === "latino");
					if (!langs.length) return; // solo doblaje latino
					const href = $(el).attr("href") || "";
					const isMovie = /pelicula/i.test($(el).find("span.meta-type").first().text() || "");
					out.push({
						pageUrl: href.startsWith("http") ? href : new URL(href, m).href,
						title: t,
						kind: isMovie ? "movie" : "series",
					});
				});
				if (out.length) return out.slice(0, 5);
			} catch { /* siguiente mirror */ }
		}
		return [];
	},
	async getVideoUrls(pageUrl, { season, episode }) {
		let url = pageUrl;
		const isSeries = season != null;
		if (isSeries) {
			const html0 = await getHtml(pageUrl, AH_DETAIL_MS);
			const slugM = /ANIME_SLUG\s*=\s*'([^']+)'/.exec(html0);
			const dataM = /TEMPORADAS_DATA\s*=\s*(\[[\s\S]*?\]);/.exec(html0);
			if (!slugM || !dataM) return [];
			try {
				const temps = JSON.parse(dataM[1]);
				const slug = slugM[1];
				const temp = temps.find((t) => parseInt(t.numero_temporada, 10) === season);
				const ep = (temp?.episodios || []).find((e) => parseInt(e.numero_episodio, 10) === (episode ?? 1));
				if (!ep) return [];
				const langs = (ep.idiomas || []).map((l) => this._lang(l));
				if (langs.length && !langs.includes("latino")) return [];
				url = `https://animejara.com/episode/${slug}-${season}x${episode ?? 1}/`;
			} catch { return []; }
		}
		const html = await getHtml(url, AH_DETAIL_MS);
		const $ = cheerio.load(html);
		const out = [];
		const langNames = $("div.botones-idioma div.lang-name").toArray()
			.map((d) => this._lang($(d).text()));
		const iframes = $("div.player, div#player, iframe").toArray()
			.map((el) => $(el).attr("src") || ($(el).is("iframe") ? $(el).attr("data-src") : ""))
			.filter(Boolean);
		// Emparejar iframes con idiomas en orden; sin marcador, aceptar
		iframes.slice(0, 8).forEach((src0, i) => {
			const lang = langNames[i];
			if (lang && lang !== "latino") return;
			const src = src0.startsWith("http") ? src0 : new URL(src0, url).href;
			if (/hqq|netuplayer|krakenfiles/i.test(src)) return;
			out.push({ url: src, quality: "HD", server: "", language: "latino" });
		});
		return out;
	},
};



// ---------------------------------------------------------------------------
// NOTA HDFull: NO incluido en el MVP. El canal de Alfa requiere cuenta de
// usuario (login con token CSRF), la librería ofuscada alfaresolver y
// js/providers.js para descifrar los enlaces. No es replicable con fetch
// simple desde Node. Alternativa sugerida: repelishd.cam (RepelisHD).
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Orquestador principal
// ---------------------------------------------------------------------------
async function fetchAlfaHttpSource(sourceId, type, id, season, episode) {
	const src = SOURCES[sourceId];
	if (!src) return [];

	const cacheKey = `ah:${sourceId}:${type}:${id}`;
	const hit = cacheGet(cacheKey);
	if (hit) return hit;

	try {
		const meta = await fetchMeta(type, id);
		if (!meta) return [];

		const searchResults = await src.search(meta.name, meta.year);
		if (!searchResults.length) return [];

		// Obtener URLs de video de cada resultado (en paralelo, max 3)
		const videoJobs = searchResults.slice(0, 3).map(r =>
			src.getVideoUrls(r.pageUrl, { season, episode, title: r.title })
				.catch(() => [])
		);
		const videoLists = await Promise.all(videoJobs);

		const streams = [];
		for (const list of videoLists) {
			for (const v of list) {
				if (!v.url) continue;
				streams.push({
					url: v.url,
					quality: v.quality || parseQuality(v.url + " " + (v.server || "")),
					source: src.name,
					server: v.server || "",
					language: v.language || "latino",
				});
			}
		}

		const result = streams.slice(0, 10);
		cacheSet(cacheKey, result, 30 * 60 * 1000);
		return result;
	} catch (e) {
		console.warn(`HTTP ${sourceId} falló:`, e.message);
		return [];
	}
}

// Cap duro de latencia por fuente: si una fuente tarda más de ms, se descarta
// para no exceder el timeout de 8000ms que tiene Nuvio configurado.
function withTimeout(promise, ms) {
	return Promise.race([
		promise,
		new Promise((_, reject) => setTimeout(() => reject(new Error("cap de tiempo excedido")), ms)),
	]);
}

// Fetch paralelo de múltiples fuentes HTTP con cap global por fuente
async function fetchAllHttpSources(type, id, season, episode, sourceIds) {
	const jobs = sourceIds.map(srcId =>
		withTimeout(fetchAlfaHttpSource(srcId, type, id, season, episode), AH_SOURCE_CAP_MS)
			.catch((e) => {
				console.warn(`HTTP ${srcId} descartado por latencia:`, e.message);
				return [];
			})
	);
	const results = await Promise.all(jobs);
	return results.flat();
}

module.exports = {
	fetchAlfaHttpSource,
	fetchAllHttpSources,
	SOURCES,
	isLatino,
	AH_TIMEOUT_MS,
};
