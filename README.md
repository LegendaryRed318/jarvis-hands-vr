# JARVIS Hands VR

The JARVIS Hands holograms on a phone in a cheap VR headset (front cover off, so the back
camera can see). A single web page: three.js for the holograms, MediaPipe Tasks Vision for the
hands, both from jsDelivr; the hand model from Google's model store. No build step.

- `index.html`: the start page and settings
- `js/app.js`: camera, hand tracking, two-eye drawing, head turning, the moves and the menu
- `js/logic.js`: everything without a browser in it (hand reading, pinch, following hands,
  camera maths, the ring menu, model checking)
- `models.json`: the 17 models, exported from JARVIS Hands (`hands.py` built-ins and
  `hand_maker.py` recipes)
- `PLAN.md`: what to do, what works, what is next

## Checks

```
npm test                                  # 9 checks of js/logic.js (Node 22)
python tests/run_scenario.py              # 14 checks of the real page, see the file for setup
```

`run_scenario.py` drives the real page in headless Edge (fake camera, SwiftShader WebGL) and
feeds it made-up hands through the `?test=1` hook (`window.__jh.feed`).

## Privacy

The camera picture is used for each frame on the phone and thrown away. Nothing is uploaded or
stored, apart from the settings in the browser's localStorage.
