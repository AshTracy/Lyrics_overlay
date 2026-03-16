# 🎵 Lyrics Overlay

Fenêtre transparente always-on-top qui affiche les paroles synchronisées en temps réel pendant la lecture musicale. Fonctionne avec Spotify, VLC, Windows Media Player, foobar2000, et tout player enregistré dans SMTC.

---

## Structure du projet

```
lyrics-overlay/
├── package.json
├── src/
│   ├── main/
│   │   ├── index.js                ← Processus principal Electron
│   │   └── preload.js              ← Pont IPC sécurisé (contextIsolation)
│   └── modules/
│       ├── systemDetector.js       ← Détection système multi-player + arbitrage sources
│       ├── smtcBridge.js           ← Gestionnaire du bridge Python SMTC
│       ├── smtc_bridge.py          ← Bridge Python winsdk (Spotify/SMTC)
│       ├── localFilePlayer.js      ← Lecture fichiers audio locaux
│       ├── lyricsParser.js         ← Parser LRC / SRT / TXT
│       ├── lyricsFetcher.js        ← Fetch paroles (LRCLIB + Genius + cache SQLite)
│       ├── lyricsSyncEngine.js     ← Synchronisation position → ligne active
│       ├── lrcCache.js             ← Cache fichiers .lrc locaux
│       └── settingsStore.js        ← Préférences persistantes JSON
└── renderer/
    ├── overlay.html                ← UI de l'overlay
    └── renderer.js                 ← Logique UI + fetch paroles (Chromium fetch)
```

---

## Installation

```bash
npm install
```

### Dépendance optionnelle — Bridge Python (recommandé pour Spotify)

Le bridge Python offre une détection Spotify plus précise (pause, position, seek) sans scripts PowerShell :

```bash
pip install winsdk
```

> Requiert Python 3.8+ et Windows 10/11.
> Si Python est installé mais non trouvé, l'app cherche automatiquement `py` (launcher Windows), puis `where python` en ignorant les alias Microsoft Store, puis les chemins standards `%LOCALAPPDATA%\Programs\Python\`.
> Si absent, l'app bascule automatiquement sur les scripts PowerShell SMTC.

---

## Lancement

```bash
npm run dev    # Avec DevTools détaché (logs visibles)
npm start      # Mode production
```

---

## Fonctionnalités

### Détection des players

| Player | Méthode | Pause détectée | Position |
|---|---|---|---|
| Spotify | Bridge Python winsdk | ✅ | ✅ précise (1s) |
| VLC | API HTTP intégrée | ✅ | ✅ précise (1s) |
| Windows Media Player | SMTC PowerShell | ✅ | ✅ |
| foobar2000, MPC-HC… | Titre de fenêtre + SMTC | ✅ | via SMTC |
| iTunes, AIMP, MusicBee… | Titre de fenêtre | ⚠️ basique | non |

#### Bridge Python SMTC (Spotify)

Au démarrage, l'app tente de lancer `smtc_bridge.py`. Si `winsdk` est installé, le bridge tourne en processus persistant et émet un état JSON par seconde : état lecture/pause, position en secondes, seek détecté, identifiant du player.

Si Python ou `winsdk` est absent, fallback automatique sur les scripts PowerShell SMTC.

#### Interface HTTP VLC

VLC expose une API REST sur `localhost:8080`. Pour l'activer :

1. **Outils → Préférences → Afficher : Tous les paramètres**
2. **Interface → Interfaces principales** → cocher **Web**
3. **Interface → Lua → HTTP** → définir un mot de passe si souhaité (vide par défaut)
4. Redémarrer VLC

Le mot de passe et le port sont configurables dans le panneau ⚙ de l'overlay. Le champ mot de passe est masqué par défaut avec un bouton 👁 pour l'afficher.

> Note : VLC 4.0+ peut exiger un mot de passe. VLC 3.x accepte une connexion sans mot de passe par défaut.

Un monitor autonome interroge VLC toutes les secondes pour la pause/reprise et la position exacte. Les changements de piste sont détectés via le titre de fenêtre (toutes les 2s).

#### Arbitrage Spotify / VLC simultanés

Quand les deux players sont ouverts en même temps, l'overlay affiche toujours **celui qui joue**. Si les deux jouent, Spotify a la priorité. Dès qu'une source se met en pause et que l'autre joue, l'affichage bascule automatiquement.

---

### Paroles

**Priorité de recherche :**
1. Fichier `.lrc` / `.srt` / `.txt` adjacent au fichier audio
2. Cache `.lrc` local (dossier configurable)
3. **LRCLIB** — API gratuite, paroles synchronisées, sans clé API
4. **Genius** — paroles non synchronisées, nécessite `GENIUS_API_KEY`

Le fetch réseau est effectué dans le renderer (Chromium `fetch()`) plutôt que dans le main process Node.js, ce qui évite les blocages réseau de certains antivirus Windows.

**Cache .lrc local :**
Chaque parole trouvée est sauvegardée en fichier `.lrc` (synchronisé) ou `.txt` (plain) dans un dossier dédié. Configurable depuis le panneau ⚙ :
- **📁 Ouvrir** — ouvre le dossier dans l'Explorateur Windows
- **📂 Changer…** — choisir n'importe quel dossier
- **↩ Défaut** — revenir à `%APPDATA%\lyrics-overlay\lyrics-cache\`

Les titres parasites (publicités Spotify, "Spotify Free"…) sont filtrés et ne génèrent pas de fichiers cache. Un guard `lastFetchedKey` empêche de re-fetcher la même piste plusieurs fois de suite.

---

### Synchronisation

- Recherche binaire de la ligne active O(log n)
- Interpolation de position toutes les 250ms pour un défilement fluide sans appel OS
- **Seek détecté automatiquement** : écart > 2s entre position estimée et réelle → recalage immédiat
- **Pause/reprise** : timer d'interpolation figé en pause, recalé à la reprise avec la position live
- `forceUpdate()` après seek pour rafraîchir la ligne même si l'index ne change pas
- **Isolation de position par source** : chaque source (Spotify/VLC) conserve sa propre position ; pas de contamination croisée lors des switches
- Décalage ajustable ±5s depuis le slider

---

### Paramètres

Accessibles via le bouton ⚙ de l'overlay. L'ouverture du panneau rend automatiquement la fenêtre focusable pour permettre la saisie dans les champs texte. La fermeture remet la fenêtre en mode overlay non-focusable.

| Paramètre | Description |
|---|---|
| Thème | Sombre / Clair / Minimal |
| Opacité | 20% – 100% |
| Taille police | 12 – 32px |
| Lignes visibles | 1 (active) ou 3 (prev + active + next) |
| Mode passthrough | Les clics traversent la fenêtre |
| Afficher pochette | Activer / désactiver |
| Interface HTTP VLC | Port (défaut 8080) + mot de passe (vide par défaut) |
| Dossier .lrc | Chemin du cache de fichiers paroles |
| Vider le cache | Supprime SQLite + fichiers .lrc |
| 🔍 Tester la détection | Affiche le player détecté + état SMTC brut (debug) |

---

## Configuration Genius (optionnel)

```bash
GENIUS_API_KEY=votre_cle_ici npm start
```

Créer une clé sur https://genius.com/api-clients

---

## Notes techniques

### Ordre de démarrage

L'ordre de boot est important pour éviter les race conditions :

```
1. setupIpcHandlers()     — enregistrer renderer-ready avant que la fenêtre charge
2. createOverlayWindow()  — la fenêtre charge et envoie renderer-ready (maintenant capturé)
3. await startPolling()   — le bridge Python démarre, premier poll après que la fenêtre existe
```

### Architecture réseau

Le fetch LRCLIB se fait dans le **renderer** via `fetch()` Chromium. Cela contourne les blocages réseau fréquents sous Windows (antivirus, processus Electron sandboxé). Le résultat est renvoyé au main via IPC pour charger le sync engine.

### Double source : locale vs système

Quand un fichier audio local est chargé, les événements système sont bloqués. Le bouton ⏏ relâche la source locale et restitue la détection système.

### Encodage PowerShell

Tous les scripts `.ps1` commencent par `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8` et sont écrits avec BOM UTF-8 pour éviter la corruption des caractères accentués dans les titres.

### Fenêtre focusable

La `BrowserWindow` est créée avec `focusable: false` pour ne pas intercepter le focus clavier pendant la lecture. Quand le panneau ⚙ est ouvert, `setFocusable(true)` est appelé pour permettre la saisie. À la fermeture, `setFocusable(false)` remet l'overlay en mode passif.

### Build / Distribution

```bash
npm install --save-dev electron-builder
npx electron-builder build --win    # .exe NSIS
npx electron-builder build --mac    # .dmg
npx electron-builder build --linux  # .AppImage
```

Pour inclure le bridge Python dans la distribution :
```json
{
  "build": {
    "extraResources": [
      { "from": "src/modules/smtc_bridge.py", "to": "smtc_bridge.py" }
    ]
  }
}
```