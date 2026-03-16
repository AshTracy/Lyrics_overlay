/**
 * Phase 3 — Récupération de paroles depuis les APIs externes
 *
 * Stratégie par priorité :
 *  1. Fichier .lrc/.srt local dans le même dossier que l'audio
 *  2. Cache SQLite local (évite les requêtes répétées)
 *  3. LRCLIB  (API gratuite, paroles synchronisées, pas de clé)
 *  4. Genius  (paroles non synchronisées, nécessite une clé API)
 *
 * Les paroles sont stockées dans SQLite avec (artist, title) comme clé.
 */

const path    = require('path')
const fs      = require('fs')
const https   = require('https')
const Database = require('better-sqlite3')

const LyricsParser = require('./lyricsParser')

// Chemin du cache SQLite dans le dossier userData d'Electron
let db = null

function getDB(userDataPath) {
  if (db) return db

  const dbPath = path.join(userDataPath, 'lyrics-cache.db')
  db = new Database(dbPath)

  db.exec(`
    CREATE TABLE IF NOT EXISTS lyrics_cache (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      artist     TEXT NOT NULL,
      title      TEXT NOT NULL,
      source     TEXT,
      synced     INTEGER DEFAULT 0,
      raw_lrc    TEXT,
      lines_json TEXT,
      fetched_at INTEGER,
      UNIQUE(artist, title)
    );
    CREATE INDEX IF NOT EXISTS idx_artist_title ON lyrics_cache(artist, title);
  `)

  return db
}

// ─── Entrée principale ────────────────────────────────────────────────────────

/**
 * @param {object} track   — { title, artist, filePath? }
 * @param {string} userDataPath — chemin Electron userData
 * @returns {{ lines, synced, source }} ou null
 */
async function fetchLyrics(track, userDataPath) {
  const { title, artist = '', filePath } = track

  if (!title) return null   // titre obligatoire, artiste optionnel

  const artistClean = normalizeKey(artist || '')
  const titleClean  = normalizeKey(title)

  // ── 1. Fichier local adjacent ────────────────────────────────────────────
  if (filePath) {
    const localResult = tryLocalFile(filePath)
    if (localResult) {
      cacheResult(userDataPath, artistClean, titleClean, localResult)
      return localResult
    }
  }

  // ── 2. Cache SQLite ──────────────────────────────────────────────────────
  const cached = getFromCache(userDataPath, artistClean, titleClean)
  if (cached) return cached

  // ── 3. LRCLIB (gratuit, synchronisé) ────────────────────────────────────
  try {
    const lrclibResult = await fetchFromLRCLIB(artist, title)
    if (lrclibResult) {
      cacheResult(userDataPath, artistClean, titleClean, lrclibResult)
      return lrclibResult
    }
  } catch (_) {
    // Source indisponible, on continue
  }

  // ── 4. Genius (non synchronisé, clé API requise) ────────────────────────
  const geniusKey = process.env.GENIUS_API_KEY
  if (geniusKey) {
    try {
      const geniusResult = await fetchFromGenius(artist, title, geniusKey)
      if (geniusResult) {
        cacheResult(userDataPath, artistClean, titleClean, geniusResult)
        return geniusResult
      }
    } catch (_) {
      // Source indisponible, on continue
    }
  }

  return null
}

// ─── 1. Fichier local ─────────────────────────────────────────────────────────

function tryLocalFile(audioPath) {
  const base = audioPath.replace(/\.[^.]+$/, '')  // retirer l'extension

  for (const ext of ['lrc', 'srt', 'txt']) {
    const lyricsPath = base + '.' + ext
    if (fs.existsSync(lyricsPath)) {
      try {
        const content = fs.readFileSync(lyricsPath, 'utf-8')
        const parsed  = LyricsParser.parse(content, ext)
        return { ...parsed, source: 'local-file' }
      } catch (_) {}
    }
  }
  return null
}

// ─── 2. Cache SQLite ──────────────────────────────────────────────────────────

function getFromCache(userDataPath, artist, title) {
  try {
    const row = getDB(userDataPath)
      .prepare('SELECT * FROM lyrics_cache WHERE artist=? AND title=?')
      .get(artist, title)

    if (!row) return null

    return {
      lines:  JSON.parse(row.lines_json),
      synced: !!row.synced,
      source: row.source + '-cached',
      rawLRC: row.raw_lrc || null
    }
  } catch (_) { return null }
}

function cacheResult(userDataPath, artist, title, result) {
  try {
    getDB(userDataPath)
      .prepare(`
        INSERT OR REPLACE INTO lyrics_cache
          (artist, title, source, synced, raw_lrc, lines_json, fetched_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        artist, title,
        result.source || 'unknown',
        result.synced ? 1 : 0,
        result.rawLRC || null,
        JSON.stringify(result.lines),
        Date.now()
      )
  } catch (e) {
    console.warn('Cache write failed:', e.message)
  }
}

// ─── 3. LRCLIB ────────────────────────────────────────────────────────────────
// API publique gratuite : https://lrclib.net/api
// Retourne des paroles synchronisées (LRC) si disponibles

async function fetchFromLRCLIB(artist, title) {
  // Si artiste connu : recherche combinée (meilleurs résultats)
  // Si artiste vide  : recherche par titre seul
  const q    = artist ? `${artist} ${title}` : title
  const url  = `https://lrclib.net/api/search?q=${encodeURIComponent(q)}`

  const data = await httpGetWithRetry(url)
  if (!data || !data.length) return null

  // Filtrer par similarité de titre (évite les faux positifs quand artiste vide)
  const titleNorm = normalizeKey(title)
  const candidates = data.filter(r => {
    const rTitle = normalizeKey(r.trackName || '')
    // Accepter si le titre correspond à au moins 80% (distance simple)
    return rTitle === titleNorm ||
           rTitle.includes(titleNorm) ||
           titleNorm.includes(rTitle)
  })

  const pool = candidates.length > 0 ? candidates : data
  const best = pool.find(r => r.syncedLyrics) || pool[0]
  if (!best) return null

  if (best.syncedLyrics) {
    const parsed = LyricsParser.parse(best.syncedLyrics, 'lrc')
    return { ...parsed, source: 'lrclib', rawLRC: best.syncedLyrics }
  }

  if (best.plainLyrics) {
    const parsed = LyricsParser.parsePlainText(best.plainLyrics)
    return { ...parsed, source: 'lrclib-plain' }
  }

  return null
}

// ─── 4. Genius ────────────────────────────────────────────────────────────────
// Retourne des paroles NON synchronisées (pas de timestamps)
// Nécessite GENIUS_API_KEY dans les variables d'environnement

async function fetchFromGenius(artist, title, apiKey) {
  const query = encodeURIComponent(`${artist} ${title}`)
  const url   = `https://api.genius.com/search?q=${query}`

  const data = await httpGetWithRetry(url, { Authorization: `Bearer ${apiKey}` })
  if (!data?.response?.hits?.length) return null

  // Premier résultat pertinent
  const hit = data.response.hits.find(h =>
    h.type === 'song' &&
    h.result.primary_artist.name.toLowerCase().includes(artist.toLowerCase())
  ) || data.response.hits[0]

  if (!hit) return null

  // Genius ne fournit pas les paroles directement via API publique
  // On renvoie juste les métadonnées + URL pour afficher un lien
  return {
    lines:  [{ time: 0, text: '⚠ Paroles non synchronisées. Ouvrir sur Genius.' }],
    synced: false,
    source: 'genius',
    geniusUrl: hit.result.url,
    rawLRC: null
  }
}

// ─── HTTP helpers ─────────────────────────────────────────────────────────────

// httpGet avec timeout réel (destroy du socket).
// ENOTFOUND / ECONNREFUSED / timeout => rejette proprement
// pour que fetchLyrics puisse passer à la source suivante sans crasher.
function httpGet(url, headers, timeoutMs) {
  if (!headers)   headers   = {}
  if (!timeoutMs) timeoutMs = 8000

  return new Promise(function(resolve, reject) {
    var opts = {
      headers: Object.assign({ 'User-Agent': 'LyricsOverlay/1.0', 'Accept': 'application/json' }, headers)
    }

    var req = https.get(url, opts, function(res) {
      if (res.statusCode < 200 || res.statusCode >= 300) {
        res.resume()
        return reject(new Error('HTTP ' + res.statusCode))
      }
      var body = ''
      res.on('data', function(d) { body += d })
      res.on('end',  function()  {
        try { resolve(JSON.parse(body)) }
        catch(e) { reject(new Error('JSON parse: ' + e.message)) }
      })
      res.on('error', reject)
    })

    var timer = setTimeout(function() {
      req.destroy(new Error('Timeout after ' + timeoutMs + 'ms'))
    }, timeoutMs)

    req.on('error', function(err) { clearTimeout(timer); reject(err) })
    req.on('close', function()    { clearTimeout(timer) })
  })
}

// Retry automatique (2 tentatives, 1s entre les deux).
// ENOTFOUND / ECONNREFUSED = pas de réseau, on abandonne sans retry inutile.
// On retourne null au lieu de throw pour permettre au fetchLyrics de continuer.
async function httpGetWithRetry(url, headers, retries) {
  if (!retries) retries = 2
  var lastErr
  for (var i = 0; i < retries; i++) {
    try {
      return await httpGet(url, headers)
    } catch(err) {
      lastErr = err
      // Pas de réseau / DNS : inutile de retry, on abandonne proprement
      var noNetwork = ['ENOTFOUND', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT']
      if (noNetwork.some(function(c) { return err.code === c || err.message.includes(c) })) {
        return null  // null = source indisponible, essayer la suivante
      }
      // Erreur auth : inutile aussi
      if (err.message.includes('HTTP 401') || err.message.includes('HTTP 403')) throw err
      if (i < retries - 1) await new Promise(function(r) { setTimeout(r, 1000) })
    }
  }
  return null  // après retries épuisés, on renvoie null plutôt que de throw
}

// ─── Normalisation des clés ───────────────────────────────────────────────────

function normalizeKey(str) {
  return str
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')  // accents
    .replace(/[^a-z0-9 ]/g, '')
    .trim()
}

// ─── Gestion du cache (IPC handlers) ─────────────────────────────────────────

function clearCache(userDataPath, artist, title) {
  try {
    if (artist && title) {
      getDB(userDataPath)
        .prepare('DELETE FROM lyrics_cache WHERE artist=? AND title=?')
        .run(normalizeKey(artist), normalizeKey(title))
    } else {
      getDB(userDataPath).prepare('DELETE FROM lyrics_cache').run()
    }
    return true
  } catch (_) { return false }
}

function getCacheStats(userDataPath) {
  try {
    const row = getDB(userDataPath)
      .prepare('SELECT COUNT(*) as count, SUM(synced) as synced FROM lyrics_cache')
      .get()
    return { total: row.count, synced: row.synced }
  } catch (_) { return { total: 0, synced: 0 } }
}

module.exports = { fetchLyrics, clearCache, getCacheStats }