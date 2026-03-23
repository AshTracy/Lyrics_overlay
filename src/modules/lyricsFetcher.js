/**
 * lyricsFetcher.js
 *
 * Note : le fetch principal des paroles est désormais effectué côté renderer
 * (via fetchLyricsRenderer dans renderer.js) pour contourner les blocages réseau.
 *
 * Ce module ne contient plus de dépendance SQLite / better-sqlite3.
 * Le cache est géré par lrcCache.js (fichiers .lrc locaux).
 *
 * Les fonctions clearCache et getCacheStats sont conservées pour compatibilité
 * avec les IPC handlers de index.js — elles délèguent à lrcCache.
 */

// clearCache et getCacheStats sont des stubs — le vrai cache est lrcCache.js
// appelé directement depuis index.js

function clearCache() {
  // No-op : géré par lrcCache.clear() dans index.js
}

function getCacheStats() {
  // No-op : géré par lrcCache.getStats() dans index.js
  return { total: 0, synced: 0 }
}

module.exports = { clearCache, getCacheStats }