/* Telemetry Watchdog worker. Runs the unchanged engine away from the page so the page stays usable. */
importScripts('watchdog-engine.js');
self.onmessage = function (e) {
  try { self.postMessage({id: e.data.id, ok: true, dataset: WatchdogEngine.analyze(e.data.name, e.data.text)}); }
  catch (err) { self.postMessage({id: e.data.id, ok: false, message: err.message}); }
};
