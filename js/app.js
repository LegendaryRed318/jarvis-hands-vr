// JARVIS Hands VR (20 Nov 2026): the laptop app's holograms, on a phone in a headset.
// The phone's back camera sees the room and your hands (MediaPipe, on this phone), the
// holograms are drawn over the room twice, once for each eye, and the phone's turn sensors keep
// them where you put them when you turn your head. Nothing is uploaded or saved.
import * as THREE from 'three';
import * as L from './logic.js';

const MP = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14';
const HAND_MODEL = 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task';
const TEST = new URLSearchParams(location.search).has('test');
const BONES = [[0, 1], [1, 2], [2, 3], [3, 4], [0, 5], [5, 6], [6, 7], [7, 8], [5, 9], [9, 10], [10, 11], [11, 12],
  [9, 13], [13, 14], [14, 15], [15, 16], [13, 17], [17, 18], [18, 19], [19, 20], [0, 17]];
const COLOURS = [0x3cd2ff, 0x5a8cff, 0xff6ec8, 0xff4646, 0xffa528, 0xffd73c, 0x82ff82, 0xffffff];
const MENU = ['NEXT', 'ADD', 'DELETE', 'EXPLODE', 'SUIT UP', 'GLOVE', 'COLOUR', 'RECENTRE', 'EXIT'];
const MODEL_RADIUS = 0.11;        // metres: how big a model is drawn at scale 1
const START_DISTANCE = 0.45;      // metres in front of you a new model appears

// ---------------------------------------------------------------- settings
const DEFAULTS = { fov: 70, eye: 1, gap: 0, ipd: 0.03, colour: 0, glove: false };
const S = { ...DEFAULTS, ...safeLoad() };
function safeLoad() {
  try { return JSON.parse(localStorage.getItem('jhvr') || '{}'); } catch { return {}; }
}
function save() { try { localStorage.setItem('jhvr', JSON.stringify(S)); } catch { /* private mode */ } }
for (const [id, fmt] of [['fov', (v) => `${v}°`], ['eye', (v) => `${Math.round(v * 100)}%`],
  ['gap', (v) => `${Math.round(v * 100)}`], ['ipd', (v) => `${Math.round(v * 1000)} mm`]]) {
  const el = document.getElementById(id), out = document.getElementById(`${id}Out`);
  el.value = S[id];
  out.textContent = fmt(S[id]);
  el.addEventListener('input', () => { S[id] = parseFloat(el.value); out.textContent = fmt(S[id]); save(); });
}

// ---------------------------------------------------------------- state
const app = {
  headset: true, running: false, video: null, landmarker: null, lastVideoTime: -1,
  matcher: new L.Matcher(), tracks: [], models: [], library: [], active: -1,
  grab: null, two: null, spin: null, spread: null, menu: null, menuT: new Map(), suit: null,
  toast: null, events: [], errors: [], fps: 0, handFps: 0, frames: 0, seenHands: 0, t: 0,
  orient: null, yaw0: 0,
};
window.__jh = app;   // for the checks and for looking at it from a laptop
const status = (s) => { document.getElementById('status').textContent = s; };
const did = (e) => { app.events.push(e); if (app.events.length > 60) app.events.shift(); };
addEventListener('error', (e) => app.errors.push(String(e.message)));
addEventListener('unhandledrejection', (e) => app.errors.push(String(e.reason)));

// ---------------------------------------------------------------- three.js
const canvas = document.getElementById('view');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.autoClear = false;
const scene = new THREE.Scene();
const rig = new THREE.Object3D();               // where your head is pointing
scene.add(rig);
const eyeCam = new THREE.PerspectiveCamera(45, 1, 0.02, 20);
rig.add(eyeCam);
const world = new THREE.Group();                // holograms live here, fixed in the room
scene.add(world);
const handLayer = new THREE.Group();            // hands are drawn in the camera's own space
rig.add(handLayer);
const hud = new THREE.Group();                  // words that stay in front of you
rig.add(hud);
const bgScene = new THREE.Scene();
const bgCam = new THREE.OrthographicCamera(-0.5, 0.5, 0.5, -0.5, 0, 1);
let videoTex = null, bgQuad = null;

function material(colour, opacity = 1) {
  return new THREE.LineBasicMaterial({ color: colour, transparent: true, opacity, blending: THREE.AdditiveBlending,
    depthWrite: false });
}

function buildModel(def) {
  const m = L.cleanModel(def);
  const g = new THREE.Group();
  g.userData = { name: m.name, parts: [], explode: 0 };
  const col = COLOURS[S.colour % COLOURS.length];
  for (const p of m.parts) {
    const pos = [];
    for (const [a, b] of p.e) pos.push(...p.v[a], ...p.v[b]);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    const lines = new THREE.LineSegments(geo, material(col, 0.95));
    const glow = new THREE.LineSegments(geo, material(col, 0.25));
    glow.scale.setScalar(1.015);
    const piece = new THREE.Group();
    piece.add(lines, glow);
    piece.userData.home = new THREE.Vector3(...p.c);
    g.add(piece);
    g.userData.parts.push(piece);
  }
  g.scale.setScalar(MODEL_RADIUS / 1.15);
  return g;
}

function setColour() {
  const col = COLOURS[S.colour % COLOURS.length];
  for (const g of app.models) {
    for (const piece of g.userData.parts) piece.children.forEach((c) => c.material.color.setHex(col));
  }
}

function addModel(i, at) {
  const def = app.library[((i % app.library.length) + app.library.length) % app.library.length];
  const g = buildModel(def);
  g.userData.lib = app.library.indexOf(def);
  g.position.copy(at || inFront(START_DISTANCE));
  g.quaternion.copy(rig.quaternion).multiply(new THREE.Quaternion().setFromEuler(new THREE.Euler(-0.35, 0.5, 0)));
  world.add(g);
  app.models.push(g);
  app.active = app.models.length - 1;
  did(`add ${def.name}`);
  return g;
}

function removeModel(g) {
  world.remove(g);
  app.models = app.models.filter((m) => m !== g);
  if (app.suit && app.suit.model === g) app.suit = null;
  app.active = app.models.length - 1;
}

function inFront(d, x = 0, y = 0) {
  return new THREE.Vector3(x, y, -d).applyQuaternion(rig.quaternion).add(rig.position);
}

// ---------------------------------------------------------------- the camera picture behind each eye
function setupBackground() {
  videoTex = new THREE.VideoTexture(app.video);
  videoTex.colorSpace = THREE.SRGBColorSpace;
  bgQuad = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ map: videoTex, depthTest: false,
    depthWrite: false }));
  bgScene.add(bgQuad);
}

function eyeViews() {
  const W = renderer.domElement.width, H = renderer.domElement.height;
  if (!app.headset) return [{ x: 0, y: 0, w: W, h: H, side: 0 }];
  const w = (W / 2) * S.eye, h = H * S.eye;
  const shift = (S.gap * W) / 2;                  // + moves the two pictures apart, - together
  return [-1, 1].map((side) => ({
    x: Math.round((side < 0 ? W / 4 : (3 * W) / 4) - w / 2 + side * shift),
    y: Math.round((H - h) / 2), w: Math.round(w), h: Math.round(h), side,
  }));
}

function videoAspect() {
  return app.video && app.video.videoWidth ? app.video.videoWidth / app.video.videoHeight : 16 / 9;
}

// ---------------------------------------------------------------- head turning (the phone's sensors)
const zee = new THREE.Vector3(0, 0, 1), q1 = new THREE.Quaternion(-Math.sqrt(0.5), 0, 0, Math.sqrt(0.5));
function orientationQuat(o) {
  const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(
    THREE.MathUtils.degToRad(o.beta || 0), THREE.MathUtils.degToRad(o.alpha || 0), -THREE.MathUtils.degToRad(o.gamma || 0), 'YXZ'));
  q.multiply(q1);
  const angle = (screen.orientation && screen.orientation.angle) || window.orientation || 0;
  q.multiply(new THREE.Quaternion().setFromAxisAngle(zee, -THREE.MathUtils.degToRad(angle)));
  return q;
}
function headTurn() {
  if (!app.orient) return;
  const q = orientationQuat(app.orient);
  const yaw = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), -app.yaw0);
  rig.quaternion.copy(yaw.multiply(q));
}
function recentre() {
  if (app.orient) {
    const e = new THREE.Euler().setFromQuaternion(orientationQuat(app.orient), 'YXZ');
    app.yaw0 = e.y;
    headTurn();
  }
  const ahead = inFront(START_DISTANCE);
  app.models.forEach((g, i) => {
    if (app.suit && app.suit.model === g) return;
    g.position.copy(ahead).add(new THREE.Vector3((i - (app.models.length - 1) / 2) * 0.28, 0, 0).applyQuaternion(rig.quaternion));
  });
  did('recentre');
}

// ---------------------------------------------------------------- hands in 3D
function handTo3D(tr) {
  const aspect = videoAspect();
  const pts = tr.raw;
  const depth = tr.depth = tr.depth ? tr.depth + (L.handDepth(pts, S.fov, aspect) - tr.depth) * 0.35
    : L.handDepth(pts, S.fov, aspect);
  const cam = (u, v) => new THREE.Vector3(...L.pointAt(u, v, depth, S.fov, aspect));
  tr.cam = pts.map(([u, v]) => cam(u, v));
  tr.camPinch = cam(...tr.hand.pinchPt);
  tr.camPalm = cam(...tr.hand.palm);
  tr.pinch3 = rig.localToWorld(tr.camPinch.clone());
  tr.palm3 = rig.localToWorld(tr.camPalm.clone());
}

const handMeshes = new Map();
function drawHands() {
  const seen = new Set();
  for (const tr of app.tracks) {
    if (tr.missing || !tr.cam) continue;
    seen.add(tr.id);
    let m = handMeshes.get(tr.id);
    if (!m) {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(BONES.length * 6), 3));
      const glove = new THREE.BufferGeometry();
      glove.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(5 * 3 * 8 * 3 + 12 * 3), 3));
      m = { bones: new THREE.LineSegments(geo, material(0x3cd2ff, 0.55)),
        glove: new THREE.LineSegments(glove, material(0xffffff, 0.9)),
        ring: new THREE.Mesh(new THREE.RingGeometry(0.9, 1, 40), new THREE.MeshBasicMaterial({ color: 0x3cd2ff,
          transparent: true, opacity: 0.6, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide })) };
      handLayer.add(m.bones, m.glove, m.ring);
      handMeshes.set(tr.id, m);
    }
    const a = m.bones.geometry.attributes.position.array;
    BONES.forEach(([i, j], k) => { tr.cam[i].toArray(a, k * 6); tr.cam[j].toArray(a, k * 6 + 3); });
    m.bones.geometry.attributes.position.needsUpdate = true;
    m.bones.material.color.setHex(tr.pinch.on ? 0xffa528 : 0x3cd2ff);
    const holding = (app.grab && app.grab.id === tr.id) || (app.suit && app.suit.id === tr.id);
    m.ring.position.copy(tr.camPalm);
    const r = Math.max(0.012, tr.depth * 0.05);
    m.ring.scale.setScalar(r);
    m.ring.material.color.setHex(holding || tr.pinch.on ? 0xffa528 : tr.hand.gap < 0.6 ? 0xffd73c : 0x3cd2ff);
    m.glove.visible = S.glove;
    if (S.glove) gloveLines(tr, m.glove);
  }
  for (const [id, m] of handMeshes) {
    if (!seen.has(id)) { handLayer.remove(m.bones, m.glove, m.ring); handMeshes.delete(id); }
  }
}

// Hologram armour plates over each finger bone and the palm (the laptop app's glove).
function gloveLines(tr, mesh) {
  const a = mesh.geometry.attributes.position.array;
  let k = 0;
  const put = (p, q) => { p.toArray(a, k); q.toArray(a, k + 3); k += 6; };
  const size = tr.cam[0].distanceTo(tr.cam[9]);
  for (const chain of [[1, 2, 3, 4], [5, 6, 7, 8], [9, 10, 11, 12], [13, 14, 15, 16], [17, 18, 19, 20]]) {
    for (let i = 0; i < 3; i++) {
      const p = tr.cam[chain[i]], q = tr.cam[chain[i + 1]];
      const d = q.clone().sub(p);
      const n = new THREE.Vector3(-d.y, d.x, 0).normalize().multiplyScalar(size * (0.085 - 0.014 * i));
      const c = [p.clone().add(n), q.clone().add(n), q.clone().sub(n), p.clone().sub(n)];
      put(c[0], c[1]); put(c[1], c[2]); put(c[2], c[3]); put(c[3], c[0]);
    }
  }
  const plate = [0, 1, 5, 9, 13, 17].map((i) => tr.cam[i]);
  plate.forEach((p, i) => put(p, plate[(i + 1) % plate.length]));
  while (k < a.length) a[k++] = 0;
  mesh.geometry.attributes.position.needsUpdate = true;
  mesh.material.color.setHex(COLOURS[S.colour % COLOURS.length]);
}

// ---------------------------------------------------------------- words that float in front of you
function toast(text, secs = 1.6) {
  if (app.toast) hud.remove(app.toast.sprite);
  const sprite = textSprite(text, '#ffd23c', 0.028);
  sprite.position.set(0, 0.07, -0.4);
  hud.add(sprite);
  app.toast = { sprite, until: app.t + secs };
}
function textSprite(text, colour, height) {
  const c = document.createElement('canvas');
  const ctx = c.getContext('2d');
  ctx.font = 'bold 56px system-ui, sans-serif';
  const w = Math.ceil(ctx.measureText(text).width) + 40;
  c.width = w; c.height = 80;
  ctx.font = 'bold 56px system-ui, sans-serif';
  ctx.fillStyle = colour;
  ctx.textBaseline = 'middle';
  ctx.shadowColor = colour; ctx.shadowBlur = 12;
  ctx.fillText(text, 20, 42);
  const tex = new THREE.CanvasTexture(c);
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false }));
  s.scale.set(height * (w / 80), height, 1);
  return s;
}

// ---------------------------------------------------------------- what the hands do
function nearestModel(p, reach = 1.4) {
  let best = -1, bestD = Infinity;
  app.models.forEach((g, i) => {
    if (app.suit && app.suit.model === g) return;
    const d = g.position.distanceTo(p);
    const r = MODEL_RADIUS * (g.scale.x / (MODEL_RADIUS / 1.15)) * reach;
    if (d < r && d < bestD) { best = i; bestD = d; }
  });
  return best;
}

function interact(dt) {
  const live = app.tracks.filter((t) => !t.missing && t.cam);
  if (menuStep(live, dt)) return;
  // grab / two-hand / spin
  for (const tr of live) {
    if (!tr.pinch.down) continue;
    const other = app.grab && app.grab.id !== tr.id ? app.tracks.find((t) => t.id === app.grab.id && t.pinch.on) : null;
    if (other) {                                   // a second pinch: resize and turn
      const g = app.grab.model;
      app.two = { a: other.id, b: tr.id, model: g, d0: other.pinch3.distanceTo(tr.pinch3), s0: g.scale.x,
        ang0: Math.atan2(tr.camPinch.y - other.camPinch.y, tr.camPinch.x - other.camPinch.x), q0: g.quaternion.clone() };
      did('two hands');
      continue;
    }
    const i = nearestModel(tr.pinch3);
    if (i >= 0) {
      const g = app.models[i];
      app.active = i;
      app.grab = { id: tr.id, model: g, offset: g.position.clone().sub(tr.pinch3) };
      did(`grab ${g.userData.name}`);
    } else if (app.active >= 0 && !app.grab) {
      app.spin = { id: tr.id, last: tr.camPinch.clone() };
    }
  }
  if (app.two) {
    const a = app.tracks.find((t) => t.id === app.two.a), b = app.tracks.find((t) => t.id === app.two.b);
    if (!a || !b || !a.pinch.on || !b.pinch.on) {
      app.two = null;
    } else if (!a.missing && !b.missing) {
      const g = app.two.model;
      const s = THREE.MathUtils.clamp(app.two.s0 * a.pinch3.distanceTo(b.pinch3) / Math.max(app.two.d0, 1e-3),
        0.25 * MODEL_RADIUS / 1.15, 4 * MODEL_RADIUS / 1.15);
      g.scale.setScalar(s);
      const ang = Math.atan2(b.camPinch.y - a.camPinch.y, b.camPinch.x - a.camPinch.x);
      const axis = new THREE.Vector3(0, 0, 1).applyQuaternion(rig.quaternion);
      g.quaternion.copy(new THREE.Quaternion().setFromAxisAngle(axis, ang - app.two.ang0).multiply(app.two.q0));
      g.position.copy(a.pinch3.clone().add(b.pinch3).multiplyScalar(0.5));
    }
  }
  if (app.grab && !app.two) {
    const tr = app.tracks.find((t) => t.id === app.grab.id);
    if (!tr || !tr.pinch.on) {
      did(`drop ${app.grab.model.userData.name}`);
      app.grab = null;
    } else if (!tr.missing) {
      app.grab.model.position.lerp(tr.pinch3.clone().add(app.grab.offset), 0.6);
    }
  }
  if (app.spin) {
    const tr = app.tracks.find((t) => t.id === app.spin.id);
    const g = app.models[app.active];
    if (!tr || !tr.pinch.on || !g) {
      app.spin = null;
    } else if (!tr.missing) {
      const d = tr.camPinch.clone().sub(app.spin.last);
      app.spin.last.copy(tr.camPinch);
      const up = new THREE.Vector3(0, 1, 0).applyQuaternion(rig.quaternion);
      const right = new THREE.Vector3(1, 0, 0).applyQuaternion(rig.quaternion);
      g.quaternion.premultiply(new THREE.Quaternion().setFromAxisAngle(up, d.x * 14))
        .premultiply(new THREE.Quaternion().setFromAxisAngle(right, -d.y * 14));
    }
  }
  // two open hands spread apart: it comes apart
  const opens = live.filter((t) => t.hand.open && !t.pinch.on);
  if (opens.length >= 2 && !app.grab && app.active >= 0) {
    const d = opens[0].palm3.distanceTo(opens[1].palm3);
    const g = app.models[app.active];
    if (!app.spread) app.spread = { d0: d, e0: g.userData.explode };
    g.userData.explode = THREE.MathUtils.clamp(app.spread.e0 + (d - app.spread.d0) / 0.25, 0, 1);
  } else {
    app.spread = null;
  }
  // a gauntlet worn on a hand
  if (app.suit) {
    // Its own hand, or, if the tracker lost it and found it again as a "new" hand, the hand
    // nearest to where it was.
    let tr = live.find((t) => t.id === app.suit.id);
    const ownGone = !app.tracks.some((t) => t.id === app.suit.id);   // not even waited for any more
    if (!tr && ownGone && app.suit.at && live.length) {
      // The tracker lost the hand for good and found it again as a "new" one, perhaps somewhere
      // else: the nearest hand takes the gauntlet back.
      tr = [...live].sort((a, b) => a.palm3.distanceTo(app.suit.at) - b.palm3.distanceTo(app.suit.at))[0];
    }
    if (tr) {
      app.suit.id = tr.id;
      app.suit.at = tr.palm3.clone();
      const g = app.suit.model;
      g.position.copy(tr.palm3);
      const d = tr.cam[9].clone().sub(tr.cam[0]);
      const roll = Math.atan2(d.x, d.y);
      g.quaternion.copy(rig.quaternion).multiply(new THREE.Quaternion().setFromEuler(new THREE.Euler(-0.25, 0, -roll)));
      // The gauntlet is 2.3 model units tall; it should run from below the wrist to the
      // fingertips: about 1.4 times the hand's length (wrist to middle fingertip).
      g.scale.setScalar((1.4 * tr.cam[0].distanceTo(tr.cam[12])) / 2.3);
      g.userData.explode = 0;
    }
  }
  // pieces drift to where the explode amount puts them
  for (const g of app.models) {
    for (const piece of g.userData.parts) {
      const want = piece.userData.home.clone().multiplyScalar(g.userData.explode * 1.3);
      piece.position.lerp(want, Math.min(1, dt * 8));
    }
    if (g !== (app.grab && app.grab.model) && !app.spin && !app.two && !(app.suit && app.suit.model === g)) {
      g.rotateY(0.25 * dt);                       // a slow turn when nobody holds it
    }
  }
}

// ---------------------------------------------------------------- the palm menu
function menuStep(live, dt) {
  if (app.menu) {
    const m = app.menu;
    m.t += dt;
    if (m.t > 7 || (live.length === 0 && m.t > 1)) {
      closeMenu();
      app.menuRearm = true;           // closed by itself: a resting hand must move before it opens again
      return true;
    }
    for (const tr of live) {
      // where the fingertip points, on the menu's flat ring
      const tip = rig.localToWorld(tr.cam[8].clone());
      const local = m.group.worldToLocal(tip.clone());
      const slot = L.ringSlot([local.x, -local.y], [0, 0], 0.035, 0.12, MENU.length);
      m.items.forEach((s, i) => s.material.opacity = i === slot ? 1 : 0.6);
      if (slot !== null && slot === m.hot) m.dwell += dt; else m.dwell = 0;
      m.hot = slot;
      const pinchSlot = tr.pinch.down ? L.ringSlot(((p) => [p.x, -p.y])(m.group.worldToLocal(tr.pinch3.clone())),
        [0, 0], 0.035, 0.12, MENU.length) : null;
      if (pinchSlot !== null || (slot !== null && m.dwell > 0.8 && m.armed)) {
        const choice = MENU[pinchSlot !== null ? pinchSlot : slot];
        closeMenu();
        menuChoice(choice, tr);
        return true;
      }
      if (slot === null) m.armed = true;
    }
    return true;
  }
  if (app.grab || app.two) return false;
  const opens = live.filter((t) => t.hand.open && !t.pinch.on);
  if (app.menuRearm && !live.some((t) => L.isStill(t))) app.menuRearm = false;
  for (const tr of live) {
    const ok = !app.menuRearm && opens.length === 1 && tr.hand.open && L.isStill(tr) && nearestModel(tr.palm3, 2.2) < 0;
    const t = ok ? (app.menuT.get(tr.id) || 0) + dt : 0;
    app.menuT.set(tr.id, t);
    if (t >= 0.8) {
      app.menuT.clear();
      openMenu(tr);
      return true;
    }
  }
  return false;
}

function openMenu(tr) {
  const group = new THREE.Group();
  group.position.copy(tr.palm3);
  group.quaternion.copy(rig.quaternion);
  const ring = new THREE.Mesh(new THREE.RingGeometry(0.035, 0.12, 48), new THREE.MeshBasicMaterial({ color: 0x0b2230,
    transparent: true, opacity: 0.55, side: THREE.DoubleSide, depthWrite: false }));
  group.add(ring);
  const items = MENU.map((name, i) => {
    const a = ((i + 0.5) / MENU.length) * Math.PI * 2 - Math.PI / 2;
    const s = textSprite(name, i === 8 ? '#ff7070' : '#c8f5ff', 0.014);
    s.position.set(Math.cos(a) * 0.078, -Math.sin(a) * 0.078, 0.002);
    s.material.opacity = 0.6;
    group.add(s);
    return s;
  });
  world.add(group);
  app.menu = { group, items, t: 0, hot: null, dwell: 0, armed: false };
  did('menu');
}
function closeMenu() {
  if (!app.menu) return;
  world.remove(app.menu.group);
  app.menu = null;
}

function menuChoice(choice, tr) {
  did(`menu ${choice}`);
  const g = app.models[app.active];
  if (choice === 'NEXT' && g) {
    const at = g.position.clone();
    const lib = g.userData.lib + 1;
    removeModel(g);
    addModel(lib, at);
    toast(app.models[app.active].userData.name);
  } else if (choice === 'ADD') {
    addModel(app.library.length ? Math.floor(Math.random() * app.library.length) : 0,
      inFront(START_DISTANCE, (Math.random() - 0.5) * 0.3, (Math.random() - 0.5) * 0.15));
    toast(app.models[app.active].userData.name);
  } else if (choice === 'DELETE' && g) {
    removeModel(g);
    toast('DELETED');
  } else if (choice === 'EXPLODE' && g) {
    g.userData.explode = g.userData.explode > 0.5 ? 0 : 1;
  } else if (choice === 'SUIT UP') {
    if (app.suit) { removeModel(app.suit.model); app.suit = null; toast('SUIT OFF'); return; }
    const k = app.library.findIndex((m) => m.name === 'GAUNTLET');
    const glove = addModel(Math.max(k, 0), tr.palm3.clone());
    app.suit = { id: tr.id, model: glove };
    toast('SUIT UP');
  } else if (choice === 'GLOVE') {
    S.glove = !S.glove; save();
    toast(S.glove ? 'GLOVE ON' : 'GLOVE OFF');
  } else if (choice === 'COLOUR') {
    S.colour = (S.colour + 1) % COLOURS.length; save();
    setColour();
  } else if (choice === 'RECENTRE') {
    recentre();
    toast('RECENTRED');
  } else if (choice === 'EXIT') {
    stop();
  }
}

// ---------------------------------------------------------------- each frame
let lastT = performance.now();
function frame(now) {
  if (!app.running) return;
  requestAnimationFrame(frame);
  const dt = Math.min(0.1, Math.max(0.001, (now - lastT) / 1000));
  lastT = now;
  app.t += dt;
  app.frames += 1;
  app.fps = app.fps ? app.fps * 0.95 + 0.05 / dt : 1 / dt;
  headTurn();
  rig.updateMatrixWorld(true);
  const v = app.video;
  let raw = null;
  if (app.feed) {
    raw = app.feed();                             // the checks: made-up hands instead of the camera's
  } else if (app.landmarker && v.readyState >= 2 && v.currentTime !== app.lastVideoTime) {
    app.lastVideoTime = v.currentTime;
    let res = null;
    try { res = app.landmarker.detectForVideo(v, now); } catch (e) { app.errors.push(String(e)); }
    raw = (res && res.landmarks) || [];
  }
  if (raw) {
    const aspect = videoAspect();
    const hands = raw.map((lm) => {
      const pts = lm.map((p) => [p.x, p.y]);
      return { ...L.readHand(pts, aspect), pts };
    });
    const gapS = app.lastDetect ? (now - app.lastDetect) / 1000 : 0;
    app.lastDetect = now;
    if (gapS > 0) app.handFps = app.handFps ? app.handFps * 0.9 + 0.1 / gapS : 1 / gapS;
    app.seenHands += hands.length ? 1 : 0;
    app.tracks = app.matcher.step(hands, dt, (t) => (app.grab && app.grab.id === t.id) || (app.suit && app.suit.id === t.id));
    for (const tr of app.tracks) {
      if (!tr.missing) { tr.raw = tr.hand.pts; handTo3D(tr); }
    }
  }
  interact(dt);
  drawHands();
  if (app.toast && app.t > app.toast.until) { hud.remove(app.toast.sprite); app.toast = null; }
  render();
}

function render() {
  const W = canvas.clientWidth * renderer.getPixelRatio(), H = canvas.clientHeight * renderer.getPixelRatio();
  if (renderer.domElement.width !== Math.round(W) || renderer.domElement.height !== Math.round(H)) {
    renderer.setSize(canvas.clientWidth, canvas.clientHeight, false);
  }
  renderer.setScissorTest(false);
  renderer.setClearColor(0x000000, 1);
  renderer.clear();
  renderer.setScissorTest(true);
  const aspectV = videoAspect();
  const vfov = 2 * Math.atan(Math.tan((S.fov * Math.PI) / 360) / aspectV) * 180 / Math.PI;
  for (const view of eyeViews()) {
    renderer.setViewport(view.x, view.y, view.w, view.h);
    renderer.setScissor(view.x, view.y, view.w, view.h);
    const crop = L.cropFor(aspectV, view.w / view.h);
    if (videoTex) {
      videoTex.repeat.set(crop.w, crop.h);
      videoTex.offset.set(crop.x0, crop.y0);
      renderer.render(bgScene, bgCam);
    }
    // The eye sees exactly the part of the picture shown behind it, so a hologram drawn at
    // a hand's place lands on that hand.
    eyeCam.fov = crop.h < 1 ? 2 * Math.atan(Math.tan((vfov * Math.PI) / 360) * crop.h) * 180 / Math.PI : vfov;
    eyeCam.aspect = view.w / view.h;
    eyeCam.position.set(view.side * S.ipd / 2, 0, 0);
    eyeCam.updateProjectionMatrix();
    eyeCam.updateMatrixWorld(true);
    renderer.render(scene, eyeCam);
  }
}

// ---------------------------------------------------------------- starting and stopping
async function start(headset) {
  app.headset = headset;
  // Full screen and landscape first, while the tap still counts: after the camera question the
  // phone no longer lets a page go full screen by itself.
  if (!TEST) {
    try { await document.documentElement.requestFullscreen({ navigationUI: 'hide' }); } catch { /* not allowed: fine */ }
    try { if (headset) await screen.orientation.lock('landscape'); } catch { /* not allowed: fine */ }
  }
  status('Starting the camera...');
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: false,
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } } });
    app.video = document.createElement('video');
    app.video.playsInline = true;
    app.video.muted = true;
    app.video.srcObject = stream;
    await app.video.play();
  } catch (e) {
    status(`The camera would not start: ${e.name || e}. Allow the camera for this page and try again.`);
    return;
  }
  if (!TEST) {
    try { app.wake = await navigator.wakeLock.request('screen'); } catch { /* fine */ }
  }
  try {
    if (typeof DeviceOrientationEvent !== 'undefined' && typeof DeviceOrientationEvent.requestPermission === 'function') {
      await DeviceOrientationEvent.requestPermission();
    }
  } catch { /* head turning off: the holograms follow the head instead */ }
  addEventListener('deviceorientation', (e) => { if (e.alpha !== null) app.orient = { alpha: e.alpha, beta: e.beta, gamma: e.gamma }; });
  status('Loading the hand tracker...');
  try {
    const { FilesetResolver, HandLandmarker } = await import(`${MP}/vision_bundle.mjs`);
    const files = await FilesetResolver.forVisionTasks(`${MP}/wasm`);
    const opts = (delegate) => ({ baseOptions: { modelAssetPath: HAND_MODEL, delegate }, runningMode: 'VIDEO', numHands: 2,
      minHandDetectionConfidence: 0.5, minHandPresenceConfidence: 0.4, minTrackingConfidence: 0.3 });
    try { app.landmarker = await HandLandmarker.createFromOptions(files, opts('GPU')); app.delegate = 'GPU'; } catch {
      app.landmarker = await HandLandmarker.createFromOptions(files, opts('CPU')); app.delegate = 'CPU';
    }
  } catch (e) {
    status(`The hand tracker would not load (is there internet?): ${e}`);
    return;
  }
  try {
    const res = await fetch('models.json');
    app.library = (await res.json()).map((m) => L.cleanModel(m));
  } catch (e) {
    status(`The models would not load: ${e}`);
    return;
  }
  document.getElementById('start').style.display = 'none';
  canvas.style.display = 'block';
  document.getElementById('exit').style.display = headset ? 'none' : 'block';
  setupBackground();
  app.running = true;
  setTimeout(() => { recentre(); if (!app.models.length) addModel(0); toast('HAND LINK ONLINE', 2.2); }, 400);
  requestAnimationFrame(frame);
}

function stop() {
  app.running = false;
  if (app.video && app.video.srcObject) app.video.srcObject.getTracks().forEach((t) => t.stop());
  if (app.wake) app.wake.release().catch(() => {});
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  canvas.style.display = 'none';
  document.getElementById('exit').style.display = 'none';
  document.getElementById('start').style.display = 'flex';
  world.clear(); app.models = []; app.grab = app.two = app.spin = app.menu = app.suit = null;
  status('Stopped. The camera is off.');
}

document.getElementById('goHeadset').addEventListener('click', () => start(true));
document.getElementById('goPhone').addEventListener('click', () => start(false));
document.getElementById('exit').addEventListener('click', stop);
if (TEST) start(new URLSearchParams(location.search).get('test') !== 'phone');
