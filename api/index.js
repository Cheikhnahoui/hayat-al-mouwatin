'use strict';
// Vercel serverless entry point: every request is routed here (see vercel.json).
// Start-up failures (missing env var, native module not found, database unreachable...) are
// logged clearly and answered with a plain 500 instead of crashing the whole function.
let app = null;
let startupError = null;
try {
  app = require('../src/server').createApp();
} catch (e) {
  startupError = e;
  console.error('[startup] failed to start the application:', e && e.stack ? e.stack : e);
}

module.exports = (req, res) => {
  if (startupError) {
    res.statusCode = 500;
    res.setHeader('content-type', 'text/plain; charset=utf-8');
    // set DEBUG_STARTUP=1 in the Vercel environment variables to see the reason in the browser (remove it afterwards)
    return res.end(process.env.DEBUG_STARTUP === '1' ? `Startup error:\n${startupError.stack || startupError}` : 'Startup error');
  }
  return app(req, res);
};
