/**
 * lrcCache.js — Cache de fichiers .lrc en local
 *
 * Chaque parole trouvée est sauvegardée dans un dossier configurable :
 *   Par défaut : {userData}/lyrics-cache/
 *   Custom      : dossier choisi par l'utilisateur dans les paramètres
 *
 * Format des fichiers :
 *   {Artiste} - {Titre}.lrc   (paroles synchronisées)
 *   {Artiste} - {Titre}.txt   (paroles non synchronisées)
 */

const fs   = require('fs')
const path = require('path')

let _customDir = null   // dossier choisi par l'utilisateur (persist dans settings)

function setCustomDir(dir) {
  _customDir = dir || null
}

function getCustomDir() {
  return _customDir
}

function sanitize(str) {
  return (str || 'unknown')
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .substring(0, 80)
}

function getCacheDir(userDataPath) {
  const dir = _customDir || path.join(userDataPath, 'lyrics-cache')
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  return dir
}

function getFilePath(userDataPath, artist, title, ext) {
  const dir  = getCacheDir(userDataPath)
  const name = artist
    ? `${sanitize(artist)} - ${sanitize(title)}${ext}`
    : `${sanitize(title)}${ext}`
  return path.join(dir, name)
}

// ─── Lecture ──────────────────────────────────────────────────────────────────

function get(userDataPath, artist, title) {
  for (const ext of ['.lrc', '.txt']) {
    const p = getFilePath(userDataPath, artist, title, ext)
    if (fs.existsSync(p)) {
      try {
        const content = fs.readFileSync(p, 'utf-8')
        return { lrc: ext === '.lrc' ? content : null, plain: ext === '.txt' ? content : null, path: p }
      } catch (_) {}
    }
  }
  return null
}

// ─── Écriture ─────────────────────────────────────────────────────────────────

function save(userDataPath, artist, title, lrc, plain) {
  try {
    if (lrc) {
      const p = getFilePath(userDataPath, artist, title, '.lrc')
      fs.writeFileSync(p, lrc, 'utf-8')
      console.log('[LrcCache] Sauvegardé:', p)
      return { saved: true, path: p }
    }
    if (plain) {
      const p = getFilePath(userDataPath, artist, title, '.txt')
      fs.writeFileSync(p, plain, 'utf-8')
      console.log('[LrcCache] Sauvegardé (plain):', p)
      return { saved: true, path: p }
    }
  } catch (e) {
    console.warn('[LrcCache] Erreur écriture:', e.message)
  }
  return { saved: false }
}

// ─── Stats ────────────────────────────────────────────────────────────────────

function getStats(userDataPath) {
  try {
    const dir   = getCacheDir(userDataPath)
    const files = fs.readdirSync(dir)
    const lrc   = files.filter(f => f.endsWith('.lrc')).length
    const txt   = files.filter(f => f.endsWith('.txt')).length
    return { total: lrc + txt, synced: lrc, plain: txt, dir }
  } catch (_) {
    return { total: 0, synced: 0, plain: 0, dir: null }
  }
}

// ─── Suppression ─────────────────────────────────────────────────────────────

function clear(userDataPath, artist, title) {
  if (artist && title) {
    for (const ext of ['.lrc', '.txt']) {
      const p = getFilePath(userDataPath, artist, title, ext)
      if (fs.existsSync(p)) { try { fs.unlinkSync(p) } catch (_) {} }
    }
  } else {
    try {
      const dir = getCacheDir(userDataPath)
      fs.readdirSync(dir)
        .filter(f => f.endsWith('.lrc') || f.endsWith('.txt'))
        .forEach(f => { try { fs.unlinkSync(path.join(dir, f)) } catch (_) {} })
    } catch (_) {}
  }
}

// ─── Nettoyage fichiers parasites ────────────────────────────────────────────

function cleanFakeFiles(userDataPath, fakeTitles) {
  try {
    const dir   = getCacheDir(userDataPath)
    const files = fs.readdirSync(dir)
    for (const f of files) {
      const lower = f.toLowerCase()
      const isFake = fakeTitles.some(t => t && lower.includes(t.toLowerCase()))
      if (isFake) {
        try { fs.unlinkSync(path.join(dir, f)); console.log('[LrcCache] Supprimé (fake):', f) }
        catch (_) {}
      }
    }
  } catch (_) {}
}

module.exports = { get, save, getStats, clear, getCacheDir, setCustomDir, getCustomDir, cleanFakeFiles }