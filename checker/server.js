'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { assertSafeHttpUrl } = require('./url-safety');

const HOST = process.env.HOST || '0.0.0.0';
const PORT = Number(process.env.PORT || 3210);
const ROOT = __dirname;
const CONFIG_PATH = path.join(ROOT, 'config.json');
const RUNTIME_CONFIG_PATH = path.join(ROOT, '.runtime-config.json');
const UI_PATH = path.join(ROOT, 'web', 'index.html');
const HOSTED_MODE = process.env.HOSTED_MODE !== '0';
const ALLOW_PRIVATE_TARGETS = process.env.ALLOW_PRIVATE_TARGETS === '1';
const ALLOW_SAVED_LOGIN = process.env.ALLOW_SAVED_LOGIN === '1';
const MAX_PAGES_LIMIT = Math.max(1, Math.min(1000, Number(process.env.MAX_PAGES_LIMIT) || 300));

function readBaseConfig() {
  return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
}

function getOutputDirectory() {
  const config = readBaseConfig();
  return path.resolve(ROOT, config.outputDirectory || 'output');
}

const state = {
  running: false,
  startedAt: null,
  finishedAt: null,
  exitCode: null,
  targetUrl: null,
  error: null,
  logs: [],
  reportReady: fs.existsSync(path.join(getOutputDirectory(), 'report.html'))
};

function addLog(text, type = 'info') {
  const normalized = String(text || '').replace(/\r/g, '');
  for (const line of normalized.split('\n')) {
    if (!line.trim()) continue;
    state.logs.push({ time: new Date().toISOString(), type, message: line });
  }
  if (state.logs.length > 1000) state.logs.splice(0, state.logs.length - 1000);
}

function sendJson(res, statusCode, payload, extraHeaders = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...extraHeaders
  });
  res.end(body);
}

function sendText(res, statusCode, text, contentType = 'text/plain; charset=utf-8') {
  const body = Buffer.from(text);
  res.writeHead(statusCode, {
    'Content-Type': contentType,
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  });
  res.end(body);
}

function readRequestBody(req, maxBytes = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > maxBytes) {
        reject(new Error('Data permintaan terlalu besar.'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch {
        reject(new Error('Format JSON tidak valid.'));
      }
    });
    req.on('error', reject);
  });
}

function parseOrigins(value) {
  const entries = Array.isArray(value) ? value : String(value || '').split(/[\n,]+/);
  const origins = [];
  for (const entry of entries) {
    const trimmed = String(entry || '').trim();
    if (!trimmed) continue;
    if (origins.length >= 10) throw new Error('Origin tambahan maksimal 10.');
    let origin;
    try {
      origin = new URL(trimmed).origin;
    } catch {
      throw new Error(`Origin tambahan tidak valid: ${trimmed}`);
    }
    if (!origins.includes(origin)) origins.push(origin);
  }
  return origins;
}

function publicState() {
  return {
    ...state,
    reportUrl: state.reportReady ? `/output/report.html?v=${Date.now()}` : null
  };
}

function serveFile(res, filePath) {
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    sendText(res, 404, 'File tidak ditemukan.');
    return;
  }

  const extension = path.extname(filePath).toLowerCase();
  const contentTypes = {
    '.html': 'text/html; charset=utf-8', '.json': 'application/json; charset=utf-8',
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
    '.webp': 'image/webp', '.svg': 'image/svg+xml', '.css': 'text/css; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8'
  };
  const stat = fs.statSync(filePath);
  res.writeHead(200, {
    'Content-Type': contentTypes[extension] || 'application/octet-stream',
    'Content-Length': stat.size,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'self' 'unsafe-inline' data: blob: https:; frame-ancestors 'none';"
  });
  fs.createReadStream(filePath).pipe(res);
}

async function startScan(options) {
  const base = readBaseConfig();
  const targetUrl = await assertSafeHttpUrl(options.startUrl, 'Link website', { allowPrivate: ALLOW_PRIVATE_TARGETS });
  const maxPages = Math.max(1, Math.min(MAX_PAGES_LIMIT, Number(options.maxPages) || Number(base.maxPages) || 100));
  const requestedOrigins = parseOrigins(options.allowedOrigins);
  const allowedOrigins = [];
  for (const origin of requestedOrigins) {
    await assertSafeHttpUrl(`${origin}/`, 'Origin tambahan', { allowPrivate: ALLOW_PRIVATE_TARGETS });
    allowedOrigins.push(origin);
  }

  const runtimeConfig = {
    ...base,
    startUrl: targetUrl,
    maxPages,
    headless: HOSTED_MODE ? true : options.headless !== false,
    autoScroll: options.autoScroll !== false,
    saveScreenshots: options.saveScreenshots !== false,
    useSavedLogin: ALLOW_SAVED_LOGIN && options.useSavedLogin === true,
    allowPrivateTargets: ALLOW_PRIVATE_TARGETS,
    allowedOrigins
  };

  fs.writeFileSync(RUNTIME_CONFIG_PATH, JSON.stringify(runtimeConfig, null, 2), 'utf8');
  state.running = true;
  state.startedAt = new Date().toISOString();
  state.finishedAt = null;
  state.exitCode = null;
  state.targetUrl = targetUrl;
  state.error = null;
  state.logs = [];
  state.reportReady = false;
  addLog(`Memulai pemeriksaan: ${targetUrl}`);
  addLog(`Batas halaman: ${maxPages}`);

  const child = spawn(process.execPath, [path.join(ROOT, 'scan.js'), RUNTIME_CONFIG_PATH], {
    cwd: ROOT,
    windowsHide: true,
    env: { ...process.env, FORCE_COLOR: '0' }
  });

  child.stdout.on('data', (chunk) => addLog(chunk.toString('utf8'), 'info'));
  child.stderr.on('data', (chunk) => addLog(chunk.toString('utf8'), 'error'));
  child.on('error', (error) => {
    state.running = false;
    state.finishedAt = new Date().toISOString();
    state.error = error.message;
    state.reportReady = false;
    addLog(`Gagal menjalankan scanner: ${error.message}`, 'error');
  });
  child.on('close', (code) => {
    state.running = false;
    state.finishedAt = new Date().toISOString();
    state.exitCode = code;
    state.reportReady = code === 0 && fs.existsSync(path.join(getOutputDirectory(), 'report.html'));
    if (code === 0) addLog('Pemeriksaan selesai. Laporan HTML sudah tersedia.', 'success');
    else {
      state.error = `Scanner berhenti dengan kode ${code}.`;
      addLog(state.error, 'error');
    }
  });
}

const server = http.createServer(async (req, res) => {
  const requestUrl = new URL(req.url, `http://${req.headers.host || `${HOST}:${PORT}`}`);

  if (req.method === 'GET' && requestUrl.pathname === '/health') {
    sendJson(res, 200, { ok: true, running: state.running });
    return;
  }
  if (req.method === 'GET' && requestUrl.pathname === '/') {
    serveFile(res, UI_PATH);
    return;
  }
  if (req.method === 'GET' && requestUrl.pathname === '/api/config') {
    const config = readBaseConfig();
    sendJson(res, 200, {
      maxPages: Math.min(config.maxPages || 100, MAX_PAGES_LIMIT),
      maxPagesLimit: MAX_PAGES_LIMIT,
      autoScroll: config.autoScroll !== false,
      saveScreenshots: config.saveScreenshots !== false,
      allowedOrigins: config.allowedOrigins || []
    });
    return;
  }
  if (req.method === 'GET' && requestUrl.pathname === '/api/status') {
    sendJson(res, 200, publicState());
    return;
  }
  if (req.method === 'POST' && requestUrl.pathname === '/api/scan') {
    if (state.running) {
      sendJson(res, 409, { ok: false, error: 'Pemeriksaan lain masih berjalan.' });
      return;
    }
    try {
      const body = await readRequestBody(req);
      await startScan(body);
      sendJson(res, 202, { ok: true, message: 'Pemeriksaan dimulai.' });
    } catch (error) {
      sendJson(res, 400, { ok: false, error: error.message });
    }
    return;
  }
  if (req.method === 'GET' && requestUrl.pathname.startsWith('/output/')) {
    const outputDirectory = getOutputDirectory();
    const relativePath = decodeURIComponent(requestUrl.pathname.slice('/output/'.length));
    const filePath = path.resolve(outputDirectory, relativePath);
    if (filePath !== outputDirectory && !filePath.startsWith(`${outputDirectory}${path.sep}`)) {
      sendText(res, 403, 'Akses ditolak.');
      return;
    }
    serveFile(res, filePath);
    return;
  }
  if (requestUrl.pathname === '/favicon.ico') {
    res.writeHead(204);
    res.end();
    return;
  }
  sendText(res, 404, 'Halaman tidak ditemukan.');
});

server.listen(PORT, HOST, () => {
  console.log(`Menu & Image Checker aktif pada http://${HOST}:${PORT}`);
});

server.on('error', (error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
