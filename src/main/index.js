const { app, BrowserWindow, ipcMain, globalShortcut, Tray, Menu, dialog, nativeImage, shell } = require('electron')
const path = require('path')

// Supprimer les erreurs DevTools "Autofill.enable / setAddresses wasn't found"
app.commandLine.appendSwitch('disable-features', 'AutofillServerCommunication,AutofillEnableAccountStorageForAccounts')
app.commandLine.appendSwitch('disable-blink-features', 'AutofillEnableToolbarStatusChip')

const LocalFilePlayer  = require('../modules/localFilePlayer')
const SystemDetector   = require('../modules/systemDetector')
const { fetchLyrics, clearCache, getCacheStats } = require('../modules/lyricsFetcher')
const LyricsSyncEngine = require('../modules/lyricsSyncEngine')
const SettingsStore    = require('../modules/settingsStore')
const lrcCache         = require('../modules/lrcCache')

let overlayWindow  = null
let tray           = null
let localPlayer    = null
let systemDetector = null
let syncEngine     = null
let settings       = null
const isDev = process.argv.includes('--dev')

// ─── Overlay window ──────────────────────────────────────────────────────────

function createOverlayWindow() {
  const saved = settings.get('window', {})

  overlayWindow = new BrowserWindow({
    width:       saved.width  || 520,
    height:      saved.height || 160,
    x:           saved.x     || 60,
    y:           saved.y     || 60,
    frame:       false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable:   true,
    movable:     true,
    hasShadow:   false,
    focusable:   false,
    webPreferences: {
      nodeIntegration:  false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js')
    }
  })

  overlayWindow.loadFile(path.join(__dirname, '../../renderer/overlay.html'))
  overlayWindow.setIgnoreMouseEvents(false)
  overlayWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  overlayWindow.setAlwaysOnTop(true, 'screen-saver')

  if (isDev) overlayWindow.webContents.openDevTools({ mode: 'detach' })

  overlayWindow.on('moved',   saveWindowBounds)
  overlayWindow.on('resized', saveWindowBounds)
  overlayWindow.on('closed',  () => { overlayWindow = null })

  overlayWindow.webContents.on('did-finish-load', () => {
    sendToOverlay('settings-loaded', settings.getAll())
  })
}

function saveWindowBounds() {
  if (!overlayWindow || overlayWindow.isDestroyed()) return
  const [x, y]         = overlayWindow.getPosition()
  const [width, height] = overlayWindow.getSize()
  settings.set('window', { x, y, width, height })
}

// ─── Tray ────────────────────────────────────────────────────────────────────

function createTray() {
  tray = new Tray(nativeImage.createEmpty())
  tray.setToolTip('Lyrics Overlay')
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '🎵 Lyrics Overlay', enabled: false },
    { type: 'separator' },
    { label: 'Ouvrir un fichier audio…', click: () => openLocalFile() },
    { type: 'separator' },
    { label: 'Afficher / Masquer', click: () => toggleOverlay() },
    { type: 'separator' },
    { label: 'Vider le cache paroles', click: () => clearCache(app.getPath('userData')) },
    { type: 'separator' },
    { label: 'Quitter', role: 'quit' }
  ]))
  tray.on('click', toggleOverlay)
}

// ─── Raccourcis ──────────────────────────────────────────────────────────────

function registerShortcuts() {
  globalShortcut.register('CommandOrControl+Shift+L', toggleOverlay)
  globalShortcut.register('CommandOrControl+Shift+O', openLocalFile)
  globalShortcut.register('CommandOrControl+Shift+Space', () => {
    localPlayer?.togglePlayPause()
    sendToOverlay('playback-state', { playing: localPlayer?.isPlaying() })
  })
}

function toggleOverlay() {
  if (!overlayWindow) return
  if (overlayWindow.isVisible()) {
    overlayWindow.hide()
  } else {
    overlayWindow.show()
    overlayWindow.setAlwaysOnTop(true, 'screen-saver')
  }
}

// ─── Chargement audio (Phase 2) ──────────────────────────────────────────────

async function openLocalFile() {
  const result = await dialog.showOpenDialog({
    title: 'Choisir un fichier audio',
    filters: [{ name: 'Audio', extensions: ['mp3','flac','wav','ogg','m4a','aac','opus'] }],
    properties: ['openFile']
  })
  if (!result.canceled && result.filePaths.length)
    await loadLocalFile(result.filePaths[0])
}

async function loadLocalFile(filePath) {
  try {
    const metadata = await localPlayer.loadFile(filePath)
    const track = {
      source:   'local', filePath,
      title:    metadata.title  || path.basename(filePath, path.extname(filePath)),
      artist:   metadata.artist || 'Artiste inconnu',
      album:    metadata.album  || '',
      duration: metadata.duration || 0,
      coverArt: metadata.coverArt || null
    }
    sendToOverlay('track-loaded', track)
    syncEngine.setDuration(track.duration)  // pour le mode non-synchronisé
    triggerLyricsFetch(track)  // Phase 3
  } catch (err) {
    sendToOverlay('error', { message: `Impossible de charger: ${err.message}` })
  }
}

// Titres à ignorer — messages UI Spotify, publicités, états vides
const IGNORED_TITLES = new Set([
  'spotify free', 'spotify premium', 'advertisement', 'publicité',
  'spotify', 'unknown', 'untitled', ''
])

function isFakeTrack(track) {
  if (!track?.title) return true
  const t = track.title.toLowerCase().trim()
  if (IGNORED_TITLES.has(t)) return true
  // Ignorer si le titre contient "spotify" seul (ex: "Spotify Free", "Spotify Ad")
  if (/^spotify\b/.test(t)) return true
  return false
}

// ─── Fetch paroles (Phase 3) ─────────────────────────────────────────────────

let lastFetchedKey = null   // évite de re-fetcher la même piste

function triggerLyricsFetch(track) {
  if (isFakeTrack(track)) {
    syncEngine.clear()
    lastFetchedKey = null
    sendToOverlay('lyrics-status', { status: 'not-found', message: '♪' })
    return
  }

  // Ne pas re-fetcher si c'est exactement la même piste
  const key = `${track.artist || ''}|${track.title}`
  if (key === lastFetchedKey) return

  lastFetchedKey = key
  syncEngine.clear()

  if (!rendererReady) {
    pendingTrack = track
    return
  }
  sendToOverlay('lyrics-status', { status: 'fetching' })
  sendToOverlay('fetch-lyrics-request', { track })
}

// ─── IPC ─────────────────────────────────────────────────────────────────────

function setupIpcHandlers() {
  ipcMain.on('renderer-ready', () => {
    rendererReady = true
    if (pendingTrack) {
      const t  = pendingTrack
      pendingTrack = null
      // Court délai pour que le renderer finisse d'installer ses listeners
      setTimeout(() => triggerLyricsFetch(t), 150)
    }
  })

  ipcMain.handle('get-window-size', () => {
    if (!overlayWindow) return { width: 520, height: 160 }
    const [width, height] = overlayWindow.getSize()
    return { width, height }
  })

  // Diagnostic : tester la détection système manuellement
  ipcMain.handle('diagnose-system-detection', async () => {
    const track = await systemDetector.getCurrentTrack()

    // Lancer aussi un script SMTC brut pour voir le SourceAppUserModelId réel
    const rawSmtc = await new Promise(resolve => {
      const ps = `
try {
  Add-Type -AssemblyName System.Runtime.WindowsRuntime | Out-Null
  $mgr = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager,Windows.Media.Control,ContentType=WindowsRuntime]::RequestAsync().GetAwaiter().GetResult()
  $sessions = $mgr.GetSessions()
  foreach ($s in $sessions) {
    $pb = $s.GetPlaybackInfo()
    $p  = $s.TryGetMediaPropertiesAsync().GetAwaiter().GetResult()
    Write-Output "APP:$($s.SourceAppUserModelId) STATUS:$($pb.PlaybackStatus) TITLE:$($p.Title) ARTIST:$($p.Artist)"
  }
} catch { Write-Output "ERROR:$($_.Exception.Message)" }
`
      if (process.platform !== 'win32') { resolve('non-windows'); return }
      systemDetector._runPS(ps, out => resolve(out || 'no-output'))
    })

    return {
      platform: process.platform,
      detected: track,
      lastKey:  systemDetector._lastTrackKey,
      rawSmtc,
    }
  })

  ipcMain.handle('lyrics-from-renderer', (e, { track, result }) => {
    if (!result?.lines?.length) {
      sendToOverlay('lyrics-status', {
        status: 'not-found',
        message: 'Aucune parole trouvée. Placez un fichier .lrc à côté du fichier audio.'
      })
      return { ok: false }
    }
    syncEngine.loadLyrics(result)
    sendToOverlay('lyrics-status', {
      status:    'ready',
      synced:    result.synced,
      source:    result.source,
      lineCount: result.lines.length
    })
    return { ok: true }
  })

  ipcMain.handle('lrc-cache-get', (e, { artist, title }) => {
    return lrcCache.get(app.getPath('userData'), artist, title)
  })

  ipcMain.handle('lrc-cache-save', (e, { artist, title, lrc, plain }) => {
    return lrcCache.save(app.getPath('userData'), artist, title, lrc, plain)
  })

  ipcMain.handle('set-vlc-config', (e, { port, password }) => {
    if (port)                SystemDetector.vlcConfig.port     = parseInt(port)
    if (password !== undefined) SystemDetector.vlcConfig.password = password
    settings.set('vlcHttp', { port: SystemDetector.vlcConfig.port, password: SystemDetector.vlcConfig.password })
    return { ok: true, config: SystemDetector.vlcConfig }
  })

  ipcMain.handle('get-vlc-config', () => ({
    port:     SystemDetector.vlcConfig.port,
    password: SystemDetector.vlcConfig.password,
  }))

  ipcMain.handle('open-lrc-folder', () => {
    const dir = lrcCache.getCacheDir(app.getPath('userData'))
    shell.openPath(dir)
    return { dir }
  })

  ipcMain.handle('choose-lrc-folder', async () => {
    const result = await dialog.showOpenDialog(overlayWindow, {
      title:       'Choisir le dossier des fichiers .lrc',
      properties:  ['openDirectory', 'createDirectory']
    })
    if (result.canceled || !result.filePaths[0]) return { canceled: true }
    const dir = result.filePaths[0]
    lrcCache.setCustomDir(dir)
    settings.set('lrcCacheDir', dir)
    return { dir }
  })

  ipcMain.handle('reset-lrc-folder', () => {
    lrcCache.setCustomDir(null)
    settings.set('lrcCacheDir', null)
    const dir = lrcCache.getCacheDir(app.getPath('userData'))
    return { dir }
  })

  ipcMain.handle('open-file-dialog',  ()               => openLocalFile())
  ipcMain.handle('get-system-track',  ()               => systemDetector?.getCurrentTrack() || null)
  ipcMain.handle('get-settings',      ()               => settings.getAll())
  ipcMain.handle('get-cache-stats',   () => {
    const lrc = lrcCache.getStats(app.getPath('userData'))
    return { ...getCacheStats(app.getPath('userData')), lrcFiles: lrc.total, lrcSynced: lrc.synced, lrcDir: lrc.dir }
  })
  ipcMain.handle('clear-lyrics-cache',(e, t) => {
    clearCache(app.getPath('userData'), t?.artist, t?.title)
    lrcCache.clear(app.getPath('userData'), t?.artist, t?.title)
    return { ok: true }
  })
  ipcMain.handle('fetch-lyrics-manual',(e, track)      => triggerLyricsFetch(track))
  ipcMain.handle('jump-to-line',      (e, idx)         => { const t = syncEngine.jumpToLine(idx); if (t !== null) localPlayer?.seek(t); return { time: t } })
  ipcMain.handle('export-lrc',        (e, meta)        => syncEngine.exportLRC(meta))

  ipcMain.handle('player-command', async (e, { command, value }) => {
    switch (command) {
      case 'play':          localPlayer?.play();  break
      case 'pause':         localPlayer?.pause(); break
      case 'seek':          localPlayer?.seek(value); break
      case 'volume':        localPlayer?.setVolume(value); break
      case 'sync-position': syncEngine?.update(value); break
      case 'release':
        // Libère la source locale → le polling système reprend
        localPlayer?.releaseFile()
        syncEngine?.clear()
        sendToOverlay('track-released', {})
        break
    }
    return { ok: true }
  })

  ipcMain.on('window-drag',     (e, { deltaX, deltaY }) => {
    if (!overlayWindow) return
    const [x, y] = overlayWindow.getPosition()
    overlayWindow.setPosition(x + deltaX, y + deltaY)
  })
  ipcMain.on('window-resize',   (e, { width, height }) =>
    overlayWindow?.setSize(Math.max(300, Math.min(900, width)), Math.max(80, Math.min(400, height)))
  )
  ipcMain.on('set-opacity',     (e, v) => overlayWindow?.setOpacity(Math.max(0.2, Math.min(1, v))))
  ipcMain.on('set-passthrough', (e, v) => overlayWindow?.setIgnoreMouseEvents(v, { forward: true }))
  ipcMain.on('set-focusable',   (e, v) => {
    if (!overlayWindow) return
    overlayWindow.setFocusable(v)
    if (v) overlayWindow.focus()
  })
  ipcMain.on('sync-offset',     (e, v)   => { syncEngine.setOffset(v); settings.set('syncOffset', v) })
  ipcMain.on('sync-position',   (e, pos) => syncEngine?.update(pos))
  ipcMain.on('save-settings',   (e, patch) => {
    settings.patch(patch)
    if (patch.opacity !== undefined) overlayWindow?.setOpacity(patch.opacity)
  })
  ipcMain.on('open-url', (e, url) => shell.openExternal(url))
}

// ─── Helper ──────────────────────────────────────────────────────────────────

let rendererReady = false
let pendingTrack  = null   // dernier track détecté avant que le renderer soit prêt

function sendToOverlay(channel, data) {
  if (channel === 'system-position') {
    if (localPlayer?.hasFile()) return
    console.log(`[sendToOverlay] system-position pos=${data.position?.toFixed(2)} lines=${syncEngine?.lines?.length}`)
    syncEngine?.update(data.position)
    return
  }
  if (channel === 'system-seek') {
    if (localPlayer?.hasFile()) return
    syncEngine?.forceUpdate(data.position)
    return
  }
  if (channel === 'system-track-changed') {
    if (localPlayer?.hasFile()) return
    if (data.duration > 0) syncEngine?.setDuration(data.duration)
  }
  if (channel === 'system-track-duration') {
    if (localPlayer?.hasFile()) return
    syncEngine?.setDuration(data.duration)
    return   // pas besoin d'envoyer au renderer
  }
  if (channel === 'system-playback-state') {
    if (localPlayer?.hasFile()) return
  }
  if (overlayWindow && !overlayWindow.isDestroyed())
    overlayWindow.webContents.send(channel, data)
}

// ─── Boot ─────────────────────────────────────────────────────────────────────

app.whenReady().then(async () => {
  if (!app.requestSingleInstanceLock()) { app.quit(); return }

  settings       = new SettingsStore(app.getPath('userData'))
  // Restaurer le dossier .lrc custom si défini
  const savedLrcDir = settings.get('lrcCacheDir', null)
  if (savedLrcDir) lrcCache.setCustomDir(savedLrcDir)

  // Nettoyer les fichiers .lrc créés par erreur (faux tracks Spotify etc.)
  lrcCache.cleanFakeFiles(app.getPath('userData'), Array.from(IGNORED_TITLES))

  localPlayer    = new LocalFilePlayer(sendToOverlay)
  systemDetector = new SystemDetector(sendToOverlay)
  syncEngine     = new LyricsSyncEngine(sendToOverlay)

  // Restaurer l'offset de synchro
  syncEngine.setOffset(settings.get('syncOffset', 0))

  // Restaurer la config VLC HTTP
  const vlcCfg = settings.get('vlcHttp', {})
  if (vlcCfg.port)     SystemDetector.vlcConfig.port     = vlcCfg.port
  if (vlcCfg.password !== undefined) SystemDetector.vlcConfig.password = vlcCfg.password

  // Hook : position audio → moteur de sync (Phase 4)
  localPlayer._syncHook = (pos) => syncEngine.update(pos)

  // Hook : changement de piste système → fetch paroles (Phase 3)
  // Assigné AVANT startPolling pour éviter la race condition du premier poll
  systemDetector.onTrackChange = (track) => {
    if (localPlayer?.hasFile()) return
    lastFetchedKey = null   // forcer le re-fetch à chaque vrai changement de piste
    triggerLyricsFetch(track)
  }

  // IPC handlers avant la fenêtre — renderer-ready ne doit pas être manqué
  setupIpcHandlers()
  createOverlayWindow()
  createTray()
  registerShortcuts()

  // Polling après que la fenêtre et les IPC sont prêts
  await systemDetector.startPolling(2000)

  app.on('second-instance', () => { overlayWindow?.show(); overlayWindow?.focus() })
})

app.on('will-quit', () => {
  saveWindowBounds()
  settings?.save()
  globalShortcut.unregisterAll()
  systemDetector?.stopPolling()
  localPlayer?.destroy()
})

app.on('window-all-closed', () => {}) // Tray app — ne pas quitter