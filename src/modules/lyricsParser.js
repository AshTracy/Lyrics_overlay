/**
 * Phase 3 — Parser de fichiers de paroles synchronisées
 * Supporte : .lrc (standard + étendu), .srt (SubRip), .txt (non synchronisé)
 *
 * Sortie normalisée : Array<{ time: number, text: string }>
 * time = secondes depuis le début du morceau
 */

class LyricsParser {

  /**
   * Détecter le format et parser automatiquement
   * @param {string} content  — contenu brut du fichier
   * @param {string} ext      — extension sans le point ('lrc', 'srt', 'txt')
   * @returns {{ lines: Array<{time,text}>, meta: object, synced: boolean }}
   */
  static parse(content, ext = 'lrc') {
    const normalized = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n')

    switch (ext.toLowerCase()) {
      case 'lrc': return this.parseLRC(normalized)
      case 'srt': return this.parseSRT(normalized)
      default:    return this.parsePlainText(normalized)
    }
  }

  // ─── Format LRC ────────────────────────────────────────────────────────────
  // [mm:ss.xx] Texte de la ligne
  // [ti:Titre] [ar:Artiste] [al:Album] [by:Créateur] [offset:+/-ms]

  static parseLRC(content) {
    const meta  = {}
    const lines = []
    let   offset = 0  // décalage global en secondes

    const metaRe  = /^\[(\w+):(.+)\]$/
    const timeRe  = /\[(\d{1,2}):(\d{2})[.:]([\d]{2,3})\]/g
    const lineRe  = /^(\[[\d:.\]]+)+(.*)$/

    for (const raw of content.split('\n')) {
      const trimmed = raw.trim()
      if (!trimmed) continue

      // Balises méta
      const metaMatch = trimmed.match(metaRe)
      if (metaMatch) {
        const key = metaMatch[1].toLowerCase()
        const val = metaMatch[2].trim()
        if (key === 'offset') { offset = parseInt(val) / 1000; continue }
        meta[key] = val
        continue
      }

      // Lignes avec timestamp(s)
      if (!lineRe.test(trimmed)) continue

      // Extraire tous les timestamps de cette ligne (LRC étendu permet plusieurs)
      const timestamps = []
      let m
      timeRe.lastIndex = 0
      while ((m = timeRe.exec(trimmed)) !== null) {
        const min  = parseInt(m[1])
        const sec  = parseInt(m[2])
        const cent = m[3].length === 2 ? parseInt(m[3]) / 100 : parseInt(m[3]) / 1000
        timestamps.push(min * 60 + sec + cent + offset)
      }

      if (!timestamps.length) continue

      // Texte = tout ce qui vient après le dernier bracket fermant
      const text = trimmed.replace(/^\[[\d:.\]]+(\[[\d:.\]]+)*/,'').trim()

      for (const time of timestamps) {
        lines.push({ time, text: text || '♪' })
      }
    }

    // Trier par temps (LRC étendu peut être dans le désordre)
    lines.sort((a, b) => a.time - b.time)

    return { lines, meta, synced: lines.length > 0 }
  }

  // ─── Format SRT ────────────────────────────────────────────────────────────
  // 1
  // 00:00:01,500 --> 00:00:04,200
  // Texte de la ligne

  static parseSRT(content) {
    const lines  = []
    const blocks = content.split(/\n\n+/)

    for (const block of blocks) {
      const rows = block.trim().split('\n')
      if (rows.length < 3) continue

      // Ligne 2 : timestamps
      const timeRow = rows[1]
      const timeMatch = timeRow.match(
        /(\d{2}):(\d{2}):(\d{2})[,.](\d{3})\s*-->\s*(\d{2}):(\d{2}):(\d{2})[,.](\d{3})/
      )
      if (!timeMatch) continue

      const startTime =
        parseInt(timeMatch[1]) * 3600 +
        parseInt(timeMatch[2]) * 60   +
        parseInt(timeMatch[3])        +
        parseInt(timeMatch[4]) / 1000

      // Lignes 3+ : texte (peut être multiligne, on joint avec espace)
      const text = rows.slice(2)
        .map(l => l.replace(/<[^>]+>/g, '').trim())  // retirer balises HTML/SRT
        .filter(Boolean)
        .join(' ')

      if (text) lines.push({ time: startTime, text })
    }

    lines.sort((a, b) => a.time - b.time)
    return { lines, meta: {}, synced: lines.length > 0 }
  }

  // ─── Texte brut (non synchronisé) ─────────────────────────────────────────

  static parsePlainText(content) {
    const lines = content.split('\n')
      .map(l => l.trim())
      .filter(Boolean)
      .map((text, i) => ({ time: i, text }))  // index comme placeholder

    return { lines, meta: {}, synced: false }
  }

  // ─── Utilitaires ──────────────────────────────────────────────────────────

  /**
   * Trouver l'index de la ligne active pour une position donnée
   * Retourne -1 si avant le début
   */
  static getActiveIndex(lines, positionSecs) {
    if (!lines.length) return -1

    let idx = -1
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].time <= positionSecs) idx = i
      else break
    }
    return idx
  }

  /**
   * Formater des secondes en [mm:ss.xx] pour export LRC
   */
  static formatLRCTime(secs) {
    const min  = Math.floor(secs / 60)
    const sec  = Math.floor(secs % 60)
    const cent = Math.round((secs % 1) * 100)
    return `[${String(min).padStart(2,'0')}:${String(sec).padStart(2,'0')}.${String(cent).padStart(2,'0')}]`
  }
}

module.exports = LyricsParser
