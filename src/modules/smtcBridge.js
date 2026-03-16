/**
 * smtcBridge.js
 * Lance smtc_bridge.py en processus enfant et lit les états JSON sur stdout.
 * Plus fiable que les scripts PowerShell one-shot : processus persistant, async Python.
 *
 * Nécessite : pip install winsdk  (Windows 10/11 uniquement)
 */

const { spawn }  = require('child_process')
const path        = require('path')
const fs          = require('fs')

class SmtcBridge {
  constructor() {
    this._proc       = null
    this._ready      = false
    this._lastState  = null
    this._callbacks  = []   // listeners onState(state)
    this._buffer     = ''
    this._available  = null // null=inconnu, true/false
  }

  // Chercher le vrai exécutable Python (évite les alias Microsoft Store)
  static async findPython() {
    const { execFile, exec } = require('child_process')

    if (process.platform === 'win32') {
      // 1. Essayer `py` (Python Launcher for Windows) — toujours un vrai binaire
      const pyLauncher = await new Promise(resolve => {
        execFile('py', ['--version'], { timeout: 3000, windowsHide: true }, (err, stdout, stderr) => {
          const out = (stdout || stderr || '').toLowerCase()
          resolve(!err && out.includes('python') ? 'py' : null)
        })
      })
      if (pyLauncher) return pyLauncher

      // 2. `where.exe python` — retourne le vrai chemin, ignore les alias Store
      const wherePath = await new Promise(resolve => {
        exec('where python', { timeout: 3000, windowsHide: true }, (err, stdout) => {
          if (err || !stdout) { resolve(null); return }
          // where.exe peut retourner plusieurs lignes — prendre la première qui n'est pas WindowsApps
          const lines = stdout.trim().split('\n').map(l => l.trim()).filter(Boolean)
          const real  = lines.find(l => !l.toLowerCase().includes('windowsapps'))
          resolve(real || null)
        })
      })
      if (wherePath) return wherePath

      // 3. Emplacements standards selon version Python
      const localApp = process.env.LOCALAPPDATA || ''
      const userProfile = process.env.USERPROFILE || ''
      const candidates = [
        path.join(localApp, 'Programs', 'Python', 'Python313', 'python.exe'),
        path.join(localApp, 'Programs', 'Python', 'Python312', 'python.exe'),
        path.join(localApp, 'Programs', 'Python', 'Python311', 'python.exe'),
        path.join(localApp, 'Programs', 'Python', 'Python310', 'python.exe'),
        path.join(localApp, 'Programs', 'Python', 'Python39',  'python.exe'),
        'C:\\Python313\\python.exe',
        'C:\\Python312\\python.exe',
        'C:\\Python311\\python.exe',
        'C:\\Python310\\python.exe',
        'C:\\Python39\\python.exe',
        path.join(userProfile, 'AppData', 'Local', 'Programs', 'Python', 'Python313', 'python.exe'),
        path.join(userProfile, 'AppData', 'Local', 'Programs', 'Python', 'Python312', 'python.exe'),
      ]
      for (const p of candidates) {
        if (p && fs.existsSync(p)) return p
      }

      return null
    }

    // macOS / Linux — PATH standard suffit
    for (const cmd of ['python3', 'python']) {
      const found = await new Promise(resolve => {
        execFile(cmd, ['--version'], { timeout: 3000 }, (err) => resolve(!err))
      })
      if (found) return cmd
    }
    return null
  }

  get isAvailable() { return this._available === true }
  get isRunning()   { return this._proc !== null }

  // Démarrer le bridge — retourne une Promise<boolean> (true = winsdk dispo)
  start() {
    if (this._proc) return Promise.resolve(true)

    return new Promise(async (resolve) => {
      const scriptPath = path.join(__dirname, 'smtc_bridge.py')

      if (!fs.existsSync(scriptPath)) {
        console.warn('[SmtcBridge] smtc_bridge.py introuvable')
        this._available = false
        resolve(false)
        return
      }

      const pythonCmd = await SmtcBridge.findPython()
      if (!pythonCmd) {
        console.warn('[SmtcBridge] Python introuvable. Installez Python depuis https://python.org ou le Microsoft Store.')
        this._available = false
        resolve(false)
        return
      }

      console.log(`[SmtcBridge] Python trouvé : ${pythonCmd}`)

      let proc
      try {
        proc = spawn(pythonCmd, [scriptPath], {
          stdio:       ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
        })
      } catch (err) {
        console.warn('[SmtcBridge] Impossible de lancer Python:', err.message)
        this._available = false
        resolve(false)
        return
      }

      this._proc = proc

      // Lire stdout ligne par ligne
      proc.stdout.setEncoding('utf8')
      proc.stdout.on('data', (chunk) => {
        this._buffer += chunk
        const lines = this._buffer.split('\n')
        this._buffer = lines.pop()   // garder le fragment incomplet

        for (const line of lines) {
          const trimmed = line.trim()
          if (!trimmed) continue
          try {
            const state = JSON.parse(trimmed)

            if (state.ready) {
              this._ready     = true
              this._available = true
              console.log('[SmtcBridge] Prêt')
              resolve(true)
              continue
            }

            if (state.error === 'winsdk_not_installed') {
              console.warn('[SmtcBridge] winsdk non installé. Installez avec : pip install winsdk')
              this._available = false
              resolve(false)
              continue
            }

            this._lastState = state
            this._callbacks.forEach(cb => {
              try { cb(state) } catch (_) {}
            })

          } catch (_) {}
        }
      })

      proc.stderr.on('data', (data) => {
        const msg = data.toString().trim()
        if (msg) console.warn('[SmtcBridge stderr]', msg.substring(0, 200))
      })

      proc.on('exit', (code) => {
        console.log(`[SmtcBridge] Processus terminé (code ${code})`)
        this._proc  = null
        this._ready = false
        if (this._available === null) {
          this._available = false
          resolve(false)
        }
      })

      proc.on('error', (err) => {
        console.warn('[SmtcBridge] Erreur:', err.message)
        this._proc      = null
        this._available = false
        resolve(false)
      })

      // Timeout : si pas de réponse après 5s, Python introuvable ou erreur
      setTimeout(() => {
        if (!this._ready && this._available === null) {
          console.warn('[SmtcBridge] Timeout au démarrage')
          this._available = false
          resolve(false)
        }
      }, 5000)
    })
  }

  // Arrêter le processus Python
  stop() {
    if (this._proc) {
      this._proc.kill()
      this._proc = null
    }
    this._ready = false
  }

  // S'abonner aux mises à jour d'état
  onState(cb) {
    this._callbacks.push(cb)
    return () => {
      this._callbacks = this._callbacks.filter(c => c !== cb)
    }
  }

  // Dernier état connu
  getLastState() { return this._lastState }
}

module.exports = SmtcBridge