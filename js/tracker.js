// JARVIS Hands VR: the hand tracker, in its own thread (21 Nov 2026).
// On the main thread, finding the hands in each camera picture made the drawing wait, so the
// holograms stuttered when the head turned. Here it runs beside the drawing instead: the page
// sends each new camera picture, this sends back the 21 points of each hand.
/* eslint-env worker */
/* global importScripts */
// MediaPipe's CommonJS bundle writes to `exports`; its own wasm loader then uses importScripts,
// which only a classic (not module) worker has.
var exports = {};   // eslint-disable-line no-var, no-unused-vars
let landmarker = null;

self.onmessage = async (e) => {
  const m = e.data;
  if (m.type === 'init') {
    try {
      // jsDelivr serves the .cjs file as "application/node", which importScripts refuses, so it
      // is fetched as text and run here instead (it only defines things on `exports`).
      const code = await (await fetch(`${m.mp}/vision_bundle.cjs`)).text();
      (0, eval)(code);   // eslint-disable-line no-eval
      const { FilesetResolver, HandLandmarker } = self.exports;
      const files = await FilesetResolver.forVisionTasks(`${m.mp}/wasm`);
      const opts = (delegate) => ({
        baseOptions: { modelAssetPath: m.model, delegate }, runningMode: 'VIDEO', numHands: 2,
        minHandDetectionConfidence: 0.5, minHandPresenceConfidence: 0.4, minTrackingConfidence: 0.3,
      });
      let delegate = 'GPU';
      try { landmarker = await HandLandmarker.createFromOptions(files, opts('GPU')); } catch {
        delegate = 'CPU';
        landmarker = await HandLandmarker.createFromOptions(files, opts('CPU'));
      }
      postMessage({ type: 'ready', delegate });
    } catch (err) {
      postMessage({ type: 'failed', error: String((err && err.message) || err) });
    }
  } else if (m.type === 'frame') {
    const t0 = performance.now();
    let hands = [], error = null;
    try {
      const res = landmarker.detectForVideo(m.bitmap, m.t);
      hands = (res.landmarks || []).map((lm) => lm.map((p) => [p.x, p.y]));
    } catch (err) {
      error = String((err && err.message) || err);
    }
    if (m.bitmap.close) m.bitmap.close();
    postMessage({ type: 'hands', t: m.t, hands, ms: performance.now() - t0, error });
  }
};
