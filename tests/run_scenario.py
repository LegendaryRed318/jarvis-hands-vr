"""Drive the real page in headless Edge with made-up hands (tests/scenario.js) and check the results.

  1. serve this folder:   python -m http.server 8765 --bind 127.0.0.1
  2. make a fake camera from a photo of hands (any hand photo works):
       ffmpeg -loop 1 -i hands.jpg -vf "scale=-2:560,pad=1400:720:(ow-iw)/2:(oh-ih)/2,crop=1280:720:'60+60*sin(t)':0,format=yuvj420p" -t 6 -r 30 hands.mjpeg
  3. start Edge:          msedge --headless=new --remote-debugging-port=9333 --use-fake-ui-for-media-stream
                          --use-fake-device-for-media-stream --use-file-for-fake-video-capture=hands.mjpeg
                          --autoplay-policy=no-user-gesture-required --enable-unsafe-swiftshader about:blank
  4. python tests/run_scenario.py [screenshot.png]

Exit code = number of failed checks.
"""
import asyncio
import base64
import json
import os
import sys
import urllib.request

import websockets

HERE = os.path.dirname(os.path.abspath(__file__))
URL = "http://127.0.0.1:8765/?test=1"
SHOT = sys.argv[1] if len(sys.argv) > 1 else None


async def run():
    tabs = json.loads(urllib.request.urlopen("http://127.0.0.1:9333/json").read())
    page = next(t for t in tabs if t["type"] == "page")
    async with websockets.connect(page["webSocketDebuggerUrl"], max_size=50_000_000) as ws:
        n = 0

        async def call(method, **params):
            nonlocal n
            n += 1
            my = n
            await ws.send(json.dumps({"id": my, "method": method, "params": params}))
            while True:
                msg = json.loads(await ws.recv())
                if msg.get("id") == my:
                    return msg.get("result", msg.get("error"))

        async def value(expr):
            r = await call("Runtime.evaluate", expression=expr, returnByValue=True)
            return r.get("result", {}).get("value")

        await call("Emulation.setDeviceMetricsOverride", width=1560, height=720, deviceScaleFactor=1, mobile=True)
        await call("Page.navigate", url=URL)
        await asyncio.sleep(3)
        if SHOT:
            # A picture of the headset view with the real tracker on the fake camera's hands.
            for _ in range(600):
                if (await value("(window.__jh && window.__jh.seenHands) || 0")) > 8:
                    break
                await asyncio.sleep(0.1)
            await asyncio.sleep(1)
            r = await call("Page.captureScreenshot", format="png")
            with open(SHOT, "wb") as f:
                f.write(base64.b64decode(r["data"]))
        with open(os.path.join(HERE, "scenario.js"), encoding="utf-8") as f:
            js = f.read()
        r = await call("Runtime.evaluate", expression=js, awaitPromise=True, returnByValue=True, timeout=300000)
        return json.loads(r["result"]["value"])


out = asyncio.run(run())
print(json.dumps(out, indent=1))
checks = [
    ("the app starts with one model", out.get("started")),
    ("the hand tracker runs in its own thread", out.get("trackerMode") == "worker"),
    ("and finds the real hands in the camera's pictures", (out.get("realHandsSeen") or 0) >= 5),
    ("a pinch on the model takes hold of it", out.get("grabbed")),
    ("moving the pinch moves the model", (out.get("movedRight") or 0) > 0.03),
    ("opening the fingers lets go", out.get("dropped")),
    ("a second pinch on it is two-hand mode", out.get("twoHands")),
    ("pulling two pinches apart makes it bigger", (out.get("scaleUp") or 0) > 1.2),
    ("two open hands spread apart open it up", (out.get("exploded") or 0) > 0.5),
    ("an open palm held still away from it opens the menu", out.get("menuOpened")),
    ("SUIT UP in the menu puts the gauntlet on", out.get("suit") == "GAUNTLET"),
    ("and the gauntlet stays on the moving hand", out.get("suitOnHand") is not None and out["suitOnHand"] < 0.02),
    ("the gauntlet goes back on a hand that comes back somewhere else", out.get("suitFollowsNewHand")),
    ("the hand outline sits on the hand in both eyes (under 1.5 px)", (out.get("outlineOffPx") if out.get("outlineOffPx") is not None else 99) < 1.5),
    ("(the old way it sat over 20 px off: the check can tell)", (out.get("outlineOffPxOldWay") or 0) > 20),
    ("a shaking still hand is drawn steady (under half the shake)",
     out.get("shakeRaw") and out.get("shakeDrawn") is not None and out["shakeDrawn"] < 0.5 * out["shakeRaw"]),
    ("a hand guessed far too far away still grabs what it is in front of", out.get("grabbedWithDepthOff")),
    ("SCREEN shows the video and plays it", out.get("screenShown") and out.get("screenPlaying")),
    ("a quick pinch on the screen pauses it", out.get("tapPaused")),
    ("a held pinch moves the screen (and does not play/pause it)",
     (out.get("screenMoved") or 0) > 0.05 and out.get("screenStillPaused")),
    ("a menu left alone closes by itself", out.get("menuClosedByItself")),
    ("and does not keep reopening for a resting hand", out.get("menuReopenedWhileResting") == 0),
    ("the first turn reading puts the hologram in front", (out.get("inFrontAfterFirstReading") if out.get("inFrontAfterFirstReading") is not None else 99) < 3),
    ("turning the head 30 degrees leaves it 30 degrees to the side", abs(abs(out.get("turnedBy30SeesItAt") or 0) - 30) < 3),
    ("no errors in the page", not out.get("errors")),
]
fails = 0
for name, ok in checks:
    fails += 0 if ok else 1
    print(("PASS  " if ok else "FAIL  ") + name)
print(f"\n{fails} failed")
sys.exit(fails)
