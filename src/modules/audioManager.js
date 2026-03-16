/**
 * AudioManager — Orchestre les deux sources audio (Phase 2)
 * Priorité : local player si actif, sinon détection système
 */

class AudioManager {
  constructor(localPlayer, systemDetector) {
    this.localPlayer    = localPlayer
    this.systemDetector = systemDetector
    this.activeSource   = null // 'local' | 'system' | null
  }

  setActiveSource(source) {
    this.activeSource = source
  }

  isLocalActive() {
    return this.localPlayer?.isPlaying()
  }

  getActiveSource() {
    if (this.localPlayer?.isPlaying()) return 'local'
    return 'system'
  }
}

module.exports = AudioManager
