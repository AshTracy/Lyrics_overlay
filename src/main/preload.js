const { contextBridge, ipcRenderer } = require('electron')

const ALLOWED_CHANNELS = [
  'track-loaded', 'playback-position', 'playback-state',
  'track-ended',  'system-track-changed', 'volume-changed',
  'lyrics-loaded', 'lyrics-update', 'lyrics-status', 'lyrics-cleared',
  'settings-loaded', 'cache-cleared', 'error', 'track-released',
  'fetch-lyrics-request', 'system-playback-state', 'system-seek'
]

contextBridge.exposeInMainWorld('electronAPI', {
  // Fichiers
  openFileDialog:    ()             => ipcRenderer.invoke('open-file-dialog'),

  // Lecteur
  playerCommand:     (cmd, val)     => ipcRenderer.invoke('player-command', { command: cmd, value: val }),
  syncPosition:      (pos)          => ipcRenderer.send('sync-position', pos),

  // Système
  getSystemTrack:    ()             => ipcRenderer.invoke('get-system-track'),

  // Paroles — le renderer fait le fetch réseau (Chromium), puis envoie au main
  sendLyricsToMain:  (track, result) => ipcRenderer.invoke('lyrics-from-renderer', { track, result }),
  clearLyricsCache:  (track)        => ipcRenderer.invoke('clear-lyrics-cache', track),
  getCacheStats:     ()             => ipcRenderer.invoke('get-cache-stats'),
  // Cache .lrc local (dossier lyrics-cache/)
  getLrcFromCache:   (artist, title) => ipcRenderer.invoke('lrc-cache-get', { artist, title }),
  saveLrcToCache:    (artist, title, lrc, plain) => ipcRenderer.invoke('lrc-cache-save', { artist, title, lrc, plain }),
  getVlcConfig:      ()             => ipcRenderer.invoke('get-vlc-config'),
  setVlcConfig:      (cfg)          => ipcRenderer.invoke('set-vlc-config', cfg),
  chooseLrcFolder:   ()             => ipcRenderer.invoke('choose-lrc-folder'),
  resetLrcFolder:    ()             => ipcRenderer.invoke('reset-lrc-folder'),

  // Sync (Phase 4)
  setSyncOffset:     (secs)         => ipcRenderer.send('sync-offset', secs),
  jumpToLine:        (idx)          => ipcRenderer.invoke('jump-to-line', idx),
  exportLRC:         (meta)         => ipcRenderer.invoke('export-lrc', meta),

  // Fenêtre (Phase 1)
  dragWindow:        (dx, dy)       => ipcRenderer.send('window-drag',    { deltaX: dx, deltaY: dy }),
  resizeWindow:      (w, h)         => ipcRenderer.send('window-resize',  { width: w, height: h }),
  getWindowSize:     ()             => ipcRenderer.invoke('get-window-size'),
  diagnose:          ()             => ipcRenderer.invoke('diagnose-system-detection'),
  setOpacity:        (v)            => ipcRenderer.send('set-opacity',    v),
  setPassthrough:    (v)            => ipcRenderer.send('set-passthrough', v),
  setFocusable:      (v)            => ipcRenderer.send('set-focusable',   v),

  // Paramètres (Phase 5)
  getSettings:       ()             => ipcRenderer.invoke('get-settings'),
  saveSettings:      (patch)        => ipcRenderer.send('save-settings', patch),

  // Signaler au main que le renderer est prêt à recevoir des événements
  signalReady:       ()             => ipcRenderer.send('renderer-ready'),

  // URL externe
  openUrl:           (url)          => ipcRenderer.send('open-url', url),

  // Événements reçus du main
  on: (channel, cb) => {
    if (!ALLOWED_CHANNELS.includes(channel)) return () => {}
    const fn = (_, data) => cb(data)
    ipcRenderer.on(channel, fn)
    return () => ipcRenderer.removeListener(channel, fn)
  }
})