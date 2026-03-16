# smtc_bridge.py
# Pont SMTC → stdout JSON pour Lyrics Overlay
# Requiert : pip install winsdk
# Usage : python smtc_bridge.py
# Émet une ligne JSON par seconde sur stdout

import asyncio
import json
import sys
import os

try:
    from winsdk.windows.media.control import (
        GlobalSystemMediaTransportControlsSessionManager as SessionManager,
        GlobalSystemMediaTransportControlsSessionPlaybackStatus as PlaybackStatus,
    )
except ImportError:
    # winsdk non installé — émettre une erreur JSON et quitter
    print(json.dumps({"error": "winsdk_not_installed"}), flush=True)
    sys.exit(1)


async def get_state():
    try:
        manager = await SessionManager.request_async()
        session = manager.get_current_session()
        if not session:
            return {"is_active": False}

        playback = session.get_playback_info()
        timeline = session.get_timeline_properties()

        try:
            media = await session.try_get_media_properties_async()
        except Exception:
            media = None

        try:
            pos_sec = timeline.position.total_seconds()
            end_sec = timeline.end_time.total_seconds()
            pct     = (pos_sec / end_sec * 100) if end_sec > 0 else 0.0
        except Exception:
            pos_sec = 0.0
            end_sec = 0.0
            pct     = 0.0

        status     = playback.playback_status if playback else None
        is_playing = (status == PlaybackStatus.PLAYING)
        is_paused  = (status == PlaybackStatus.PAUSED)

        # Ignorer si ni playing ni paused (stopped, closed...)
        if not is_playing and not is_paused:
            return {"is_active": False}

        app_id = ""
        try:
            app_id = session.source_app_user_model_id or ""
        except Exception:
            pass

        return {
            "is_active":  True,
            "is_playing": is_playing,
            "is_paused":  is_paused,
            "track":      media.title        if media else "",
            "artist":     media.artist       if media else "",
            "album":      media.album_title  if media else "",
            "pos_sec":    round(pos_sec, 2),
            "end_sec":    round(end_sec, 2),
            "pct":        round(pct, 2),
            "app_id":     app_id.lower(),
        }

    except Exception as e:
        return {"is_active": False, "error": str(e)}


async def main():
    # Signaler que le bridge est prêt
    print(json.dumps({"ready": True}), flush=True)

    while True:
        state = await get_state()
        print(json.dumps(state), flush=True)
        await asyncio.sleep(1)


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
