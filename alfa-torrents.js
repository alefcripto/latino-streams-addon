// ---------------------------------------------------------------------------
// alfa-torrents.js — Fuentes torrent estilo Alfa (Kodi) para Latino Streams
//
// Adapta 5 canales torrent latinos del addon Alfa (open source, GPL):
//   - CineCalidad  (https://www.cinecalidad.vg) — PENDIENTE: el sitio migró a SPA React,
//                  el scraper HTML de Alfa ya no funciona. Requiere ingeniería inversa de su API.
//   - EliteTorrent (https://www.elitetorrent.com) — OK
//   - HackTorrent  (https://hacktorrent.to)      — OK (API JSON)
//   - MiTorrent    (https://mitorrent.mx)        — OK
//   - PelisPanda   (https://pelispanda.org)      — PENDIENTE: el sitio rediseñado eliminó
//                  el endpoint wp-json. Requiere ingeniería inversa.
//
// Cada fuente: buscar por título → tarjetas → página detalle →
//   URLs torrent → infoHash (magnet o descarga .torrent + bencode).
// Solo se devuelven resultados con audio latino (o dual sin castellano).
// ---------------------------------------------------------------------------

const cheerio = require("cheerio");
const crypto = require("crypto");

const UA = "LatinoStreams/1.0 (+stremio-addon)";
const AT_TIMEOUT_MS = 10000;

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
		return await fetch(url, { ...options, signal: ctrl.signal });
	} finally {
		clearTimeout(t);
	}
}

// --- Título y año desde Cinemeta ---
async function fetchMeta(type, id) {
	const imdb = String(id).split(":")[0];
	if (!/^tt\d+$/.test(imdb)) return null;
	try {
		const metaType = type === "series" ? "series" : "movie";
		const res = await fetchWithTimeout(`https://v3-cinemeta.strem.io/meta/${metaType}/${imdb}.json`, 8000, {
			headers: { "User-Agent": UA },
		});
		if (!res.ok) return null;
		const j = await res.json();
		const name = j?.meta?.name || null;
		let year = null;
		const rd = j?.meta?.released || j?.meta?.releaseInfo || "";
		const ym = /(\d{4})/.exec(rd);
		if (ym) year = parseInt(ym[1], 10);
		return name ? { name, year } : null;
	} catch {
		return null;
	}
}
// Compat: devuelve solo el título
async function fetchTitle(type, id) {
	const m = await fetchMeta(type, id);
	return m ? m.name : null;
}

// --- Bencode mínimo + infoHash ---
function bdecodeRaw(buf, pos) {
	const c = String.fromCharCode(buf[pos]);
	if (c === "i") {
		const end = buf.indexOf(0x65, pos); // 'e'
		return [parseInt(buf.slice(pos + 1, end).toString(), 10), end + 1];
	}
	if (c === "l" || c === "d") {
		const arr = c === "l" ? [] : {};
		let p = pos + 1;
		while (String.fromCharCode(buf[p]) !== "e") {
			const [k, np] = bdecodeRaw(buf, p);
			p = np;
			if (c === "l") arr.push(k);
			else {
				const [v, np2] = bdecodeRaw(buf, p);
				p = np2;
				arr[k.toString()] = v;
			}
		}
		return [arr, p + 1];
	}
	if (c >= "0" && c <= "9") {
		const colon = buf.indexOf(0x3a, pos); // ':'
		const len = parseInt(buf.slice(pos, colon).toString(), 10);
		return [buf.slice(colon + 1, colon + 1 + len), colon + 1 + len];
	}
	throw new Error("bdecode inválido en " + pos);
}

function infoHashFromTorrent(buf) {
	try {
		// Encontrar el diccionario "info" sin decodificar todo: buscar "4:info" y su valor
		const needle = Buffer.from("4:info");
		const idx = buf.indexOf(needle);
		if (idx < 0) return null;
		const [infoVal, endPos] = bdecodeRaw(buf, idx + needle.length);
		// Re-codificar el valor info a bencode para el hash. Como bdecodeRaw devuelve
		// Buffers para strings, re-codificamos de forma canónica:
		const reenc = bencode(infoVal);
		return crypto.createHash("sha1").update(reenc).digest("hex");
	} catch {
		return null;
	}
}

function bencode(v) {
	if (Buffer.isBuffer(v)) return Buffer.concat([Buffer.from(String(v.length) + ":"), v]);
	if (typeof v === "number") return Buffer.from(`i${v}e`);
	if (Array.isArray(v)) return Buffer.concat([Buffer.from("l"), ...v.map(bencode), Buffer.from("e")]);
	if (typeof v === "object" && v !== null) {
		const keys = Object.keys(v).sort();
		const parts = [Buffer.from("d")];
		for (const k of keys) {
			parts.push(bencode(Buffer.from(k)));
			parts.push(bencode(v[k]));
		}
		parts.push(Buffer.from("e"));
		return Buffer.concat(parts);
	}
	return Buffer.from(String(v.length) + ":" + v);
}

function magnetInfoHash(magnet) {
	const m = /xt=urn:btih:([a-zA-Z0-9]+)/i.exec(magnet || "");
	if (!m) return null;
	let h = m[1].toLowerCase();
	if (h.length === 32) {
		// base32 → hex
		const alphabet = "abcdefghijklmnopqrstuvwxyz234567";
		let bits = "";
		for (const ch of h) bits += alphabet.indexOf(ch).toString(2).padStart(5, "0");
		let hex = "";
		for (let i = 0; i + 8 <= bits.length; i += 8) hex += parseInt(bits.slice(i, i + 8), 2).toString(16).padStart(2, "0");
		return hex.slice(0, 40);
	}
	return h.length === 40 ? h : null;
}

// --- Detección de idioma / calidad ---
const LATINO_RE = /latin[oa]|espa[ñn]ol[\s._-]*latin|audio[\s._-]*latin|\[lat\]|\(lat\)|\slat\s|latinoam[eé]rica|dual[\s._-]*lat\b|wolfmax4k/i;
// 🇪🇸 solo cuenta como latino si NO es parte de una lista multi-idioma
function hasLatinoFlag(text) {
	if (!/🇪🇸/.test(text)) return false;
	const flags = (text.match(/🇬🇧|🇮🇹|🇵🇹|🇫🇷|🇩🇪|🇳🇱|🇪🇸|🇲🇽|🇦🇷|🇨🇴/g) || []).length;
	if (flags >= 3) return false;
	return true;
}
const DUAL_RE = /\bdual\b/i;
const SPAIN_RE = /castellano|espa[ñn]a|\[esp\]|\(esp\)|spanish\s*\(spain\)/i;
const HINDI_RE = /hindi|hind[ií]/i;

function latinoTier(text) {
	if (HINDI_RE.test(text)) return -1; // excluir falsos "dual" hindi+eng
	if (LATINO_RE.test(text) || hasLatinoFlag(text)) return 0;
	if (DUAL_RE.test(text) && !SPAIN_RE.test(text)) return 1;
	return 2;
}

function parseQuality(text) {
	if (/2160p|\b4k\b/i.test(text)) return { label: "2160p", score: 4 };
	if (/1080p/i.test(text)) return { label: "1080p", score: 3 };
	if (/720p/i.test(text)) return { label: "720p", score: 2 };
	if (/480p/i.test(text)) return { label: "480p", score: 1 };
	return { label: "SD", score: 0 };
}

function normTitle(s) {
	return String(s || "")
		.toLowerCase()
		.normalize("NFD")
		.replace(/[\u0300-\u036f]/g, "")
		.replace(/[^a-z0-9]+/g, " ")
		.trim();
}

function titleMatches(cardName, title) {
	const nn = normTitle(cardName);
	const nt = normTitle(title);
	if (!nn || !nt) return false;
	// Coincidencia directa (subcadena)
	if (nn.includes(nt) || nt.includes(nn)) return true;
	// Scoring por palabras: la primera palabra debe coincidir + 40% de overlap
	const cardWords = nn.split(" ").filter((w) => w.length > 2);
	const titleWords = nt.split(" ").filter((w) => w.length > 2);
	if (!titleWords.length || !cardWords.length) return false;
	if (cardWords[0] !== titleWords[0]) return false;
	const cardSet = new Set(cardWords);
	let hits = 0;
	for (const w of titleWords) if (cardSet.has(w)) hits++;
	return hits / titleWords.length >= 0.4;
}

// Genera variaciones de búsqueda: título limpio → primeras palabras.
// Los buscadores de estos sitios son muy literales; probar de específico a general.
function buildQueries(title) {
	const clean = normTitle(title).replace(/\s+/g, " ").trim();
	const words = clean.split(" ").filter((w) => w.length > 2);
	const queries = [];
	if (clean) queries.push(clean);
	// Quitar la última palabra progresivamente (mínimo 1 palabra)
	for (let n = words.length - 1; n >= 1; n--) {
		const q = words.slice(0, n).join(" ");
		if (q && !queries.includes(q)) queries.push(q);
	}
	return queries.slice(0, 4);
}

// Decodifica URLs ofuscadas de EliteTorrent: base64 xN + ROT13
// Devuelve URL absoluta (antepone baseHost si es ruta relativa)
function decodeEliteTorrentUrl(obfuscated, baseHost) {
	try {
		let d = obfuscated;
		// Extraer parámetro 'i' si es URL del acortador
		const m = /[?&]i=([^&]+)/.exec(d);
		if (m) d = decodeURIComponent(m[1]);
		// base64 hasta que deje de parecer base64
		for (let i = 0; i < 12; i++) {
			if (!/^[A-Za-z0-9+/=]+$/.test(d)) break;
			let dec;
			try {
				dec = Buffer.from(d, "base64").toString("utf8");
			} catch {
				break;
			}
			if (!dec || /�/.test(dec) || !/^[\x20-\x7e]+$/.test(dec)) break;
			d = dec;
			if (/^[a-z]+:\/\//i.test(d) && !/^[A-Za-z0-9+/=]+$/.test(d)) break;
		}
		// ROT13
		d = d.replace(/[a-zA-Z]/g, (c) => {
			const base = c <= "Z" ? 65 : 97;
			return String.fromCharCode(((c.charCodeAt(0) - base + 13) % 26) + base);
		});
		d = d.trim();
		if (d.startsWith("http")) return d;
		if (d.startsWith("/") && baseHost) return baseHost.replace(/\/$/, "") + d;
		return null;
	} catch {
		return null;
	}
}

// ---------------------------------------------------------------------------
// Definición de fuentes
// ---------------------------------------------------------------------------

const SOURCES = {
	// --- CineCalidad: búsqueda ?s=, tarjetas <article>, detalle con data-url base64 ---
	cinecalidad: {
		name: "CineCalidad",
		mirrors: ["https://www.cinecalidad.vg"],
		async search(title, type) {
			for (const m of this.mirrors) {
				for (const qq of buildQueries(title)) {
					try {
						const q = encodeURIComponent(qq);
						const res = await fetchWithTimeout(`${m}/?s=${q}`, AT_TIMEOUT_MS, {
							headers: { "User-Agent": UA },
						});
						if (!res.ok) continue;
						const $ = cheerio.load(await res.text());
						const cards = [];
						$("article").each((_, el) => {
							const a = $(el).find("a").first();
							const href = a.attr("href");
							const img = $(el).find("img.w-full").first();
							let name = img.attr("title") || img.attr("alt") || "";
							name = name.split(" (")[0].trim();
							if (/premium|promo/i.test(name)) return;
							if (href && name) cards.push({ url: new URL(href, m).href, name });
						});
						const matched = cards.filter((c) => titleMatches(c.name, title));
						if (matched.length) return { cards: matched, host: m };
					} catch {
						// siguiente query/espejo
					}
				}
			}
			return { cards: [], host: null };
		},
		async detail(card) {
			const rows = [];
			try {
				const res = await fetchWithTimeout(card.url, AT_TIMEOUT_MS, {
					headers: { "User-Agent": UA },
				});
				if (!res.ok) return rows;
				const $ = cheerio.load(await res.text());
				// Enlaces torrent: elementos con data-url o data-src en base64
				$("[data-url], [data-src]").each((_, el) => {
					const label = $(el).text().trim().toLowerCase();
					if (!/torrent|descargar|download/i.test(label) && !/torrent/i.test($(el).attr("class") || "")) return;
					const b64 = $(el).attr("data-url") || $(el).attr("data-src") || "";
					if (!b64) return;
					let url = null;
					try {
						url = Buffer.from(b64, "base64").toString("utf8").trim();
					} catch {
						return;
					}
					if (!url) return;
					if (/mediafire/i.test(url)) return;
					const magnet = url.startsWith("magnet:") ? url : null;
					const torrentUrl = magnet ? null : url;
					if (!magnet && !torrentUrl) return;
					const rowText = $(el).parent().text().replace(/\s+/g, " ").trim();
					rows.push({ torrentUrl, magnet, rowText, flag: "LAT" });
				});
				// Fallback: enlaces directos a .torrent o magnet en la página
				$("a[href]").each((_, el) => {
					const href = $(el).attr("href") || "";
					if (href.startsWith("magnet:")) {
						rows.push({ torrentUrl: null, magnet: href, rowText: $(el).text().trim(), flag: "LAT" });
					} else if (/\.torrent(\?|$)/i.test(href)) {
						rows.push({ torrentUrl: new URL(href, card.url).href, magnet: null, rowText: $(el).text().trim(), flag: "LAT" });
					}
				});
			} catch {
				// ignorar
			}
			return rows;
		},
	},

	// --- EliteTorrent: búsqueda ?s=&x=0&y=0, tarjetas ul.miniboxs-ficha li ---
	elitetorrent: {
		name: "EliteTorrent",
		mirrors: ["https://www.elitetorrent.com"],
		async search(title, type) {
			for (const m of this.mirrors) {
				for (const qq of buildQueries(title)) {
					try {
						const q = encodeURIComponent(qq);
						const res = await fetchWithTimeout(`${m}/?s=${q}&x=0&y=0`, AT_TIMEOUT_MS, {
							headers: { "User-Agent": UA },
						});
						if (!res.ok) continue;
						const $ = cheerio.load(await res.text());
						const cards = [];
						$("ul.miniboxs-ficha li").each((_, el) => {
							const a = $(el).find("div.imagen a").first();
							const href = a.attr("href");
							const name = (a.attr("title") || "").trim();
							// Idioma desde la bandera: span[id] img[data-src] (ej. .../latino.png)
							const flagImg = $(el).find("span[id] img").first();
							const flagSrc = flagImg.attr("data-src") || flagImg.attr("src") || "";
							const flagAlt = `${flagImg.attr("title") || ""} ${flagImg.attr("alt") || ""}`;
							let lang = "";
							if (/latino/i.test(flagSrc) || /latino/i.test(flagAlt)) lang = "Latino";
							else if (/castellano/i.test(flagSrc) || /castellano/i.test(flagAlt)) lang = "Castellano";
							else if (/vose|subtitul/i.test(flagSrc) || /vose|subtitul/i.test(flagAlt)) lang = "VOSE";
							if (href && name) cards.push({ url: new URL(href, m).href, name, lang });
						});
						const matched = cards.filter((c) => titleMatches(c.name, title));
						if (matched.length) return { cards: matched, host: m };
					} catch {
						// siguiente query/espejo
					}
				}
			}
			return { cards: [], host: null };
		},
		async detail(card) {
			const rows = [];
			try {
				const res = await fetchWithTimeout(card.url, AT_TIMEOUT_MS, {
					headers: { "User-Agent": UA },
				});
				if (!res.ok) return rows;
				const html = await res.text();
				const $ = cheerio.load(html);
				// Año de la ficha (formato 2024-07-24)
				let pageYear = null;
				const ym = /(19|20)\d{2}-\d{2}-\d{2}/.exec(html);
				if (ym) pageYear = parseInt(ym[0].slice(0, 4), 10);
				if (pageYear) card.year = pageYear;
				$("a.enlace_torrent, a[href*='acortame-esto.com']").each((_, el) => {
					const href = $(el).attr("href") || "";
					const text = $(el).text().trim();
					const decoded = decodeEliteTorrentUrl(href, "https://www.elitetorrent.com");
					if (decoded) {
						const magnet = decoded.startsWith("magnet:") ? decoded : null;
						rows.push({
							torrentUrl: magnet ? null : decoded,
							magnet,
							rowText: text,
							flag: card.lang || "",
						});
					}
				});
				// Fallback: magnets directos
				$("a[href^='magnet:']").each((_, el) => {
					const href = $(el).attr("href") || "";
					if (!rows.some((r) => r.magnet === href)) {
						rows.push({ torrentUrl: null, magnet: href, rowText: $(el).text().trim(), flag: card.lang || "" });
					}
				});
			} catch {
				// ignorar
			}
			return rows;
		},
	},

	// --- MiTorrent: búsqueda search-result/, tarjetas div.browse-movie-wrap ---
	mitorrent: {
		name: "MiTorrent",
		mirrors: ["https://mitorrent.mx"],
		async search(title, type) {
			for (const m of this.mirrors) {
				for (const qq of buildQueries(title)) {
					try {
						const q = encodeURIComponent(qq);
						const res = await fetchWithTimeout(
							`${m}/search-result/?search_query=${q}&calidad=&genero=&dtyear=&audio=`,
							AT_TIMEOUT_MS,
							{ headers: { "User-Agent": UA } }
						);
						if (!res.ok) continue;
						const $ = cheerio.load(await res.text());
						const cards = [];
						$("div.browse-movie-wrap").each((_, el) => {
							const a = $(el).find("a").first();
							const href = a.attr("href");
							const name = $(el).find("div.browse-movie-bottom a").first().text().trim();
							if (/1 a[ñn]o/i.test(name)) return;
							const lang = $(el).find("div.browse-movie-tags").first().text().trim();
							if (href && name) cards.push({ url: new URL(href, m).href, name, lang });
						});
						const matched = cards.filter((c) => titleMatches(c.name, title));
						if (matched.length) return { cards: matched, host: m };
					} catch {
						// siguiente query/espejo
					}
				}
			}
			return { cards: [], host: null };
		},
		async detail(card) {
			const rows = [];
			try {
				const res = await fetchWithTimeout(card.url, AT_TIMEOUT_MS, {
					headers: { "User-Agent": UA },
				});
				if (!res.ok) return rows;
				const $ = cheerio.load(await res.text());
				$("div.modal-torrent a[href]").each((_, el) => {
					const href = $(el).attr("href") || "";
					const text = $(el).text().trim();
					if (href.startsWith("magnet:")) {
						rows.push({ torrentUrl: null, magnet: href, rowText: text, flag: card.lang || "" });
					} else if (/\.torrent(\?|$)/i.test(href) || href) {
						const abs = new URL(href, card.url).href;
						rows.push({ torrentUrl: abs, magnet: null, rowText: text, flag: card.lang || "" });
					}
				});
			} catch {
				// ignorar
			}
			return rows;
		},
	},
};

// --- HackTorrent y PelisPanda usan la misma API JSON (wp-json/wpreact) ---
function makeWpJsonSource(name, mirrors) {
	return {
		name,
		mirrors,
		async search(title, type) {
			for (const m of this.mirrors) {
				for (const qq of buildQueries(title)) {
					try {
						const q = encodeURIComponent(qq);
						const res = await fetchWithTimeout(
							`${m}/wp-json/wpreact/v1/search?query=${q}&posts_per_page=20&page=1`,
							AT_TIMEOUT_MS,
							{ headers: { "User-Agent": UA, Accept: "application/json" } }
						);
						if (!res.ok) continue;
						const j = await res.json();
						const items = j?.results || j?.movies || j?.data || (Array.isArray(j) ? j : []);
						const cards = [];
						for (const it of items) {
							const itTitle = (it.title || "").replace(/&amp;/g, "&");
							const slug = it.slug || "";
							if (!itTitle || !slug) continue;
							const mediatype = it.type === "pelicula" ? "movie" : "tvshow";
							const kind = mediatype === "movie" ? "movie" : it.type === "anime" ? "anime" : "serie";
							cards.push({
								url: `${m}/wp-json/wpreact/v1/${kind}/${slug}/`,
								name: itTitle,
								lang: it.language || "",
								year: it.year || "",
								mediatype,
							});
						}
						const matched = cards.filter((c) => titleMatches(c.name, title));
						if (matched.length) return { cards: matched, host: m };
					} catch {
						// siguiente query/espejo
					}
				}
			}
			return { cards: [], host: null };
		},
		async detail(card) {
			const rows = [];
			try {
				const res = await fetchWithTimeout(card.url, AT_TIMEOUT_MS, {
					headers: { "User-Agent": UA, Accept: "application/json" },
				});
				if (!res.ok) return rows;
				const j = await res.json();
				// La API devuelve torrents en varios formatos posibles
				const candidates = [];
				if (Array.isArray(j?.downloads)) candidates.push(...j.downloads);
				if (Array.isArray(j?.torrents)) candidates.push(...j.torrents);
				if (Array.isArray(j?.data?.torrents)) candidates.push(...j.data.torrents);
				if (Array.isArray(j?.data?.downloads)) candidates.push(...j.data.downloads);
				if (Array.isArray(j?.links)) candidates.push(...j.links);
				// También buscar download_link sueltos en el JSON
				const flat = JSON.stringify(j);
				const dlMatches = flat.match(/https?:[^"\\]*\.torrent[^"\\]*/gi) || [];
				for (const t of candidates) {
					const url = t.download_link || t.url || t.link || "";
					if (!url) continue;
					const magnet = url.startsWith("magnet:") ? url : null;
					rows.push({
						torrentUrl: magnet ? null : url,
						magnet,
						rowText: `${t.quality || ""} ${t.size || ""} ${url}`.trim().slice(0, 200),
						flag: t.language || j?.language || card.lang || "",
					});
				}
				for (const dl of dlMatches.slice(0, 5)) {
					if (!rows.some((r) => r.torrentUrl === dl)) {
						rows.push({ torrentUrl: dl, magnet: null, rowText: "", flag: card.lang || "" });
					}
				}
			} catch {
				// ignorar
			}
			return rows;
		},
	};
}

SOURCES.hacktorrent = makeWpJsonSource("HackTorrent", ["https://hacktorrent.cc", "https://hacktorrent.to"]);
SOURCES.pelispanda = makeWpJsonSource("PelisPanda", ["https://pelispanda.org"]);

// ---------------------------------------------------------------------------
// Orquestador: busca en una fuente y devuelve streams estilo Stremio
// ---------------------------------------------------------------------------

async function resolveInfoHash(row) {
	if (row.magnet) return magnetInfoHash(row.magnet);
	if (row.torrentUrl) {
		try {
			const res = await fetchWithTimeout(row.torrentUrl, AT_TIMEOUT_MS, {
				headers: { "User-Agent": UA },
			});
			if (!res.ok) return null;
			const buf = Buffer.from(await res.arrayBuffer());
			// Verificar que sea un torrent (empieza con 'd')
			if (buf[0] !== 0x64) return null;
			return infoHashFromTorrent(buf);
		} catch {
			return null;
		}
	}
	return null;
}

async function fetchAlfaTorrentSource(sourceId, type, id, season, episode) {
	const src = SOURCES[sourceId];
	if (!src) return [];
	const cacheKey = `alfa-torrent:${sourceId}:${type}:${id}`;
	const hit = cacheGet(cacheKey);
	if (hit) return hit;

	try {
		const meta = await fetchMeta(type, id);
		if (!meta) return [];
		const title = meta.name;
		const year = meta.year;

		const { cards } = await src.search(title, type);
		let matched = cards.filter((c) => titleMatches(c.name, title)).slice(0, 5);
		if (!matched.length) {
			cacheSet(cacheKey, [], 30 * 60 * 1000);
			return [];
		}

		// Si tenemos año, priorizar tarjetas cuyo detalle coincida en año.
		// (Los títulos en español no siempre coinciden por palabras.)
		const detailPages = (
			await Promise.all(
				matched.map(async (c) => {
					try {
						const rows = await src.detail(c);
						return { card: c, rows };
					} catch {
						return { card: c, rows: [] };
					}
				})
			)
		).filter((d) => d.rows.length > 0);

		// Filtrar por año si el detalle lo indica y conocemos el año
		let pages = detailPages;
		if (year) {
			const withYear = detailPages.filter((d) => {
				if (d.card.year && Math.abs(d.card.year - year) <= 1) return true;
				// Buscar año en el texto de las filas
				const text = d.rows.map((r) => r.rowText).join(" ");
				const ym = /(19|20)\d{2}/.exec(text);
				if (ym && Math.abs(parseInt(ym[0], 10) - year) <= 1) return true;
				// Si no hay año en el detalle, mantener (no podemos descartar)
				return !ym && !d.card.year;
			});
			if (withYear.length) pages = withYear;
		}

		const detailRows = pages.flatMap((d) =>
			d.rows.map((r) => ({ ...r, cardName: d.card.name }))
		);

		// Para series: filtrar por temporada si el texto lo indica
		let rows = detailRows;
		if (type === "series" && season != null) {
			rows = detailRows.filter((r) => {
				const t = `${r.rowText} ${r.flag} ${r.cardName || ""}`;
				const sm = /temporada\s+(\d+)|season\s+(\d+)|s(\d{1,2})/i.exec(t);
				if (!sm) return true; // sin info de temporada: incluir
				const n = parseInt(sm[1] || sm[2] || sm[3], 10);
				return n === season;
			});
		}

		const streams = [];
		await Promise.all(
			rows.slice(0, 8).map(async (r) => {
				const infoHash = await resolveInfoHash(r);
				if (!infoHash) return;
				const text = `${r.rowText}\n${r.flag}`;
				const tier = latinoTier(text);
				if (tier < 0 || tier === 2) return;
				const ql = parseQuality(text);
				streams.push({
					infoHash: infoHash.toLowerCase(),
					tier,
					quality: ql.label,
					qualityScore: ql.score,
					seeders: 0,
					size: "?",
					releaseName: text.slice(0, 120),
					filename: "",
					rawTitle: text,
					source: src.name,
				});
			})
		);

		streams.sort((a, b) => a.tier - b.tier || b.qualityScore - a.qualityScore);
		cacheSet(cacheKey, streams, 30 * 60 * 1000);
		return streams;
	} catch (e) {
		console.warn(`${src.name} falló:`, e.message);
		return [];
	}
}

module.exports = {
	fetchAlfaTorrentSource,
	ALFA_TORRENT_SOURCES: Object.fromEntries(
		Object.entries(SOURCES).map(([id, s]) => [id, s.name])
	),
};
