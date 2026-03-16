/**
 * Phase 5 — Persistance des préférences utilisateur
 * Stockage JSON dans le dossier userData d'Electron
 * (ex: ~/Library/Application Support/lyrics-overlay/settings.json)
 */

const fs   = require('fs')
const path = require('path')

const DEFAULTS = {
  // Fenêtre
  window: { x: 60, y: 60, width: 520, height: 160 },

  // Apparence (Phase 5)
  opacity:       0.82,
  fontSize:      18,
  theme:         'dark',        // 'dark' | 'light' | 'minimal'
  accentColor:   '#c8a96e',     // couleur de la ligne active
  fontFamily:    'serif',       // 'serif' | 'sans' | 'mono'
  showCoverArt:  true,
  showProgress:  true,
  linesVisible:  3,             // 1 = seulement active | 3 = prev+curr+next

  // Comportement
  syncOffset:    0,             // décalage paroles en secondes
  passthrough:   false,         // mode click-through
  startMinimized: false,

  // Raccourcis (lecture seule ici, éditable dans le futur)
  shortcuts: {
    toggle:    'CommandOrControl+Shift+L',
    openFile:  'CommandOrControl+Shift+O',
    playPause: 'CommandOrControl+Shift+Space'
  }
}

class SettingsStore {
  constructor(userDataPath) {
    this._filePath = path.join(userDataPath, 'settings.json')
    this._data     = { ...DEFAULTS }
    this._dirty    = false
    this._load()
  }

  // ─── Lecture ────────────────────────────────────────────────────────────

  get(key, fallback) {
    const val = this._data[key]
    return val !== undefined ? val : (fallback !== undefined ? fallback : DEFAULTS[key])
  }

  getAll() {
    return { ...this._data }
  }

  // ─── Écriture ────────────────────────────────────────────────────────────

  set(key, value) {
    this._data[key] = value
    this._dirty     = true
    this._scheduleSave()
  }

  /** Fusion partielle (pour les patches depuis le renderer) */
  patch(obj) {
    for (const [k, v] of Object.entries(obj)) {
      if (v !== null && typeof v === 'object' && !Array.isArray(v) && typeof this._data[k] === 'object') {
        this._data[k] = { ...this._data[k], ...v }
      } else {
        this._data[k] = v
      }
    }
    this._dirty = true
    this._scheduleSave()
  }

  reset(key) {
    if (key) this._data[key] = DEFAULTS[key]
    else     this._data = { ...DEFAULTS }
    this._dirty = true
    this._scheduleSave()
  }

  // ─── I/O ────────────────────────────────────────────────────────────────

  _load() {
    try {
      if (fs.existsSync(this._filePath)) {
        const raw  = fs.readFileSync(this._filePath, 'utf-8')
        const json = JSON.parse(raw)
        // Fusion profonde avec les defaults pour gérer les nouvelles clés
        this._data = this._deepMerge(DEFAULTS, json)
      }
    } catch (e) {
      console.warn('Settings load failed, using defaults:', e.message)
      this._data = { ...DEFAULTS }
    }
  }

  save() {
    try {
      fs.writeFileSync(this._filePath, JSON.stringify(this._data, null, 2), 'utf-8')
      this._dirty = false
    } catch (e) {
      console.error('Settings save failed:', e.message)
    }
  }

  _saveTimer = null
  _scheduleSave() {
    clearTimeout(this._saveTimer)
    this._saveTimer = setTimeout(() => this.save(), 1500)
  }

  _deepMerge(defaults, overrides) {
    const result = { ...defaults }
    for (const [k, v] of Object.entries(overrides)) {
      if (v !== null && typeof v === 'object' && !Array.isArray(v) && typeof defaults[k] === 'object') {
        result[k] = this._deepMerge(defaults[k], v)
      } else {
        result[k] = v
      }
    }
    return result
  }
}

module.exports = SettingsStore
