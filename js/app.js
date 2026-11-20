// JARVIS Hands VR: the laptop app's holograms, on a phone in a headset.
// The phone's back camera sees the room and your hands (MediaPipe, on this phone), the
// holograms are drawn over the room twice, once for each eye, and the phone's turn sensors keep
// them where you put them when you turn your head. Nothing is uploaded or saved.
//
// Second version (21 Nov 2026), after RED's first try ("buggy, not moving properly"):
//  - the hand points and the depth guess are smoothed (they were raw, so everything shook);
//  - you grab what your fingers are IN FRONT OF, not what is at the guessed 3D distance;
//  - the hand tracker runs in its own thread, so the drawing never waits for it;
//  - the outline of your hand is pinned to your hand in the picture, in BOTH eyes (in the
//    headset it sat about 47 pixels off in each eye before);
//  - holograms turn with the picture's own moment, so they stop sliding when you turn;
//  - thick glowing lines, a video screen, a camera picker, and it installs as an app.
import * as THREE from 'three';
import { LineSegments2 } from 'three/addons/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import * as L from './logic.js';

const MP = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14';
const HAND_MODEL = 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task';
const Q = new URLSearchParams(location.search);
const TEST = Q.has('test');
const BONES = [[0, 1], [1, 2], [2, 3], [3, 4], [0, 5], [5, 6], [6, 7], [7, 8], [5, 9], [9, 10], [10, 11], [11, 12],
  [9, 13], [13, 14], [14, 15], [15, 16], [13, 17], [17, 18], [18, 19], [19, 20], [0, 17]];
const GLOVE_SEGS = 5 * 3 * 4 + 6;
const COLOURS = [0x3cd2ff, 0x5a8cff, 0xff6ec8, 0xff4646, 0xffa528, 0xffd73c, 0x82ff82, 0xffffff];
const MENU = ['NEXT', 'ADD', 'DELETE', 'EXPLODE', 'SUIT UP', 'GLOVE', 'COLOUR', 'SCREEN', 'RECENTRE', 'EXIT'];
const MODEL_RADIUS = 0.11;        // metres: how big a model is drawn at scale 1
const START_DISTANCE = 0.45;      // metres in front of you a new model appears
const SCREEN_DISTANCE = 1.3;      // metres to the video screen
const PICTURE_DEPTH = 0.5;        // metres the camera picture seems to be at, in the headset
const DEPTH_GAIN = 1;             // a held model moves this much nearer/further per metre of hand
const FOLLOW_TAU = 0.04;          // seconds: how closely a held model follows the fingers
const LAG_MS = 70;                // camera delay to assume when the browser does not say
const UP = new THREE.Vector3(0, 1, 0);

// ---------------------------------------------------------------- settings
const DEFAULTS = { fov: 70, eye: 1, gap: 0, ipd: 0.03, colour: 0, glove: false, cam: '' };
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
  headset: true, running: false, video: null, landmarker: null, worker: null, trackerMode: '', delegate: '',
  lastVideoTime: -1, matcher: new L.Matcher(), tracks: [], models: [], library: [], active: -1,
  grab: null, two: null, spin: null, spread: null, menu: null, menuT: new Map(), suit: null, screen: null, film: null,
  toast: null, events: [], errors: [], fps: 0, handFps: 0, trackMs: 0, frames: 0, detections: 0, seenHands: 0, t: 0,
  shownAt: 0, orientSeen: false, yaw0: 0, busy: false, busySince: 0, pending: null, lastDetect: 0, warnedLight: false,
};
window.__jh = app;   // for the checks and for looking at it from a laptop
const status = (s) => { document.getElementById('status').textContent = s; };
const did = (e) => { app.events.push(e); if (app.events.length > 60) app.events.shift(); };
const oops = (e) => { if (app.errors.length < 20) app.errors.push(String(e)); };
addEventListener('error', (e) => oops(e.message));
addEventListener('unhandledrejection', (e) => oops(e.reason));
const olog = new L.OrientationLog(1200);

// ---------------------------------------------------------------- three.js
const canvas = document.getElementById('view');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.autoClear = false;
const scene = new THREE.Scene();
const rig = new THREE.Object3D();               // where your head is pointing
scene.add(rig);
const eyeCam = new THREE.PerspectiveCamera(45, 1, 0.02, 20);      // holograms: true 3D
rig.add(eyeCam);
const handCam = new THREE.PerspectiveCamera(45, 1, 0.02, 20);     // hand outlines: pinned to the picture
handCam.layers.set(1);
rig.add(handCam);
const world = new THREE.Group();                // holograms live here, fixed in the room
scene.add(world);
const handLayer = new THREE.Group();            // hands are drawn in the camera's own space
rig.add(handLayer);
const hud = new THREE.Group();                  // words that stay in front of you
rig.add(hud);
const bgScene = new THREE.Scene();
const bgCam = new THREE.OrthographicCamera(-0.5, 0.5, 0.5, -0.5, 0, 1);
let videoTex = null;

// Thick, glowing lines (plain WebGL lines are one pixel wide, which looked thin and flickery).
const lineMats = new Set();
// Glows ADD light (so they shine on a dark room); the core lines are plain colour, and a soft dark
// edge goes under them: added light on a white wall stays white, so a hologram in a bright room
// used to vanish.
function lineMaterial(colour, width, opacity, depthTest = true, blending = THREE.AdditiveBlending) {
  const m = new LineMaterial({ color: colour, linewidth: width, worldUnits: false, transparent: true, opacity,
    blending, depthWrite: false, depthTest });
  lineMats.add(m);
  return m;
}
function lines(positions, colour, width, opacity, depthTest = true, blending = THREE.NormalBlending) {
  const geo = new LineSegmentsGeometry();
  geo.setPositions(positions instanceof Float32Array ? positions : new Float32Array(positions));
  const l = new LineSegments2(geo, lineMaterial(colour, width, opacity, depthTest, blending));
  l.renderOrder = 2;
  return l;
}
// The same lines again, under the core: a dark edge and a wide glow.
function underlay(core, colour, depthTest = true) {
  const shadow = new LineSegments2(core.geometry, lineMaterial(0x000000, core.material.linewidth * 4, 0.28, depthTest,
    THREE.NormalBlending));
  const glow = new LineSegments2(core.geometry, lineMaterial(colour, core.material.linewidth * 3.2, 0.2, depthTest));
  shadow.renderOrder = 0;
  glow.renderOrder = 1;
  return [shadow, glow];
}
function setLinePositions(l, arr) {
  const data = l.geometry.attributes.instanceStart.data;
  data.array.set(arr);
  data.needsUpdate = true;
}
function dispose(o) {
  o.traverse((c) => {
    if (c.geometry) c.geometry.dispose();
    for (const m of c.material ? [].concat(c.material) : []) {
      if (m.map && !m.map.keep) m.map.dispose();
      m.dispose();
      lineMats.delete(m);
    }
  });
}

function buildModel(def) {
  const m = L.cleanModel(def);
  const g = new THREE.Group();
  g.userData = { name: m.name, parts: [], explode: 0, base: MODEL_RADIUS / 1.15 };
  const col = COLOURS[S.colour % COLOURS.length];
  for (const p of m.parts) {
    const pos = [];
    for (const [a, b] of p.e) pos.push(...p.v[a], ...p.v[b]);
    const piece = new THREE.Group();
    const core = lines(pos, col, 2.4, 0.95);
    const [shadow, glow] = underlay(core, col);
    glow.userData.tint = true;
    core.userData.tint = true;
    piece.add(shadow, glow, core);
    piece.userData.home = new THREE.Vector3(...p.c);
    g.add(piece);
    g.userData.parts.push(piece);
  }
  g.scale.setScalar(g.userData.base);
  return g;
}

function setColour() {
  const col = COLOURS[S.colour % COLOURS.length];
  for (const g of app.models) {
    for (const piece of g.userData.parts) piece.children.forEach((c) => { if (c.userData.tint) c.material.color.setHex(col); });
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
  dispose(g);
  app.models = app.models.filter((m) => m !== g);
  if (app.suit && app.suit.model === g) app.suit = null;
  if (app.grab && app.grab.model === g) app.grab = null;
  if (app.two && app.two.model === g) app.two = null;
  app.active = app.models.length - 1;
}

function inFront(d, x = 0, y = 0) {
  return new THREE.Vector3(x, y, -d).applyQuaternion(rig.quaternion).add(rig.position);
}
function facingYou() {             // the way you face, without the head's tilt to one side
  const e = new THREE.Euler().setFromQuaternion(rig.quaternion, 'YXZ');
  return new THREE.Quaternion().setFromEuler(new THREE.Euler(e.x, e.y, 0, 'YXZ'));
}

// ---------------------------------------------------------------- the camera picture behind each eye
function setupBackground() {
  if (videoTex) { videoTex.dispose(); bgScene.clear(); }
  videoTex = new THREE.VideoTexture(app.video);
  videoTex.colorSpace = THREE.SRGBColorSpace;
  bgScene.add(new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ map: videoTex,
    depthTest: false, depthWrite: false })));
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

// What one eye shows: which part of the camera picture, how wide the eye sees, and how far its
// picture is slid sideways so the room looks PICTURE_DEPTH away (then a hologram at arm's length
// sits on the room without a double image, and the hand outline can be pinned to the hand).
function eyeSetup(view) {
  const crop = L.cropFor(videoAspect(), view.w / view.h);
  const ty = L.tans(S.fov, videoAspect())[1] * crop.h;          // half-height tangent the eye sees
  const f = view.h / 2 / ty;                                     // focal length, pixels
  const shift = L.pictureShift(view.side, f, S.ipd, PICTURE_DEPTH);
  return { crop, fov: (2 * Math.atan(ty) * 180) / Math.PI, shift, texX: crop.x0 - (shift / view.w) * crop.w };
}

function aimCameras(view, eye) {
  for (const cam of [eyeCam, handCam]) {
    cam.fov = eye.fov;
    cam.aspect = view.w / view.h;
  }
  eyeCam.position.set(view.side * S.ipd / 2, 0, 0);
  eyeCam.updateProjectionMatrix();
  // The hand outline is drawn from the middle, slid exactly as far as the picture behind it.
  handCam.setViewOffset(view.w, view.h, -eye.shift, 0, view.w, view.h);
  handCam.updateProjectionMatrix();
  eyeCam.updateMatrixWorld(true);
  handCam.updateMatrixWorld(true);
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
function onOrientation(e) {
  if (e.alpha === null || e.alpha === undefined) return;
  olog.add(e.timeStamp || performance.now(), orientationQuat(e).toArray());
  if (!app.orientSeen) {
    // The first reading can come after the first hologram was placed, and the head's "forward"
    // can be anywhere: put everything in front again, or the hologram may start behind you.
    app.orientSeen = true;
    if (app.running) { headTurn(); recentre(); }
  }
}
function headQuat() {
  const qa = olog.at(app.shownAt || performance.now() - LAG_MS);
  return qa ? new THREE.Quaternion().fromArray(qa) : null;
}
function headTurn() {
  const q = headQuat();
  if (!q) return;
  rig.quaternion.copy(new THREE.Quaternion().setFromAxisAngle(UP, -app.yaw0).multiply(q));
  rig.updateMatrixWorld(true);
}
function recentre() {
  const q = headQuat();
  if (q) {
    app.yaw0 = new THREE.Euler().setFromQuaternion(q, 'YXZ').y;
    headTurn();
  }
  const ahead = inFront(START_DISTANCE);
  const free = app.models.filter((g) => !(app.suit && app.suit.model === g));
  free.forEach((g, i) => {
    g.position.copy(ahead).add(new THREE.Vector3((i - (free.length - 1) / 2) * 0.28, 0, 0).applyQuaternion(rig.quaternion));
  });
  if (app.screen) { app.screen.position.copy(inFront(SCREEN_DISTANCE)); app.screen.quaternion.copy(facingYou()); }
  did('recentre');
}

// ---------------------------------------------------------------- the hand tracker
function loadWorker() {
  return new Promise((resolve) => {
    let w;
    try { w = new Worker('js/tracker.js'); } catch (e) { oops(`worker: ${e}`); resolve(null); return; }
    const give = (ok) => { clearTimeout(timer); if (!ok) w.terminate(); resolve(ok ? w : null); };
    const timer = setTimeout(() => { oops('worker: no answer'); give(false); }, 45000);
    w.onerror = (e) => { oops(`worker: ${e.message || 'failed'}`); e.preventDefault(); give(false); };
    w.onmessage = (e) => {
      if (e.data.type === 'ready') { app.delegate = e.data.delegate; w.onmessage = onWorker; w.onerror = null; give(true); }
      if (e.data.type === 'failed') { oops(`worker: ${e.data.error}`); give(false); }
    };
    w.postMessage({ type: 'init', mp: MP, model: HAND_MODEL });
  });
}
async function loadMainThread() {
  const { FilesetResolver, HandLandmarker } = await import(`${MP}/vision_bundle.mjs`);
  const files = await FilesetResolver.forVisionTasks(`${MP}/wasm`);
  const opts = (delegate) => ({ baseOptions: { modelAssetPath: HAND_MODEL, delegate }, runningMode: 'VIDEO', numHands: 2,
    minHandDetectionConfidence: 0.5, minHandPresenceConfidence: 0.4, minTrackingConfidence: 0.3 });
  try { app.landmarker = await HandLandmarker.createFromOptions(files, opts('GPU')); app.delegate = 'GPU'; } catch {
    app.landmarker = await HandLandmarker.createFromOptions(files, opts('CPU')); app.delegate = 'CPU';
  }
}
async function loadTracker() {
  if (app.worker || app.landmarker) return;
  if (!Q.has('mainthread') && typeof Worker !== 'undefined' && typeof createImageBitmap === 'function'
      && 'requestVideoFrameCallback' in HTMLVideoElement.prototype) {
    app.worker = await loadWorker();
  }
  if (app.worker) { app.trackerMode = 'worker'; return; }
  await loadMainThread();
  app.trackerMode = 'main';
}

function onWorker(e) {
  const m = e.data;
  if (m.type !== 'hands') return;
  app.busy = false;
  app.trackMs = app.trackMs ? app.trackMs * 0.9 + m.ms * 0.1 : m.ms;
  if (m.error) oops(`tracker: ${m.error}`);
  if (!app.feed) app.pending = { hands: m.hands, t: m.t };
}

// Each new camera picture: note when it was taken (to turn the holograms by where the head was
// then), and hand it to the tracker if the tracker is free.
function pump(now, meta) {
  if (!app.running || !app.video) return;
  const taken = meta && meta.captureTime;
  if (app.lastCam) app.camFps = app.camFps ? app.camFps * 0.9 + 100 / (now - app.lastCam) : 1000 / (now - app.lastCam);
  app.lastCam = now;
  app.shownAt = taken && Math.abs(now - taken) < 1500 ? taken : now - LAG_MS;
  if (app.worker && !app.feed && (!app.busy || performance.now() - app.busySince > 2000)) {
    app.busy = true;
    app.busySince = performance.now();
    const t = performance.now();
    createImageBitmap(app.video).then((bitmap) => {
      if (app.worker) app.worker.postMessage({ type: 'frame', bitmap, t }, [bitmap]);
      else { bitmap.close(); app.busy = false; }
    }).catch((err) => { app.busy = false; oops(`picture: ${err}`); });
  }
  app.video.requestVideoFrameCallback(pump);
}

function processHands(raw, t) {
  const aspect = videoAspect();
  const hands = raw.map((pts) => ({ ...L.readHand(pts, aspect), pts }));
  const ddt = app.lastDetect ? Math.min(0.25, Math.max(0.005, (t - app.lastDetect) / 1000)) : 1 / 30;
  if (app.lastDetect) app.handFps = app.handFps ? app.handFps * 0.9 + 0.1 / ddt : 1 / ddt;
  app.lastDetect = t;
  app.detections += 1;
  app.seenHands += hands.length ? 1 : 0;
  app.tracks = app.matcher.step(hands, ddt, (tr) => (app.grab && app.grab.id === tr.id) || (app.suit && app.suit.id === tr.id));
  for (const tr of app.tracks) {
    if (tr.missing) continue;
    if (!tr.smooth) { tr.smooth = new L.HandSmoother(); tr.depthF = new L.OneEuro(0.7, 2.5, 1); }
    tr.pts = tr.smooth.step(tr.hand.pts, ddt);         // drawn and aimed with: smoothed
    tr.view = L.readHand(tr.pts, aspect);              // pinch on/off stays on the raw points: quick
    tr.depth = tr.depthF.filter(L.handDepth(tr.pts, S.fov, aspect), ddt);
  }
}

// ---------------------------------------------------------------- hands in 3D
function handTo3D(tr) {
  const aspect = videoAspect();
  const cam = (p) => new THREE.Vector3(...L.pointAt(p[0], p[1], tr.depth, S.fov, aspect));
  tr.cam = tr.pts.map(cam);
  tr.camPinch = cam(tr.view.pinchPt);
  tr.camPalm = cam(tr.view.palm);
  tr.pinch3 = rig.localToWorld(tr.camPinch.clone());
  tr.palm3 = rig.localToWorld(tr.camPalm.clone());
}

const handMeshes = new Map();
function onHandLayer(o) { o.layers.set(1); o.frustumCulled = false; return o; }
function drawHands() {
  const seen = new Set();
  for (const tr of app.tracks) {
    if (tr.missing || !tr.cam) continue;
    seen.add(tr.id);
    let m = handMeshes.get(tr.id);
    if (!m) {
      const bones = lines(new Float32Array(BONES.length * 6), 0x3cd2ff, 2.2, 0.8, false);
      const [boneShade, boneGlow] = underlay(bones, 0x3cd2ff, false);
      m = { bones, boneGlow, boneShade,
        glove: lines(new Float32Array(GLOVE_SEGS * 6), 0xffffff, 2.4, 0.9, false),
        ring: new THREE.Mesh(new THREE.RingGeometry(0.9, 1, 40), new THREE.MeshBasicMaterial({ color: 0x3cd2ff,
          transparent: true, opacity: 0.7, depthWrite: false, depthTest: false,
          side: THREE.DoubleSide })) };
      for (const o of [m.boneShade, m.boneGlow, m.bones, m.glove, m.ring]) handLayer.add(onHandLayer(o));
      handMeshes.set(tr.id, m);
    }
    const a = new Float32Array(BONES.length * 6);
    BONES.forEach(([i, j], k) => { tr.cam[i].toArray(a, k * 6); tr.cam[j].toArray(a, k * 6 + 3); });
    setLinePositions(m.bones, a);
    const col = tr.pinch.on ? 0xffa528 : 0x3cd2ff;
    m.bones.material.color.setHex(col);
    m.boneGlow.material.color.setHex(col);
    const holding = (app.grab && app.grab.id === tr.id) || (app.suit && app.suit.id === tr.id);
    m.ring.position.copy(tr.camPalm);
    m.ring.scale.setScalar(Math.max(0.012, tr.depth * 0.05));
    m.ring.material.color.setHex(holding || tr.pinch.on ? 0xffa528 : tr.hand.gap < 0.6 ? 0xffd73c : 0x3cd2ff);
    m.glove.visible = S.glove;
    if (S.glove) gloveLines(tr, m.glove);
  }
  for (const [id, m] of handMeshes) {
    if (!seen.has(id)) {
      for (const o of [m.boneShade, m.boneGlow, m.bones, m.glove, m.ring]) handLayer.remove(o);
      for (const o of [m.boneShade, m.boneGlow]) { o.material.dispose(); lineMats.delete(o.material); }
      dispose(m.bones); dispose(m.glove); dispose(m.ring);
      handMeshes.delete(id);
    }
  }
}

// Hologram armour plates over each finger bone and the palm (the laptop app's glove).
function gloveLines(tr, mesh) {
  const a = new Float32Array(GLOVE_SEGS * 6);
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
  setLinePositions(mesh, a);
  mesh.material.color.setHex(COLOURS[S.colour % COLOURS.length]);
}

// ---------------------------------------------------------------- words that float in front of you
function toast(text, secs = 1.6) {
  if (app.toast) { hud.remove(app.toast.sprite); dispose(app.toast.sprite); }
  const sprite = textSprite(text, '#ffd23c', 0.028);
  if (sprite.scale.x > 0.2) sprite.scale.multiplyScalar(0.2 / sprite.scale.x);   // fits one eye
  sprite.position.set(0, 0.07, -0.4);
  hud.add(sprite);
  app.toast = { sprite, until: app.t + secs, text };
}
function textSprite(text, colour, height) {
  const c = document.createElement('canvas');
  const ctx = c.getContext('2d');
  ctx.font = 'bold 56px system-ui, sans-serif';
  const w = Math.ceil(ctx.measureText(text).width) + 40;
  c.width = w; c.height = 80;
  ctx.font = 'bold 56px system-ui, sans-serif';
  ctx.textBaseline = 'middle';
  ctx.lineWidth = 10; ctx.lineJoin = 'round';
  ctx.strokeStyle = 'rgba(0, 10, 18, 0.55)';
  ctx.strokeText(text, 20, 42);                    // a dark edge: readable on a white wall too
  ctx.fillStyle = colour;
  ctx.shadowColor = colour; ctx.shadowBlur = 12;
  ctx.fillText(text, 20, 42);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false }));
  s.scale.set(height * (w / 80), height, 1);
  return s;
}

// ---------------------------------------------------------------- what you can grab, and aiming at it
function grabbables(withScreen = true) {
  const list = app.models.filter((g) => !(app.suit && app.suit.model === g));
  if (withScreen && app.screen && app.screen.visible) list.push(app.screen);
  return list;
}
function radiusOf(g) {
  return g.userData.screen ? g.userData.halfDiag * g.scale.x : 1.15 * g.scale.x * (1 + g.userData.explode * 0.8);
}
// The thing your fingers are in front of (as you see it), or null.
function aimAt(camPoint, slack = 1.3, withScreen = true) {
  const list = grabbables(withScreen);
  const i = L.pickByRay(camPoint.toArray(),
    list.map((g) => ({ centre: rig.worldToLocal(g.position.clone()).toArray(), radius: radiusOf(g) })), slack);
  return i >= 0 ? list[i] : null;
}
// Start holding g with the hand tr: from now on it keeps the same place relative to the fingers.
function holdWith(g, tr) {
  const local = rig.worldToLocal(g.position.clone());
  app.grab = { id: tr.id, model: g, dist: local.length(), depth0: tr.depth,
    rot: new THREE.Quaternion().setFromUnitVectors(tr.camPinch.clone().normalize(), local.clone().normalize()),
    t0: app.t, start: g.position.clone(), moved: 0 };
}
function tapped(g) {
  if (g.userData.screen) playPause();
}

function interact(dt) {
  const live = app.tracks.filter((t) => !t.missing && t.cam);
  if (menuStep(live, dt)) return;
  // grab / two-hand / spin
  for (const tr of live) {
    if (!tr.pinch.down) continue;
    const other = app.grab && app.grab.id !== tr.id ? app.tracks.find((t) => t.id === app.grab.id && t.pinch.on) : null;
    if (other && other.camPinch) {                 // a second pinch: resize and turn
      const g = app.grab.model;
      app.two = { a: other.id, b: tr.id, model: g, s0: g.scale.x, q0: g.quaternion.clone(),
        ang0: Math.max(L.angleBetween(other.camPinch.toArray(), tr.camPinch.toArray()), 0.02),
        roll0: Math.atan2(tr.camPinch.y - other.camPinch.y, tr.camPinch.x - other.camPinch.x),
        dist: rig.worldToLocal(g.position.clone()).length() };
      did('two hands');
      continue;
    }
    const g = aimAt(tr.camPinch);
    if (g) {
      holdWith(g, tr);
      if (!g.userData.screen) app.active = app.models.indexOf(g);
      did(`grab ${g.userData.name}`);
    } else if (app.active >= 0 && !app.grab) {
      app.spin = { id: tr.id, last: tr.camPinch.clone() };
    }
  }
  if (app.two) {
    const a = app.tracks.find((t) => t.id === app.two.a), b = app.tracks.find((t) => t.id === app.two.b);
    if (!a || !b || !a.pinch.on || !b.pinch.on) {
      app.two = null;
      // One hand still holds it: carry on from where it is now, not from before the resize.
      const keep = app.grab && app.tracks.find((t) => t.id === app.grab.id && t.pinch.on && t.camPinch);
      if (keep) holdWith(app.grab.model, keep);
    } else if (!a.missing && !b.missing) {
      const g = app.two.model, base = g.userData.base;
      const ang = L.angleBetween(a.camPinch.toArray(), b.camPinch.toArray());
      g.scale.setScalar(THREE.MathUtils.clamp((app.two.s0 * ang) / app.two.ang0, 0.25 * base, 4 * base));
      const roll = Math.atan2(b.camPinch.y - a.camPinch.y, b.camPinch.x - a.camPinch.x);
      const axis = new THREE.Vector3(0, 0, 1).applyQuaternion(rig.quaternion);
      g.quaternion.copy(new THREE.Quaternion().setFromAxisAngle(axis, roll - app.two.roll0).multiply(app.two.q0));
      const mid = a.camPinch.clone().normalize().add(b.camPinch.clone().normalize()).normalize();
      g.position.copy(rig.localToWorld(mid.multiplyScalar(app.two.dist)));
    }
  }
  if (app.grab && !app.two) {
    const tr = app.tracks.find((t) => t.id === app.grab.id);
    if (!tr || !tr.pinch.on) {
      const gr = app.grab;
      app.grab = null;
      did(`drop ${gr.model.userData.name}`);
      if (app.t - gr.t0 < 0.35 && gr.moved < 0.03) tapped(gr.model);
    } else if (!tr.missing && tr.camPinch) {
      const gr = app.grab;
      const dir = tr.camPinch.clone().normalize().applyQuaternion(gr.rot);
      const dist = THREE.MathUtils.clamp(gr.dist + (tr.depth - gr.depth0) * DEPTH_GAIN, 0.2, 3);
      gr.model.position.lerp(rig.localToWorld(dir.multiplyScalar(dist)), 1 - Math.exp(-dt / FOLLOW_TAU));
      gr.moved = Math.max(gr.moved, gr.model.position.distanceTo(gr.start));
    }
  }
  if (app.spin) {
    const tr = app.tracks.find((t) => t.id === app.spin.id);
    const g = app.models[app.active];
    if (!tr || !tr.pinch.on || !g) {
      app.spin = null;
    } else if (!tr.missing && tr.camPinch) {
      const d = tr.camPinch.clone().sub(app.spin.last);
      app.spin.last.copy(tr.camPinch);
      const up = new THREE.Vector3(0, 1, 0).applyQuaternion(rig.quaternion);
      const right = new THREE.Vector3(1, 0, 0).applyQuaternion(rig.quaternion);
      g.quaternion.premultiply(new THREE.Quaternion().setFromAxisAngle(up, d.x * 14))
        .premultiply(new THREE.Quaternion().setFromAxisAngle(right, -d.y * 14));
    }
  }
  // two open hands spread apart: it comes apart (judged by how far apart they LOOK)
  const opens = live.filter((t) => t.hand.open && !t.pinch.on);
  if (opens.length >= 2 && !app.grab && app.active >= 0) {
    const d = L.angleBetween(opens[0].camPalm.toArray(), opens[1].camPalm.toArray()) * START_DISTANCE;
    const g = app.models[app.active];
    if (!app.spread) app.spread = { d0: d, e0: g.userData.explode };
    g.userData.explode = THREE.MathUtils.clamp(app.spread.e0 + (d - app.spread.d0) / 0.25, 0, 1);
  } else {
    app.spread = null;
  }
  // a gauntlet worn on a hand
  if (app.suit) {
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
// Which slice of the menu ring a point of the hand is over, as you see it: the line from the
// camera through the point, met with the ring's flat face (so a wrong depth guess cannot miss).
function menuSlot(m, camPoint) {
  const o = rig.localToWorld(new THREE.Vector3());
  const d = rig.localToWorld(camPoint.clone()).sub(o);
  const n = new THREE.Vector3(0, 0, 1).applyQuaternion(m.group.quaternion);
  const hit = L.rayPlane(o.toArray(), d.toArray(), m.group.position.toArray(), n.toArray());
  if (!hit) return null;
  const local = m.group.worldToLocal(new THREE.Vector3(...hit));
  return L.ringSlot([local.x, -local.y], [0, 0], 0.035, 0.12, MENU.length);
}

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
      const slot = menuSlot(m, tr.cam[8]);
      m.items.forEach((s, i) => { s.material.opacity = i === slot ? 1 : 0.6; });
      if (slot !== null && slot === m.hot) m.dwell += dt; else m.dwell = 0;
      m.hot = slot;
      const pinchSlot = tr.pinch.down ? menuSlot(m, tr.camPinch) : null;
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
    const ok = !app.menuRearm && opens.length === 1 && tr.hand.open && L.isStill(tr) && !aimAt(tr.camPalm, 1.3, false);
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
  const ring = new THREE.Mesh(new THREE.RingGeometry(0.035, 0.12, 60), new THREE.MeshBasicMaterial({ color: 0x0b2230,
    transparent: true, opacity: 0.6, side: THREE.DoubleSide, depthWrite: false }));
  group.add(ring);
  const edge = [];
  for (const r of [0.035, 0.12]) {
    for (let i = 0; i < 60; i++) {
      const a0 = (i / 60) * Math.PI * 2, a1 = ((i + 1) / 60) * Math.PI * 2;
      edge.push(Math.cos(a0) * r, Math.sin(a0) * r, 0.001, Math.cos(a1) * r, Math.sin(a1) * r, 0.001);
    }
  }
  for (let i = 0; i < MENU.length; i++) {
    const a = (i / MENU.length) * Math.PI * 2 - Math.PI / 2;
    edge.push(Math.cos(a) * 0.035, -Math.sin(a) * 0.035, 0.001, Math.cos(a) * 0.12, -Math.sin(a) * 0.12, 0.001);
  }
  group.add(lines(edge, 0x3cd2ff, 1.6, 0.55));
  const items = MENU.map((name, i) => {
    const a = ((i + 0.5) / MENU.length) * Math.PI * 2 - Math.PI / 2;
    const s = textSprite(name, name === 'EXIT' ? '#ff7070' : '#c8f5ff', 0.0125);
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
  dispose(app.menu.group);
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
  } else if (choice === 'SCREEN') {
    showScreen(!(app.screen && app.screen.visible));
  } else if (choice === 'RECENTRE') {
    recentre();
    toast('RECENTRED');
  } else if (choice === 'EXIT') {
    stop();
  }
}

// ---------------------------------------------------------------- the video screen
function makeScreen() {
  const v = app.film.video;
  const tex = new THREE.VideoTexture(v);
  tex.colorSpace = THREE.SRGBColorSpace;
  const w = 1.0, h = w / (v.videoWidth && v.videoHeight ? v.videoWidth / v.videoHeight : 16 / 9);
  const g = new THREE.Group();
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ map: tex, toneMapped: false,
    side: THREE.DoubleSide }));
  const frame = lines([-w / 2, -h / 2, 0, w / 2, -h / 2, 0, w / 2, -h / 2, 0, w / 2, h / 2, 0,
    w / 2, h / 2, 0, -w / 2, h / 2, 0, -w / 2, h / 2, 0, -w / 2, -h / 2, 0], 0x3cd2ff, 3, 0.8);
  g.add(mesh, frame);
  g.userData = { screen: true, name: 'SCREEN', halfDiag: Math.hypot(w, h) / 2, base: 1, parts: [], explode: 0 };
  g.position.copy(inFront(SCREEN_DISTANCE));
  g.quaternion.copy(facingYou());
  world.add(g);
  app.screen = g;
}
function showScreen(on) {
  if (!app.film) { toast('PICK A VIDEO ON THE START PAGE FIRST', 2.6); return; }
  if (!app.screen) makeScreen();
  app.screen.visible = on;
  if (on) {
    app.film.video.play().catch((e) => oops(`video: ${e}`));
    toast('PINCH THE SCREEN TO PLAY OR PAUSE', 2.4);
  } else {
    app.film.video.pause();
    if (app.grab && app.grab.model === app.screen) app.grab = null;
  }
}
function playPause() {
  const v = app.film && app.film.video;
  if (!v) return;
  if (v.paused) { v.play().catch((e) => oops(`video: ${e}`)); toast('PLAY'); } else { v.pause(); toast('PAUSED'); }
}
function removeScreen() {
  if (!app.screen) return;
  world.remove(app.screen);
  dispose(app.screen);
  app.screen = null;
  if (app.film) app.film.video.pause();
}

// ---------------------------------------------------------------- each frame
let lastT = performance.now(), diagT = 0;
const diag = document.getElementById('diag');
function frame(now) {
  if (!app.running) return;
  requestAnimationFrame(frame);
  const dt = Math.min(0.1, Math.max(0.001, (now - lastT) / 1000));
  lastT = now;
  app.t += dt;
  app.frames += 1;
  app.fps = app.fps ? app.fps * 0.95 + 0.05 / dt : 1 / dt;
  const v = app.video;
  if (!app.hasRVFC) app.shownAt = performance.now() - LAG_MS;
  headTurn();
  rig.updateMatrixWorld(true);
  if (app.feed) {
    // the checks: made-up hands instead of the camera's (points as {x, y} like MediaPipe's, or [x, y])
    processHands(app.feed().map((lm) => lm.map((p) => (Array.isArray(p) ? p : [p.x, p.y]))), performance.now());
  } else if (app.pending) {
    processHands(app.pending.hands, app.pending.t);
    app.pending = null;
  } else if (app.landmarker && v.readyState >= 2 && v.currentTime !== app.lastVideoTime) {
    app.lastVideoTime = v.currentTime;
    const t = performance.now();
    let res = null;
    try { res = app.landmarker.detectForVideo(v, t); } catch (e) { oops(e); }
    processHands(((res && res.landmarks) || []).map((lm) => lm.map((p) => [p.x, p.y])), t);
  }
  for (const tr of app.tracks) if (!tr.missing && tr.pts) handTo3D(tr);
  interact(dt);
  drawHands();
  if (app.toast && app.t > app.toast.until) { hud.remove(app.toast.sprite); dispose(app.toast.sprite); app.toast = null; }
  // A dark room makes the camera itself slow (the laptop's dropped from 30 to 10 pictures a
  // second): that, not a slow tracker, is what light fixes.
  if (!app.warnedLight && app.t > 6 && app.camFps && app.camFps < 18 && !app.feed) {
    app.warnedLight = true;
    toast('MORE LIGHT = SMOOTHER HANDS', 3);
  }
  render();
  if (now - diagT > 500 && diag.style.display !== 'none') {
    diagT = now;
    diag.textContent = `${Math.round(app.fps)} fps · camera ${Math.round(app.camFps || 0)}/s · hands ${Math.round(app.handFps)}/s · ${app.trackerMode} ${app.delegate}`
      + `${app.trackMs ? ` ${Math.round(app.trackMs)} ms` : ''}${app.orientSeen ? '' : ' · no turn sensor'}`;
  }
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
  for (const view of eyeViews()) {
    renderer.setViewport(view.x, view.y, view.w, view.h);
    renderer.setScissor(view.x, view.y, view.w, view.h);
    for (const m of lineMats) m.resolution.set(view.w, view.h);
    const eye = eyeSetup(view);
    if (videoTex) {
      videoTex.repeat.set(eye.crop.w, eye.crop.h);
      videoTex.offset.set(eye.texX, eye.crop.y0);
      renderer.render(bgScene, bgCam);
    }
    aimCameras(view, eye);
    renderer.render(scene, eyeCam);                // holograms, the screen, the menu, words
    renderer.render(scene, handCam);               // hand outlines, on top, on the hands
  }
}

// For the checks: how many pixels each hand point's outline lands from that point in the camera
// picture, in each eye. useEyeCam draws them the old way (from each eye) to show what was wrong.
function checkAlign(useEyeCam = false) {
  let worst = 0;
  for (const view of eyeViews()) {
    const eye = eyeSetup(view);
    aimCameras(view, eye);
    const cam = useEyeCam ? eyeCam : handCam;
    const texX = useEyeCam ? eye.crop.x0 : eye.texX;          // the old way did not slide the picture
    for (const tr of app.tracks) {
      if (tr.missing || !tr.cam) continue;
      tr.pts.forEach(([u, v], i) => {
        const px = ((u - texX) / eye.crop.w) * view.w, py = ((v - eye.crop.y0) / eye.crop.h) * view.h;
        const p = rig.localToWorld(tr.cam[i].clone()).project(cam);
        worst = Math.max(worst, Math.hypot(((p.x + 1) / 2) * view.w - px, ((1 - p.y) / 2) * view.h - py));
      });
    }
  }
  return worst;
}
Object.assign(app, { menuChoice, checkAlign, recentre, showScreen, aimAt, onOrientation, rig, olog });

// ---------------------------------------------------------------- cameras, videos, installing
const camSelect = document.getElementById('cam');
async function listCameras(ask) {
  try {
    if (ask) (await navigator.mediaDevices.getUserMedia({ video: true })).getTracks().forEach((t) => t.stop());
    const cams = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput');
    if (!ask && cams.every((d) => !d.label)) return;      // no names until the camera is allowed once
    camSelect.length = 1;
    cams.forEach((d, i) => camSelect.add(new Option(d.label || `Camera ${i + 1}`, d.deviceId)));
    camSelect.value = cams.some((d) => d.deviceId === S.cam) ? S.cam : '';
    document.getElementById('camCount').textContent = cams.length ? `${cams.length} found` : '';
  } catch (e) { document.getElementById('camCount').textContent = `Could not list them: ${e.name || e}`; }
}
camSelect.addEventListener('change', () => { S.cam = camSelect.value; save(); });
document.getElementById('findCams').addEventListener('click', () => listCameras(true));
if (!TEST) listCameras(false);

document.getElementById('film').addEventListener('change', (e) => {
  const f = e.target.files && e.target.files[0];
  if (!f) return;
  if (app.film) { removeScreen(); URL.revokeObjectURL(app.film.url); }
  const video = document.createElement('video');
  const url = URL.createObjectURL(f);
  Object.assign(video, { src: url, playsInline: true, loop: true, preload: 'auto' });
  app.film = { video, url, name: f.name };
  document.getElementById('filmName').textContent = `Ready: ${f.name}. In the headset, open the menu and pick SCREEN.`;
});

let installEvent = null;
addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  installEvent = e;
  document.getElementById('install').hidden = false;
});
document.getElementById('install').addEventListener('click', async () => {
  if (!installEvent) return;
  installEvent.prompt();
  await installEvent.userChoice.catch(() => null);
  installEvent = null;
  document.getElementById('install').hidden = true;
});
if ('serviceWorker' in navigator && !Q.has('nosw')) {
  navigator.serviceWorker.register('sw.js').catch((e) => oops(`offline copy: ${e}`));
}

// ---------------------------------------------------------------- starting and stopping
async function openCamera() {
  const size = { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } };
  const tries = S.cam ? [{ deviceId: { exact: S.cam } }, { facingMode: { ideal: 'environment' } }]
    : [{ facingMode: { ideal: 'environment' } }];
  let last = null;
  for (const which of tries) {
    try { return await navigator.mediaDevices.getUserMedia({ audio: false, video: { ...which, ...size } }); } catch (e) { last = e; }
  }
  throw last;
}

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
    const stream = await openCamera();
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
  removeEventListener('deviceorientation', onOrientation);
  addEventListener('deviceorientation', onOrientation);
  status('Loading the hand tracker (the first time takes a while)...');
  try {
    await loadTracker();
  } catch (e) {
    status(`The hand tracker would not load (is there internet?): ${e}`);
    return;
  }
  if (!app.library.length) {
    try {
      const res = await fetch('models.json');
      app.library = (await res.json()).map((m) => L.cleanModel(m));
    } catch (e) {
      status(`The models would not load: ${e}`);
      return;
    }
  }
  document.getElementById('start').style.display = 'none';
  canvas.style.display = 'block';
  document.getElementById('exit').style.display = headset ? 'none' : 'block';
  diag.style.display = headset && !TEST ? 'none' : 'block';
  setupBackground();
  app.running = true;
  app.hasRVFC = 'requestVideoFrameCallback' in app.video;
  if (app.hasRVFC) app.video.requestVideoFrameCallback(pump);
  setTimeout(() => {
    headTurn();
    recentre();
    if (!app.models.length) addModel(0);
    toast('HAND LINK ONLINE', 2.2);
  }, 400);
  requestAnimationFrame(frame);
}

function stop() {
  app.running = false;
  if (app.video && app.video.srcObject) app.video.srcObject.getTracks().forEach((t) => t.stop());
  if (app.wake) app.wake.release().catch(() => {});
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  canvas.style.display = 'none';
  diag.style.display = 'none';
  document.getElementById('exit').style.display = 'none';
  document.getElementById('start').style.display = 'flex';
  removeScreen();
  for (const g of [...app.models]) removeModel(g);
  closeMenu();
  app.grab = app.two = app.spin = app.suit = app.pending = null;
  app.busy = false;
  status('Stopped. The camera is off.');
}

document.getElementById('goHeadset').addEventListener('click', () => start(true));
document.getElementById('goPhone').addEventListener('click', () => start(false));
document.getElementById('exit').addEventListener('click', stop);
if (TEST) start(Q.get('test') !== 'phone');
