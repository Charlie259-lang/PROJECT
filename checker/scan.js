'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { chromium } = require('playwright');
const { createUrlGuard } = require('./url-safety');

const DEFAULT_MENU_SELECTORS = [
  'nav a', 'nav button', 'header a', 'header button',
  'aside a', 'aside button', '.sidebar a', '.sidebar button',
  '.menu a', '.menu button', '[class*="sidebar" i] a', '[class*="sidebar" i] button',
  '[class*="menu" i] a', '[class*="menu" i] button',
  '[class*="nav" i] a', '[class*="nav" i] button',
  '[id*="menu" i] a', '[id*="menu" i] button',
  '[id*="nav" i] a', '[id*="nav" i] button',
  '[role="navigation"] a', '[role="navigation"] button',
  '[role="menuitem"]', '[role="treeitem"]', 'a[href]'
];

const DANGEROUS_MENU_TEXT = /(?:logout|log\s*out|sign\s*out|keluar|hapus|delete|remove|simpan|save|submit|kirim|send|approve|reject|tolak|setuju|konfirmasi|confirm|bayar|pay\s*now)/i;

async function launchChromium(options) {
  const launchOptions = {
    ...options,
    args: [
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-background-networking',
      '--disable-default-apps',
      '--disable-extensions',
      '--disable-sync'
    ]
  };
  try {
    return await chromium.launch(launchOptions);
  } catch (error) {
    const candidates = ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable'];
    for (const executablePath of candidates) {
      if (!fs.existsSync(executablePath)) continue;
      try {
        console.warn(`Browser Playwright tidak ditemukan. Menggunakan: ${executablePath}`);
        return await chromium.launch({ ...launchOptions, executablePath });
      } catch {}
    }
    throw error;
  }
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&#039;');
}

function safeFileName(value) {
  const hash = crypto.createHash('sha1').update(value).digest('hex').slice(0, 10);
  const slug = value.replace(/^https?:\/\//i, '').replace(/[^a-z0-9]+/gi, '-')
    .replace(/^-+|-+$/g, '').slice(0, 70) || 'page';
  return `${slug}-${hash}.png`;
}

function normalizeUrl(value, baseUrl) {
  if (!value || /^javascript:|^mailto:|^tel:/i.test(value)) return null;
  try {
    const url = new URL(value, baseUrl);
    url.hash = url.hash || '';
    return url.href;
  } catch { return null; }
}

function loadConfig() {
  const configPath = path.resolve(process.argv[2] || 'config.json');
  if (!fs.existsSync(configPath)) throw new Error(`Config tidak ditemukan: ${configPath}`);
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  if (!config.startUrl) throw new Error('startUrl wajib diisi.');
  return { config, configPath, rootDir: path.dirname(configPath) };
}

function isExcluded(url, patterns) {
  const lower = String(url || '').toLowerCase();
  return (patterns || []).some((pattern) => lower.includes(String(pattern).toLowerCase()));
}

function isAllowed(url, allowedOrigins) {
  try { return allowedOrigins.includes(new URL(url).origin); } catch { return false; }
}

function memoryMb() {
  return Math.round(process.memoryUsage().rss / 1024 / 1024);
}

async function autoScroll(page) {
  await page.evaluate(async () => {
    const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    let stable = 0;
    let previousHeight = 0;
    for (let step = 0; step < 40; step += 1) {
      window.scrollBy(0, Math.max(450, Math.floor(window.innerHeight * 0.85)));
      await delay(100);
      const currentHeight = document.documentElement.scrollHeight;
      if (window.scrollY + window.innerHeight >= currentHeight - 8) {
        stable = currentHeight === previousHeight ? stable + 1 : 0;
        previousHeight = currentHeight;
        if (stable >= 2) break;
      }
    }
    window.scrollTo(0, 0);
    await delay(150);
  }).catch(() => {});
}

async function expandMenus(page) {
  for (const frame of page.frames()) {
    await frame.evaluate(() => {
      document.querySelectorAll('details').forEach((item) => { item.open = true; });
    }).catch(() => {});

    const toggles = frame.locator([
      'nav [aria-expanded="false"]', 'aside [aria-expanded="false"]',
      '[class*="sidebar" i] [aria-expanded="false"]',
      '[class*="menu" i] [aria-expanded="false"]',
      '[role="navigation"] [aria-expanded="false"]'
    ].join(','));
    const count = Math.min(await toggles.count().catch(() => 0), 40);
    for (let i = 0; i < count; i += 1) {
      const toggle = toggles.nth(i);
      const info = await toggle.evaluate((el) => ({
        text: (el.innerText || el.getAttribute('aria-label') || '').trim(),
        tag: el.tagName.toLowerCase(),
        href: el.getAttribute('href') || '',
        type: el.getAttribute('type') || '',
        inForm: Boolean(el.closest('form')),
        ariaControls: el.getAttribute('aria-controls') || ''
      })).catch(() => null);
      if (!info || info.inForm || info.type === 'submit' || DANGEROUS_MENU_TEXT.test(info.text)) continue;
      const safe = info.tag === 'button' || Boolean(info.ariaControls) || !info.href || info.href === '#' || /^javascript:/i.test(info.href);
      if (!safe) continue;
      await toggle.click({ timeout: 1800 }).catch(() => {});
      await frame.waitForTimeout(80).catch(() => {});
    }
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
        try { nodes = [...document.querySelectorAll(selector)]; } catch { continue; }
        for (const element of nodes) {
          if (seen.has(element)) continue;
          seen.add(element);
          elements.push({ element, selector });
        }
      }

      const visible = (element) => {
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
      };
      const textOf = (element) => (
        element.innerText || element.getAttribute('aria-label') || element.getAttribute('title') ||
        element.querySelector('img')?.getAttribute('alt') || ''
      ).replace(/\s+/g, ' ').trim();
      const inferRoute = (element) => {
        const attrs = ['href', 'data-href', 'data-url', 'data-route', 'data-path', 'routerlink', 'ng-reflect-router-link', 'to'];
        for (const name of attrs) {
          const value = element.getAttribute(name);
          if (value) return { value, source: name };
        }
        const onclick = element.getAttribute('onclick') || '';
        const match = onclick.match(/(?:location(?:\.href)?|window\.location)\s*=\s*['"]([^'"]+)['"]/i);
        return match ? { value: match[1], source: 'onclick' } : { value: null, source: null };
      };
      const likelyMenu = (element) => Boolean(element.closest('nav,aside,header,[role="navigation"],[role="menu"],[class*="sidebar" i],[class*="menu" i],[class*="nav" i],[id*="menu" i],[id*="nav" i]'));

      return elements.map(({ element }) => {
        const route = inferRoute(element);
        let directUrl = null;
        if (route.value && !/^javascript:/i.test(route.value)) {
          try { directUrl = new URL(route.value, location.href).href; } catch {}
        }
        const isVisible = visible(element);
        return {
          menuName: textOf(element) || '(Tanpa nama)',
          directUrl,
          rawRoute: route.value,
          routeSource: route.source,
          elementType: element.tagName.toLowerCase(),
          target: element.getAttribute('target') || '',
          visible: isVisible,
          sourceKind: likelyMenu(element) ? 'menu' : 'link'
        };
      }).filter((item) => item.directUrl || item.visible);
    }, selectors).catch(() => []);
    allMenus.push(...frameMenus.map((item) => ({ ...item, sourceFrame: frame.url() })));
  }
  return allMenus;
}

async function discoverDynamicMenus(page, sourceUrl, selectors, limit) {
  if (limit <= 0) return [];
  const candidates = await page.evaluate((menuSelectors) => {
    const found = [];
    const seen = new Set();
    for (const selector of menuSelectors.filter((item) => !item.trim().startsWith('a[href]'))) {
      let nodes = [];
      try { nodes = [...document.querySelectorAll(selector)]; } catch { continue; }
      nodes.forEach((element, index) => {
        if (seen.has(element)) return;
        seen.add(element);
        const routeAttrs = ['href','data-href','data-url','data-route','data-path','routerlink','ng-reflect-router-link','to'];
        if (routeAttrs.some((name) => element.getAttribute(name))) return;
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        const visible = style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
        const text = (element.innerText || element.getAttribute('aria-label') || element.getAttribute('title') || '').replace(/\s+/g,' ').trim();
        const type = (element.getAttribute('type') || '').toLowerCase();
        if (!visible || !text || type === 'submit' || element.closest('form')) return;
        found.push({ selector, index, text });
      });
    }
    return found.slice(0, 60);
  }, selectors).catch(() => []);

  const results = [];
  for (const candidate of candidates.slice(0, limit)) {
    if (DANGEROUS_MENU_TEXT.test(candidate.text)) continue;
    try {
      if (page.url() !== sourceUrl) {
        await page.goto(sourceUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
        await page.waitForTimeout(350);
        await expandMenus(page);
      }
      const locator = page.locator(candidate.selector).nth(candidate.index);
      if (!(await locator.isVisible({ timeout: 1000 }).catch(() => false))) continue;
      const before = page.url();
      const popupPromise = page.context().waitForEvent('page', { timeout: 1400 }).catch(() => null);
      await locator.click({ timeout: 2500 }).catch(() => null);
      await page.waitForTimeout(650);
      const popup = await popupPromise;
      let destination = popup ? popup.url() : page.url();
      if (popup) {
        await popup.waitForLoadState('domcontentloaded', { timeout: 2500 }).catch(() => {});
        destination = popup.url();
        await popup.close().catch(() => {});
      }
      if (/^https?:/i.test(destination) && destination !== before) {
        results.push({
          menuName: candidate.text,
          directUrl: destination,
          rawRoute: null,
          routeSource: 'click',
          elementType: 'dynamic',
          target: popup ? '_blank' : '',
          visible: true,
          sourceKind: 'clicked',
          sourceFrame: sourceUrl
        });
      }
    } catch {}
  }
  if (page.url() !== sourceUrl) {
    await page.goto(sourceUrl, { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
  }
  return results;
}

async function inspectImages(page) {
  const combined = { domBroken: [], totalImageUrls: 0 };
  for (const frame of page.frames()) {
    const result = await frame.evaluate(() => {
      const results = [];
      const allUrls = new Set();
      for (const img of document.images) {
        const url = img.currentSrc || img.src || img.getAttribute('data-src') || img.getAttribute('data-lazy-src') || '';
        if (url) allUrls.add(url);
        if (url && img.complete && img.naturalWidth === 0) {
          results.push({ imageUrl: url, errorType: 'DOM_BROKEN', status: 'naturalWidth = 0', element: `<img alt="${img.alt || ''}" class="${img.className || ''}">` });
        }
      }
      document.querySelectorAll('source[srcset]').forEach((source) => {
        const first = source.srcset.split(',')[0]?.trim().split(/\s+/)[0];
        if (first) { try { allUrls.add(new URL(first, location.href).href); } catch {} }
      });
      let checked = 0;
      for (const element of document.querySelectorAll('*')) {
        if (checked++ >= 4000) break;
        const background = getComputedStyle(element).backgroundImage;
        if (!background || background === 'none') continue;
        for (const match of background.matchAll(/url\(["']?(.+?)["']?\)/g)) {
          try { allUrls.add(new URL(match[1], location.href).href); } catch {}
        }
      }
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
    return `<tr data-search="${escapeHtml(`${menu.menuName} ${menu.directUrl || ''} ${menu.sourcePage} ${menu.sourceKind || ''}`.toLowerCase())}">
      <td>${index + 1}</td>
      <td><strong>${escapeHtml(menu.menuName)}</strong></td>
      <td>${url}</td>
      <td><span class="badge ${menu.directUrl ? (menu.internal ? 'ok' : 'info') : 'warn'}">${type}</span></td>
      <td>${escapeHtml(menu.sourceKind === 'clicked' ? 'Hasil klik' : menu.sourceKind === 'link' ? 'Tautan halaman' : 'Menu')}</td>
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
    ${data.complete === false ? '<p><strong>Laporan sementara:</strong> pemeriksaan masih berjalan atau terhenti sebelum selesai.</p>' : ''}
  </section>

  <div class="cards">
    <div class="card"><div class="label">Menu ditemukan</div><div class="value">${data.menus.length}</div></div>
    <div class="card"><div class="label">Direct link internal</div><div class="value">${data.menus.filter((m) => m.directUrl && m.internal).length}</div></div>
    <div class="card"><div class="label">Halaman diperiksa</div><div class="value">${data.pages.length}</div></div>
    <div class="card"><div class="label">Gambar bermasalah</div><div class="value">${data.brokenImages.length}</div></div>
  </div>

  <section class="section">
    <div class="section-head"><h2>Daftar Semua Menu</h2><div class="tools"><input id="menuSearch" placeholder="Cari nama menu atau URL..."></div></div>
    <div class="table-wrap"><table><thead><tr><th>No.</th><th>Nama Menu</th><th>Direct Link</th><th>Jenis</th><th>Kategori</th><th>Ditemukan di</th></tr></thead><tbody id="menuBody">${menuRows || '<tr><td colspan="6" class="empty">Menu tidak ditemukan. Sesuaikan menuSelectors di config.json.</td></tr>'}</tbody></table></div>
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
  const { config, rootDir } = loadConfig();
  const startUrl = new URL(config.startUrl).href;
  const allowedOrigins = [...new Set((config.allowedOrigins?.length ? config.allowedOrigins : [new URL(startUrl).origin])
    .map((item) => new URL(item, startUrl).origin))];
  const selectors = config.menuSelectors?.length ? [...new Set([...config.menuSelectors, ...DEFAULT_MENU_SELECTORS])] : DEFAULT_MENU_SELECTORS;
  const outputDir = path.resolve(rootDir, config.outputDirectory || 'output');
  const screenshotDir = path.join(outputDir, 'screenshots');
  fs.rmSync(outputDir, { recursive: true, force: true });
  fs.mkdirSync(screenshotDir, { recursive: true });

  const authPath = path.resolve(rootDir, config.authStatePath || '.auth/state.json');
  const contextOptions = {
    ignoreHTTPSErrors: true,
    serviceWorkers: 'block',
    viewport: { width: 1280, height: 800 }
  };
  if (config.useSavedLogin && fs.existsSync(authPath)) contextOptions.storageState = authPath;

  const browser = await launchChromium({ headless: config.headless !== false });
  const urlGuard = createUrlGuard({ allowPrivate: config.allowPrivateTargets === true });
  const queue = [startUrl];
  const queued = new Set(queue);
  const visited = new Set();
  const menuMap = new Map();
  const pages = [];
  const allBroken = [];
  const maxPages = Math.max(1, Number(config.maxPages) || 30);
  const dynamicClickLimit = Math.max(0, Math.min(20, Number(config.maxDynamicMenuClicks) || 8));
  let dynamicClicksUsed = 0;

  const buildData = (complete) => ({
    startUrl,
    complete,
    generatedAt: new Intl.DateTimeFormat('id-ID', { dateStyle: 'full', timeStyle: 'long', timeZone: 'Asia/Phnom_Penh' }).format(new Date()),
    menus: [...menuMap.values()].sort((a, b) => a.menuName.localeCompare(b.menuName, 'id')),
    brokenImages: deduplicateBroken(allBroken),
    pages
  });

  const writeSnapshot = (complete, currentUrl = null) => {
    const data = buildData(complete);
    fs.writeFileSync(path.join(outputDir, 'data.json'), JSON.stringify(data, null, 2), 'utf8');
    fs.writeFileSync(path.join(outputDir, 'report.html'), generateHtml(data), 'utf8');
    fs.writeFileSync(path.join(outputDir, 'progress.json'), JSON.stringify({
      running: !complete,
      complete,
      currentUrl,
      pagesScanned: pages.length,
      maxPages,
      queueRemaining: queue.length,
      menusFound: data.menus.length,
      brokenImages: data.brokenImages.length,
      memoryMb: memoryMb(),
      updatedAt: new Date().toISOString()
    }, null, 2), 'utf8');
  };

  while (queue.length && visited.size < maxPages) {
    const url = queue.shift();
    if (visited.has(url)) continue;
    visited.add(url);
    console.log(`[${visited.size}/${maxPages}] Memeriksa ${url} | RAM Node ${memoryMb()} MB`);

    const context = await browser.newContext(contextOptions);
    await context.route('**/*', async (route) => {
      const requestUrl = route.request().url();
      if (!/^https?:/i.test(requestUrl)) return route.continue();
      if (await urlGuard(requestUrl)) return route.continue();
      console.warn(`[DIBLOKIR] ${requestUrl}`);
      return route.abort('blockedbyclient');
    });
    const page = await context.newPage();
    page.setDefaultTimeout(config.navigationTimeoutMs || 30000);

    const networkBroken = [];
    page.on('response', (response) => {
      const request = response.request();
      if (request.resourceType() === 'image' && response.status() >= 400) {
        networkBroken.push({ imageUrl: response.url(), errorType: 'HTTP_ERROR', status: `HTTP ${response.status()}`, element: '' });
      }
    });
    page.on('requestfailed', (request) => {
      if (request.resourceType() === 'image') {
        networkBroken.push({ imageUrl: request.url(), errorType: 'NETWORK_ERROR', status: request.failure()?.errorText || 'Request gagal', element: '' });
      }
    });

    let navigationStatus = 'OK';
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: config.navigationTimeoutMs || 30000 });
      await page.waitForTimeout(Math.max(400, Number(config.waitAfterLoadMs) || 900));
      await expandMenus(page);
      if (config.autoScroll !== false) await autoScroll(page);
      await page.waitForTimeout(350);
    } catch (error) {
      navigationStatus = `Gagal: ${String(error.message).split('\n')[0]}`;
    }

    const finalUrl = page.url();
    const title = await page.title().catch(() => '');
    const extractedMenus = await extractMenus(page, selectors).catch(() => []);

    // Periksa gambar sebelum mencoba klik menu dinamis, supaya navigasi percobaan
    // tidak mengubah halaman yang sedang dianalisis.
    const inspection = await inspectImages(page).catch(() => ({ domBroken: [], totalImageUrls: 0 }));
    let pageBroken = deduplicateBroken([...networkBroken, ...inspection.domBroken]
      .map((item) => ({ ...item, pageUrl: finalUrl, pageTitle: title })));

    let screenshot = null;
    if (pageBroken.length && config.saveScreenshots === true) {
      const filename = safeFileName(finalUrl);
      const absolutePath = path.join(screenshotDir, filename);
      await page.screenshot({ path: absolutePath, fullPage: false }).catch(() => {});
      if (fs.existsSync(absolutePath)) screenshot = `screenshots/${filename}`;
    }
    pageBroken = pageBroken.map((item) => ({ ...item, screenshot }));
    allBroken.push(...pageBroken);

    if (dynamicClicksUsed < dynamicClickLimit && visited.size <= 2) {
      const discovered = await discoverDynamicMenus(page, finalUrl, selectors, dynamicClickLimit - dynamicClicksUsed).catch(() => []);
      dynamicClicksUsed += discovered.length;
      extractedMenus.push(...discovered);
    }

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

    pages.push({ url: finalUrl, title, totalImageUrls: inspection.totalImageUrls, brokenCount: pageBroken.length, navigationStatus });

    writeSnapshot(false, finalUrl);
    console.log(`  Menu: ${menuMap.size} | Halaman: ${pages.length} | Gambar error: ${deduplicateBroken(allBroken).length}`);
    await context.close().catch(() => {});
  }

  writeSnapshot(true, null);
  await browser.close();
  const data = buildData(true);
  console.log('\nSelesai.');
  console.log(`Menu/tautan ditemukan : ${data.menus.length}`);
  console.log(`Halaman diperiksa     : ${data.pages.length}`);
  console.log(`Gambar bermasalah     : ${data.brokenImages.length}`);
  console.log(`Laporan HTML          : ${path.join(outputDir, 'report.html')}`);
})().catch((error) => {
  console.error('\nTerjadi kesalahan:', error.stack || error.message);
  process.exitCode = 1;
});
