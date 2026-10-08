/**
 * Latino Streams — Stremio addon
 *
 * Busca las mejores fuentes en español latino (vía el agregador Torrentio)
 * y las resuelve a reproducción instantánea usando la cuenta TorBox del usuario.
 *
 * Sin API key de TorBox funciona igual, devolviendo los torrents latino
 * para que Stremio los reproduzca con su motor integrado.
 */

const { addonBuilder, getRouter } = require("stremio-addon-sdk");
const express = require("express");
const landingTemplate = require("stremio-addon-sdk/src/landingTemplate");
const { XMLParser } = require("fast-xml-parser");
const cheerio = require("cheerio");
const crypto = require("crypto");
const { fetchAlfaTorrentSource } = require("./alfa-torrents.js");
const { fetchAllHttpSources } = require("./alfa-http.js");

const TORRENTIO_BASE = "https://torrentio.strem.fun";
const TORBOX_API = "https://api.torbox.app/v1/api";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

// Fuentes HTTP habilitadas (se agregan conforme se implementan adaptadores en alfa-http.js)
// TODO: Actualizar según resultados de auditoría
const HTTP_SOURCES_ENABLED = [
	"cuevana2espanol",
	"pelisplus",
	"entrepeliculasyseries",
	"sololatino",
];

// ---------------------------------------------------------------------------
// Manifest
// ---------------------------------------------------------------------------
const manifest = {
	id: "com.latino-streams.torbox",
	version: "1.0.1",
	name: "Latino Streams ⚡",
	description:
		"Las mejores fuentes en español latino, reproducidas al instante con tu cuenta de TorBox.",
	resources: ["stream"],
	types: ["movie", "series"],
	idPrefixes: ["tt"],
	catalogs: [],
	behaviorHints: {
		configurable: true,
		configurationRequired: false,
	},
	config: [
		{
			key: "torboxKey",
			type: "password",
			title: "TorBox API Key (recomendado para reproducción instantánea)",
			required: false,
		},
		{
			key: "instantOnly",
			type: "checkbox",
			title: "Solo mostrar fuentes instantáneas (ya cacheadas en TorBox)",
			default: "checked",
		},
		{
			key: "maxResults",
			type: "select",
			title: "Máximo de resultados por título",
			options: ["4", "6", "8", "10", "12"],
			default: "8",
		},
		{
			key: "srcTorrentio",
			type: "checkbox",
			title: "Fuente: Torrentio (⚠️ bloqueado desde el servidor, usar solo si funciona)",
			default: "unchecked",
		},
		{
			key: "srcEztv",
			type: "checkbox",
			title: "Fuente: EZTV (⚠️ bloqueado desde el servidor)",
			default: "unchecked",
		},
		{
			key: "srcGrantorrent",
			type: "checkbox",
			title: "Fuente: GranTorrent (torrents latino — pelis y series)",
			default: "checked",
		},
		{
			key: "srcElitetorrent",
			type: "checkbox",
			title: "Fuente: EliteTorrent (torrents latino — pelis y series)",
			default: "checked",
		},
		{
			key: "srcMitorrent",
			type: "checkbox",
			title: "Fuente: MiTorrent (torrents latino — pelis y series)",
			default: "checked",
		},
		{
			key: "srcHacktorrent",
			type: "checkbox",
			title: "Fuente: HackTorrent (torrents latino — pelis y series)",
			default: "checked",
		},
		{
			key: "extraSources",
			type: "text",
			title: "Addons extra (URLs de manifest, una por línea) — ej. tu MediaFusion o Comet configurado",
			required: false,
		},
		{
			key: "torznabUrl",
			type: "text",
			title: "URL Torznab (Prowlarr/Jackett) — cientos de indexadores, incluyendo en español",
			required: false,
		},
		{
			key: "torznabKey",
			type: "password",
			title: "API Key de Prowlarr/Jackett",
			required: false,
		},
	],
};

// ---------------------------------------------------------------------------
// Caché en memoria con TTL + LRU acotada + single-flight + stale fallback
// (adaptado del patrón de xTremio v2.0.0)
// ---------------------------------------------------------------------------
const _cache = new Map();
const _inflight = new Map(); // single-flight: key -> Promise en curso
const CACHE_MAX = 5000;
const STALE_MS = 6 * 60 * 60 * 1000; // 6h: cuánto se conserva una entrada vencida como respaldo

function cacheGet(key, { allowStale = false } = {}) {
	const e = _cache.get(key);
	if (!e) return null;
	if (Date.now() <= e.exp) {
		// LRU: mover al final (más reciente)
		_cache.delete(key);
		_cache.set(key, e);
		return { val: e.val, stale: false };
	}
	// Vencida: ¿servir como respaldo?
	if (allowStale && Date.now() <= e.exp + STALE_MS) {
		return { val: e.val, stale: true };
	}
	_cache.delete(key);
	return null;
}
function cacheSet(key, val, ttlMs) {
	if (_cache.has(key)) _cache.delete(key);
	else if (_cache.size >= CACHE_MAX) _cache.delete(_cache.keys().next().value); // LRU: saca la más vieja
	_cache.set(key, { val, exp: Date.now() + ttlMs });
}
// Single-flight: si ya hay una petición en curso para esta key, espera su
// resultado en vez de lanzar otra (evita martillear las fuentes).
function withSingleFlight(key, fn) {
	if (_inflight.has(key)) return _inflight.get(key);
	const p = (async () => {
		try {
			return await fn();
		} finally {
			_inflight.delete(key);
		}
	})();
	_inflight.set(key, p);
	return p;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Orquestación v2 (solo orquestación; los scrapers no se tocan):
// - Deadline global al recolectar fuentes: las lentas no arrastran el total.
// - Respuestas parciales: se devuelve lo que haya llegado al cumplirse el deadline.
// - Caché corta (5 min) de la respuesta final: reintentos de Nuvio al instante.
// - Timeouts en llamadas TorBox: ninguna puede colgarse eternamente.
// ---------------------------------------------------------------------------
const GATHER_DEADLINE_MS = 9000;   // recolectar fuentes torrent
const RESOLVE_DEADLINE_MS = 4000;  // resolución vía TorBox
const STREAM_CACHE_TTL_MS = 5 * 60 * 1000; // caché corta de la respuesta final
const TORBOX_TIMEOUT_MS = 10000;   // timeout por llamada a la API de TorBox

// Latencia reciente por fuente (media móvil): detecta las lentas crónicas.
const _srcLat = new Map(); // name -> { avg, n }
function recordLatency(name, ms) {
	const e = _srcLat.get(name) || { avg: ms, n: 0 };
	e.n += 1;
	e.avg = e.avg * 0.7 + ms * 0.3;
	_srcLat.set(name, e);
	if (e.n >= 3 && e.avg > GATHER_DEADLINE_MS * 0.75) {
		console.warn(`Fuente lenta: ${name} promedia ${Math.round(e.avg)}ms en ${e.n} consultas`);
	}
}

function shortHash(s) {
	let h = 0;
	const str = String(s || "");
	for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) | 0;
	return (h >>> 0).toString(36);
}

// ---------------------------------------------------------------------------
// Detección de latino + parseo de calidad/seeders
// ---------------------------------------------------------------------------
const LATINO_RE = /latin[oa]|espa[ñn]ol[\s._-]*latin|audio[\s._-]*latin|\[lat\]|\(lat\)|\slat\s|\blat\b|latinoam[eé]rica|dual[\s._-]*lat\b/i;
// 🇪🇸 es castellano (España), NO latino: solo las banderas latinoamericanas cuentan
function hasLatinoFlag(text) {
	if (!/🇲🇽|🇦🇷|🇨🇴|🇨🇱|🇵🇪|🇻🇪|🇺🇾|🇪🇨/.test(text)) return false;
	// Contar banderas de países; si hay 3+, es multi-idioma (subtítulos), no doblaje latino
	const flags = (text.match(/🇬🇧|🇮🇹|🇵🇹|🇫🇷|🇩🇪|🇳🇱|🇪🇸|🇲🇽|🇦🇷|🇨🇴|🇨🇱|🇵🇪|🇻🇪|🇺🇾|🇪🇨/g) || []).length;
	if (flags >= 3) return false;
	return true;
}
const DUAL_RE = /\bdual\b/i;
const SPAIN_RE = /castellano|espa[ñn]a|\[esp\]|\(esp\)|spanish\s*\(spain\)/i;
// Rechazo explícito: portugués, castellano y solo-subtítulos nunca son latino
const REJECT_RE = /portugu[eê]s|\bpt[\s._-]?br\b|\bdublad[oa]\b|\blegendad[oa]\b|🇧🇷|\bbrazilian\b|castellano|espa[ñn]a|\[esp\]|\(esp\)|spanish|\bsubtitulad[oa]\b|\bvose\b/i;
// Etiqueta genérica "español": probablemente latino si no hay marca de rechazo
const ESPANOL_RE = /espa[ñn]ol/i;

// Clasificación: 0 = latino confirmado (latino, español latino, [LAT], 🇲🇽...), 1 = probablemente latino (dual, español), 2 = descartar
function classifyTier(text) {
	if (LATINO_RE.test(text) || hasLatinoFlag(text)) return 0;
	if (/🇪🇸|🇵🇹|🇧🇷/.test(text)) return 2; // bandera España/Portugal/Brasil sin marca latina
	if (REJECT_RE.test(text)) return 2;
	if (DUAL_RE.test(text) && !SPAIN_RE.test(text)) return 1;
	if (ESPANOL_RE.test(text)) return 1;
	return 2;
}
const SEEDERS_RE = /👤\s*([\d.,]+)/;
const SIZE_RE = /💾\s*([\d.]+\s*[KMGT]B)/i;

function parseQuality(text) {
	if (/2160p|\b4k\b/i.test(text)) return { label: "2160p", score: 4 };
	if (/1080p/i.test(text)) return { label: "1080p", score: 3 };
	if (/720p/i.test(text)) return { label: "720p", score: 2 };
	if (/480p/i.test(text)) return { label: "480p", score: 1 };
	return { label: "SD", score: 0 };
}

function parseTorrentioStream(raw) {
	if (!raw || !raw.infoHash) return null;
	const filename = (raw.behaviorHints && raw.behaviorHints.filename) || "";
	const text = `${raw.name || ""}\n${raw.title || ""}\n${filename}`;
	const lower = text.toLowerCase();

	// tier: 0 = latino confirmado, 1 = dual (probablemente latino), 2 = descartar
	const tier = classifyTier(text);
	if (tier === 2) return null;

	const q = parseQuality(text);
	const seedersM = text.match(SEEDERS_RE);
	const sizeM = text.match(SIZE_RE);
	const releaseName = (raw.title || "").split("\n")[0].slice(0, 120) || filename.slice(0, 120);

	return {
		infoHash: raw.infoHash.toLowerCase(),
		tier,
		quality: q.label,
		qualityScore: q.score,
		seeders: seedersM ? parseInt(seedersM[1].replace(/[.,]/g, ""), 10) || 0 : 0,
		size: sizeM ? sizeM[1] : "?",
		releaseName,
		filename,
		rawTitle: raw.title || "",
	};
}

function rankStreams(a, b) {
	return (
		a.tier - b.tier ||
		b.qualityScore - a.qualityScore ||
		b.seeders - a.seeders
	);
}

// ---------------------------------------------------------------------------
// Fuentes de streams (todo-en-uno con fallbacks)
// Cada fuente devuelve streams en el formato común de parseTorrentioStream.
// Si una fuente falla o tarda, las demás igual responden.
// ---------------------------------------------------------------------------
const SOURCE_TIMEOUT_MS = 6000;

async function fetchWithTimeout(url, ms, options = {}) {
	const ctrl = new AbortController();
	const t = setTimeout(() => ctrl.abort(), ms);
	try {
		const res = await fetch(url, { ...options, signal: ctrl.signal });
		return res;
	} finally {
		clearTimeout(t);
	}
}

function formatBytes(b) {
	const n = parseInt(b, 10);
	if (!n) return "?";
	if (n >= 1e9) return (n / 1e9).toFixed(2) + " GB";
	if (n >= 1e6) return (n / 1e6).toFixed(0) + " MB";
	return Math.round(n / 1e3) + " KB";
}

// --- Fuente 1: Torrentio (agregador principal) ---
async function fetchTorrentio(type, id) {
	const cacheKey = `src:torrentio:${type}:${id}`;
	const hit = cacheGet(cacheKey);
	if (hit) return hit.val;

	const url = `${TORRENTIO_BASE}/stream/${type}/${encodeURIComponent(id)}.json`;
	const res = await fetchWithTimeout(url, SOURCE_TIMEOUT_MS, {
		headers: { "User-Agent": UA },
	});
	if (!res.ok) throw new Error(`Torrentio respondió ${res.status}`);
	const json = await res.json();

	const parsed = (json.streams || [])
		.map((s) => ({ ...parseTorrentioStream(s), source: "Torrentio" }))
		.filter((s) => s && s.infoHash);
	cacheSet(cacheKey, parsed, 60 * 60 * 1000);
	return parsed;
}

// --- Fuente 2: EZTV (respaldo directo para series) ---
async function fetchEZTV(type, id, season, episode) {
	if (type !== "series" || season == null) return [];
	const cacheKey = `src:eztv:${id}:${season}:${episode}`;
	const hit = cacheGet(cacheKey);
	if (hit) return hit.val;

	const imdb = String(id).split(":")[0].replace(/^tt/, "");
	const url = `https://eztv.re/api/get-torrents?imdb_id=${imdb}&limit=100`;
	const res = await fetchWithTimeout(url, SOURCE_TIMEOUT_MS, {
		headers: { "User-Agent": UA },
		redirect: "follow",
	});
	if (!res.ok) throw new Error(`EZTV respondió ${res.status}`);
	const json = await res.json();

	const parsed = (json.torrents || [])
		.filter(
			(t) =>
				parseInt(t.season, 10) === season &&
				(episode == null || parseInt(t.episode, 10) === episode)
		)
		.map((t) => {
			const text = `${t.filename || ""} ${t.title || ""}`;
			const q = parseQuality(text);
			const releaseName = (t.filename || t.title || "").slice(0, 120);
			const tier = classifyTier(text);
			if (tier === 2 || !t.hash) return null;
			return {
				infoHash: String(t.hash).toLowerCase(),
				tier,
				quality: q.label,
				qualityScore: q.score,
				seeders: parseInt(t.seeds, 10) || 0,
				size: formatBytes(t.size_bytes),
				releaseName,
				filename: t.filename || "",
				rawTitle: t.title || "",
				source: "EZTV",
			};
		})
		.filter(Boolean);
	cacheSet(cacheKey, parsed, 60 * 60 * 1000);
	return parsed;
}

// --- Fuente: GranTorrent (torrents latino — pelis y series; scrapers estilo Alfa/Kodi) ---
const GT_MIRRORS = ["https://grantorrent.zip", "https://grantorrent.foo", "https://grantorrent.net"];
const GT_TIMEOUT_MS = 6000;

// Resuelve el título vía Cinemeta (GranTorrent busca por texto, no por IMDb ID)
async function fetchTitle(type, id) {
	const imdb = String(id).split(":")[0];
	const cacheKey = `title:${type}:${imdb}`;
	const hit = cacheGet(cacheKey);
	if (hit) return hit.val;
	try {
		const res = await fetchWithTimeout(`https://v3-cinemeta.strem.io/meta/${type}/${imdb}.json`, 8000, {
			headers: { "User-Agent": UA },
		});
		if (!res.ok) return null;
		const json = await res.json();
		const name = json && json.meta && json.meta.name ? String(json.meta.name) : null;
		if (name) cacheSet(cacheKey, name, 24 * 3600 * 1000);
		return name;
	} catch {
		return null;
	}
}

// Parser bencode mínimo: extrae el dict "info" con su rango exacto de bytes
function bdecodeRaw(buf, pos) {
	const c = buf[pos];
	if (c === 0x69) {
		// entero: i<num>e
		const e = buf.indexOf(0x65, pos);
		if (e < 0) throw new Error("bencode inválido");
		return { value: parseInt(buf.toString("ascii", pos + 1, e), 10), next: e + 1, start: pos, end: e + 1 };
	}
	if (c === 0x6c || c === 0x64) {
		// lista / diccionario
		const isDict = c === 0x64;
		let p = pos + 1;
		const out = isDict ? {} : [];
		let infoRange = null;
		while (p < buf.length && buf[p] !== 0x65) {
			const k = bdecodeRaw(buf, p);
			p = k.next;
			const v = bdecodeRaw(buf, p);
			p = v.next;
			if (isDict) {
				const ks = k.value.toString("utf8");
				out[ks] = v.value;
				if (ks === "info") infoRange = [v.start, v.end];
			} else {
				out.push(v.value);
			}
		}
		const r = { value: out, next: p + 1, start: pos, end: p + 1 };
		if (infoRange) r.infoRange = infoRange;
		return r;
	}
	// string: <len>:<bytes>
	const colon = buf.indexOf(0x3a, pos);
	if (colon < 0) throw new Error("bencode inválido");
	const len = parseInt(buf.toString("ascii", pos, colon), 10);
	if (!Number.isFinite(len) || len < 0 || pos + len > buf.length) throw new Error("bencode inválido");
	const s = colon + 1;
	return { value: buf.slice(s, s + len), next: s + len, start: pos, end: s + len };
}

function infoHashFromTorrent(buf) {
	if (!buf || buf.length < 50 || buf[0] !== 0x64) return null;
	try {
		const root = bdecodeRaw(buf, 0);
		if (!root || !root.infoRange) return null;
		const [s, e] = root.infoRange;
		return crypto.createHash("sha1").update(buf.slice(s, e)).digest("hex");
	} catch {
		return null;
	}
}

function magnetInfoHash(magnet) {
	const m = /btih:([a-zA-Z0-9]+)/i.exec(magnet || "");
	if (!m) return null;
	const h = m[1];
	if (/^[a-fA-F0-9]{40}$/.test(h)) return h.toLowerCase();
	if (/^[a-zA-Z2-7]{32}$/.test(h)) {
		const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
		let bits = "";
		for (const ch of h.toUpperCase()) {
			const v = alphabet.indexOf(ch);
			if (v < 0) return null;
			bits += v.toString(2).padStart(5, "0");
		}
		let hex = "";
		for (let i = 0; i + 8 <= bits.length; i += 8) {
			hex += parseInt(bits.slice(i, i + 8), 2).toString(16).padStart(2, "0");
		}
		if (hex.length === 40) return hex;
	}
	return null;
}

function normTitle(s) {
	return String(s || "")
		.toLowerCase()
		.normalize("NFD")
		.replace(/[\u0300-\u036f]/g, "")
		.replace(/[^a-z0-9]+/g, " ")
		.trim();
}

async function fetchGranTorrent(type, id, season, episode) {
	const cacheKey = `src:grantorrent:${type}:${id}`;
	const hit = cacheGet(cacheKey);
	if (hit) return hit.val;
	try {
		const title = await fetchTitle(type, id);
		if (!title) return [];
		const section = type === "series" ? "series_p" : "peliculas";
		const q = encodeURIComponent(title);

		// 1. Buscar en los espejos (fallback automático)
		let html = null;
		let mirrorHost = null;
		for (const m of GT_MIRRORS) {
			try {
				const res = await fetchWithTimeout(`${m}/${section}/?query=${q}`, GT_TIMEOUT_MS, {
					headers: { "User-Agent": UA },
				});
				if (res.ok) {
					html = await res.text();
					mirrorHost = new URL(m).hostname;
					break;
				}
			} catch {
				// probar siguiente espejo
			}
		}
		if (!html) return [];

		// 2. Tarjetas de resultados (estructura documentada por el canal Alfa)
		const $ = cheerio.load(html);
		const cards = [];
		$("div.movie-list div.relative").each((_, el) => {
			const a = $(el).find("a").first();
			const href = a.attr("href");
			const name = $(el).find("p").first().text().trim();
			if (href && name) cards.push({ url: new URL(href, `https://${mirrorHost}`).href, name });
		});

		const nt = normTitle(title);
		const matched = cards
			.filter((c) => {
				const nn = normTitle(c.name);
				if (!nn.includes(nt) && !nt.includes(nn)) return false;
				if (type === "series" && season != null) {
					const sm = /temporada\s+(\d+)/i.exec(c.name);
					if (sm && parseInt(sm[1], 10) !== season) return false;
				}
				return true;
			})
			.slice(0, 3);
		if (!matched.length) {
			cacheSet(cacheKey, [], 30 * 60 * 1000);
			return [];
		}

		// 3. Páginas de detalle → filas con enlaces torrent
		const detailPages = (
			await Promise.all(
				matched.map(async (c) => {
					try {
						const res = await fetchWithTimeout(c.url, GT_TIMEOUT_MS, {
							headers: { "User-Agent": UA },
						});
						if (!res.ok) return null;
						return { card: c, html: await res.text() };
					} catch {
						return null;
					}
				})
			)
		).filter(Boolean);

		const rows = [];
		for (const d of detailPages) {
			const $$ = cheerio.load(d.html);
			$$("tr").each((_, tr) => {
				const link = $$(tr).find("a.linktorrent").first();
				if (!link.length) return;
				const dataSrc = link.attr("data-src") || "";
				let torrentUrl = null;
				if (dataSrc) {
					try {
						torrentUrl = Buffer.from(dataSrc, "base64").toString("utf8").trim();
					} catch {
						// ignorar
					}
				}
				const href = link.attr("href") || "";
				const magnet = href.startsWith("magnet:") ? href : null;
				if (!torrentUrl && !magnet) return;
				const flagImg = $$(tr).find("td img").first();
				const flag = `${flagImg.attr("alt") || ""} ${flagImg.attr("title") || ""} ${flagImg.attr("src") || ""}`;
				const rowText = $$(tr).text().replace(/\s+/g, " ").trim();
				// Para series: solo filas de la temporada pedida (packs "Temporada N Completa" valen)
				if (type === "series" && season != null) {
					const sm = /temporada\s+(\d+)/i.exec(`${d.card.name} ${rowText}`);
					if (sm && parseInt(sm[1], 10) !== season) return;
				}
				rows.push({ torrentUrl, magnet, flag, rowText, cardName: d.card.name });
			});
		}

		// 4. Resolver infoHash de cada fila (magnet directo o descarga del .torrent)
		const streams = [];
		await Promise.all(
			rows.slice(0, 8).map(async (r) => {
				let infoHash = r.magnet ? magnetInfoHash(r.magnet) : null;
				if (!infoHash && r.torrentUrl) {
					const candidates = [r.torrentUrl];
					try {
						const u = new URL(r.torrentUrl);
						// reescribir al host de torrents del espejo activo (estilo Alfa: files.{espejo})
						candidates.push(`https://files.${mirrorHost}${u.pathname}`);
					} catch {
						// ignorar
					}
					for (const cand of candidates) {
						try {
							const res = await fetchWithTimeout(cand, GT_TIMEOUT_MS, {
								headers: { "User-Agent": UA },
							});
							if (!res.ok) continue;
							const buf = Buffer.from(await res.arrayBuffer());
							infoHash = infoHashFromTorrent(buf);
							if (infoHash) break;
						} catch {
							// siguiente candidato
						}
					}
				}
				if (!infoHash) return;
				const text = `${r.cardName}\n${r.rowText}\n${r.flag}`;
				const tier = classifyTier(text);
				if (tier === 2) return;
				const ql = parseQuality(text);
				streams.push({
					infoHash: infoHash.toLowerCase(),
					tier,
					quality: ql.label,
					qualityScore: ql.score,
					seeders: 0,
					size: "?",
					releaseName: `${r.cardName} — ${r.rowText}`.slice(0, 120),
					filename: "",
					rawTitle: text,
					source: "GranTorrent",
				});
			})
		);

		streams.sort(rankStreams);
		cacheSet(cacheKey, streams, 30 * 60 * 1000);
		return streams;
	} catch (e) {
		console.warn("GranTorrent falló:", e.message);
		return [];
	}
}

// --- Fuente 3+: addons extra definidos por el usuario (ej. su MediaFusion/Comet) ---
function parseExtraSourceUrls(raw) {
	if (!raw) return [];
	return String(raw)
		.split(/[\n,;]+/)
		.map((u) => u.trim().replace(/^stremio:\/\//, "https://"))
		.filter((u) => /^https?:\/\//i.test(u))
		.map((u) => u.replace(/\/manifest\.json\/?$/i, "").replace(/\/$/, ""))
		.filter((u, i, arr) => arr.indexOf(u) === i)
		.slice(0, 5); // máximo 5 para no demorar
}

async function fetchCustomSource(origin, type, id) {
	const cacheKey = `src:custom:${origin}:${type}:${id}`;
	const hit = cacheGet(cacheKey);
	if (hit) return hit.val;

	const url = `${origin}/stream/${type}/${encodeURIComponent(id)}.json`;
	const res = await fetchWithTimeout(url, SOURCE_TIMEOUT_MS, {
		headers: { "User-Agent": UA },
	});
	if (!res.ok) throw new Error(`Fuente extra respondió ${res.status}`);
	const json = await res.json();
	const label = origin.replace(/^https?:\/\//, "").split("/")[0];

	const parsed = (json.streams || [])
		.map((s) => ({ ...parseTorrentioStream(s), source: `Extra (${label})` }))
		.filter((s) => s && s.infoHash);
	cacheSet(cacheKey, parsed, 60 * 60 * 1000);
	return parsed;
}

// --- Fuente 4: Torznab (Prowlarr/Jackett) — cientos de indexadores, incl. en español ---
const xmlParser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@" });

function torznabAttrs(item) {
	const attrs = {};
	const raw = item["torznab:attr"];
	if (!raw) return attrs;
	for (const a of Array.isArray(raw) ? raw : [raw]) {
		if (a && a["@name"]) attrs[a["@name"]] = a["@value"];
	}
	return attrs;
}

async function fetchTorznab(torznabUrl, torznabKey, type, id, season, episode) {
	if (!torznabUrl) return [];
	const cacheKey = `src:torznab:${type}:${id}`;
	const hit = cacheGet(cacheKey);
	if (hit) return hit.val;

	const imdb = String(id).split(":")[0].replace(/^tt/, "");
	const base = torznabUrl.replace(/\/$/, "");
	const params =
		type === "series"
			? `t=tvsearch&imdbid=${imdb}${season != null ? `&season=${season}` : ""}${episode != null ? `&ep=${episode}` : ""}`
			: `t=movie&imdbid=${imdb}`;
	const url = `${base}?${params}&apikey=${encodeURIComponent(torznabKey || "")}`;

	const res = await fetchWithTimeout(url, 20000, { headers: { "User-Agent": UA } });
	if (!res.ok) throw new Error(`Torznab respondió ${res.status}`);
	const xml = await res.text();
	const doc = xmlParser.parse(xml);
	const channel = (doc && doc.rss && doc.rss.channel) || {};
	let items = channel.item || [];
	if (!Array.isArray(items)) items = [items];

	const parsed = items
		.map((item) => {
			if (!item) return null;
			const attrs = torznabAttrs(item);
			const title = String(item.title || "");
			const enclosure = item.enclosure || {};
			const encUrl = String(enclosure["@url"] || attrs.magneturl || "");
			let infoHash = String(attrs.infohash || "").toLowerCase();
			if (!infoHash) {
				const m = encUrl.match(/btih:([a-f0-9]{40})/i);
				if (m) infoHash = m[1].toLowerCase();
			}
			if (!infoHash) return null;

			const q = parseQuality(title);
			const tier = classifyTier(title);
			if (tier === 2) return null;

			return {
				infoHash,
				tier,
				quality: q.label,
				qualityScore: q.score,
				seeders: parseInt(attrs.seeders, 10) || 0,
				size: formatBytes(attrs.size),
				releaseName: title.slice(0, 120),
				filename: "",
				rawTitle: title,
				source: "Torznab",
			};
		})
		.filter(Boolean);
	cacheSet(cacheKey, parsed, 60 * 60 * 1000);
	return parsed;
}

// Orquesta todas las fuentes en paralelo, con fallback automático
async function fetchAllSources(type, id, { season, episode, config }) {
	const cacheKey = `all:${type}:${id}:${config.srcTorrentio ? 1 : 0}${config.srcEztv ? 1 : 0}${config.srcGrantorrent ? 1 : 0}${config.srcElitetorrent ? 1 : 0}${config.srcMitorrent ? 1 : 0}${config.srcHacktorrent ? 1 : 0}:${shortHash(config.extraSources)}:${shortHash(config.torznabUrl)}`;
	const hit = cacheGet(cacheKey);
	if (hit) return hit.val;

	// Single-flight: peticiones paralelas idénticas comparten una sola ejecución
	return withSingleFlight("sf:" + cacheKey, async () => {
		// Doble chequeo tras entrar al single-flight (otra petición pudo poblar el caché)
		const hit2 = cacheGet(cacheKey);
		if (hit2) return hit2.val;
		try {
			return await _fetchAllSourcesInner(type, id, { season, episode, config, cacheKey });
		} catch (e) {
			// Stale fallback: si todo falla, servir copia vencida antes que vacío
			const stale = cacheGet(cacheKey, { allowStale: true });
			if (stale) {
				console.warn("Sirviendo caché vencido para", cacheKey.slice(0, 40));
				return stale.val;
			}
			throw e;
		}
	});
}

async function _fetchAllSourcesInner(type, id, { season, episode, config, cacheKey }) {

	const jobs = [];
	const addJob = (name, promise) => {
		jobs.push({
			name,
			promise: promise.catch((e) => {
				console.warn(`${name} falló:`, e.message);
				return [];
			}),
		});
	};
	if (config.srcTorrentio !== false) addJob("torrentio", fetchTorrentio(type, id));
	if (config.srcEztv !== false) addJob("eztv", fetchEZTV(type, id, season, episode));
	if (config.srcGrantorrent !== false) addJob("grantorrent", fetchGranTorrent(type, id, season, episode));
	for (const [cfgKey, srcId] of [
		["srcElitetorrent", "elitetorrent"],
		["srcMitorrent", "mitorrent"],
		["srcHacktorrent", "hacktorrent"],
	]) {
		if (config[cfgKey] !== false) {
			addJob(srcId, fetchAlfaTorrentSource(srcId, type, id, season, episode));
		}
	}
	for (const origin of parseExtraSourceUrls(config.extraSources)) {
		addJob("extra:" + origin, fetchCustomSource(origin, type, id));
	}
	if (config.torznabUrl) {
		addJob("torznab", fetchTorznab(config.torznabUrl, config.torznabKey, type, id, season, episode));
	}

	// Recolectar a medida que cada fuente responde, con deadline global.
	// Las fuentes lentas NO arrastran el tiempo total: se descartan para esta
	// petición, pero sus promesas siguen en segundo plano calentando su
	// propia caché para la próxima vez.
	const seen = new Set();
	const merged = [];
	const t0 = Date.now();
	const pending = new Map(jobs.map((j, i) => [i, j]));
	while (pending.size > 0) {
		const remain = GATHER_DEADLINE_MS - (Date.now() - t0);
		if (remain <= 0) break;
		const settled = await Promise.race([
			...[...pending.entries()].map(([i, j]) =>
				j.promise.then((list) => ({ i, name: j.name, list, ms: Date.now() - t0 }))
			),
			sleep(remain).then(() => null), // deadline: no esperar más
		]);
		if (settled === null) break; // se acabó el tiempo: devolver parciales
		pending.delete(settled.i);
		recordLatency(settled.name, settled.ms);
		for (const s of settled.list || []) {
			if (!s || seen.has(s.infoHash)) continue;
			seen.add(s.infoHash);
			merged.push(s);
		}
	}
	if (pending.size > 0) {
		console.warn(
			`Deadline ${GATHER_DEADLINE_MS}ms: ${[...pending.values()].map((j) => j.name).join(", ")} no respondieron a tiempo`
		);
	}

	// Filtrar solo latino y ordenar
	const latino = merged.filter((s) => s.tier < 2).sort(rankStreams);
	cacheSet(cacheKey, latino, 30 * 60 * 1000);
	return latino;
}

// ---------------------------------------------------------------------------
// TorBox
// ---------------------------------------------------------------------------
async function torboxCall(key, path, { method = "GET", body = null, form = null } = {}) {
	const headers = { Authorization: `Bearer ${key}`, "User-Agent": UA };
	let payload = null;
	if (form) {
		payload = form; // FormData: fetch pone el content-type solo
	} else if (body) {
		headers["Content-Type"] = "application/json";
		payload = JSON.stringify(body);
	}
	const res = await fetch(TORBOX_API + path, {
		method,
		headers,
		body: payload,
		signal: AbortSignal.timeout(TORBOX_TIMEOUT_MS),
	});
	const json = await res.json().catch(() => ({}));
	if (!res.ok || json.success === false) {
		const err = new Error(json.error || json.detail || `TorBox HTTP ${res.status}`);
		err.status = res.status;
		throw err;
	}
	return json.data;
}

async function verifyTorboxKey(key) {
	const cacheKey = `tbkey:${key.slice(0, 12)}`;
	const hit = cacheGet(cacheKey);
	if (hit !== null) return hit.val;
	try {
		await torboxCall(key, "/user/me");
		cacheSet(cacheKey, true, 60 * 60 * 1000);
		return true;
	} catch (e) {
		console.warn("TorBox key inválida:", e.message);
		cacheSet(cacheKey, false, 10 * 60 * 1000);
		return false;
	}
}

async function checkCached(key, hashes) {
	const uniq = [...new Set(hashes)].slice(0, 100);
	if (!uniq.length) return {};
	const cacheKey = `cached:${shortHash(uniq.sort().join(","))}`;
	const hit = cacheGet(cacheKey);
	if (hit) return hit.val;

	// GET con query params (equivalente documentado a instantAvailability)
	const qs = new URLSearchParams({
		hash: uniq.join(","),
		format: "object",
		list_files: "false",
	});
	const data = await torboxCall(key, `/torrents/checkcached?${qs.toString()}`);

	const out = {};
	for (const h of uniq) {
		const v = data && (data[h] || data[h.toLowerCase()]);
		out[h] = !!(v && v !== false);
	}
	cacheSet(cacheKey, out, 30 * 60 * 1000);
	return out;
}

const VIDEO_EXT = /\.(mkv|mp4|avi|m4v|ts|mov|wmv|webm|m2ts)$/i;
function pickFile(files, { isSeries, season, episode, hintFilename }) {
	if (!files || !files.length) return null;
	const videos = files.filter(
		(f) => VIDEO_EXT.test(f.name || "") && !/sample/i.test(f.name || "")
	);
	const pool = videos.length ? videos : files;

	if (hintFilename) {
		const m = pool.find(
			(f) => f.name === hintFilename || (f.name || "").endsWith("/" + hintFilename)
		);
		if (m) return m;
	}
	if (isSeries && season != null && episode != null) {
		const patterns = [
			new RegExp(`s0*${season}e0*${episode}(?![0-9])`, "i"),
			new RegExp(`[^0-9]${season}x0*${episode}(?![0-9])`, "i"),
		];
		for (const p of patterns) {
			const m = pool.find((f) => p.test(f.name || ""));
			if (m) return m;
		}
	}
	return [...pool].sort((a, b) => (b.size || 0) - (a.size || 0))[0];
}

async function resolveViaTorbox(key, stream, { isSeries, season, episode }) {
	const cacheKey = `resolved:${stream.infoHash}:${isSeries ? `${season}x${episode}` : "movie"}`;
	const hit = cacheGet(cacheKey);
	if (hit) return hit.val;

	// 1. agregar el magnet a TorBox (si ya está cacheado es casi instantáneo)
	const form = new FormData();
	form.append("magnet", `magnet:?xt=urn:btih:${stream.infoHash}`);
	let created;
	try {
		created = await torboxCall(key, "/torrents/createtorrent", { method: "POST", form });
	} catch (e) {
		console.warn("createtorrent falló:", e.message);
		return null;
	}
	const torrentId = created && created.torrent_id;
	if (!torrentId) return null;

	// 2. obtener la lista de archivos
	let files = [];
	try {
		const list = await torboxCall(key, `/torrents/mylist?id=${torrentId}`);
		const arr = Array.isArray(list) ? list : [list];
		const entry =
			arr.find((t) => String(t.id) === String(torrentId)) || arr[0];
		files = (entry && entry.files) || [];
	} catch (e) {
		console.warn("mylist falló:", e.message);
		return null;
	}

	const file = pickFile(files, {
		isSeries,
		season,
		episode,
		hintFilename: stream.filename,
	});
	if (!file || file.id == null) return null;

	// 3. generar el link de descarga (con reintentos por si aún indexa)
	let dlUrl = null;
	for (let attempt = 0; attempt < 3 && !dlUrl; attempt++) {
		try {
			const data = await torboxCall(
				key,
				`/torrents/requestdl?token=${encodeURIComponent(key)}&torrent_id=${torrentId}&file_id=${file.id}`
			);
			if (typeof data === "string" && data.startsWith("http")) dlUrl = data;
		} catch (e) {
			await sleep(2000);
		}
	}
	if (dlUrl) cacheSet(cacheKey, dlUrl, 6 * 60 * 60 * 1000); // 6h: requestdl tiene presupuesto limitado
	return dlUrl;
}

// paralelismo limitado
async function mapLimit(items, limit, fn) {
	const results = new Array(items.length);
	let i = 0;
	async function worker() {
		while (i < items.length) {
			const idx = i++;
			try {
				results[idx] = await fn(items[idx], idx);
			} catch (e) {
				results[idx] = null;
			}
		}
	}
	await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
	return results;
}

// mapLimit con deadline: si se acaba el tiempo devuelve los resultados
// parciales completados hasta el momento. Las tareas en curso siguen en
// segundo plano y calientan sus cachés.
async function mapLimitDeadline(items, limit, ms, fn) {
	const results = new Array(items.length).fill(null);
	let i = 0;
	let stopped = false;
	async function worker() {
		while (!stopped && i < items.length) {
			const idx = i++;
			try {
				results[idx] = await fn(items[idx], idx);
			} catch (e) {
				results[idx] = null;
			}
		}
	}
	const workers = Promise.all(
		Array.from({ length: Math.min(limit, items.length) }, worker)
	);
	await Promise.race([workers, sleep(ms).then(() => { stopped = true; })]);
	return results;
}

// ---------------------------------------------------------------------------
// Addon
// ---------------------------------------------------------------------------
const builder = new addonBuilder(manifest);

// Clave de la caché corta de respuesta final: todo lo que cambia la salida.
function streamCacheKey(type, id, config) {
	const c = config || {};
	const relevant = {
		t: type,
		id: String(id),
		tb: c.torboxKey ? shortHash(c.torboxKey) : "-",
		io: c.instantOnly !== false ? 1 : 0,
		mx: String(c.maxResults || "8"),
		src: ["srcTorrentio", "srcEztv", "srcGrantorrent", "srcElitetorrent", "srcMitorrent", "srcHacktorrent"]
			.map((k) => (c[k] === false ? 0 : 1)).join(""),
		ex: shortHash(c.extraSources || ""),
		tz: shortHash((c.torznabUrl || "").trim()),
	};
	return `stream:${type}:${String(id).slice(0, 64)}:${shortHash(JSON.stringify(relevant))}`;
}

builder.defineStreamHandler(async ({ type, id, config }) => {
	// Caché corta de la respuesta final: los reintentos de Nuvio y la
	// navegación atrás/adelante responden al instante (<1s).
	const skey = streamCacheKey(type, id, config);
	const hit = cacheGet(skey);
	if (hit) return hit.val;
	return withSingleFlight("sf:" + skey, async () => {
		const hit2 = cacheGet(skey);
		if (hit2) return hit2.val;
		const out = await _streamHandlerInner({ type, id, config });
		cacheSet(skey, out, STREAM_CACHE_TTL_MS);
		return out;
	});
});

async function _streamHandlerInner({ type, id, config }) {
	try {
		const { torboxKey = "", instantOnly = true, maxResults = "8" } = config || {};
		const max = Math.min(Math.max(parseInt(maxResults, 10) || 8, 1), 12);

		const parts = String(id).split(":");
		const season = parts[1] ? parseInt(parts[1], 10) : null;
		const episode = parts[2] ? parseInt(parts[2], 10) : null;
		const isSeries = type === "series";

		// 1. Fuentes latino desde todas las fuentes (todo-en-uno con fallbacks)
		// Torrents y HTTP en paralelo para máxima velocidad
		const [latino, httpStreams] = await Promise.all([
			fetchAllSources(type, id, {
				season,
				episode,
				config: {
					srcTorrentio: config.srcTorrentio !== false,
					srcEztv: config.srcEztv !== false,
					srcGrantorrent: config.srcGrantorrent !== false,
					srcElitetorrent: config.srcElitetorrent !== false,
					srcMitorrent: config.srcMitorrent !== false,
					srcHacktorrent: config.srcHacktorrent !== false,
					extraSources: config.extraSources || "",
					torznabUrl: (config.torznabUrl || "").trim(),
					torznabKey: config.torznabKey || "",
				},
			}),
			HTTP_SOURCES_ENABLED.length
				? withSingleFlight(`sf:http:${type}:${id}`, () =>
					fetchAllHttpSources(type, id, season, episode, HTTP_SOURCES_ENABLED).catch(() => [])
				)
				: Promise.resolve([]),
		]);

		// Convertir streams HTTP a formato Stremio (van directo, sin TorBox)
		const httpFormatted = (httpStreams || []).map((s) => ({
			url: s.url,
			name: `Latino ${s.quality} 🌐`,
			title: `${s.source}\n🇲🇽 LATINO • ${s.quality}${s.server ? ` • ⚙️ ${s.server}` : ""}\n🌐 Streaming directo`,
			behaviorHints: { bingeGroup: `latino|http|${s.quality}` },
		}));

		if (!latino.length && !httpFormatted.length) return { streams: [] };

		const torboxOk = torboxKey && (await verifyTorboxKey(torboxKey));

		// 2. Resolver con TorBox
		if (torboxOk) {
			const cached = await checkCached(
				torboxKey,
				latino.slice(0, 60).map((s) => s.infoHash)
			);
			const cachedOnes = latino.filter((s) => cached[s.infoHash]);
			const uncachedOnes = latino.filter((s) => !cached[s.infoHash]);
			const pool = instantOnly ? cachedOnes : [...cachedOnes, ...uncachedOnes];

			const resolved = await mapLimitDeadline(pool.slice(0, max), 4, RESOLVE_DEADLINE_MS, async (s) => {
				if (!cached[s.infoHash]) {
					// sin caché: devolver el magnet para el motor de Stremio
					return {
						infoHash: s.infoHash,
						name: `Latino ${s.quality} 🧲`,
						title: `${s.releaseName}\n🇲🇽 LATINO • ${s.quality} • 💾 ${s.size} • 👤 ${s.seeders} • ⚙️ ${s.source}\n🧲 Torrent directo (no está en caché de TorBox)`,
						behaviorHints: { bingeGroup: `latino|magnet|${s.quality}` },
					};
				}
				const url = await resolveViaTorbox(torboxKey, s, { isSeries, season, episode });
				if (!url) return null;
				return {
					url,
					name: `Latino ${s.quality} ⚡`,
					title: `${s.releaseName}\n🇲🇽 LATINO • ${s.quality} • 💾 ${s.size} • 👤 ${s.seeders} • ⚙️ ${s.source}\n⚡ Reproducción instantánea vía TorBox`,
					behaviorHints: { bingeGroup: `latino|torbox|${s.quality}` },
				};
			});

			const ok = resolved.filter(Boolean);
			// Combinar con streams HTTP directos (siempre disponibles, sin TorBox)
			const combined = [...httpFormatted.slice(0, max), ...ok];
			if (combined.length) return { streams: combined.slice(0, max) };
			// si TorBox falló en todo, caemos al modo magnet
		}

		// 3. Fallback: magnets latino directos (Stremio los reproduce nativamente)
		// + streams HTTP directos al inicio (no requieren torrent)
		const magnets = latino.slice(0, max).map((s) => ({
			infoHash: s.infoHash,
			name: `Latino ${s.quality} 🧲`,
			title: `${s.releaseName}\n🇲🇽 LATINO • ${s.quality} • 💾 ${s.size} • 👤 ${s.seeders} • ⚙️ ${s.source}\n🧲 Torrent directo${torboxKey ? "" : " — agrega tu TorBox API Key en la configuración para reproducción instantánea"}`,
			behaviorHints: { bingeGroup: `latino|magnet|${s.quality}` },
		}));
		return {
			streams: [...httpFormatted.slice(0, max), ...magnets].slice(0, max),
		};
	} catch (err) {
		console.error("stream handler error:", err.message);
		return { streams: [] };
	}
}

const addonInterface = builder.getInterface();

// ---------------------------------------------------------------------------
// Servidor HTTP
// ---------------------------------------------------------------------------
const app = express();

// Página de configuración auto-generada (formulario con la API key de TorBox)
app.get("/configure", (req, res) => {
	res.setHeader("content-type", "text/html; charset=utf-8");
	res.end(`<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Configurar Latino Streams ⚡</title>
<style>
*{box-sizing:border-box}body{font-family:system-ui,sans-serif;background:#0f1420;color:#e8ecf4;margin:0;padding:20px}
.card{max-width:620px;margin:0 auto;background:#182030;border-radius:16px;padding:28px;box-shadow:0 8px 40px rgba(0,0,0,.4)}
h1{margin:0 0 4px;font-size:1.5em}p.sub{color:#9aa4b8;margin:0 0 20px;font-size:.9em}
.field{margin-bottom:14px}.field label{display:block;font-weight:600;margin-bottom:6px;font-size:.92em}
.field input[type=text],.field input[type=password],.field select{width:100%;padding:10px 12px;border-radius:8px;border:1px solid #2a3448;background:#0b0f18;color:#e8ecf4;font-size:.95em}
.check{display:flex;align-items:center;gap:10px;padding:10px 12px;background:#0b0f18;border-radius:8px;margin-bottom:8px;cursor:pointer}
.check input{width:18px;height:18px;accent-color:#6c5ce7}
.check span{font-size:.92em}
.btn{display:block;width:100%;margin-top:18px;padding:14px;background:#6c5ce7;color:#fff;border:none;border-radius:10px;font-size:1em;font-weight:700;cursor:pointer}
.btn:hover{background:#5a4bd1}
#result{display:none;margin-top:20px;padding:16px;background:#0b0f18;border-radius:10px;border:1px solid #6c5ce7}
#result p{margin:0 0 10px;font-size:.9em;color:#9aa4b8}
#manifestUrl{width:100%;padding:10px;background:#182030;border:1px solid #2a3448;border-radius:8px;color:#7bed9f;font-family:monospace;font-size:.82em;word-break:break-all}
.copybtn{margin-top:10px;padding:10px 20px;background:#2a3448;color:#fff;border:none;border-radius:8px;cursor:pointer;font-weight:600}
.steps{margin-top:16px;font-size:.88em;color:#9aa4b8;line-height:1.7}
.steps b{color:#e8ecf4}
</style></head><body><div class="card">
<h1>Latino Streams ⚡</h1>
<p class="sub">Configura tus fuentes y obtén tu enlace de instalación para Nuvio / Stremio</p>
<form id="cfg">
<div class="field"><label>TorBox API Key (recomendado)</label><input type="password" id="torboxKey" placeholder="Pégala aquí (torbox.app → Settings → API)"></div>
<div class="check"><input type="checkbox" id="instantOnly" checked><span>Solo fuentes instantáneas (ya en caché de TorBox)</span></div>
<div class="field"><label>Máximo de resultados</label><select id="maxResults"><option>4</option><option>6</option><option selected>8</option><option>10</option><option>12</option></select></div>
<div class="check"><input type="checkbox" id="srcTorrentio"><span>Torrentio (⚠️ bloqueado desde servidor)</span></div>
<div class="check"><input type="checkbox" id="srcEztv"><span>EZTV (⚠️ bloqueado desde servidor)</span></div>
<div class="check"><input type="checkbox" id="srcGrantorrent" checked><span>GranTorrent (latino)</span></div>
<div class="check"><input type="checkbox" id="srcElitetorrent" checked><span>EliteTorrent (latino)</span></div>
<div class="check"><input type="checkbox" id="srcMitorrent" checked><span>MiTorrent (latino)</span></div>
<div class="check"><input type="checkbox" id="srcHacktorrent" checked><span>HackTorrent (latino)</span></div>
<div class="field"><label>Addons extra (opcional, una URL por línea)</label><input type="text" id="extraSources" placeholder="https://..."></div>
<div class="field"><label>URL Torznab Prowlarr/Jackett (opcional)</label><input type="text" id="torznabUrl" placeholder="https://..."></div>
<div class="field"><label>API Key Prowlarr/Jackett (opcional)</label><input type="password" id="torznabKey"></div>
<button type="submit" class="btn">Generar enlace de instalación</button>
</form>
<div id="result">
<p><b>Tu enlace personalizado:</b> cópialo y pégalo en Nuvio/Stremio → Addons → Añadir por URL</p>
<div id="manifestUrl"></div>
<button class="copybtn" onclick="copiar()">📋 Copiar enlace</button>
<div class="steps"><b>En Nuvio:</b> Addons → + → Pegar URL → Instalar<br><b>En Stremio:</b> Addons → Pegar en la barra de búsqueda → Install</div>
</div>
<script>
document.getElementById('cfg').addEventListener('submit', function(e){
  e.preventDefault();
  const cfg = {};
  const v = id => document.getElementById(id).value.trim();
  const c = id => document.getElementById(id).checked;
  if(v('torboxKey')) cfg.torboxKey = v('torboxKey');
  cfg.instantOnly = c('instantOnly');
  cfg.maxResults = v('maxResults');
  cfg.srcTorrentio = c('srcTorrentio');
  cfg.srcEztv = c('srcEztv');
  cfg.srcGrantorrent = c('srcGrantorrent');
  cfg.srcElitetorrent = c('srcElitetorrent');
  cfg.srcMitorrent = c('srcMitorrent');
  cfg.srcHacktorrent = c('srcHacktorrent');
  if(v('extraSources')) cfg.extraSources = v('extraSources');
  if(v('torznabUrl')) cfg.torznabUrl = v('torznabUrl');
  if(v('torznabKey')) cfg.torznabKey = v('torznabKey');
  const url = window.location.origin + '/' + encodeURIComponent(JSON.stringify(cfg)) + '/manifest.json';
  document.getElementById('manifestUrl').textContent = url;
  document.getElementById('result').style.display = 'block';
  document.getElementById('result').scrollIntoView({behavior:'smooth'});
});
function copiar(){
  const t = document.getElementById('manifestUrl').textContent;
  navigator.clipboard.writeText(t).then(()=>alert('¡Enlace copiado! Pégalo en Nuvio/Stremio.'));
}
</script>
</div></body></html>`);
});

// Landing sencilla
app.get("/", (req, res) => {
	res.setHeader("content-type", "text/html; charset=utf-8");
	res.end(`<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Latino Streams ⚡ — Stremio Addon</title>
<style>body{font-family:system-ui,sans-serif;background:#0f1420;color:#e8ecf4;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}
.card{max-width:560px;padding:32px;background:#182030;border-radius:16px;box-shadow:0 8px 40px rgba(0,0,0,.4)}
h1{margin:0 0 8px}.btn{display:inline-block;margin-top:16px;padding:12px 24px;background:#6c5ce7;color:#fff;border-radius:10px;text-decoration:none;font-weight:600}
code{background:#0b0f18;padding:2px 6px;border-radius:6px}</style></head>
<body><div class="card">
<h1>Latino Streams ⚡</h1>
<p>Addon de Stremio que encuentra las <b>mejores fuentes en español latino</b> y las reproduce al instante con tu cuenta de <b>TorBox</b>.</p>
<ol>
<li>Consigue tu API key en <code>torbox.app → Settings → API</code>.</li>
<li>Pulsa <b>Configurar</b>, pega tu key y guarda.</li>
<li>Instala el addon en Stremio y disfruta 🇲🇽.</li>
</ol>
<a class="btn" href="/configure">Configurar</a>
</div></body></html>`);
});

// Endpoint de diagnóstico: prueba cada fuente y reporta estado
app.get("/debug/sources", async (req, res) => {
	const results = {};
	const test = async (name, fn) => {
		const t0 = Date.now();
		try {
			const r = await fn();
			results[name] = { ok: true, count: Array.isArray(r) ? r.length : 0, ms: Date.now() - t0 };
		} catch (e) {
			results[name] = { ok: false, error: e.message.slice(0, 100), ms: Date.now() - t0 };
		}
	};
	// Probar con Deadpool 2 (tt5463162) que sabemos tiene contenido latino
	await test("elitetorrent", () => fetchAlfaTorrentSource("elitetorrent", "movie", "tt5463162", null, null));
	await test("hacktorrent", () => fetchAlfaTorrentSource("hacktorrent", "movie", "tt5463162", null, null));
	await test("torrentio", async () => {
		const r = await fetch(`${TORRENTIO_BASE}/stream/movie/tt5463162.json`, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(8000) });
		if (!r.ok) throw new Error(`HTTP ${r.status}`);
		const j = await r.json();
		return j.streams || [];
	});
	res.json({ timestamp: new Date().toISOString(), results });
});

// Rutas del protocolo Stremio (manifest, stream) — con soporte de config en la URL
app.use(getRouter(builder.getInterface()));

const PORT = process.env.PORT || 7000;
app.listen(PORT, () => {
	console.log(`Latino Streams escuchando en http://127.0.0.1:${PORT}/manifest.json`);
});
