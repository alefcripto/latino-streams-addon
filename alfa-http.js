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
// Cada fuente es un adaptador con:
//   - id, name, mirrors[] (rotación de dominios)
//   - search(title, year) → [{ pageUrl, title }]
//   - getVideoUrls(pageUrl, { season, episode }) → [{ url, quality, server }]
//
// Restricciones de velocidad:
//   - Timeout 5s por request (AT_TIMEOUT_MS)
//   - Todo en paralelo vía Promise.all en fetchAlfaHttpSource
//   - Cache en memoria 30min
// ---------------------------------------------------------------------------

const cheerio = require("cheerio");

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const AH_TIMEOUT_MS = 5000; // 5s max por request

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
const LATINO_RE = /latin[oa]|espa[ñn]ol[\s._-]*latin|audio[\s._-]*latin|\[lat\]|\(lat\)|latinoam[eé]rica|dual[\s._-]*lat\b/i;
const CASTELLANO_RE = /castellano|\[esp\]|\(esp\)|espa[ñn]a/i;

function isLatino(text) {
	if (!text) return false;
	if (CASTELLANO_RE.test(text)) return false;
	return LATINO_RE.test(text);
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

// Helper para crear un adaptador genérico de búsqueda HTML
function makeHtmlSource(id, name, mirrors, { searchPath, resultSelector, titleSelector, linkSelector, getVideoUrls }) {
	SOURCES[id] = {
		id, name, mirrors,
		async search(title, year) {
			const results = [];
			for (const mirror of mirrors) {
				try {
					const url = mirror + searchPath(encodeURIComponent(title));
					const res = await fetchWithTimeout(url, AH_TIMEOUT_MS, {
						headers: { "User-Agent": UA, "Accept-Language": "es-MX,es;q=0.9" },
					});
					if (!res.ok) continue;
					const html = await res.text();
					const $ = cheerio.load(html);
					$(resultSelector).each((_, el) => {
						const $el = $(el);
						const t = $el.find(titleSelector).text().trim() || $el.attr("title") || "";
						let href = $el.find(linkSelector).attr("href") || $el.attr("href") || "";
						if (href && !href.startsWith("http")) {
							href = mirror + (href.startsWith("/") ? href : "/" + href);
						}
						if (t && href && titleMatch(title, t)) {
							// Filtrar por año si está disponible
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

// Fetch paralelo de múltiples fuentes HTTP con timeout global
async function fetchAllHttpSources(type, id, season, episode, sourceIds) {
	const jobs = sourceIds.map(srcId =>
		fetchAlfaHttpSource(srcId, type, id, season, episode).catch(() => [])
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
