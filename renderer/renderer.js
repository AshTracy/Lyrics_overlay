/**
 * renderer.js — Overlay UI complet (Phases 1–5)
 */

const api = window.electronAPI
const $   = id => document.getElementById(id)

// ─── État ─────────────────────────────────────────────────────────────────────
let state = {
  playing:    false,
  position:   0,
  duration:   0,
  source:     null,
  track:      null,
  lyricsReady: false,
  synced:     false,
  lyricsSource: null
}

// ─── DOM ──────────────────────────────────────────────────────────────────────
const elApp         = $('app')
const elTitle       = $('track-title')
const elArtist      = $('track-artist')
const elCover       = $('cover')
const elBadge       = $('source-badge')
const elBtnOpen     = $('btn-open')
const elBtnPlay     = $('btn-play')
const elBtnSettings = $('btn-settings')
const elBtnClose    = $('btn-close')
const elProgress    = $('progress-bar')
const elFill        = $('progress-fill')
const elLyricsZone  = $('lyrics-zone')
const elEmpty       = $('empty-state')
const elStatus      = $('lyrics-status')
const elLinePrev    = $('line-prev')
const elLineCurr    = $('line-curr')
const elLineNext    = $('line-next')
const elSettings    = $('settings-panel')
const elOpenBtn     = $('open-btn')

// ─── Phase 1 : Resize ─────────────────────────────────────────────────────────
// Drag is handled natively via -webkit-app-region:drag in CSS — no JS needed.
{
  const handle = $('resize-handle')
  let resizing = false, sx = 0, sy = 0, sw = 0, sh = 0

  handle.addEventListener('mousedown', async e => {
    e.preventDefault(); e.stopPropagation()
    const size = await api.getWindowSize()
    sw = size.width; sh = size.height
    sx = e.screenX; sy = e.screenY
    resizing = true
  })
  document.addEventListener('mousemove', e => {
    if (!resizing) return
    api.resizeWindow(sw + (e.screenX - sx), sh + (e.screenY - sy))
  })
  document.addEventListener('mouseup', () => { resizing = false })
}

// ─── Audio Web (lecture réelle via Chromium) ──────────────────────────────────
let audioEl = null

function createAudio(filePath) {
  if (audioEl) { audioEl.pause(); audioEl.src = ''; audioEl = null }
  audioEl = new Audio(filePath)
  audioEl.addEventListener('ended', () => {
    state.playing = false
    elBtnPlay.textContent = '▶'
    elLineCurr.classList.remove('playing')
    // Fin de piste → libérer la source locale, le polling Spotify reprend
    setTimeout(() => api.playerCommand('release'), 1500)
  })
  audioEl.addEventListener('error', () => showStatus('⚠ Erreur lecture audio', 4000))
  return audioEl
}



// ─── Contrôles basiques ───────────────────────────────────────────────────────
elBtnClose.addEventListener('click', () => api.playerCommand('quit'))
elBtnOpen.addEventListener('click', () => api.openFileDialog())

// Bouton ⏏ : relâche la source locale, le polling Spotify reprend
const elBtnRelease = $('btn-release')
elBtnRelease.addEventListener('click', () => {
  if (audioEl) { audioEl.pause(); audioEl.src = ''; audioEl = null }
  state.source  = null
  state.playing = false
  elBtnPlay.style.display    = 'none'
  elBtnRelease.style.display = 'none'
  resetLyricLines()
  showStatus('Mode détection système actif', 3000)
  api.playerCommand('release')
})
elOpenBtn.addEventListener('click', () => api.openFileDialog())
elBtnPlay.addEventListener('click', () => {
  if (state.source !== 'local' || !audioEl) return
  if (state.playing) {
    audioEl.pause()
    state.playing = false
    elBtnPlay.textContent = '▶'
    elLineCurr.classList.remove('playing')
    api.playerCommand('pause')  // notifie le main pour le ticker de sync
  } else {
    audioEl.play()
    state.playing = true
    elBtnPlay.textContent = '⏸'
    elLineCurr.classList.add('playing')
    api.playerCommand('play')
  }
})
elProgress.addEventListener('click', e => {
  if (!state.duration || state.source !== 'local') return
  const r    = elProgress.getBoundingClientRect()
  const secs = ((e.clientX - r.left) / r.width) * state.duration
  if (audioEl) audioEl.currentTime = secs
  api.playerCommand('seek', secs)
})

// ─── Phase 3 : Clic sur une ligne → seek ─────────────────────────────────────
;[elLinePrev, elLineCurr, elLineNext].forEach(el => {
  el.addEventListener('click', () => {
    const idx = parseInt(el.dataset.idx)
    if (!isNaN(idx) && idx >= 0) api.jumpToLine(idx)
  })
})

// ─── Phase 5 : Paramètres ─────────────────────────────────────────────────────
elBtnSettings.addEventListener('click', () => {
  const isOpen = elSettings.classList.toggle('open')
  api.setFocusable(isOpen)
})

// Thèmes
document.querySelectorAll('.theme-btn[data-theme]').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.theme-btn[data-theme]').forEach(b => b.classList.remove('active'))
    btn.classList.add('active')
    const theme = btn.dataset.theme
    elApp.dataset.theme = theme
    api.saveSettings({ theme })
  })
})

// Lignes visibles
document.querySelectorAll('.theme-btn[data-lines]').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.theme-btn[data-lines]').forEach(b => b.classList.remove('active'))
    btn.classList.add('active')
    const n = parseInt(btn.dataset.lines)
    setLinesVisible(n)
    api.saveSettings({ linesVisible: n })
  })
})

function setLinesVisible(n) {
  elLinePrev.style.display = n >= 3 ? '' : 'none'
  elLineNext.style.display = n >= 3 ? '' : 'none'
}

// Opacité
const slOpacity = $('sl-opacity')
const vlOpacity = $('vl-opacity')
slOpacity.addEventListener('input', e => {
  const v = parseInt(e.target.value) / 100
  vlOpacity.textContent = e.target.value + '%'
  api.setOpacity(v)
  api.saveSettings({ opacity: v })
})

// Taille de police
const slFont = $('sl-fontsize')
const vlFont = $('vl-fontsize')
slFont.addEventListener('input', e => {
  const sz = parseInt(e.target.value)
  vlFont.textContent = sz
  elLyricsZone.style.setProperty('--font-size', sz + 'px')
  api.saveSettings({ fontSize: sz })
})

// Phase 4 : Décalage sync
const slOffset = $('sl-offset')
const dispOffset = $('offset-display')
slOffset.addEventListener('input', e => {
  const secs = parseInt(e.target.value) / 1000
  dispOffset.textContent = (secs >= 0 ? '+' : '') + secs.toFixed(1) + 's'
  api.setSyncOffset(secs)
})

// Passthrough
$('cb-passthrough').addEventListener('change', e => {
  api.setPassthrough(e.target.checked)
  api.saveSettings({ passthrough: e.target.checked })
})

// Cover art toggle
$('cb-cover').addEventListener('change', e => {
  elCover.style.display = e.target.checked ? '' : 'none'
  api.saveSettings({ showCoverArt: e.target.checked })
})

// Vider cache
$('btn-clear-cache').addEventListener('click', async () => {
  await api.clearLyricsCache(state.track)
  showStatus('Cache vidé ✓', 2000)
  updateCacheStats()
})

// Diagnostic détection système
$('btn-diagnose').addEventListener('click', async () => {
  showStatus('<span class="spinner">⟳</span> Diagnostic en cours…')
  const result = await api.diagnose()
  if (result.detected) {
    showStatus(`✓ ${result.detected.artist || '(artiste inconnu)'} — ${result.detected.title} [${result.detected.source}]`, 10000)
  } else if (result.rawSmtc && result.rawSmtc !== 'no-output' && result.rawSmtc !== 'non-windows') {
    showStatus(`⚠ SMTC brut : ${result.rawSmtc.substring(0, 120)}`, 12000)
  } else {
    showStatus(`✗ Rien détecté (${result.platform}). Player ouvert et en lecture ?`, 8000)
  }
})

// Dossier .lrc
if ($('btn-open-lrc-folder')) {
  $('btn-open-lrc-folder').addEventListener('click', async () => {
    const r = await api.openLrcFolder()
    showStatus(`📁 Dossier ouvert : ${r.dir}`, 5000)
  })
}
if ($('btn-choose-lrc-folder')) {
  $('btn-choose-lrc-folder').addEventListener('click', async () => {
    const r = await api.chooseLrcFolder()
    if (!r.canceled) {
      showStatus(`✓ Dossier .lrc : ${r.dir}`, 5000)
      updateCacheStats()
    }
  })
}
if ($('btn-reset-lrc-folder')) {
  $('btn-reset-lrc-folder').addEventListener('click', async () => {
    const r = await api.resetLrcFolder()
    showStatus(`↩ Dossier réinitialisé : ${r.dir}`, 5000)
    updateCacheStats()
  })
}

// Seek système (avance rapide Spotify etc.)
api.on('system-seek', data => {
  // Le main a déjà mis à jour syncEngine — juste afficher l'indicateur visuel
  showStatus(`⏩ Position : ${Math.floor(data.position / 60)}:${String(Math.floor(data.position % 60)).padStart(2,'0')}`, 1500)
})

// Pause/play système
api.on('system-playback-state', data => {
  state.playing = data.playing
  elBtnPlay.textContent = data.playing ? '⏸' : '▶'
  elLineCurr.classList.toggle('playing', data.playing)
})

// VLC HTTP config
;(async () => {
  const cfg = await api.getVlcConfig()
  if ($('vlc-port'))     $('vlc-port').value     = cfg.port     || 8080
  if ($('vlc-password')) $('vlc-password').value = cfg.password || ''
})()

if ($('btn-vlc-show')) {
  $('btn-vlc-show').addEventListener('click', () => {
    const inp = $('vlc-password')
    inp.type = inp.type === 'password' ? 'text' : 'password'
    $('btn-vlc-show').textContent = inp.type === 'password' ? '👁' : '🙈'
  })
}

if ($('btn-vlc-save')) {
  $('btn-vlc-save').addEventListener('click', async () => {
    const port     = $('vlc-port')?.value
    const password = $('vlc-password')?.value ?? ''
    await api.setVlcConfig({ port, password })
    const status = $('vlc-config-status')
    if (status) {
      status.textContent = `✓ Sauvegardé (port ${port})`
      setTimeout(() => { status.textContent = '' }, 3000)
    }
  })
}

if ($('btn-vlc-test')) {
  $('btn-vlc-test').addEventListener('click', async () => {
    const status = $('vlc-config-status')
    if (status) status.textContent = '⟳ Test en cours…'
    // Sauvegarder d'abord les valeurs courantes
    const port     = $('vlc-port')?.value
    const password = $('vlc-password')?.value ?? ''
    await api.setVlcConfig({ port, password })
    // Tester la connexion via fetch direct depuis le renderer
    try {
      const auth = btoa(`:${password}`)
      const resp = await fetch(`http://localhost:${port}/requests/status.json`, {
        headers: { Authorization: `Basic ${auth}` },
        signal: AbortSignal.timeout(3000)
      })
      if (resp.status === 200) {
        const data = await resp.json()
        if (status) status.textContent = `✓ Connecté — VLC ${data.state || 'OK'}`
      } else if (resp.status === 403) {
        if (status) status.textContent = '✗ Mot de passe incorrect'
      } else {
        if (status) status.textContent = `✗ Erreur HTTP ${resp.status}`
      }
    } catch (e) {
      if (status) status.textContent = '✗ VLC inaccessible — interface HTTP activée ?'
    }
    setTimeout(() => { if (status) status.textContent = '' }, 5000)
  })
}

async function updateCacheStats() {
  const stats = await api.getCacheStats()
  const lrcPart = stats.lrcFiles ? ` · ${stats.lrcFiles} .lrc` : ''
  $('cache-stats').textContent = `${stats.total || 0} SQLite${lrcPart}`
  if (stats.lrcDir && $('lrc-folder-path')) {
    $('lrc-folder-path').textContent = stats.lrcDir
    $('lrc-folder-path').title = stats.lrcDir
  }
}

// ─── Phase 5 : Charger les préférences sauvegardées ──────────────────────────
api.on('settings-loaded', prefs => {
  if (!prefs) return

  // Thème
  if (prefs.theme) {
    elApp.dataset.theme = prefs.theme
    document.querySelectorAll('.theme-btn[data-theme]').forEach(b => {
      b.classList.toggle('active', b.dataset.theme === prefs.theme)
    })
  }

  // Opacité
  if (prefs.opacity !== undefined) {
    const pct = Math.round(prefs.opacity * 100)
    slOpacity.value = pct; vlOpacity.textContent = pct + '%'
  }

  // Police
  if (prefs.fontSize) {
    slFont.value = prefs.fontSize; vlFont.textContent = prefs.fontSize
    elLyricsZone.style.setProperty('--font-size', prefs.fontSize + 'px')
  }

  // Offset
  if (prefs.syncOffset !== undefined) {
    slOffset.value = prefs.syncOffset * 1000
    const s = prefs.syncOffset
    dispOffset.textContent = (s >= 0 ? '+' : '') + s.toFixed(1) + 's'
  }

  // Autres
  if (prefs.passthrough) $('cb-passthrough').checked = prefs.passthrough
  if (prefs.showCoverArt === false) { $('cb-cover').checked = false; elCover.style.display = 'none' }
  if (prefs.linesVisible) setLinesVisible(prefs.linesVisible)

  updateCacheStats()
})

// ─── Phase 2 : Événements audio ──────────────────────────────────────────────

api.on('track-loaded', data => {
  state.source   = data.source
  state.duration = data.duration || 0
  state.playing  = false
  state.track    = data

  elTitle.textContent  = data.title  || '—'
  elArtist.textContent = data.artist || '—'

  // Pochette
  elCover.innerHTML = ''
  if (data.coverArt) {
    const img = document.createElement('img')
    img.src = data.coverArt
    elCover.appendChild(img)
  } else {
    elCover.textContent = '♪'
  }

  elBadge.style.display = ''
  elBadge.textContent   = data.source === 'local' ? 'LOCAL' : 'SYSTÈME'
  elBadge.className     = data.source === 'local' ? 'local' : 'system'

  elBtnPlay.style.display    = data.source === 'local' ? '' : 'none'
  elBtnRelease.style.display = data.source === 'local' ? '' : 'none'
  elBtnPlay.textContent = '▶'

  elFill.style.width = '0%'
  showLyricsZone()
  resetLyricLines()

  // Créer l'élément audio et le connecter au moteur de sync via IPC
  if (data.source === 'local' && data.filePath) {
    const audio = createAudio(data.filePath)

    // timeupdate → envoyer la position au main (ticker de sync)
    audio.addEventListener('timeupdate', () => {
      const pos = audio.currentTime
      state.position = pos
      if (state.duration > 0)
        elFill.style.width = ((pos / state.duration) * 100) + '%'
      // Envoyer au main pour le moteur de sync (fire-and-forget)
      api.syncPosition(pos)
    })

    // Auto-play dès que le fichier est prêt
    audio.addEventListener('canplay', () => {
      if (!state.playing) {
        audio.play().then(() => {
          state.playing = true
          elBtnPlay.textContent = '⏸'
          elLineCurr.classList.add('playing')
          api.playerCommand('play')
        }).catch(() => {})
      }
    }, { once: true })
  }
})

api.on('system-track-changed', data => {
  if (state.source === 'local' && state.playing) return
  if (audioEl && !state.playing) {
    audioEl.pause(); audioEl.src = ''; audioEl = null
  }

  state.source   = 'system'
  state.track    = data
  state.playing  = data.playing !== false  // respecter l'état reçu (pause VLC etc.)
  state.position = data.position || 0
  state.duration = 0

  elTitle.textContent  = data.title  || '—'
  elArtist.textContent = data.artist || '—'
  elCover.innerHTML    = ''
  elCover.textContent  = '♪'

  // Astuce VLC : si API HTTP non dispo, afficher un conseil
  if (data.source === 'vlc' && !data.vlcHttpAvailable) {
    showStatus('💡 VLC : activer Interface Web (Outils→Préférences→Interface) pour détecter la pause', 8000)
  }

  elBadge.style.display = ''
  // Badge avec le nom du player détecté
  const sourceName = {
    spotify:          'SPOTIFY',
    vlc:              'VLC',
    itunes:           'ITUNES',
    groove:           'GROOVE',
    foobar2000:       'FOOBAR',
    'mpc-hc':         'MPC-HC',
    'mpc-hc64':       'MPC-HC',
    wmplayer:         'WMP',
    windowsmediaplayer: 'WMP',
    mediaplayer:      'WMP',
    mediaplayerapp:   'WMP',
    'windows-media':  'MEDIA PLAYER',
    winamp:           'WINAMP',
    aimp:             'AIMP',
    musicbee:         'MUSICBEE',
    mediamonkey:      'MEDIAMONKEY',
    music:            'APPLE MUSIC',
    mpris:            'MPRIS',
    windows:          'SYSTÈME',
  }
  elBadge.textContent = sourceName[data.source] || data.source?.toUpperCase() || 'SYSTÈME'
  elBadge.className   = 'system'

  elBtnPlay.style.display = 'none'   // on ne contrôle pas Spotify
  elFill.style.width = '0%'
  showLyricsZone()
  resetLyricLines()
})

api.on('playback-position', data => {
  state.position = data.position
  state.duration = data.duration
  if (state.duration > 0)
    elFill.style.width = ((state.position / state.duration) * 100) + '%'
})

api.on('playback-state', data => {
  state.playing = data.playing
  elBtnPlay.textContent = data.playing ? '⏸' : '▶'
  elLineCurr.classList.toggle('playing', data.playing)
})

// ─── Phase 3 : Fetch des paroles (côté renderer, réseau Chromium) ────────────

// Parser LRC inline — pas de dépendance externe
function _parseLRC(text) {
  const lines = [], off = { ms: 0 }
  for (const raw of text.split('\n')) {
    const meta = raw.match(/^\[offset:\s*([+-]?\d+)\s*\]/i)
    if (meta) { off.ms = parseInt(meta[1]); continue }
    const re    = /\[(\d{1,3}):(\d{2})[.:](\d{1,3})\]/g
    const txt   = raw.replace(/\[\d{1,3}:\d{2}[.:]\d{1,3}\]/g, '').trim()
    if (!txt) continue
    let m
    while ((m = re.exec(raw)) !== null) {
      const secs = parseInt(m[1]) * 60 + parseInt(m[2]) + parseInt(m[3].padEnd(3,'0')) / 1000
      lines.push({ time: Math.max(0, secs + off.ms / 1000), text: txt })
    }
  }
  lines.sort((a, b) => a.time - b.time)
  return { lines, synced: lines.some(l => l.time > 0) }
}

function _parsePlain(text) {
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean).map((t, i) => ({ time: i, text: t }))
  return { lines, synced: false }
}

function _normalizeStr(s) {
  return (s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9 ]/g, '').trim()
}

const FAKE_TITLES = new Set(['spotify free','spotify premium','advertisement','publicité','spotify','unknown','untitled',''])

async function fetchLyricsRenderer(track) {
  const { title, artist = '', filePath } = track
  if (!title) return null

  // Ignorer les faux tracks Spotify (publicités, écrans vides…)
  if (FAKE_TITLES.has(title.toLowerCase().trim()) || /^spotify\b/i.test(title)) {
    return null
  }

  // 1. Cache .lrc local (dossier lyrics-cache dans userData)
  // Le main nous donne le chemin via api.getLrcCachePath()
  try {
    const cached = await api.getLrcFromCache(artist, title)
    if (cached?.lrc) {
      return { ..._parseLRC(cached.lrc), source: 'cache-local' }
    }
  } catch (e) {
    console.warn('[Fetch] Erreur cache local:', e.message)
  }

  // 2. Fichier .lrc/.srt/.txt adjacent au fichier audio
  if (filePath) {
    const base = filePath.replace(/\.[^.]+$/, '')
    for (const ext of ['.lrc', '.srt', '.txt']) {
      try {
        const url  = 'file:///' + base.replace(/\\/g, '/') + ext
        const resp = await fetch(url, { signal: AbortSignal.timeout(2000) })
        if (!resp.ok) continue
        const txt = await resp.text()
        if (!txt.trim()) continue
        if (ext === '.lrc' || ext === '.srt') return { ..._parseLRC(txt), source: 'local-file' }
        return { ..._parsePlain(txt), source: 'local-file' }
      } catch (_) {}
    }
  }

  // 3. LRCLIB via Chromium fetch
  try {
    const q    = artist ? `${artist} ${title}` : title
    const url  = `https://lrclib.net/api/search?q=${encodeURIComponent(q)}`

    const resp = await fetch(url, {
      headers: { 'Accept': 'application/json' },
      signal:  AbortSignal.timeout(10000)
    })

    if (resp.ok) {
      const data = await resp.json()

      if (data?.length) {
        const norm       = _normalizeStr(title)
        const candidates = data.filter(r => {
          const t = _normalizeStr(r.trackName || '')
          return t === norm || t.includes(norm) || norm.includes(t)
        })

        const pool = candidates.length ? candidates : data
        const best = pool.find(r => r.syncedLyrics) || pool[0]

        if (best?.syncedLyrics) {
          const parsed = _parseLRC(best.syncedLyrics)
          // Sauvegarder dans le cache local
          api.saveLrcToCache(artist, title, best.syncedLyrics).catch(() => {})
          return { ...parsed, source: 'lrclib' }
        }
        if (best?.plainLyrics) {
          const parsed = _parsePlain(best.plainLyrics)
          api.saveLrcToCache(artist, title, null, best.plainLyrics).catch(() => {})
          return { ...parsed, source: 'lrclib-plain' }
        }
      }
    } else {
      const body = await resp.text()
      console.warn('[Fetch] LRCLIB erreur body:', body.substring(0, 200))
    }
  } catch (e) {
    console.warn('[Fetch] LRCLIB exception:', e.message)
  }

  console.warn('[Fetch] Aucune parole trouvée')
  return null
}

api.on('fetch-lyrics-request', async data => {
  const { track } = data
  try {
    const result = await fetchLyricsRenderer(track)
    await api.sendLyricsToMain(track, result)
  } catch (e) {
    console.warn('[Renderer fetch] erreur:', e.message)
    await api.sendLyricsToMain(track, null)
  }
})

// ─── Phase 3 : Status des paroles ────────────────────────────────────────────

api.on('lyrics-status', data => {
  switch (data.status) {
    case 'fetching':
      showStatus('<span class="spinner">⟳</span> Recherche des paroles…')
      break
    case 'ready':
      state.lyricsReady = true
      state.synced      = data.synced
      state.lyricsSource = data.source
      const syncLabel = data.synced ? '✓ Sync' : '~ Non sync'
      showStatus(`${syncLabel} · ${data.lineCount} lignes · ${formatSource(data.source)}`, 3000)
      break
    case 'not-found':
      state.lyricsReady = false
      showStatus(data.message || '✗ Paroles introuvables', 6000)
      elLineCurr.textContent = '♪'
      break
    case 'error':
      showStatus(`⚠ ${data.message}`, 4000)
      break
  }
})

// ─── Phase 4 : Mise à jour de la ligne active ─────────────────────────────────

let _lyricsTransitioning = false

api.on('lyrics-update', data => {
  if (!data) return

  const prevIdx = parseInt(elLineCurr.dataset.idx ?? '-999')
  const newIdx  = data.curr?.idx ?? -1
  const changed = newIdx !== prevIdx

  if (data.prev) {
    elLinePrev.textContent = data.prev.text
    elLinePrev.dataset.idx = data.prev.idx
    elLinePrev.className   = 'lyric-line'
  } else {
    elLinePrev.textContent = ''
    elLinePrev.className   = 'lyric-line'
  }

  if (data.curr) {
    elLineCurr.textContent = data.curr.text
    elLineCurr.dataset.idx = data.curr.idx
    elLineCurr.className   = 'lyric-line active' + (state.playing ? ' playing' : '')
  } else {
    elLineCurr.textContent = '♪'
    elLineCurr.className   = 'lyric-line active'
  }

  if (data.next) {
    elLineNext.textContent = data.next.text
    elLineNext.dataset.idx = data.next.idx
    elLineNext.className   = 'lyric-line next'
  } else {
    elLineNext.textContent = ''
    elLineNext.className   = 'lyric-line'
  }

  // Fade-in only on line change — content is already updated above
  if (changed && !_lyricsTransitioning) {
    _lyricsTransitioning = true
    elLyricsZone.classList.add('transitioning')
    requestAnimationFrame(() => {
      elLyricsZone.classList.remove('transitioning')
      setTimeout(() => { _lyricsTransitioning = false }, 300)
    })
  }
})

api.on('lyrics-cleared', () => resetLyricLines())
api.on('error', data => { showStatus(`⚠ ${data.message}`, 5000) })

// Set beat animation speed from estimated BPM
api.on('lyrics-loaded', data => {
  if (data?.bpm) {
    const beatSec = (60 / data.bpm).toFixed(3)
    document.documentElement.style.setProperty('--beat-duration', `${beatSec}s`)
  }
})
api.on('vlc-auth-error', () => {
  showStatus('🔒 VLC : mot de passe requis — ouvrez ⚙ Paramètres › Interface HTTP VLC', 8000)
})

// ─── Helpers ──────────────────────────────────────────────────────────────────

function showLyricsZone() {
  elEmpty.style.display = 'none'
  elLyricsZone.classList.add('visible')
}

function resetLyricLines() {
  elLinePrev.textContent = ''; elLinePrev.dataset.idx = '-1'
  elLineCurr.textContent = '♪'; elLineCurr.dataset.idx = '0'
  elLineCurr.className   = 'lyric-line active'
  elLineNext.textContent = ''; elLineNext.dataset.idx = '1'
}

let statusTimer = null
function showStatus(html, autoClearMs = 0) {
  elStatus.innerHTML = html
  elStatus.classList.add('visible')
  clearTimeout(statusTimer)
  if (autoClearMs > 0)
    statusTimer = setTimeout(() => elStatus.classList.remove('visible'), autoClearMs)
}

function formatSource(src) {
  if (!src) return ''
  if (src === 'cache-local')          return '💾 cache local'
  if (src.includes('local-file'))     return '📁 fichier local'
  if (src.includes('lrclib'))         return '🌐 LRCLIB'
  if (src.includes('genius'))         return '🌐 Genius'
  if (src.includes('cached'))         return '💾 cache'
  return src
}

// ─── Init ─────────────────────────────────────────────────────────────────────
;(async () => {
  updateCacheStats()
  // Signaler au main que tous les listeners sont en place
  // → le main peut maintenant envoyer fetch-lyrics-request sans risque
  api.signalReady()
})()