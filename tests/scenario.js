// Run inside the page (?test=1) by tests/run_scenario.py: made-up hands drive the real app,
// three.js and all, and the result of each step comes back as JSON. The first step uses the
// (fake) camera for real, to check the hand tracker in its own thread finds real hands.
(async () => {
  const L = await import('/js/logic.js');
  const app = window.__jh;
  const frames = (n) => new Promise((r) => { let k = 0; const f = () => (++k >= n ? r() : requestAnimationFrame(f)); requestAnimationFrame(f); });
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  for (let i = 0; i < 600 && !(app.running && app.models.length); i++) await wait(100);
  const out = { started: app.running && app.models.length === 1 };
  const aspect = app.video.videoWidth / app.video.videoHeight;
  // 0. the real tracker, in its own thread, on the camera's pictures (a photo of two hands)
  out.trackerMode = app.trackerMode;
  out.delegate = app.delegate;
  for (let i = 0; i < 100 && app.seenHands < 5; i++) await wait(100);
  out.realDetections = app.detections;
  out.realHandsSeen = app.seenHands;
  out.trackMs = Math.round(app.trackMs);
  out.renderFpsWithTracker = Math.round(app.fps);
  const OPEN = {0: [0, 0], 1: [0.25, 0.15], 2: [0.48, 0.35], 3: [0.62, 0.55], 4: [0.72, 0.75], 5: [0.28, 0.95],
    6: [0.32, 1.35], 7: [0.34, 1.62], 8: [0.35, 1.85], 9: [0, 1], 10: [0, 1.45], 11: [0, 1.75], 12: [0, 2],
    13: [-0.22, 0.93], 14: [-0.26, 1.33], 15: [-0.28, 1.6], 16: [-0.29, 1.82], 17: [-0.42, 0.8],
    18: [-0.5, 1.1], 19: [-0.54, 1.3], 20: [-0.57, 1.48]};
  const POSES = { open: {}, pinch: {4: [0.72, 0.85], 6: [0.4, 1.25], 7: [0.58, 1.2], 8: [0.7, 0.95]} };
  const PINCH_AT = { pinch: [0.71, 0.90], open: [0.535, 1.30] };
  const hand = (pose, cx, cy, s) => { const p = {...OPEN, ...POSES[pose]};
    return Array.from({length: 21}, (_, i) => ({ x: cx + (p[i][0] * s) / aspect, y: cy - p[i][1] * s, z: 0 })); };
  const at = (pose, u, v, s) => hand(pose, u - (PINCH_AT[pose][0] * s) / aspect, v + PINCH_AT[pose][1] * s, s);
  // a hand size that the app reads as `metres` away
  const sizeFor = (metres) => {
    let S = 0.1, best = 9;
    for (let s = 0.03; s < 0.5; s += 0.001) {
      const d = L.handDepth(hand('open', 0.5, 0.7, s).map((q) => [q.x, q.y]), app.fov || 70, aspect);
      if (Math.abs(d - metres) < best) { best = Math.abs(d - metres); S = s; }
    }
    return S;
  };
  const S = sizeFor(0.45);
  let current = [];
  app.feed = () => current;
  const g0 = app.models[0];
  const live = () => app.tracks.find((t) => !t.missing);
  // 1. pinch the model, move it, let go
  current = [at('open', 0.5, 0.5, S)]; await frames(8);
  current = [at('pinch', 0.5, 0.5, S)]; await frames(8);
  out.grabbed = !!app.grab;
  const x0 = g0.position.x;
  for (let i = 1; i <= 15; i++) { current = [at('pinch', 0.5 + i * 0.008, 0.5, S)]; await frames(1); }
  await frames(6);
  out.movedRight = +(g0.position.x - x0).toFixed(3);
  current = [at('open', 0.62, 0.5, S)]; await frames(12);
  out.dropped = !app.grab;
  // 2. pinch it with one hand, then a second pinch, and pull apart: bigger
  const s0 = g0.scale.x;
  current = [at('pinch', 0.62, 0.5, S)]; await frames(8);
  current = [at('pinch', 0.62, 0.5, S), at('open', 0.8, 0.5, S)]; await frames(6);
  current = [at('pinch', 0.62, 0.5, S), at('pinch', 0.8, 0.5, S)]; await frames(6);
  out.twoHands = !!app.two;
  for (let i = 1; i <= 12; i++) { current = [at('pinch', 0.62 - i * 0.006, 0.5, S), at('pinch', 0.8 + i * 0.006, 0.5, S)]; await frames(1); }
  await frames(4);
  out.scaleUp = +(g0.scale.x / s0).toFixed(2);
  current = [at('open', 0.55, 0.5, S), at('open', 0.87, 0.5, S)]; await frames(12);
  // 3. two open hands spread apart: it comes apart
  current = []; await frames(30);
  current = [at('open', 0.5, 0.7, S), at('open', 0.7, 0.7, S)]; await frames(8);
  for (let i = 1; i <= 15; i++) { current = [at('open', 0.5 - i * 0.012, 0.7, S), at('open', 0.7 + i * 0.012, 0.7, S)]; await frames(1); }
  await frames(10);
  out.exploded = +g0.userData.explode.toFixed(2);
  g0.userData.explode = 0;
  // 4. an open palm held still away from it: the menu
  current = []; await frames(30);
  current = [at('open', 0.12, 0.78, S)];
  for (let i = 0; i < 60 && !app.menu; i++) await frames(2);
  out.menuOpened = !!app.menu;
  // 5. pinch SUIT UP on it (aim through the camera at where the item is drawn)
  const tx = L.tans(70, aspect)[0], ty = L.tans(70, aspect)[1];
  const project = (w) => { const p = app.rig.worldToLocal(w.clone()); return [0.5 + p.x / -p.z / (2 * tx), 0.5 - p.y / -p.z / (2 * ty)]; };
  if (app.menu) {
    const k = 4;   // NEXT, ADD, DELETE, EXPLODE, SUIT UP
    const [u, v] = project(app.menu.items[k].getWorldPosition(g0.position.clone()));
    current = [at('open', u, v, S)]; await frames(3);
    current = [at('pinch', u, v, S)]; await frames(8);
  }
  out.suit = app.suit ? app.suit.model.userData.name : null;
  current = [at('open', 0.3, 0.6, S)]; await frames(20);
  if (app.suit) {
    const tr = app.tracks.find((t) => t.id === app.suit.id);
    out.suitOnHand = tr ? +app.suit.model.position.distanceTo(tr.palm3).toFixed(3) : null;
  }
  // 6. the hand lost for good and found again somewhere else: the gauntlet goes back on it
  if (app.suit) {
    current = []; await frames(45);
    current = [at('open', 0.75, 0.4, S)]; await frames(15);
    const tr = live();
    out.suitFollowsNewHand = !!(tr && app.suit.id === tr.id && app.suit.model.position.distanceTo(tr.palm3) < 0.02);
    app.menuChoice('SUIT UP');   // take it off again
  }
  // 7. the outline of the hand sits ON the hand in the picture, in both eyes of the headset
  current = [at('open', 0.4, 0.55, S)]; await frames(10);
  out.outlineOffPx = +app.checkAlign().toFixed(2);
  out.outlineOffPxOldWay = +app.checkAlign(true).toFixed(1);
  // 8. a still hand that shakes is drawn steady
  {
    let seed = 11;
    const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647 - 0.5; };
    const base = at('open', 0.4, 0.55, S), raws = [], drawn = [];
    for (let i = 0; i < 90; i++) {
      current = [base.map((p) => ({ x: p.x + rnd() * 0.008, y: p.y + rnd() * 0.008, z: 0 }))];
      await frames(1);
      const tr = live();
      if (i > 30 && tr) { raws.push(current[0][8].x); drawn.push(tr.pts[8][0]); }
    }
    const spread = (xs) => { const m = xs.reduce((a, b) => a + b, 0) / xs.length; return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / xs.length); };
    out.shakeRaw = +spread(raws).toFixed(5);
    out.shakeDrawn = +spread(drawn).toFixed(5);
  }
  // 9. a hand guessed much further away than the model still grabs what it is in front of
  current = []; await frames(40);
  app.models.slice(1).forEach((g) => { g.position.set(0, 0, -9); });
  g0.position.copy(app.rig.localToWorld(new g0.position.constructor(0, 0, -0.45)));
  const far = sizeFor(0.8);
  current = [at('open', 0.5, 0.5, far)]; await frames(10);
  current = [at('pinch', 0.5, 0.5, far)]; await frames(8);
  out.grabbedWithDepthOff = !!(app.grab && app.grab.model === g0);
  current = [at('open', 0.5, 0.5, far)]; await frames(12);
  // 10. the video screen: a quick pinch plays and pauses, a held pinch moves it
  current = []; await frames(40);
  g0.position.set(0, 0, -9);
  const c = document.createElement('canvas'); c.width = 320; c.height = 180;
  const cx = c.getContext('2d');
  let hue = 0; const paint = setInterval(() => { cx.fillStyle = `hsl(${hue = (hue + 7) % 360} 80% 50%)`; cx.fillRect(0, 0, 320, 180); }, 40);
  const vid = document.createElement('video'); vid.muted = true; vid.playsInline = true; vid.srcObject = c.captureStream(25);
  app.film = { video: vid, url: '', name: 'test' };
  app.menuChoice('SCREEN');
  await frames(20);
  out.screenShown = !!(app.screen && app.screen.visible);
  out.screenPlaying = !vid.paused;
  const [su, sv] = project(app.screen.position.clone());
  current = [at('open', su, sv, S)]; await frames(6);
  current = [at('pinch', su, sv, S)]; await frames(5);
  current = [at('open', su, sv, S)]; await frames(15);
  out.tapPaused = vid.paused;
  const sx0 = app.screen.position.x;
  current = [at('pinch', su, sv, S)]; await frames(8);
  for (let i = 1; i <= 15; i++) { current = [at('pinch', su + i * 0.01, sv, S)]; await frames(1); }
  await frames(6);
  out.screenMoved = +(app.screen.position.x - sx0).toFixed(3);
  current = [at('open', su + 0.15, sv, S)]; await frames(12);
  out.screenStillPaused = vid.paused;
  app.menuChoice('SCREEN');
  clearInterval(paint);
  // 11. a menu left alone closes by itself and does not keep coming back for a resting hand
  current = []; await frames(45);
  current = [at('open', 0.15, 0.8, S)];
  for (let i = 0; i < 80 && !app.menu; i++) await frames(2);
  const opened = app.events.filter((e) => e === 'menu').length;
  await wait(9500);
  out.menuReopenedWhileResting = app.events.filter((e) => e === 'menu').length - opened;
  out.menuClosedByItself = !app.menu;
  current = []; await frames(30);
  // 12. head turning: the first reading puts the hologram in front; turning leaves it in the room
  g0.position.set(0, 0, -9);
  const turn = (alpha) => app.onOrientation({ alpha, beta: 90, gamma: 0, timeStamp: performance.now() });
  turn(200);
  await frames(10);
  const dirOf = (g) => { const p = app.rig.worldToLocal(g.position.clone()); return (Math.atan2(p.x, -p.z) * 180) / Math.PI; };
  out.inFrontAfterFirstReading = +Math.abs(dirOf(g0)).toFixed(1);
  for (let a = 200; a <= 230; a += 3) { turn(a); await frames(2); }
  await frames(10);
  out.turnedBy30SeesItAt = +dirOf(g0).toFixed(1);
  out.fps = Math.round(app.fps);
  out.events = app.events.slice(-14);
  out.errors = app.errors.slice(0, 8);
  app.feed = null;
  return JSON.stringify(out);
})()
