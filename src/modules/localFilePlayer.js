/**
 * Phase 2 — Lecteur de fichiers locaux
 * Gère la lecture audio native + extraction de métadonnées (music-metadata)
 * Envoie la position toutes les ~100ms au renderer via sendToOverlay
 */

const path = require('path')
const fs   = require('fs')

// music-metadata v10+ est ESM-only — utiliser import() dynamique
let _parseFile = null
async function getParseFile() {
  if (!_parseFile) {
    const mm = await import('music-metadata')
    _parseFile = mm.parseFile
  }
  return _parseFile
}

class LocalFilePlayer {
  constructor(sendToOverlay) {
    this.sendToOverlay = sendToOverlay

    this.filePath    = null
    this.metadata    = null
    this._playing    = false
    this._position   = 0      // secondes
    this._duration   = 0
    this._volume     = 1.0
    this._startedAt  = null   // Date.now() au moment du play
    this._posAtStart = 0      // position en secondes au moment du play
    this._ticker     = null   // setInterval pour position
  }

  // ─── Chargement ────────────────────────────────────────────────────────────

  async loadFile(filePath) {
    this.stop()
    this.filePath = filePath

    // Extraire les métadonnées avec music-metadata
    const parseFile = await getParseFile()
    const raw = await parseFile(filePath, { duration: true, skipPostHeaders: true })
    const tags = raw.common || {}

    // Extraire la pochette si disponible
    let coverArt = null
    if (tags.picture && tags.picture.length > 0) {
      const pic = tags.picture[0]
      const b64 = Buffer.from(pic.data).toString('base64')
      coverArt = `data:${pic.format};base64,${b64}`
    }

    this._duration = raw.format.duration || 0

    this.metadata = {
      title:    tags.title    || path.basename(filePath, path.extname(filePath)),
      artist:   (tags.artist || tags.artists?.[0]) || 'Artiste inconnu',
      album:    tags.album    || '',
      year:     tags.year     || null,
      duration: this._duration,
      filePath,
      coverArt
    }

    this._position   = 0
    this._playing    = false

    return this.metadata
  }

  // ─── Contrôles de lecture ──────────────────────────────────────────────────

  play() {
    if (!this.filePath || this._playing) return
    this._playing    = true
    this._startedAt  = Date.now()
    this._posAtStart = this._position
    this._startTicker()
  }

  pause() {
    if (!this._playing) return
    // Sauvegarder la position courante avant de stopper
    this._position = this._currentPosition()
    this._playing  = false
    this._stopTicker()
    this.sendToOverlay('playback-state', { playing: false, position: this._position })
  }

  stop() {
    this._playing  = false
    this._position = 0
    this._stopTicker()
  }

  togglePlayPause() {
    if (this._playing) this.pause()
    else this.play()
  }

  seek(seconds) {
    const wasPlaying = this._playing
    if (wasPlaying) this._stopTicker()

    this._position   = Math.max(0, Math.min(this._duration, seconds))
    this._startedAt  = Date.now()
    this._posAtStart = this._position

    if (wasPlaying) this._startTicker()

    this.sendToOverlay('playback-position', {
      position: this._position,
      duration: this._duration
    })
  }

  setVolume(v) {
    this._volume = Math.max(0, Math.min(1, v))
    // Dans un vrai contexte Electron, on utiliserait l'API Web Audio
    // depuis le renderer — ici on notifie simplement
    this.sendToOverlay('volume-changed', { volume: this._volume })
  }

  isPlaying()  { return this._playing }
  hasFile()    { return this.filePath !== null }

  // Libère le fichier → permet au polling système de reprendre
  releaseFile() {
    this.stop()
    this.filePath = null
    this.metadata = null
  }

  // ─── Ticker de position ────────────────────────────────────────────────────

  _currentPosition() {
    if (!this._playing) return this._position
    const elapsed = (Date.now() - this._startedAt) / 1000
    return Math.min(this._duration, this._posAtStart + elapsed)
  }

  _startTicker() {
    this._stopTicker()
    this._ticker = setInterval(() => {
      const pos = this._currentPosition()

      // Fin de piste
      if (pos >= this._duration && this._duration > 0) {
        this._position = this._duration
        this._playing  = false
        this._stopTicker()
        this.sendToOverlay('playback-state',    { playing: false, position: this._duration })
        this.sendToOverlay('track-ended',       { filePath: this.filePath })
        return
      }

      this._position = pos
      this.sendToOverlay('playback-position', {
        position: pos,
        duration: this._duration
      })
      // Phase 4 : hook pour le moteur de sync
      if (this._syncHook) this._syncHook(pos)
    }, 100) // 10 fps — suffisant pour la synchro paroles
  }

  _stopTicker() {
    if (this._ticker) {
      clearInterval(this._ticker)
      this._ticker = null
    }
  }

  destroy() {
    this.stop()
  }
}

module.exports = LocalFilePlayer