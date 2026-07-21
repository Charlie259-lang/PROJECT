'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { chromium } = require('playwright');
const { createUrlGuard } = require('./url-safety');

async function launchChromium(options) {
  try {
    return await chromium.launch(options);
  } catch (error) {
    const candidates = ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable'];
    for (const executablePath of candidates) {
      if (!fs.existsSync(executablePath)) continue;
      try {
        console.warn(`Browser bawaan Playwright tidak ditemukan. Menggunakan: ${executablePath}`);
        return await chromium.launch({ ...options, executablePath });
      } catch {}
    }
    throw error;
  }
}

const DEFAULT_MENU_SELECTORS = [
  'nav a', 'nav button', 'aside a', 'aside button',
  '.sidebar a', '.sidebar button', '.menu a', '.menu button',
  "[role='navigation'] a", "[role='navigation'] button", "[role='menuitem']"
];

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function safeFileName(value) {
  const hash = crypto.createHash('sha1').update(value).digest('hex').slice(0, 10);
  const slug = value
    .replace(/^https?:\/\//i, '')
    .replace(/[^a-z0-9]+/gi, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 70) || 'page';
  return `${slug}-${hash}.png`;
}

function normalizeUrl(value, baseUrl) {
  if (!value) return null;
  try {
    return new URL(value, baseUrl).href;
  } catch {
    return null;
  }
}

function loadConfig() {
  const configPath = path.resolve(process.argv[2] || 'config.json');
  if (!fs.existsSync(configPath)) {
    throw new Error(`Config tidak ditemukan: ${configPath}`);
  }
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  if (!config.startUrl) throw new Error('startUrl wajib diisi di config.json.');
  return { config, configPath, rootDir: path.dirname(configPath) };
}

function isExcluded(url, patterns) {
  const lower = String(url || '').toLowerCase();
  return (patterns || []).some((pattern) => lower.includes(String(pattern).toLowerCase()));
}

function isAllowed(url, allowedOrigins) {
  try {
    return allowedOrigins.includes(new URL(url).origin);
  } catch {
    return false;
  }
}

async function autoScroll(page) {
  await page.evaluate(async () => {
    const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const maxSteps = 80;
    let previousHeight = 0;

    for (let step = 0; step < maxSteps; step += 1) {
      window.scrollBy(0, Math.max(500, Math.floor(window.innerHeight * 0.8)));
      await delay(150);
      const currentHeight = document.documentElement.scrollHeight;
      if (window.scrollY + window.innerHeight >= currentHeight - 5) {
        if (currentHeight === previousHeight) break;
        previousHeight = currentHeight;
      }
    }

    window.scrollTo(0, 0);
    await delay(250);
  });
}

async function expandMenus(page) {
  await page.evaluate(() => {
    document.querySelectorAll('nav details, aside details, .sidebar details, .menu details').forEach((item) => {
      item.open = true;
    });
  }).catch(() => {});

  const toggles = page.locator([
    'nav [aria-expanded="false"]',
    'aside [aria-expanded="false"]',
    '.sidebar [aria-expanded="false"]',
    '.menu [aria-expanded="false"]'
  ].join(','));

  const count = Math.min(await toggles.count().catch(() => 0), 30);
  for (let i = 0; i < count; i += 1) {
    const toggle = toggles.nth(i);
    const text = ((await toggle.innerText().catch(() => '')) || '').trim().toLowerCase();
    const tagName = await toggle.evaluate((el) => el.tagName.toLowerCase()).catch(() => '');
    const href = (await toggle.getAttribute('href').catch(() => null)) || '';
    const ariaControls = await toggle.getAttribute('aria-controls').catch(() => null);
    const safeToggle = tagName === 'button' || Boolean(ariaControls) || !href || href === '#' || /^javascript:/i.test(href);
    if (!safeToggle || /logout|sign\s*out|keluar|hapus|delete/.test(text)) continue;
    await toggle.click({ timeout: 1500 }).catch(() => {});
  }
}

async function extractMenus(page, selectors) {
  const allMenus = [];
  for (const frame of page.frames()) {
    const frameMenus = await frame.evaluate((menuSelectors) => {
    const elements = [];
    const seen = new Set();

    for (const selector of menuSelectors) {
      let nodes = [];
      try { nodes = Array.from(document.querySelectorAll(selector)); } catch { continue; }
      for (const element of nodes) {
        if (seen.has(element)) continue;
        seen.add(element);
        elements.push(element);
      }
    }

    function visible(element) {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
    }

    function cleanText(element) {
      return (
        element.innerText ||
        element.getAttribute('aria-label') ||
        element.getAttribute('title') ||
        element.querySelector('img')?.getAttribute('alt') ||
        ''
      ).replace(/\s+/g, ' ').trim();
    }

    function inferRoute(element) {
      const attributes = ['href', 'data-href', 'data-url', 'data-route', 'data-path', 'routerlink', 'ng-reflect-router-link'];
      for (const name of attributes) {
        const value = element.getAttribute(name);
        if (value) return { value, source: name };
      }

      const onclick = element.getAttribute('onclick') || '';
      const match = onclick.match(/(?:location(?:\.href)?|window\.location)\s*=\s*['"]([^'"]+)['"]/i);
      if (match) return { value: match[1], source: 'onclick' };
      return { value: null, source: null };
    }

    return elements.map((element) => {
      const route = inferRoute(element);
      let directUrl = null;
      if (route.value && !/^javascript:/i.test(route.value)) {
        try { directUrl = new URL(route.value, location.href).href; } catch {}
      }

      return {
        menuName: cleanText(element) || '(Tanpa nama)',
        directUrl,
        rawRoute: route.value,
        routeSource: route.source,
        elementType: element.tagName.toLowerCase(),
        target: element.getAttribute('target') || '',
        visible: visible(element)
      };
    }).filter((item) => item.visible);
    }, selectors).catch(() => []);
    allMenus.push(...frameMenus.map((item) => ({ ...item, sourceFrame: frame.url() })));
  }
  return allMenus;
}

async function inspectImages(page) {
  const combined = { domBroken: [], totalImageUrls: 0 };
  for (const frame of page.frames()) {
    const result = await frame.evaluate(() => {
    const results = [];
    const allUrls = new Set();

    for (const img of document.images) {
      const url = img.currentSrc || img.src || img.getAttribute('data-src') || '';
      if (url) allUrls.add(url);

      if (url && img.complete && img.naturalWidth === 0) {
        results.push({
          imageUrl: url || '(src kosong)',
          errorType: 'DOM_BROKEN',
          status: 'naturalWidth = 0',
          element: `<img alt="${img.alt || ''}" class="${img.className || ''}">`
        });
      }
    }

    document.querySelectorAll('source[srcset]').forEach((source) => {
      const first = source.srcset.split(',')[0]?.trim().split(/\s+/)[0];
      if (first) {
        try { allUrls.add(new URL(first, location.href).href); } catch {}
      }
    });

    document.querySelectorAll('*').forEach((element) => {
      const background = getComputedStyle(element).backgroundImage;
      if (!background || background === 'none') return;
      const matches = [...background.matchAll(/url\(["']?(.+?)["']?\)/g)];
      for (const match of matches) {
        try { allUrls.add(new URL(match[1], location.href).href); } catch {}
      }
    });

      return { domBroken: results, totalImageUrls: allUrls.size };
    }).catch(() => ({ domBroken: [], totalImageUrls: 0 }));
    combined.totalImageUrls += result.totalImageUrls;
    combined.domBroken.push(...result.domBroken.map((item) => ({ ...item, frameUrl: frame.url() })));
  }
  return combined;
}

function deduplicateBroken(items) {
  const map = new Map();
  for (const item of items) {
    const key = [item.pageUrl, item.imageUrl, item.status, item.errorType].join('|');
    if (!map.has(key)) map.set(key, item);
  }
  return [...map.values()];
}

function generateHtml(data) {
  const menuRows = data.menus.map((menu, index) => {
    const type = menu.directUrl ? (menu.internal ? 'Internal' : 'Eksternal') : 'Tanpa direct link';
    const url = menu.directUrl
      ? `<a href="${escapeHtml(menu.directUrl)}" target="_blank" rel="noreferrer">${escapeHtml(menu.directUrl)}</a>`
      : `<span class="muted">${escapeHtml(menu.rawRoute || 'Tidak ditemukan')}</span>`;
    return `<tr data-search="${escapeHtml(`${menu.menuName} ${menu.directUrl || ''} ${menu.sourcePage}`.toLowerCase())}">
      <td>${index + 1}</td>
      <td><strong>${escapeHtml(menu.menuName)}</strong></td>
      <td>${url}</td>
      <td><span class="badge ${menu.directUrl ? (menu.internal ? 'ok' : 'info') : 'warn'}">${type}</span></td>
      <td><a href="${escapeHtml(menu.sourcePage)}" target="_blank" rel="noreferrer">Halaman sumber</a></td>
    </tr>`;
  }).join('');

  const imageRows = data.brokenImages.map((image, index) => {
    const screenshot = image.screenshot
      ? `<a href="${escapeHtml(image.screenshot)}" target="_blank">Lihat screenshot</a>`
      : '<span class="muted">—</span>';
    return `<tr data-search="${escapeHtml(`${image.pageTitle} ${image.pageUrl} ${image.imageUrl} ${image.status}`.toLowerCase())}" data-status="error">
      <td>${index + 1}</td>
      <td><strong>${escapeHtml(image.pageTitle || '(Tanpa judul)')}</strong><br><a href="${escapeHtml(image.pageUrl)}" target="_blank" rel="noreferrer">${escapeHtml(image.pageUrl)}</a></td>
      <td class="break"><a href="${escapeHtml(image.imageUrl)}" target="_blank" rel="noreferrer">${escapeHtml(image.imageUrl)}</a></td>
      <td><span class="badge error">${escapeHtml(image.status)}</span><br><small>${escapeHtml(image.errorType)}</small></td>
      <td class="break">${escapeHtml(image.element || '—')}</td>
      <td>${screenshot}</td>
    </tr>`;
  }).join('');

  const pageRows = data.pages.map((page, index) => `<tr>
    <td>${index + 1}</td>
    <td><a href="${escapeHtml(page.url)}" target="_blank" rel="noreferrer">${escapeHtml(page.title || page.url)}</a></td>
    <td>${page.totalImageUrls}</td>
    <td><span class="badge ${page.brokenCount ? 'error' : 'ok'}">${page.brokenCount ? `${page.brokenCount} bermasalah` : 'Aman'}</span></td>
    <td>${escapeHtml(page.navigationStatus)}</td>
  </tr>`).join('');

  return `<!doctype html>
<html lang="id">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Laporan Menu & Gambar</title>
<style>
:root{color-scheme:light;--bg:#f5f7fb;--panel:#fff;--text:#172033;--muted:#667085;--line:#e4e7ec;--ok:#067647;--okbg:#ecfdf3;--err:#b42318;--errbg:#fef3f2;--warn:#b54708;--warnbg:#fffaeb;--info:#175cd3;--infobg:#eff8ff}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font-family:Inter,Segoe UI,Arial,sans-serif}.wrap{width:min(1500px,96%);margin:28px auto 60px}.hero{background:linear-gradient(135deg,#101828,#344054);color:#fff;border-radius:18px;padding:26px;box-shadow:0 12px 35px rgba(16,24,40,.16)}h1{margin:0 0 8px;font-size:clamp(24px,3vw,38px)}.hero p{margin:4px 0;color:#d0d5dd}.cards{display:grid;grid-template-columns:repeat(4,minmax(160px,1fr));gap:14px;margin:18px 0}.card,.section{background:var(--panel);border:1px solid var(--line);border-radius:14px;box-shadow:0 5px 18px rgba(16,24,40,.05)}.card{padding:18px}.card .label{color:var(--muted);font-size:13px}.card .value{font-size:30px;font-weight:800;margin-top:5px}.section{margin-top:18px;overflow:hidden}.section-head{display:flex;align-items:center;justify-content:space-between;gap:14px;padding:18px;border-bottom:1px solid var(--line)}.section-head h2{margin:0;font-size:20px}.tools{display:flex;gap:8px;flex-wrap:wrap}input{border:1px solid #d0d5dd;border-radius:9px;padding:10px 12px;min-width:250px;font:inherit}table{width:100%;border-collapse:collapse;font-size:14px}th,td{padding:12px 14px;border-bottom:1px solid var(--line);text-align:left;vertical-align:top}th{background:#f9fafb;color:#475467;position:sticky;top:0}tr:hover td{background:#fcfcfd}a{color:#175cd3;text-decoration:none}a:hover{text-decoration:underline}.badge{display:inline-block;border-radius:999px;padding:4px 9px;font-size:12px;font-weight:700}.badge.ok{color:var(--ok);background:var(--okbg)}.badge.error{color:var(--err);background:var(--errbg)}.badge.warn{color:var(--warn);background:var(--warnbg)}.badge.info{color:var(--info);background:var(--infobg)}.muted,small{color:var(--muted)}.break{max-width:430px;overflow-wrap:anywhere}.empty{padding:28px;text-align:center;color:var(--muted)}.table-wrap{overflow:auto;max-height:680px}.footer{margin-top:18px;color:var(--muted);font-size:13px;text-align:center}@media(max-width:850px){.cards{grid-template-columns:repeat(2,1fr)}.section-head{align-items:flex-start;flex-direction:column}input{min-width:100%;width:100%}}@media(max-width:520px){.cards{grid-template-columns:1fr}.wrap{width:94%;margin-top:14px}.hero{padding:20px}th,td{padding:10px;font-size:13px}}
</style>
</head>
<body>
<div class="wrap">
  <section class="hero">
    <h1>Laporan Menu & Pengecekan Gambar</h1>
    <p>Target: ${escapeHtml(data.startUrl)}</p>
    <p>Dibuat: ${escapeHtml(data.generatedAt)}</p>
  </section>

  <div class="cards">
    <div class="card"><div class="label">Menu ditemukan</div><div class="value">${data.menus.length}</div></div>
    <div class="card"><div class="label">Direct link internal</div><div class="value">${data.menus.filter((m) => m.directUrl && m.internal).length}</div></div>
    <div class="card"><div class="label">Halaman diperiksa</div><div class="value">${data.pages.length}</div></div>
    <div class="card"><div class="label">Gambar bermasalah</div><div class="value">${data.brokenImages.length}</div></div>
  </div>

  <section class="section">
    <div class="section-head"><h2>Daftar Semua Menu</h2><div class="tools"><input id="menuSearch" placeholder="Cari nama menu atau URL..."></div></div>
    <div class="table-wrap"><table><thead><tr><th>No.</th><th>Nama Menu</th><th>Direct Link</th><th>Jenis</th><th>Ditemukan di</th></tr></thead><tbody id="menuBody">${menuRows || '<tr><td colspan="5" class="empty">Menu tidak ditemukan. Sesuaikan menuSelectors di config.json.</td></tr>'}</tbody></table></div>
  </section>

  <section class="section">
    <div class="section-head"><h2>Hasil Pengecekan Gambar</h2><div class="tools"><input id="imageSearch" placeholder="Cari halaman, URL gambar, atau error..."></div></div>
    <div class="table-wrap"><table><thead><tr><th>No.</th><th>Halaman</th><th>URL Gambar</th><th>Status</th><th>Elemen</th><th>Bukti</th></tr></thead><tbody id="imageBody">${imageRows || '<tr><td colspan="6" class="empty">Tidak ditemukan gambar yang crash atau gagal dimuat.</td></tr>'}</tbody></table></div>
  </section>

  <section class="section">
    <div class="section-head"><h2>Ringkasan Halaman</h2></div>
    <div class="table-wrap"><table><thead><tr><th>No.</th><th>Halaman</th><th>Jumlah URL Gambar</th><th>Hasil</th><th>Navigasi</th></tr></thead><tbody>${pageRows}</tbody></table></div>
  </section>

  <div class="footer">Dibuat otomatis oleh Menu & Image Checker menggunakan Playwright.</div>
</div>
<script>
function bindSearch(inputId, bodyId){
  const input=document.getElementById(inputId),body=document.getElementById(bodyId);
  if(!input||!body)return;
  input.addEventListener('input',()=>{const q=input.value.trim().toLowerCase();body.querySelectorAll('tr[data-search]').forEach(row=>{row.style.display=!q||row.dataset.search.includes(q)?'':'none';});});
}
bindSearch('menuSearch','menuBody');bindSearch('imageSearch','imageBody');
</script>
</body></html>`;
}

(async () => {
  const { config, configPath, rootDir } = loadConfig();
  const startUrl = new URL(config.startUrl).href;
  const allowedOrigins = (config.allowedOrigins?.length ? config.allowedOrigins : [new URL(startUrl).origin])
    .map((item) => new URL(item, startUrl).origin);
  const selectors = config.menuSelectors?.length ? config.menuSelectors : DEFAULT_MENU_SELECTORS;
  const outputDir = path.resolve(rootDir, config.outputDirectory || 'output');
  const screenshotDir = path.join(outputDir, 'screenshots');
  fs.rmSync(outputDir, { recursive: true, force: true });
  fs.mkdirSync(screenshotDir, { recursive: true });

  const authPath = path.resolve(rootDir, config.authStatePath || '.auth/state.json');
  const contextOptions = {
    ignoreHTTPSErrors: true,
    serviceWorkers: 'block',
    viewport: { width: 1440, height: 1000 }
  };
  if (config.useSavedLogin && fs.existsSync(authPath)) contextOptions.storageState = authPath;
  if (config.useSavedLogin && !fs.existsSync(authPath)) {
    console.warn(`Session login belum ada: ${authPath}. Jalankan SAVE_LOGIN.bat terlebih dahulu.`);
  }

  const browser = await launchChromium({ headless: config.headless !== false });
  const context = await browser.newContext(contextOptions);
  const urlGuard = createUrlGuard({ allowPrivate: config.allowPrivateTargets === true });
  await context.route('**/*', async (route) => {
    const requestUrl = route.request().url();
    if (!/^https?:/i.test(requestUrl)) {
      await route.continue();
      return;
    }
    if (await urlGuard(requestUrl)) {
      await route.continue();
    } else {
      console.warn(`[DIBLOKIR] Request menuju jaringan lokal/private: ${requestUrl}`);
      await route.abort('blockedbyclient');
    }
  });
  const page = await context.newPage();
  page.setDefaultTimeout(config.navigationTimeoutMs || 45000);

  const queue = [startUrl];
  const queued = new Set(queue);
  const visited = new Set();
  const menuMap = new Map();
  const pages = [];
  const allBroken = [];
  const maxPages = Math.max(1, Number(config.maxPages) || 100);

  while (queue.length && visited.size < maxPages) {
    const url = queue.shift();
    if (visited.has(url)) continue;
    visited.add(url);
    console.log(`[${visited.size}/${maxPages}] Memeriksa ${url}`);

    const networkBroken = [];
    const onResponse = (response) => {
      const request = response.request();
      if (request.resourceType() === 'image' && response.status() >= 400) {
        networkBroken.push({ imageUrl: response.url(), errorType: 'HTTP_ERROR', status: `HTTP ${response.status()}`, element: '' });
      }
    };
    const onRequestFailed = (request) => {
      if (request.resourceType() === 'image') {
        networkBroken.push({ imageUrl: request.url(), errorType: 'NETWORK_ERROR', status: request.failure()?.errorText || 'Request gagal', element: '' });
      }
    };
    page.on('response', onResponse);
    page.on('requestfailed', onRequestFailed);

    let navigationStatus = 'OK';
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: config.navigationTimeoutMs || 45000 });
      await page.waitForLoadState('networkidle', { timeout: 7000 }).catch(() => {});
      await expandMenus(page);
      if (config.autoScroll !== false) await autoScroll(page);
      await page.waitForTimeout(config.waitAfterLoadMs || 1200);
    } catch (error) {
      navigationStatus = `Gagal: ${error.message.split('\n')[0]}`;
    }

    const finalUrl = page.url();
    const title = await page.title().catch(() => '');
    const extractedMenus = await extractMenus(page, selectors).catch(() => []);

    for (const menu of extractedMenus) {
      const directUrl = normalizeUrl(menu.directUrl || menu.rawRoute, finalUrl);
      const record = {
        ...menu,
        directUrl,
        sourcePage: finalUrl,
        internal: directUrl ? isAllowed(directUrl, allowedOrigins) : false
      };
      const key = `${record.menuName}|${record.directUrl || record.rawRoute || ''}`;
      if (!menuMap.has(key)) menuMap.set(key, record);

      if (directUrl && record.internal && !isExcluded(directUrl, config.excludeUrlPatterns) && !queued.has(directUrl) && !visited.has(directUrl)) {
        queued.add(directUrl);
        queue.push(directUrl);
      }
    }

    const inspection = await inspectImages(page).catch(() => ({ domBroken: [], totalImageUrls: 0 }));
    let pageBroken = deduplicateBroken([
      ...networkBroken,
      ...inspection.domBroken
    ].map((item) => ({ ...item, pageUrl: finalUrl, pageTitle: title })));

    let screenshot = null;
    if (pageBroken.length && config.saveScreenshots !== false) {
      const filename = safeFileName(finalUrl);
      const absolutePath = path.join(screenshotDir, filename);
      await page.screenshot({ path: absolutePath, fullPage: true }).catch(() => {});
      if (fs.existsSync(absolutePath)) screenshot = `screenshots/${filename}`;
    }
    pageBroken = pageBroken.map((item) => ({ ...item, screenshot }));
    allBroken.push(...pageBroken);

    pages.push({
      url: finalUrl,
      title,
      totalImageUrls: inspection.totalImageUrls,
      brokenCount: pageBroken.length,
      navigationStatus
    });

    page.off('response', onResponse);
    page.off('requestfailed', onRequestFailed);
  }

  const data = {
    startUrl,
    generatedAt: new Intl.DateTimeFormat('id-ID', { dateStyle: 'full', timeStyle: 'long', timeZone: 'Asia/Phnom_Penh' }).format(new Date()),
    menus: [...menuMap.values()].sort((a, b) => a.menuName.localeCompare(b.menuName, 'id')),
    brokenImages: deduplicateBroken(allBroken),
    pages
  };

  fs.writeFileSync(path.join(outputDir, 'data.json'), JSON.stringify(data, null, 2), 'utf8');
  fs.writeFileSync(path.join(outputDir, 'report.html'), generateHtml(data), 'utf8');

  await browser.close();
  console.log('\nSelesai.');
  console.log(`Menu ditemukan       : ${data.menus.length}`);
  console.log(`Halaman diperiksa    : ${data.pages.length}`);
  console.log(`Gambar bermasalah    : ${data.brokenImages.length}`);
  console.log(`Laporan HTML         : ${path.join(outputDir, 'report.html')}`);
})().catch((error) => {
  console.error('\nTerjadi kesalahan:', error.stack || error.message);
  process.exitCode = 1;
});
