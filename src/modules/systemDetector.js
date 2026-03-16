/**
 * Phase 2 — Détection de l'audio système (v3 - Windows optimisé)
 *
 * Windows : Stratégies parallèles titre fenêtre + SMTC
 * Position : interpolation JS entre polls (pas de PS toutes les 1s)
 * macOS    : AppleScript via fichier .scpt
 * Linux    : playerctl MPRIS
 */

const { exec } = require('child_process')
const os        = require('os')
const fs        = require('fs')
const path      = require('path')
const SmtcBridge = require('./smtcBridge')

class SystemDetector {
  constructor(sendToOverlay) {
    this.sendToOverlay     = sendToOverlay
    this._pollInterval     = null
    this._posInterval      = null
    this._lastTrackKey     = null
    this._currentTrack     = null
    this._posAtPoll        = 0
    this._posTimer         = null
    this._isPlaying        = false
    this._vlcMonitorActive = false
    this._vlcTicking       = false
    this.platform          = os.platform()
    this.onTrackChange     = null
    this._smtcBridge       = new SmtcBridge()
    this._smtcAvailable    = false
  }

  // ─── Polling ──────────────────────────────────────────────────────────────

  async startPolling(intervalMs = 2000) {
    this.stopPolling()

    // Tenter de démarrer le bridge Python SMTC
    if (this.platform === 'win32') {
      this._smtcAvailable = await this._smtcBridge.start()
      if (this._smtcAvailable) {
        console.log('[Detector] Bridge Python SMTC actif — détection améliorée')
        // Le bridge pousse les états toutes les 1s — on les écoute
        this._smtcBridge.onState((state) => this._onSmtcState(state))
      } else {
        console.log('[Detector] Bridge Python indisponible — fallback PowerShell')
      }
    }

    setTimeout(() => this._poll(), 500)
    this._pollInterval = setInterval(() => this._poll(), intervalMs)
    this._posInterval  = setInterval(() => this._tickPosition(), 250)
  }

  stopPolling() {
    clearInterval(this._pollInterval)
    clearInterval(this._posInterval)
    this._pollInterval = null
    this._posInterval  = null
    this._stopVlcMonitor()
    this._smtcBridge?.stop()
  }

  // ─── Bridge Python SMTC ───────────────────────────────────────────────────
  // Reçoit les états JSON toutes les 1s depuis smtc_bridge.py

  _onSmtcState(state) {
    // VLC géré par son propre monitor HTTP — ignorer ici
    if (this._vlcMonitorActive) return
    // Ignorer les états inactifs si aucune piste connue
    if (!state.is_active) {
      if (this._currentTrack && this._isPlaying) {
        this._isPlaying = false
        this._posTimer  = null
        this.sendToOverlay('system-playback-state', { playing: false })
      }
      return
    }

    const title  = state.track  || ''
    const artist = state.artist || ''
    if (!title) return

    // Identifier la source depuis app_id
    const appId  = state.app_id || ''
    const source = appId.includes('spotify') ? 'spotify'
                 : appId.includes('groove')  ? 'groove'
                 : appId.includes('zune')    ? 'groove'
                 : 'windows'

    const key = `${artist}|${title}`

    // ── Changement de piste ──────────────────────────────────────────────
    if (key !== this._lastTrackKey) {
      this._lastTrackKey = key
      this._isPlaying    = state.is_playing
      this._posAtPoll    = state.pos_sec || 0
      this._posTimer     = state.is_playing ? Date.now() : null

      const track = {
        artist,
        title,
        album:    state.album || '',
        position: state.pos_sec || 0,
        duration: state.end_sec || 0,
        playing:  state.is_playing,
        source,
      }
      this._currentTrack = track
      this.sendToOverlay('system-track-changed', track)
      if (this.onTrackChange) this.onTrackChange(track)
      return
    }

    // ── Pause / reprise ──────────────────────────────────────────────────
    const wasPlaying = this._isPlaying
    this._isPlaying  = state.is_playing

    if (!wasPlaying && state.is_playing) {
      const pos = state.pos_sec || this._posAtPoll
      this._posAtPoll = pos
      this._posTimer  = Date.now()
      this.sendToOverlay('system-playback-state', { playing: true })
      this.sendToOverlay('system-seek', { position: pos })
      return
    }

    if (wasPlaying && !state.is_playing) {
      this._posAtPoll = state.pos_sec || this._interpolatedPos()
      this._posTimer  = null
      this.sendToOverlay('system-playback-state', { playing: false })
      return
    }

    // ── Seek (position réelle vs estimée) ────────────────────────────────
    if (state.is_playing && state.pos_sec > 0) {
      const drift = Math.abs(state.pos_sec - this._interpolatedPos())
      if (drift > 2.0) {
        this.sendToOverlay('system-seek', { position: state.pos_sec })
      }
      this._posAtPoll = state.pos_sec
      this._posTimer  = Date.now()
    }

    // Mettre à jour la durée si elle arrive après le changement de piste
    // (Spotify Free peut retourner end_sec=0 au premier tick puis la vraie valeur)
    if (state.end_sec > 0 && this._currentTrack && !this._currentTrack.duration) {
      this._currentTrack.duration = state.end_sec
      this.sendToOverlay('system-track-duration', { duration: state.end_sec })
    }
  }

  async _poll() {
    try {
      // Si le bridge Python gère Spotify et qu'aucun VLC n'est actif,
      // on ne lance pas le script PS (coûteux) — le bridge suffit
      if (this._smtcAvailable && !this._vlcMonitorActive) {
        // Vérifier quand même si VLC vient d'être lancé via titre de fenêtre
        const track = await this._getWindowsTitleOnly()
        if (track?.source === 'vlc' && track.title !== (this._currentTrack?.title)) {
          this._lastTrackKey = `${track.artist}|${track.title}`
          this._currentTrack = track
          this._posAtPoll    = 0
          this._posTimer     = Date.now()
          this._isPlaying    = true
          this._startVlcMonitor()
          this.sendToOverlay('system-track-changed', track)
          if (this.onTrackChange) this.onTrackChange(track)
        }
        return
      }

      const track = await this.getCurrentTrack()
      if (!track) return

      const key = `${track.artist}|${track.title}`

      if (key !== this._lastTrackKey) {
        this._lastTrackKey = key
        this._currentTrack = track
        this._posAtPoll    = track.position || 0
        this._posTimer     = Date.now()
        this._isPlaying    = track.playing !== false

        if (track.source === 'vlc') {
          this._startVlcMonitor()
        } else {
          this._stopVlcMonitor()
        }

        this.sendToOverlay('system-track-changed', track)
        if (this.onTrackChange) this.onTrackChange(track)
        return
      }

      if (this._vlcMonitorActive) return

      const wasPlaying = this._isPlaying
      this._isPlaying  = track.playing !== false

      if (!wasPlaying && this._isPlaying) {
        const resumePos = (track.position > 0) ? track.position : this._posAtPoll
        this._posAtPoll = resumePos
        this._posTimer  = Date.now()
        this.sendToOverlay('system-playback-state', { playing: true })
        this.sendToOverlay('system-seek', { position: resumePos })
        setTimeout(() => this._pollPosition(), 600)
        return
      }

      if (wasPlaying && !this._isPlaying) {
        this._posAtPoll = this._interpolatedPos()
        this._posTimer  = null
        this.sendToOverlay('system-playback-state', { playing: false })
        return
      }

      if (track.position > 0) {
        const drift = Math.abs(track.position - this._interpolatedPos())
        if (drift > 2.0) {
          this.sendToOverlay('system-seek', { position: track.position })
        }
        this._posAtPoll = track.position
        this._posTimer  = this._isPlaying ? Date.now() : null
      }

    } catch (_) {}
  }

  // Poll léger uniquement sur le titre de fenêtre (pas SMTC) — pour détecter VLC
  _getWindowsTitleOnly() {
    return new Promise((resolve) => {
      const playerNames = ['vlc'].map(p => `"${p}"`).join(',')
      const ps = `
$players = @(${playerNames})
foreach ($pname in $players) {
  $proc = Get-Process -Name $pname -ErrorAction SilentlyContinue |
    Where-Object { $_.MainWindowTitle -and $_.MainWindowTitle.Length -gt 2 } |
    Select-Object -First 1
  if ($proc) { Write-Output "$($pname)|$($proc.MainWindowTitle)"; exit }
}
Write-Output "NONE"
`
      this._runPS(ps, (out) => {
        if (!out || out === 'NONE' || !out.includes('|')) { resolve(null); return }
        const pipeIdx  = out.indexOf('|')
        const procName = out.substring(0, pipeIdx).trim()
        const winTitle = out.substring(pipeIdx + 1).trim()
        const player   = SystemDetector.KNOWN_PLAYERS.find(p => p.name.toLowerCase() === procName.toLowerCase())
        const parsed   = this._parseTitleByFormat(winTitle, player?.format || 'artist - title', procName)
        resolve(parsed ? { ...parsed, position: 0, playing: true, source: procName.toLowerCase() } : null)
      })
    })
  }

  // Poll léger juste pour la position (après reprise)
  async _pollPosition() {
    try {
      const track = await this.getCurrentTrack()
      if (!track || track.position <= 0) return
      const drift = Math.abs(track.position - this._interpolatedPos())
      if (drift > 1.0) {
        this._posAtPoll = track.position
        this._posTimer  = Date.now()
        this.sendToOverlay('system-seek', { position: track.position })
      }
    } catch (_) {}
  }

  // Position interpolée courante
  _interpolatedPos() {
    if (this._posTimer === null) return this._posAtPoll
    return this._posAtPoll + (Date.now() - this._posTimer) / 1000
  }

  // Estime la position par interpolation JS sans appel OS
  _tickPosition() {
    if (!this._currentTrack) { return }
    if (!this._isPlaying)    { return }
    if (this._posTimer === null) { return }
    const estimated = this._interpolatedPos()
    console.log(`[Tick] pos=${estimated.toFixed(2)} posAtPoll=${this._posAtPoll.toFixed(2)} track=${this._currentTrack?.title}`)
    this.sendToOverlay('system-position', { position: estimated })
  }

  // ─── Dispatch plateforme ──────────────────────────────────────────────────

  async getCurrentTrack() {
    switch (this.platform) {
      case 'darwin': return this._getMacOSTrack()
      case 'win32':  return this._getWindowsTrack()
      case 'linux':  return this._getLinuxTrack()
      default:       return null
    }
  }

  // =========================================================================
  // WINDOWS — Stratégies parallèles : titre fenêtre + SMTC
  //
  // SMTC (System Media Transport Controls) détecte TOUT player qui
  // s'enregistre : Spotify, VLC, WMP, Groove, foobar2000+plugin, MPC-HC…
  //
  // Stratégie 1 (rapide, ~200ms) : titre de fenêtre du process
  // Stratégie 2 (lente, ~1-3s)  : SMTC → artiste + titre + position
  // Les deux tournent en parallèle. SMTC gagne si il a la position.
  // =========================================================================

  // Players connus avec leur format de titre de fenêtre
  static get KNOWN_PLAYERS() {
    return [
      { name: 'Spotify',          format: 'artist - title' },
      { name: 'vlc',              format: 'title - vlc'    },
      { name: 'foobar2000',       format: 'title - foo'    },
      { name: 'MPC-HC',           format: 'title - mpc'    },
      { name: 'MPC-HC64',         format: 'title - mpc'    },
      // WMP classique (wmplayer.exe) : "Title - Windows Media Player"
      { name: 'wmplayer',         format: 'title - wmp'    },
      // Nouveau Windows Media Player (Win11 Store) — app UWP, pas de MainWindowTitle fiable
      // Détecté uniquement via SMTC (SourceAppUserModelId contient "ZuneMusic")
      { name: 'WindowsMediaPlayer', format: 'title - wmp'  },
      { name: 'MediaPlayer',      format: 'title - wmp'    },
      { name: 'iTunes',           format: 'artist - title' },
      { name: 'AIMP',             format: 'artist - title' },
      { name: 'MediaMonkey',      format: 'artist - title' },
      { name: 'MusicBee',         format: 'artist - title' },
      { name: 'Winamp',           format: 'title - winamp' },
      { name: 'groove',           format: 'artist - title' },
    ]
  }

  _getWindowsTrack() {
    return new Promise((resolve) => {
      let resolved    = false
      let titleResult = null
      let smtcTimer   = null

      const finalize = (result) => {
        if (resolved) return
        resolved = true
        clearTimeout(smtcTimer)
        resolve(result)
      }

      setTimeout(() => finalize(titleResult), 6000)

      // ── Stratégie 1 : titre de fenêtre (rapide ~200ms) ───────────────────
      const playerNames = SystemDetector.KNOWN_PLAYERS.map(p => `"${p.name}"`).join(',')
      const ps1 = `
$players = @(${playerNames})
foreach ($pname in $players) {
  $proc = Get-Process -Name $pname -ErrorAction SilentlyContinue |
    Where-Object { $_.MainWindowTitle -and $_.MainWindowTitle.Length -gt 2 } |
    Select-Object -First 1
  if ($proc) {
    Write-Output "$($pname)|$($proc.MainWindowTitle)"
    exit
  }
}
Write-Output "NONE"
`
      this._runPS(ps1, (out1) => {
        if (out1 && out1 !== 'NONE' && out1.includes('|')) {
          const pipeIdx  = out1.indexOf('|')
          const procName = out1.substring(0, pipeIdx).trim()
          const winTitle = out1.substring(pipeIdx + 1).trim()
          const player   = SystemDetector.KNOWN_PLAYERS.find(
            p => p.name.toLowerCase() === procName.toLowerCase()
          )
          const parsed = this._parseTitleByFormat(winTitle, player?.format || 'artist - title', procName)
          if (parsed) {
            titleResult = { ...parsed, position: 0, playing: true, source: procName.toLowerCase() }

            if (procName.toLowerCase() === 'vlc') {
              this._getVlcHttpStatus().then(vlcStatus => {
                if (vlcStatus) {
                  titleResult = {
                    ...titleResult,
                    playing:          vlcStatus.playing,
                    position:         vlcStatus.position,
                    vlcHttpAvailable: true
                  }
                }
                smtcTimer = setTimeout(() => finalize(titleResult), this._smtcAvailable ? 0 : 2000)
              }).catch(() => {
                smtcTimer = setTimeout(() => finalize(titleResult), this._smtcAvailable ? 0 : 2000)
              })
              return
            }
          }
        }

        // Si bridge Python actif : pas besoin d'attendre le script PS SMTC
        // Le bridge gère Spotify/SMTC de son côté
        if (this._smtcAvailable) {
          finalize(titleResult)
          return
        }

        // Sinon : laisser 2s à SMTC PS pour répondre
        smtcTimer = setTimeout(() => finalize(titleResult), 2000)
      })

      // ── Stratégie 2 : SMTC via PowerShell (fallback si Python indisponible) ─
      if (this._smtcAvailable) return   // bridge Python gère déjà SMTC
      const ps2 = `
try {
  Add-Type -AssemblyName System.Runtime.WindowsRuntime | Out-Null
  $mgr  = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager,Windows.Media.Control,ContentType=WindowsRuntime]::RequestAsync().GetAwaiter().GetResult()
  $sess = $mgr.GetCurrentSession()
  if ($null -eq $sess) { exit }
  $pb = $sess.GetPlaybackInfo()
  # Status: 4=Playing 5=Paused — on accepte les deux, on ignore Stopped(2)/Closed(1)
  if ($pb.PlaybackStatus -lt 4) { exit }
  $playing = if ($pb.PlaybackStatus -eq 4) { "1" } else { "0" }
  $p    = $sess.TryGetMediaPropertiesAsync().GetAwaiter().GetResult()
  $pos  = 0
  try { $pos = $sess.GetTimelineProperties().Position.TotalSeconds } catch {}
  $app  = $sess.SourceAppUserModelId
  Write-Output "$($p.Artist)|$($p.Title)|$($p.AlbumTitle)|$pos|$app|$playing"
} catch {}
`
      this._runPS(ps2, (out2) => {
        if (out2 && out2.includes('|')) {
          const parts = out2.split('|')
          if (parts.length >= 2 && parts[1].trim()) {
            const appId  = (parts[4] || '').toLowerCase()
            const source = appId.includes('spotify')         ? 'spotify'
                         : appId.includes('vlc')             ? 'vlc'
                         : appId.includes('itunes')          ? 'itunes'
                         : appId.includes('zunemusic')       ? 'windows-media'
                         : appId.includes('windowsmedia')    ? 'windows-media'
                         : appId.includes('mediaplayer')     ? 'windows-media'
                         : appId.includes('groove')          ? 'groove'
                         : appId.includes('foobar')          ? 'foobar2000'
                         : appId.includes('musicbee')        ? 'musicbee'
                         : appId.includes('aimp')            ? 'aimp'
                         : 'windows'
            const isPlaying = parts[5]?.trim() !== '0'
            const smtcResult = {
              artist:   parts[0].trim(),
              title:    parts[1].trim(),
              album:    (parts[2] || '').trim(),
              position: parseFloat(parts[3]) || 0,
              playing:  isPlaying,
              source
            }
            if (smtcResult.position > 0 && isPlaying) {
              this._posAtPoll = smtcResult.position
              this._posTimer  = Date.now()
            }
            finalize(smtcResult)   // SMTC gagne toujours
            return
          }
        }
        // SMTC n'a rien trouvé → fallback sur titre de fenêtre
        finalize(titleResult)
      })
    })
  }

  _parseTitleByFormat(winTitle, format, procName) {
    if (!winTitle) return null

    let clean = winTitle

    // ── Détecter la pause depuis le titre de fenêtre ─────────────────────────
    // VLC affiche "(en pause)" ou "(paused)" ou "(pausado)" etc. dans le titre
    // foobar2000 affiche "[PAUSED]", MPC-HC affiche "(Paused)"
    const pausePatterns = [
      /\(en pause\)/i,          // VLC français
      /\(paused?\)/i,           // VLC anglais, MPC-HC
      /\[paused?\]/i,           // foobar2000
      /\bpause[d]?\b/i,         // générique
    ]
    const isPaused = pausePatterns.some(p => p.test(clean))

    // Supprimer les indicateurs de pause du titre avant parsing
    clean = clean
      .replace(/\s*\(en pause\)/i, '')
      .replace(/\s*\(paused?\)/i, '')
      .replace(/\s*\[paused?\]/i, '')

    // ── Supprimer les suffixes player ────────────────────────────────────────
    clean = clean.replace(/ - (?:[\w\s\u00C0-\u024F\uFFFD]*?\s+)?VLC\s*$/i, '')
    clean = clean
      .replace(/ - foobar2000.*$/i, '')
      .replace(/ - Windows Media Player$/i, '')
      .replace(/ - Lecteur Windows Media$/i, '')
      .replace(/ - Microsoft Windows Media Player$/i, '')
      .replace(/ - MPC-HC.*$/i, '')
      .replace(/ - Winamp$/i, '')
      .replace(new RegExp(` - ${procName}.*$`, 'i'), '')
      .trim()

    if (format === 'artist - title') {
      const idx = clean.indexOf(' - ')
      if (idx > 0) {
        return {
          artist:  clean.substring(0, idx).trim(),
          title:   clean.substring(idx + 3).trim(),
          album:   '',
          playing: !isPaused
        }
      }
    }

    if (clean && clean.toLowerCase() !== procName.toLowerCase()) {
      return { artist: '', title: clean, album: '', playing: !isPaused }
    }
    return null
  }

  // ─── VLC HTTP API ─────────────────────────────────────────────────────────
  // Basé sur /requests/status.json (VLC ≥ 2.0)
  // Nécessite : Outils → Préférences → Interface → Interfaces principales → Web
  // Mot de passe : celui défini dans VLC → Lua/HTTP (vide par défaut)

  static vlcConfig = {
    host:     'http://localhost',
    port:     8080,
    password: '',
  }

  async _getVlcHttpStatus() {
    const { host, port, password } = SystemDetector.vlcConfig
    const url  = `${host}:${port}/requests/status.json`
    const auth = Buffer.from(`:${password}`).toString('base64')

    return new Promise((resolve) => {
      const req = require('http').get(url, {
        headers: { Authorization: `Basic ${auth}` },
        timeout: 2000
      }, (res) => {
        if (res.statusCode !== 200) { resolve(null); return }
        let data = ''
        res.on('data', d => data += d)
        res.on('end', () => {
          try {
            const json = JSON.parse(data)
            resolve({
              isOpen:    true,
              isPlaying: json.state === 'playing',
              isPaused:  json.state === 'paused',
              isStopped: json.state === 'stopped',
              playing:   json.state === 'playing',
              position:  json.time     ?? 0,   // position en secondes
              length:    json.length   ?? 0,   // durée totale en secondes
              percent:   (json.position ?? 0) * 100,
              filename:  json.information?.category?.meta?.filename ?? '',
              available: true
            })
          } catch (_) { resolve(null) }
        })
      })
      req.on('error', () => resolve(null))
      req.on('timeout', () => { req.destroy(); resolve(null) })
    })
  }

  // Monitor VLC autonome — remplace _poll() entièrement quand VLC est actif
  // Inspiré du script monitorVlc fourni : poll toutes les 1s via status.json
  _startVlcMonitor() {
    if (this._vlcMonitorActive) return
    this._vlcMonitorActive = true
    this._vlcTicking = false

    const tick = async () => {
      if (!this._vlcMonitorActive) return
      if (this._vlcTicking) return
      this._vlcTicking = true

      try {
        const status = await this._getVlcHttpStatus()

        if (!status) {
          // HTTP non disponible — arrêter le monitor, laisser _poll gérer
          this._stopVlcMonitor()
          this._vlcTicking = false
          return
        }

        // ── Position ──────────────────────────────────────────────────────
        if (status.isPlaying && status.position >= 0) {
          const drift = Math.abs(status.position - this._interpolatedPos())
          if (drift > 1.5) {
            this.sendToOverlay('system-seek', { position: status.position })
          }
          this._posAtPoll = status.position
          this._posTimer  = Date.now()
        }

        // ── Pause / reprise ───────────────────────────────────────────────
        const wasPlaying = this._isPlaying
        this._isPlaying  = status.isPlaying
        if (wasPlaying !== this._isPlaying) {
          if (!this._isPlaying) {
            this._posAtPoll = status.position || this._interpolatedPos()
            this._posTimer  = null
            this.sendToOverlay('system-playback-state', { playing: false })
          } else {
            this._posAtPoll = status.position
            this._posTimer  = Date.now()
            this.sendToOverlay('system-playback-state', { playing: true })
            this.sendToOverlay('system-seek', { position: status.position })
          }
        }

      } catch (_) {}

      this._vlcTicking = false
      if (this._vlcMonitorActive) setTimeout(tick, 1000)
    }

    tick()
  }

  _stopVlcMonitor() {
    this._vlcMonitorActive = false
  }

  _runPS(script, callback) {
    // Forcer la sortie PS en UTF-8 pour éviter la corruption des accents
    const wrappedScript = `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8\n` + script
    const tmpFile = path.join(os.tmpdir(), `lo-${Date.now()}-${Math.random().toString(36).slice(2)}.ps1`)
    // Écrire en UTF-8 avec BOM (requis par PowerShell pour reconnaître l'encodage)
    const bom     = Buffer.from([0xEF, 0xBB, 0xBF])
    const content = Buffer.concat([bom, Buffer.from(wrappedScript, 'utf-8')])

    fs.writeFile(tmpFile, content, (writeErr) => {
      if (writeErr) { callback(null); return }

      exec(
        `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${tmpFile}"`,
        { timeout: 8000, windowsHide: true, encoding: 'utf8' },
        (err, stdout, stderr) => {
          fs.unlink(tmpFile, () => {})
          if (err && process.argv.includes('--dev'))
            console.warn('[WinDetect]', err.message, (stderr || '').slice(0, 120))
          callback((stdout || '').trim() || null)
        }
      )
    })
  }

  // =========================================================================
  // macOS — AppleScript via fichier .scpt temporaire
  // =========================================================================

  _getMacOSTrack() {
    return new Promise((resolve) => {
      const script = [
        'set result to ""',
        'tell application "System Events"',
        '  set runningApps to name of every process whose background only is false',
        'end tell',
        'if "Spotify" is in runningApps then',
        '  try',
        '    tell application "Spotify"',
        '      if player state is playing then',
        '        set t to current track',
        '        set result to (artist of t) & "|" & (name of t) & "|" & (album of t) & "|" & (player position as text) & "|spotify"',
        '      end if',
        '    end tell',
        '  end try',
        'end if',
        'if result is "" and "Music" is in runningApps then',
        '  try',
        '    tell application "Music"',
        '      if player state is playing then',
        '        set t to current track',
        '        set result to (artist of t) & "|" & (name of t) & "|" & (album of t) & "|" & (player position as text) & "|music"',
        '      end if',
        '    end tell',
        '  end try',
        'end if',
        'return result'
      ].join('\n')

      const tmpFile = path.join(os.tmpdir(), 'lyrics-overlay-detect.scpt')
      fs.writeFile(tmpFile, script, 'utf-8', (err) => {
        if (err) { resolve(null); return }
        exec(`osascript "${tmpFile}"`, { timeout: 5000 }, (err2, stdout, stderr) => {
          if (err2 && process.argv.includes('--dev'))
            console.warn('[macOS detect]', stderr?.trim() || err2.message)
          const out   = (stdout || '').trim()
          if (!out) { resolve(null); return }
          const parts = out.split('|')
          if (parts.length < 4) { resolve(null); return }
          const pos = parseFloat(parts[3]) || 0
          if (pos > 0) { this._posAtPoll = pos; this._posTimer = Date.now() }
          resolve({
            artist:   parts[0].trim(),
            title:    parts[1].trim(),
            album:    parts[2].trim(),
            position: pos,
            source:   parts[4]?.trim() || 'macos'
          })
        })
      })
    })
  }

  // =========================================================================
  // Linux — playerctl MPRIS
  // =========================================================================

  _getLinuxTrack() {
    return new Promise((resolve) => {
      exec('playerctl metadata --format "{{artist}}|{{title}}|{{album}}|{{position}}" 2>/dev/null',
        { timeout: 3000 },
        (err, stdout) => {
          const out = (stdout || '').trim()
          if (err || !out) { resolve(null); return }
          const parts = out.split('|')
          if (parts.length < 2 || !parts[0] || !parts[1]) { resolve(null); return }
          const pos = parseInt(parts[3] || '0') / 1e6
          if (pos > 0) { this._posAtPoll = pos; this._posTimer = Date.now() }
          resolve({
            artist:   parts[0].trim(),
            title:    parts[1].trim(),
            album:    (parts[2] || '').trim(),
            position: pos,
            source:   'mpris'
          })
        }
      )
    })
  }
}

module.exports = SystemDetector