# 🎵 Lyrics Overlay

Fenêtre transparente always-on-top qui affiche les paroles synchronisées en temps réel pendant la lecture musicale. Fonctionne avec Spotify, VLC, Windows Media Player, foobar2000, et tout player enregistré dans SMTC.

---

## Structure du projet

```
lyrics-overlay/
├── package.json
├── .gitignore
├── build-assets/           ← Icônes pour le build (.ico, .icns, .png)
├── src/
│   ├── main/
│   │   ├── index.js        ← Processus principal Electron
│   │   └── preload.js      ← Pont IPC sécurisé (contextIsolation)
│   └── modules/
│       ├── systemDetector.js   ← Détection système multi-player + arbitrage sources
│       ├── smtcBridge.js       ← Gestionnaire du bridge Python SMTC
│       ├── smtc_bridge.py      ← Bridge Python winsdk (Spotify/SMTC)
│       ├── localFilePlayer.js  ← Lecture fichiers audio locaux
│       ├── lyricsParser.js     ← Parser LRC / SRT / TXT
│       ├── lyricsFetcher.js    ← Stub de compatibilité (fetch déplacé dans le renderer)
│       ├── lyricsSyncEngine.js ← Synchronisation position → ligne active
│       ├── lrcCache.js         ← Cache fichiers .lrc locaux
│       └── settingsStore.js    ← Préférences persistantes JSON
└── renderer/
    ├── overlay.html        ← UI (palette #835D8D / #38E8FF / #DFE6FF)
    └── renderer.js         ← Logique UI + fetch paroles (Chromium fetch)
```

---

## Installation

```bash
npm install
npm run dev    # Lancer en mode développement
npm start      # Mode production
```

### Dépendance optionnelle — Bridge Python (recommandé pour Spotify)

```bash
pip install winsdk
```

Requiert Python 3.8+ et Windows 10/11. L'app cherche Python via le launcher `py`, puis `where python` (en ignorant les alias Microsoft Store), puis les chemins standards. Si absent, fallback automatique sur les scripts PowerShell SMTC.

---

## Build (.exe)

```bash
npm run build          # Génère dist/Lyrics Overlay Setup 2.0.0.exe
npm run publish        # Build + upload vers GitHub Releases
npm run publish:draft  # Build + upload en draft (à publier manuellement)
```

Pour `publish`, définir `GH_TOKEN` dans le terminal :

```powershell
$env:GH_TOKEN = "ghp_votre_token"
npm run publish
```

Placer `build-assets/icon.ico` (format ICO multi-résolution, 256×256 recommandé) avant le build. Sans icône, electron-builder utilise l'icône Electron par défaut.

Pour générer un `.ico` depuis un PNG : https://www.icoconverter.com

---

## Fonctionnalités

### Interface

Palette : violet `#835D8D`, cyan électrique `#38E8FF`, lavande `#DFE6FF`. Design cosmique avec glow cyan, barre de progression en dégradé violet→cyan, paroles en italique avec text-shadow.

Trois thèmes disponibles : **Sombre** (défaut), **Clair**, **Minimal**.

Le panneau ⚙ Paramètres s'ouvre en inline sous la titlebar — il pousse le contenu vers le haut sans déborder de la fenêtre. À l'ouverture, la fenêtre devient focusable pour permettre la saisie dans les champs texte. À la fermeture, elle repasse en mode overlay non-focusable.

### Détection des players

| Player | Méthode | Pause | Position |
|---|---|---|---|
| Spotify | Bridge Python winsdk | ✅ | ✅ précise (1s) |
| VLC | API HTTP intégrée | ✅ | ✅ précise (1s) |
| Windows Media Player | SMTC PowerShell | ✅ | ✅ |
| foobar2000, MPC-HC… | Titre de fenêtre + SMTC | ✅ | via SMTC |
| iTunes, AIMP, MusicBee… | Titre de fenêtre | ⚠️ basique | non |

#### Interface HTTP VLC

Pour activer l'API HTTP de VLC :

1. **Outils → Préférences → Afficher : Tous les paramètres**
2. **Interface → Interfaces principales** → cocher **Web**
3. **Interface → Lua → HTTP** → définir un mot de passe si souhaité
4. Redémarrer VLC

Le port (défaut 8080) et le mot de passe sont configurables dans ⚙ Paramètres › Interface HTTP VLC.

Si le mot de passe est incorrect ou manquant, l'overlay affiche automatiquement :

> 🔒 VLC : mot de passe requis — ouvrez ⚙ Paramètres › Interface HTTP VLC

Le monitor réessaie toutes les 5s — dès que le bon mot de passe est saisi et sauvegardé, la connexion se rétablit sans redémarrer l'app.

> VLC 4.0+ exige un mot de passe. VLC 3.x accepte une connexion sans mot de passe par défaut (champ vide).

#### Arbitrage Spotify / VLC simultanés

Quand les deux players sont ouverts, l'overlay affiche toujours celui qui joue. Si les deux jouent, Spotify a la priorité. Dès qu'une source se met en pause et que l'autre joue, l'affichage bascule automatiquement. Chaque source conserve sa propre position (`_posSpotify` / `_posVlc`) pour éviter toute contamination croisée lors des switches.

### Paroles

Priorité de recherche :

1. Fichier `.lrc` / `.srt` / `.txt` adjacent au fichier audio
2. Cache `.lrc` local (dossier configurable dans ⚙)
3. **LRCLIB** — API gratuite, paroles synchronisées, sans clé API

Le fetch réseau se fait dans le renderer (Chromium `fetch()`) pour contourner les blocages de certains antivirus Windows. Un guard `lastFetchedKey` empêche de re-fetcher la même piste plusieurs fois de suite. Les titres parasites (publicités Spotify, écrans vides…) sont filtrés automatiquement.

### Synchronisation

- Recherche binaire de la ligne active O(log n)
- Interpolation de position toutes les 250ms — défilement fluide sans appel OS
- Seek détecté automatiquement : écart > 2s → recalage immédiat via `forceUpdate()`
- Pause/reprise : timer figé en pause, recalé à la reprise avec la position live
- Décalage ajustable ±5s via le slider dans ⚙ Paramètres
- L'offset sauvegardé est clampé entre -5s et +5s au démarrage pour éviter les valeurs aberrantes

### Paramètres

| Paramètre | Description |
|---|---|
| Thème | Sombre / Clair / Minimal |
| Opacité | 20% – 100% |
| Taille police | 12 – 32px |
| Lignes visibles | 1 (active seulement) ou 3 (prev + active + next) |
| Mode passthrough | Les clics traversent la fenêtre |
| Afficher pochette | Activer / désactiver |
| Décalage paroles | ±5s pour corriger le sync |
| Interface HTTP VLC | Port + mot de passe (vide par défaut) |
| Dossier .lrc | Chemin du cache de fichiers paroles |
| Vider le cache | Supprime les fichiers .lrc en cache |
| 🔍 Tester la détection | Affiche le player détecté + état SMTC brut |

---

## Notes techniques

### Ordre de démarrage

```
1. setupIpcHandlers()    — IPC enregistrés avant que la fenêtre charge
2. createOverlayWindow() — fenêtre charge et envoie renderer-ready (capturé)
3. await startPolling()  — bridge Python démarre, fenêtre déjà prête
```

Cet ordre évite la race condition où `renderer-ready` est envoyé avant que `ipcMain.on('renderer-ready')` soit enregistré.

### Architecture réseau

Le fetch LRCLIB se fait dans le renderer via `fetch()` Chromium, pas dans le main process Node.js. Le résultat est renvoyé au main via IPC (`lyrics-from-renderer`) pour charger le sync engine.

### Suppression de better-sqlite3

`better-sqlite3` a été supprimé — il nécessite une compilation C++ native incompatible avec certaines configurations MSVC Windows. Le cache SQLite est remplacé par des fichiers `.lrc` locaux gérés par `lrcCache.js`.

### music-metadata (ESM)

`music-metadata` v10+ est ESM-only. L'import se fait via `import()` dynamique dans `localFilePlayer.js` pour rester compatible avec le CommonJS d'Electron.

### Fenêtre focusable

`BrowserWindow` créée avec `focusable: false` — l'overlay ne vole jamais le focus clavier pendant la lecture. `setFocusable(true/false)` est appelé via IPC à l'ouverture/fermeture du panneau ⚙.

### Drag de fenêtre

Le drag est géré en JS (pas `-webkit-app-region: drag`) car cette propriété CSS est incompatible avec `focusable: false`. Le delta `screenX/Y` est recalculé à chaque `mousemove` et `Math.round()` est appliqué dans `setPosition()` pour éviter la dérive sub-pixel qui faisait grossir la fenêtre.

### Variables CSS et thèmes

Les variables de thème (`--bg`, `--text`, `--accent`…) sont déclarées sur `#app` (pas sur `:root`), ce qui permet aux sélecteurs `#app[data-theme="light"]` et `#app[data-theme="minimal"]` de les overrider par cascade CSS. La taille de police `--font-size` est définie sur `#lyrics-zone` via `element.style.setProperty()`.