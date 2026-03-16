/**
 * lyricsFetcherRenderer.js
 * Fetch des paroles côté renderer (Chromium fetch API).
 * Contourne les blocages réseau du main process Electron sur Windows.
 *
 * Utilisé par renderer.js — pas de require(), pure ES module-style dans une IIFE.
 */

window.LyricsFetcherRenderer = (() => {

    // ─── Parser LRC inline (simplifié, sans dépendance) ────────────────────────
  
    function parseLRC(text) {
      const lines  = []
      const offset = { ms: 0 }
  
      for (const raw of text.split('\n')) {
        const metaMatch = raw.match(/^\[offset:\s*([+-]?\d+)\s*\]/i)
        if (metaMatch) { offset.ms = parseInt(metaMatch[1]); continue }
  
        const re    = /\[(\d{1,3}):(\d{2})\.(\d{1,3})\]/g
        const texts = raw.replace(/\[\d{1,3}:\d{2}[.:]\d{1,3}\]/g, '').trim()
        if (!texts) continue
  
        let m
        while ((m = re.exec(raw)) !== null) {
          const secs = parseInt(m[1]) * 60 + parseInt(m[2]) + parseInt(m[3].padEnd(3,'0')) / 1000
          lines.push({ time: Math.max(0, secs + offset.ms / 1000), text: texts })
        }
      }
  
      lines.sort((a, b) => a.time - b.time)
      return { lines, synced: lines.length > 0 && lines.some(l => l.time > 0) }
    }
  
    function parsePlain(text) {
      const lines = text.split('\n')
        .map(l => l.trim())
        .filter(l => l.length > 0)
        .map((text, i) => ({ time: i, text }))
      return { lines, synced: false }
    }
  
    // ─── Normalisation ──────────────────────────────────────────────────────────
  
    function normalize(str) {
      return (str || '')
        .toLowerCase()
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-z0-9 ]/g, '')
        .trim()
    }
  
    // ─── LRCLIB ─────────────────────────────────────────────────────────────────
  
    async function fetchFromLRCLIB(artist, title) {
      const q   = artist ? `${artist} ${title}` : title
      const url = `https://lrclib.net/api/search?q=${encodeURIComponent(q)}`
  
      const resp = await fetch(url, {
        headers: { 'User-Agent': 'LyricsOverlay/1.0', 'Accept': 'application/json' },
        signal:  AbortSignal.timeout(8000)
      })
      if (!resp.ok) return null
  
      const data = await resp.json()
      if (!data?.length) return null
  
      // Filtrer par similarité de titre
      const titleNorm  = normalize(title)
      const candidates = data.filter(r => {
        const t = normalize(r.trackName || '')
        return t === titleNorm || t.includes(titleNorm) || titleNorm.includes(t)
      })
  
      const pool = candidates.length > 0 ? candidates : data
      const best = pool.find(r => r.syncedLyrics) || pool[0]
      if (!best) return null
  
      if (best.syncedLyrics) {
        return { ...parseLRC(best.syncedLyrics), source: 'lrclib', rawLRC: best.syncedLyrics }
      }
      if (best.plainLyrics) {
        return { ...parsePlain(best.plainLyrics), source: 'lrclib-plain' }
      }
      return null
    }
  
    // ─── Fichier .lrc adjacent (via filePath) ───────────────────────────────────
    // Dans le renderer on ne peut pas lire le filesystem directement,
    // mais on peut charger un fichier via fetch() si on connaît son chemin.
  
    async function tryLocalFile(filePath) {
      if (!filePath) return null
      const base = filePath.replace(/\.[^.]+$/, '')
      for (const ext of ['.lrc', '.srt', '.txt']) {
        try {
          // Convertir le chemin Windows en URL file://
          const fileUrl = 'file:///' + base.replace(/\\/g, '/') + ext
          const resp    = await fetch(fileUrl, { signal: AbortSignal.timeout(2000) })
          if (!resp.ok) continue
          const text = await resp.text()
          if (!text.trim()) continue
          if (ext === '.lrc') return { ...parseLRC(text), source: 'local-lrc' }
          if (ext === '.srt') return { ...parseLRC(text), source: 'local-srt' } // srt a des timestamps aussi
          return { ...parsePlain(text), source: 'local-txt' }
        } catch (_) {}
      }
      return null
    }
  
    // ─── Entrée principale ───────────────────────────────────────────────────────
  
    async function fetchLyrics(track) {
      const { title, artist = '', filePath } = track
      if (!title) return null
  
      // 1. Fichier local adjacent
      const local = await tryLocalFile(filePath)
      if (local?.lines?.length) return local
  
      // 2. LRCLIB
      try {
        const result = await fetchFromLRCLIB(artist, title)
        if (result?.lines?.length) return result
      } catch (e) {
        console.warn('[LyricsFetcher] LRCLIB:', e.message)
      }
  
      return null
    }
  
    return { fetchLyrics }
  })()