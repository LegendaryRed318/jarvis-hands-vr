"""Drive the real page in headless Edge with made-up hands (tests/scenario.js) and check the results.

  1. serve this folder:   python -m http.server 8765 --bind 127.0.0.1
  2. start Edge:          msedge --headless=new --remote-debugging-port=9333 --use-fake-ui-for-media-stream
                          --use-fake-device-for-media-stream --enable-unsafe-swiftshader about:blank
  3. python tests/run_scenario.py

Exit code = number of failed checks.
"""
import asyncio
import json
import os
import sys
import urllib.request

import websockets

HERE = os.path.dirname(os.path.abspath(__file__))
URL = "http://127.0.0.1:8765/?test=1"


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

        await call("Emulation.setDeviceMetricsOverride", width=1560, height=720, deviceScaleFactor=1, mobile=True)
        await call("Page.navigate", url=URL)
        await asyncio.sleep(3)
        with open(os.path.join(HERE, "scenario.js"), encoding="utf-8") as f:
            js = f.read()
        r = await call("Runtime.evaluate", expression=js, awaitPromise=True, returnByValue=True, timeout=240000)
        return json.loads(r["result"]["value"])


out = asyncio.run(run())
print(json.dumps(out, indent=1))
checks = [
    ("the app starts with one model", out.get("started")),
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
    ("a menu left alone closes by itself", out.get("menuClosedByItself")),
    ("and does not keep reopening for a resting hand", out.get("menuReopenedWhileResting") == 0),
    ("no errors in the page", not out.get("errors")),
]
fails = 0
for name, ok in checks:
    fails += 0 if ok else 1
    print(("PASS  " if ok else "FAIL  ") + name)
print(f"\n{fails} failed")
sys.exit(fails)
