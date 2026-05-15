#!/usr/bin/env node
/**
 * GoPro gallery: Express server that proxies a Python REST API and serves
 * a master-detail UI. The frontend only ever talks to this server — all
 * /api/* requests are streamed to the upstream gopro.py service.
 */

const http = require('http');
const path = require('path');
const { URL } = require('url');

const express = require('express');

const PORT = Number(process.env.PORT || 3000);
const UPSTREAM = process.env.GOPRO_API || 'http://127.0.0.1:8787';

const app = express();

app.use(express.static(path.join(__dirname, 'public')));

// Hop-by-hop headers from RFC 7230 §6.1 — these must not be forwarded.
const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade',
]);

app.use('/api', (req, res) => {
  const upstream = new URL(UPSTREAM);
  const forwardHeaders = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (!HOP_BY_HOP.has(k.toLowerCase())) forwardHeaders[k] = v;
  }
  forwardHeaders.host = upstream.host;
  forwardHeaders.connection = 'close';

  const upstreamReq = http.request({
    protocol: upstream.protocol,
    hostname: upstream.hostname,
    port: upstream.port,
    method: req.method,
    path: '/api' + req.url,
    headers: forwardHeaders,
    agent: false, // upstream is HTTP/1.0, avoid pooling
  }, (upstreamRes) => {
    const outHeaders = {};
    for (const [k, v] of Object.entries(upstreamRes.headers)) {
      if (!HOP_BY_HOP.has(k.toLowerCase())) outHeaders[k] = v;
    }
    res.writeHead(upstreamRes.statusCode || 502, outHeaders);
    upstreamRes.pipe(res);
  });

  upstreamReq.on('error', (err) => {
    console.error(`[proxy] ${req.method} ${req.url} -> ${err.message}`);
    if (!res.headersSent) {
      res.status(502).json({
        error: 'upstream unavailable',
        upstream: UPSTREAM,
        detail: err.message,
      });
    } else {
      res.end();
    }
  });

  if (req.method === 'GET' || req.method === 'HEAD') {
    upstreamReq.end();
  } else {
    req.pipe(upstreamReq);
  }
  // Cancel the upstream only on *premature* client disconnect. Listening on
  // req.on('close') fires after every normal completion in modern Node and
  // would abort responses in flight (seen as "socket hang up" for
  // POST/DELETE). res.on('close') with a writableEnded check fires only
  // when the client drops before we finished writing.
  res.on('close', () => {
    if (!res.writableEnded) upstreamReq.destroy();
  });
});

app.listen(PORT, () => {
  console.log(`gallery UI:  http://localhost:${PORT}`);
  console.log(`proxying:    ${UPSTREAM}/api/* -> /api/*`);
});
