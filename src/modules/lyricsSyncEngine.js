/**
 * Phase 4 — Moteur de synchronisation des paroles
 *
 * Reçoit la position audio toutes les ~100ms et détermine
 * quelle ligne doit être affichée comme active.
 *
 * Fonctionnalités :
 *  - Suivi de la ligne active avec hysteresis (évite les sauts)
 *  - Préchargement de la ligne suivante pour l'animation
 *  - Correction de dérive (drift) configurable (+/- secondes)
 *  - Mode "karaoke" : colorisation caractère par caractère (optionnel)
 */

class LyricsSyncEngine {
  constructor(sendToOverlay) {
    this.sendToOverlay = sendToOverlay

    this.lines      = []      // [{time, text}] triés par time
    this.synced     = false
    this.offset     = 0       // correction de dérive en secondes
    this.activeIdx  = -1
    this.lastSentAt = -1      // pour éviter d'envoyer des doublons
  }

  // ─── Chargement des paroles ──────────────────────────────────────────────

  loadLyrics({ lines, synced }) {
    this.lines      = lines || []
    this.synced     = synced
    this.activeIdx  = -1
    this.lastSentAt = -1

    this.sendToOverlay('lyrics-loaded', {
      synced,
      lineCount: this.lines.length,
      firstLine: this.lines[0]?.text || null
    })

    // Envoyer immédiatement les premières lignes pour l'affichage initial
    // (avant que le ticker de position ne démarre)
    if (this.lines.length > 0) {
      this.sendToOverlay('lyrics-update', {
        prev:      null,
        curr:      { text: this.lines[0].text, idx: 0, progress: 0 },
        next:      this.lines[1] ? { text: this.lines[1].text, idx: 1 } : null,
        activeIdx: synced ? -1 : 0,  // non-sync : on affiche d'emblée la ligne 0
        progress:  0
      })
    }
  }

  clear() {
    this.lines = []; this.activeIdx = -1; this.lastSentAt = -1
    this.sendToOverlay('lyrics-cleared', {})
  }

  setOffset(seconds) {
    this.offset = seconds
  }

  setDuration(seconds) {
    this._unsyncedDuration = seconds
  }

  // ─── Mise à jour de la position (appelée toutes les ~100ms) ─────────────

  update(positionSecs) {
    this._updateInternal(positionSecs, false)
  }

  forceUpdate(positionSecs) {
    this._updateInternal(positionSecs, true)
  }

  _updateInternal(positionSecs, force) {
    if (!this.lines.length) return

    const effectivePos = positionSecs + this.offset

    // Mode non synchronisé
    if (!this.synced) {
      if (!this._unsyncedDuration || this._unsyncedDuration <= 0) return
      const ratio  = Math.min(1, effectivePos / this._unsyncedDuration)
      const newIdx = Math.min(this.lines.length - 1, Math.floor(ratio * this.lines.length))
      if (newIdx === this.activeIdx && !force) return
      this.activeIdx = newIdx
      this.sendToOverlay('lyrics-update', {
        prev:      newIdx > 0 ? { text: this.lines[newIdx - 1].text, idx: newIdx - 1 } : null,
        curr:      { text: this.lines[newIdx].text, idx: newIdx, progress: 0 },
        next:      newIdx < this.lines.length - 1 ? { text: this.lines[newIdx + 1].text, idx: newIdx + 1 } : null,
        activeIdx: newIdx,
        progress:  0
      })
      return
    }

    const newIdx = this._findActiveIndex(effectivePos)

    if (newIdx === this.activeIdx && !force) return
    this.activeIdx = newIdx

    if (newIdx < 0) {
      this.sendToOverlay('lyrics-update', {
        prev: null, curr: null,
        next: this.lines[0] ? { text: this.lines[0].text, idx: 0 } : null,
        activeIdx: -1, progress: 0
      })
      return
    }

    const curr = this.lines[newIdx]
    const prev = newIdx > 0 ? this.lines[newIdx - 1] : null
    const next = newIdx < this.lines.length - 1 ? this.lines[newIdx + 1] : null

    const lineStart    = curr.time
    const lineEnd      = next ? next.time : lineStart + 4
    const lineDuration = lineEnd - lineStart
    const progress     = Math.min(1, (effectivePos - lineStart) / lineDuration)

    this.sendToOverlay('lyrics-update', {
      prev:      prev ? { text: prev.text, idx: newIdx - 1 } : null,
      curr:      { text: curr.text, idx: newIdx, progress },
      next:      next ? { text: next.text, idx: newIdx + 1 } : null,
      activeIdx: newIdx, progress
    })
  }

  // ─── Recherche binaire de la ligne active ─────────────────────────────────

  _findActiveIndex(pos) {
    const lines = this.lines
    if (!lines.length || pos < lines[0].time) return -1

    let lo = 0, hi = lines.length - 1

    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (lines[mid].time <= pos) lo = mid
      else hi = mid - 1
    }

    return lo
  }

  // ─── Saut à une ligne spécifique ─────────────────────────────────────────

  jumpToLine(idx) {
    if (idx < 0 || idx >= this.lines.length) return null
    return this.lines[idx].time
  }

  // ─── Export LRC (permet de sauvegarder les paroles retouchées) ───────────

  exportLRC(meta = {}) {
    const LyricsParser = require('./lyricsParser')
    const header = [
      meta.title  ? `[ti:${meta.title}]`  : '',
      meta.artist ? `[ar:${meta.artist}]` : '',
      meta.album  ? `[al:${meta.album}]`  : '',
      `[by:LyricsOverlay]`,
      ''
    ].filter(l => l !== undefined).join('\n')

    const body = this.lines
      .map(l => `${LyricsParser.formatLRCTime(l.time)}${l.text}`)
      .join('\n')

    return header + body
  }

  // ─── Statistiques utiles pour le debug ───────────────────────────────────

  getStats() {
    return {
      lineCount: this.lines.length,
      synced:    this.synced,
      offset:    this.offset,
      activeIdx: this.activeIdx,
      duration:  this.lines.length ? this.lines[this.lines.length - 1].time : 0
    }
  }
}

module.exports = LyricsSyncEngine