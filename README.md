# JARVIS Hands VR

The JARVIS Hands holograms on a phone in a cheap VR headset (front cover off, so the back
camera can see). A single web page: three.js for the holograms, MediaPipe Tasks Vision for the
hands, both from jsDelivr; the hand model from Google's model store. No build step.

- `index.html`: the start page and settings (camera picker, a video for the screen, install)
- `js/app.js`: camera, two-eye drawing, head turning, the moves, the menu and the video screen
- `js/tracker.js`: the hand tracker in its own thread (a classic worker), so drawing never waits
- `js/logic.js`: everything without a browser in it (hand reading, pinch, following hands,
  smoothing, aiming, head-turn timing, camera maths, the ring menu, model checking)
- `manifest.webmanifest`, `sw.js`, `icons/`: it installs as an app and works offline after one visit
- `models.json`: the 17 models, exported from JARVIS Hands (`hands.py` built-ins and
  `hand_maker.py` recipes)

## Checks

```
npm test                                  # 17 checks of js/logic.js (Node 22)
python tests/run_scenario.py              # 25 checks of the real page, see the file for setup
```

`run_scenario.py` drives the real page in headless Edge (a photo of hands as the fake camera,
SwiftShader WebGL): first the real tracker on the camera, then made-up hands through the
`?test=1` hook (`window.__jh.feed`). `?mainthread` runs the tracker the old way; `?nosw` skips
the offline copy.

## Privacy

The camera picture is used for each frame on the phone and thrown away. Nothing is uploaded or
stored, apart from the settings in the browser's localStorage.
