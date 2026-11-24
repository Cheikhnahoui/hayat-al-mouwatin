'use strict';
// Vercel serverless entry point: every request is routed here (see vercel.json).
const { createApp } = require('../src/server');
module.exports = createApp();
