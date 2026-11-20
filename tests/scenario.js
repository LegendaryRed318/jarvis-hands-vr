// Run inside the page (?test=1) by tests/run_scenario.py: made-up hands drive the real app,
// three.js and all, and the result of each step comes back as JSON. No camera picture is used.
(async () => {
  const L = await import('/js/logic.js');
  const app = window.__jh;
  const frames = (n) => new Promise((r) => { let k = 0; const f = () => (++k >= n ? r() : requestAnimationFrame(f)); requestAnimationFrame(f); });
  for (let i = 0; i < 300 && !(app.running && app.models.length); i++) await frames(3);
  const out = { started: app.running && app.models.length === 1 };
  const aspect = app.video.videoWidth / app.video.videoHeight;
  const OPEN = {0: [0, 0], 1: [0.25, 0.15], 2: [0.48, 0.35], 3: [0.62, 0.55], 4: [0.72, 0.75], 5: [0.28, 0.95],
    6: [0.32, 1.35], 7: [0.34, 1.62], 8: [0.35, 1.85], 9: [0, 1], 10: [0, 1.45], 11: [0, 1.75], 12: [0, 2],
    13: [-0.22, 0.93], 14: [-0.26, 1.33], 15: [-0.28, 1.6], 16: [-0.29, 1.82], 17: [-0.42, 0.8],
    18: [-0.5, 1.1], 19: [-0.54, 1.3], 20: [-0.57, 1.48]};
  const POSES = { open: {}, pinch: {4: [0.72, 0.85], 6: [0.4, 1.25], 7: [0.58, 1.2], 8: [0.7, 0.95]} };
  const PINCH_AT = { pinch: [0.71, 0.90], open: [0.535, 1.30] };
  const hand = (pose, cx, cy, s) => { const p = {...OPEN, ...POSES[pose]};
    return Array.from({length: 21}, (_, i) => ({ x: cx + (p[i][0] * s) / aspect, y: cy - p[i][1] * s, z: 0 })); };
  const at = (pose, u, v, s) => hand(pose, u - (PINCH_AT[pose][0] * s) / aspect, v + PINCH_AT[pose][1] * s, s);
  // a hand size that the app reads as 0.45 m away (where the first model is)
  let S = 0.1, best = 9;
  for (let s = 0.04; s < 0.5; s += 0.002) {
    const d = L.handDepth(hand('open', 0.5, 0.7, s).map((q) => [q.x, q.y]), app.fov || 70, aspect);
    if (Math.abs(d - 0.45) < best) { best = Math.abs(d - 0.45); S = s; }
  }
  let current = [];
  app.feed = () => current;
  const g0 = app.models[0];
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
  // 4. an open palm held still away from the model: the menu
  current = []; await frames(30);
  const palmU = 0.12, palmV = 0.78;
  current = [at('open', palmU, palmV, S)];
  for (let i = 0; i < 60 && !app.menu; i++) await frames(2);
  out.menuOpened = !!app.menu;
  // 5. pinch SUIT UP on it
  if (app.menu) {
    const k = app.menu.items.findIndex((sp, i) => ['NEXT', 'ADD', 'DELETE', 'EXPLODE', 'SUIT UP'][i] === 'SUIT UP');
    const w = app.menu.items[k].getWorldPosition(new (g0.position.constructor)());
    const tx = Math.tan((70 * Math.PI) / 360), ty = tx / aspect;
    const u = 0.5 + w.x / -w.z / (2 * tx), v = 0.5 - w.y / -w.z / (2 * ty);
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
    const tr = app.tracks.find((t) => !t.missing);
    out.suitFollowsNewHand = !!(tr && app.suit.id === tr.id && app.suit.model.position.distanceTo(tr.palm3) < 0.02);
  }
  // 7. a menu left alone closes by itself and does not keep coming back for a resting hand
  current = []; await frames(45);
  g0.position.set(0, 0, -9);
  current = [at('open', 0.15, 0.8, S)];
  for (let i = 0; i < 80 && !app.menu; i++) await frames(2);
  const opened = app.events.filter((e) => e === 'menu').length;
  await new Promise((r) => setTimeout(r, 9500));
  out.menuReopenedWhileResting = app.events.filter((e) => e === 'menu').length - opened;
  out.menuClosedByItself = !app.menu;
  out.events = app.events.slice(-14);
  out.errors = app.errors.slice(0, 5);
  app.feed = null;
  return JSON.stringify(out);
})()
