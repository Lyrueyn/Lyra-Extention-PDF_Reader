/* Run: node tests/smoke.cjs. Set PLAYWRIGHT_MODULE if Playwright is not on Node's module path.
 * Uses generated PDFs and an optional LYRA_TEST_PDF; never modifies the user's library. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(__dirname, '..');
const artifacts = path.join(root, 'artifacts');
fs.mkdirSync(artifacts, { recursive: true });
function makePdf(count, { mixed = false, text = true } = {}) {
  const objects = [];
  function add(s) { objects.push(s); return objects.length; }
  add(''); add('');
  const font = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  const pages = [];
  for (let i = 1; i <= count; i++) {
    const landscape = mixed && i % 3 === 2, w = landscape ? 842 : 595, h = landscape ? 595 : 842;
    const commands = ['0.90 0.96 1 rg', `30 ${h-155} ${w-60} 125 re f`, '0.1 0.2 0.35 rg'];
    if (text) {
      commands.push(`BT /F1 25 Tf 48 ${h-80} Td (Lyra Reader - Page ${i}) Tj ET`);
      commands.push(`BT /F1 13 Tf 48 ${h-115} Td (needle alpha beta - searchable text) Tj ET`);
      for (let j = 0; j < 13; j++) commands.push(`BT /F1 12 Tf 48 ${h-200-j*27} Td (Reading line ${j+1}: selection and continuous scrolling.) Tj ET`);
    }
    const content = commands.join('\n');
    const stream = add(`<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`);
    pages.push(add(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${w} ${h}] ${mixed && i % 3 === 0 ? '/Rotate 90' : ''} /Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${stream} 0 R >>`));
  }
  const outline = add('');
  const entries = [];
  for (let i = 0; i < Math.min(count, 4); i++) entries.push(add(''));
  entries.forEach((id, i) => {
    objects[id-1] = `<< /Title (Chapter ${i+1}) /Parent ${outline} 0 R /Dest [${pages[i]} 0 R /Fit] ${i ? `/Prev ${entries[i-1]} 0 R` : ''} ${i+1<entries.length ? `/Next ${entries[i+1]} 0 R` : ''} >>`;
  });
  objects[outline-1] = `<< /Type /Outlines /First ${entries[0]} 0 R /Last ${entries.at(-1)} 0 R /Count ${entries.length} >>`;
  objects[0] = `<< /Type /Catalog /Pages 2 0 R /Outlines ${outline} 0 R >>`;
  objects[1] = `<< /Type /Pages /Kids [${pages.map(id=>`${id} 0 R`).join(' ')}] /Count ${count} >>`;
  let result = '%PDF-1.7\n', offsets = [0];
  objects.forEach((s, i) => { offsets.push(Buffer.byteLength(result)); result += `${i+1} 0 obj\n${s}\nendobj\n`; });
  const xref = Buffer.byteLength(result);
  result += `xref\n0 ${objects.length+1}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) result += `${String(offset).padStart(10, '0')} 00000 n \n`;
  result += `trailer\n<< /Size ${objects.length+1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(result);
}
const fixture = { 'mixed.pdf': makePdf(18, { mixed: true }), 'long.pdf': makePdf(180), 'one.pdf': makePdf(1), 'scan.pdf': makePdf(2, { text: false }), 'broken.pdf': Buffer.from('not a pdf'), 'encrypted.pdf': require('./encrypted-fixture.cjs')() };
const mime = { '.html':'text/html; charset=utf-8', '.js':'application/javascript', '.css':'text/css', '.pdf':'application/pdf', '.json':'application/json' };
const server = http.createServer((req, res) => {
  const name = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  if (name.startsWith('/fixtures/')) {
    const key = name.split('/').pop();
    if (key === 'real.pdf' && process.env.LYRA_TEST_PDF) {
      res.writeHead(200, { 'Content-Type': 'application/pdf' }); fs.createReadStream(process.env.LYRA_TEST_PDF).pipe(res); return;
    }
    if (key === 'encrypted.pdf' && process.env.LYRA_ENCRYPTED_PDF) {
      res.writeHead(200, { 'Content-Type': 'application/pdf' }); fs.createReadStream(process.env.LYRA_ENCRYPTED_PDF).pipe(res); return;
    }
    if (key === 'slow.pdf') { setTimeout(() => { res.writeHead(200, { 'Content-Type': 'application/pdf' }); res.end(fixture['long.pdf']); }, 700); return; }
    if (fixture[key]) { res.writeHead(200, { 'Content-Type': 'application/pdf' }); res.end(fixture[key]); return; }
    res.writeHead(404); res.end('Not found'); return;
  }
  const file = path.resolve(root, '.' + (name === '/' ? '/index.html' : name));
  if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'Content-Type': mime[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
  fs.createReadStream(file).pipe(res);
});
(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ headless: true,
    ...(process.env.LYRA_BROWSER_PATH ? { executablePath: process.env.LYRA_BROWSER_PATH } : {}) });
  const context = await browser.newContext({ viewport: { width: 1440, height: 960 }, deviceScaleFactor: 1.5 });
  const page = await context.newPage();
  const errors = [], results = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    window.hostMessages = [];
    window.chrome = window.chrome || {};
    window.chrome.webview = { postMessage: message => window.hostMessages.push(message) };
  });
  const check = async (name, fn) => { await fn(); results.push(name); console.log('PASS', name); };
  async function open(key, display = key) {
    await page.goto(`${base}/index.html?file=fixtures/${key}&name=${encodeURIComponent(display)}`);
    await page.waitForFunction(() => document.querySelector('#loading').hidden && document.querySelector('.pageWrap canvas'));
    await page.waitForSelector('.textLayer');
  }
  async function jump(n) {
    await page.locator('#pageInput').fill(String(n)); await page.locator('#pageInput').press('Enter');
    await page.waitForFunction(n => document.querySelector('#pageInput').value === String(n) && !!document.querySelector(`.pageWrap[data-page="${n}"] .textLayer`), n);
  }
  async function quiescent() {
    await page.waitForTimeout(600);
    // Canvas identity is checked inside the page across a quiet interval.
    const stable = await page.evaluate(async () => {
      const current = [...document.querySelectorAll('.pageWrap canvas')];
      await new Promise(resolve => setTimeout(resolve, 500));
      return current.every(c => c.isConnected);
    });
    assert(stable, 'bitmaps must settle rather than continuously rerender');
  }
  try {
    await check('host filename, first render and ready signal', async () => {
      await open('mixed.pdf', '100% 阅读资料.pdf');
      assert.equal(await page.locator('#fileName').innerText(), '100% 阅读资料.pdf');
      assert.equal(await page.locator('#pageTotal').innerText(), '/ 18');
      assert(await page.evaluate(() => window.hostMessages.some(m => m.type === 'lyra-book-ready')));
      assert(await page.locator('#prevBtn').isDisabled());
    });
    await check('mixed sizes and built-in rotated text alignment', async () => {
      await jump(3);
      const dimensions = await page.evaluate(() => [1,2,3].map(n => {
        const p = document.querySelector(`.pageWrap[data-page="${n}"]`), text = p.querySelector('.textLayer');
        const a = p.getBoundingClientRect(), b = text?.getBoundingClientRect();
        return { ratio: a.width/a.height, layerWidth: b?.width, layerHeight: b?.height, width:a.width, height:a.height };
      }));
      assert(Math.abs(dimensions[0].ratio - 595/842)<.01);
      assert(Math.abs(dimensions[1].ratio - 842/595)<.01);
      assert(Math.abs(dimensions[2].ratio - 842/595)<.01);
      assert(Math.abs(dimensions[2].layerWidth - dimensions[2].width)<2);
      assert(Math.abs(dimensions[2].layerHeight - dimensions[2].height)<2);
    });
    await check('selectable text and literal full-text search', async () => {
      await jump(1);
      const selection = await page.evaluate(() => {
        const span = document.querySelector('.pageWrap[data-page="1"] .textLayer span');
        const range = document.createRange(); range.selectNodeContents(span); getSelection().removeAllRanges(); getSelection().addRange(range);
        return getSelection().toString();
      });
      assert(selection.includes('Lyra Reader'));
      await page.keyboard.press('Control+f'); await page.locator('#searchInput').fill('needle alpha');
      await page.waitForFunction(() => document.querySelector('#searchCount').textContent === '1 / 18 处');
      await page.waitForSelector('mark.selected');
      await page.locator('#searchNext').click();
      await page.waitForFunction(() => document.querySelector('#pageInput').value === '2' && document.querySelector('.pageWrap[data-page="2"] mark.selected'));
      await page.locator('#searchInput').fill('[');
      await page.waitForFunction(() => document.querySelector('#searchCount').textContent.startsWith('未找到'));
      await page.locator('#searchInput').fill('needle');
      await page.waitForFunction(() => document.querySelector('#searchCount').textContent === '1 / 18 处');
      await page.locator('#searchClose').click();
      assert.equal(await page.locator('mark').count(), 0);
    });
    await check('outline navigation', async () => {
      await page.locator('#outlineTab').click(); await page.getByRole('button', { name: 'Chapter 4', exact: true }).click();
      await page.waitForFunction(() => document.querySelector('#pageInput').value === '4');
      await page.locator('#thumbTab').click();
    });
    await check('late outline resolution does not override newer navigation', async () => {
      await page.evaluate(async () => {
        const aux = await pdfjsLib.getDocument('fixtures/one.pdf').promise;
        const proto = Object.getPrototypeOf(aux), original = proto.getPageIndex;
        window.restoreOutline = () => { proto.getPageIndex = original; };
        proto.getPageIndex = async function(...args) { const result = await original.apply(this,args); await new Promise(r=>setTimeout(r,700)); return result; };
        await aux.destroy();
      });
      await page.locator('#outlineTab').click(); await page.getByRole('button', { name:'Chapter 1', exact:true }).click();
      await jump(12); await page.waitForTimeout(900);
      assert.equal(await page.locator('#pageInput').inputValue(), '12');
      await page.evaluate(() => window.restoreOutline()); await page.locator('#thumbTab').click();
    });
    await check('rapid zoom, fit persistence and reading-position preservation', async () => {
      await jump(10);
      await page.evaluate(() => { document.querySelector('#viewer').scrollTop += 250; });
      const before = await page.evaluate(() => {
        const p = document.querySelector('.pageWrap[data-page="10"]'), v = document.querySelector('#viewer');
        return (v.getBoundingClientRect().top - p.getBoundingClientRect().top)/p.clientHeight;
      });
      await page.evaluate(() => { for(let i=0;i<5;i++) document.querySelector('#zoomInBtn').click(); for(let i=0;i<3;i++) document.querySelector('#zoomOutBtn').click(); });
      await page.waitForSelector('.pageWrap[data-page="10"] .textLayer');
      const after = await page.evaluate(() => {
        const p = document.querySelector('.pageWrap[data-page="10"]'), v = document.querySelector('#viewer');
        return (v.getBoundingClientRect().top - p.getBoundingClientRect().top)/p.clientHeight;
      });
      assert(Math.abs(before-after)<.02, `anchor changed ${before} -> ${after}`);
      await page.locator('#zoomMode').selectOption('width');
      await page.setViewportSize({ width: 1120, height: 850 });
      await page.waitForTimeout(500);
      await page.locator('#sidebarBtn').click();
      await page.waitForTimeout(500);
      assert.equal(await page.locator('#zoomMode').inputValue(), 'width');
      assert(await page.evaluate(() => {
        const p = document.querySelector('.pageWrap[data-page="10"]'), v = document.querySelector('#viewer');
        return Math.abs(p.clientWidth - (v.clientWidth-40)) < 3;
      }));
      await quiescent();
      await page.locator('#sidebarBtn').click();
    });
    await check('rotation and whole-page mode', async () => {
      await jump(4); await page.locator('#rotateBtn').click();
      await page.waitForSelector('.pageWrap[data-page="4"] .textLayer[data-main-rotation="90"]');
      await page.locator('#zoomMode').selectOption('page');
      await page.waitForTimeout(500);
      assert(await page.evaluate(() => {
        const p = document.querySelector('.pageWrap[data-page="4"]'), v = document.querySelector('#viewer');
        return p.clientHeight <= v.clientHeight - 38 && p.clientWidth <= v.clientWidth - 38;
      }));
      await page.locator('#nightBtn').click(); assert(await page.locator('body').evaluate(el=>el.classList.contains('night')));
      await page.screenshot({ path: path.join(artifacts,'reader-night.png') });
    });
    await check('bounded canvas memory after traversing a long PDF', async () => {
      await page.setViewportSize({ width: 1440, height: 960 }); await open('long.pdf');
      for (const n of [20,40,60,80,100,120,140,160,180,1,90]) await jump(n);
      await quiescent();
      const memory = await page.evaluate(() => ({
        pages: document.querySelectorAll('.pageWrap canvas').length,
        thumbs: document.querySelectorAll('.thumb canvas').length,
        pixels: [...document.querySelectorAll('.pageWrap canvas')].reduce((sum,c)=>sum+c.width*c.height,0)
      }));
      assert(memory.pages <= 8, JSON.stringify(memory)); assert(memory.thumbs <= 29, JSON.stringify(memory));
      assert(memory.pixels <= 24*1024*1024, JSON.stringify(memory));
      results.push({ memory });
    });
    await check('late search-page render cannot pull the reader back after next-page', async () => {
      await jump(1);
      await page.evaluate(async () => {
        const aux = await pdfjsLib.getDocument('fixtures/one.pdf').promise, pdfPage = await aux.getPage(1);
        const proto = Object.getPrototypeOf(pdfPage), original = proto.render;
        window.restoreRender = () => { proto.render = original; };
        proto.render = function(...args) {
          const task = original.apply(this,args);
          return this.pageNumber === 90 ? { promise:task.promise.then(()=>new Promise(r=>setTimeout(r,900))), cancel:()=>task.cancel() } : task;
        };
        await aux.destroy();
      });
      await page.locator('#searchBtn').click(); await page.locator('#searchInput').fill('Page 90');
      await page.waitForFunction(() => document.querySelector('#pageInput').value === '90');
      await page.locator('#nextBtn').click();
      await page.waitForFunction(() => document.querySelector('#pageInput').value === '91');
      await page.waitForTimeout(1400);
      assert.equal(await page.locator('#pageInput').inputValue(), '91');
      await page.evaluate(() => window.restoreRender()); await page.locator('#searchClose').click();
    });
    await check('page input retains focus while typing; invalid and out-of-range handling', async () => {
      await page.locator('#pageInput').fill('12'); await page.waitForTimeout(800);
      assert(await page.locator('#pageInput').evaluate(el => document.activeElement === el));
      await page.locator('#pageInput').fill('120'); await page.locator('#pageInput').press('Enter');
      await page.waitForFunction(() => document.querySelector('#pageInput').value === '120');
      await page.locator('#pageInput').fill('99999'); await page.locator('#pageInput').press('Enter');
      await page.waitForFunction(() => document.querySelector('#pageInput').value === '180');
      assert(await page.locator('#nextBtn').isDisabled());
    });
    await check('25% zoom settles and previous-page navigation works at document end', async () => {
      await page.setViewportSize({ width: 1440, height: 1200 });
      await page.evaluate(() => { for (let i=0;i<20;i++) document.querySelector('#zoomOutBtn').click(); });
      await jump(90); await quiescent();
      assert.equal(await page.locator('#zoomValue').innerText(), '25%');
      assert(await page.locator('.pageWrap canvas').count() <= 8);
      await jump(180);
      await page.locator('#prevBtn').click();
      await page.waitForFunction(() => document.querySelector('#pageInput').value === '179');
      await quiescent();
      assert.equal(await page.locator('#pageInput').inputValue(), '179');
      await page.locator('#prevBtn').click();
      await page.waitForFunction(() => document.querySelector('#pageInput').value === '178');
      await quiescent();
      assert.equal(await page.locator('#pageInput').inputValue(), '178');
    });
    await check('single-page PDF, scan-only search and narrow window', async () => {
      await open('one.pdf'); assert(await page.locator('#prevBtn').isDisabled()); assert(await page.locator('#nextBtn').isDisabled());
      await open('scan.pdf'); await page.locator('#searchBtn').click(); await page.locator('#searchInput').fill('needle');
      await page.waitForFunction(() => document.querySelector('#searchCount').textContent.startsWith('未找到'));
      await page.setViewportSize({ width: 520, height: 760 }); await page.waitForTimeout(500);
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      await page.screenshot({ path: path.join(artifacts,'reader-narrow.png') });
    });
    await check('document replacement cancels pending load and search', async () => {
      await page.setViewportSize({ width: 1440, height: 960 });
      await page.goto(`${base}/index.html?file=fixtures/slow.pdf`);
      await page.locator('#fileInput').setInputFiles({ name: 'replacement.pdf', mimeType:'application/pdf', buffer:fixture['one.pdf'] });
      await page.waitForFunction(() => document.querySelector('#pageTotal').textContent === '/ 1' && document.querySelector('#loading').hidden);
      await page.waitForTimeout(900); assert.equal(await page.locator('#pageTotal').innerText(), '/ 1');
      await page.locator('#fileInput').setInputFiles({ name: 'long.pdf', mimeType:'application/pdf', buffer:fixture['long.pdf'] });
      await page.waitForFunction(() => document.querySelector('#pageTotal').textContent === '/ 180' && document.querySelector('#loading').hidden);
      await page.locator('#searchBtn').click(); await page.locator('#searchInput').fill('needle');
      await page.waitForTimeout(250);
      await page.locator('#fileInput').setInputFiles({ name: 'replacement.pdf', mimeType:'application/pdf', buffer:fixture['one.pdf'] });
      await page.waitForFunction(() => document.querySelector('#pageTotal').textContent === '/ 1' && document.querySelector('#loading').hidden);
      await page.waitForTimeout(500); assert.equal(await page.locator('#pageTotal').innerText(), '/ 1');
    });
    await check('bad PDF and missing URL recover with working controls', async () => {
      await page.locator('#fileInput').setInputFiles({ name:'broken.pdf', mimeType:'application/pdf', buffer:fixture['broken.pdf'] });
      await page.waitForFunction(() => document.querySelector('#status').textContent.startsWith('打开失败'));
      assert(await page.locator('#nextBtn').isDisabled()); assert.equal(await page.locator('.pageWrap').count(),0);
      await page.goto(`${base}/index.html?file=fixtures/missing.pdf`);
      await page.waitForFunction(() => document.querySelector('#status').textContent.startsWith('打开失败'));
      assert(await page.locator('#empty').isVisible());
      await page.locator('#fileInput').setInputFiles({ name:'one.pdf', mimeType:'application/pdf', buffer:fixture['one.pdf'] });
      await page.waitForFunction(() => document.querySelector('#loading').hidden && document.querySelector('.textLayer'));
    });
    await check('password retry, unlock and cancellation', async () => {
      await page.goto(`${base}/index.html?file=fixtures/encrypted.pdf`);
      await page.waitForSelector('#passwordDialog[open]'); await page.locator('#passwordInput').fill('incorrect');
      await page.locator('#passwordInput').press('Enter'); await page.waitForFunction(() => document.querySelector('#passwordHint').textContent.includes('不正确'));
      await page.locator('#passwordInput').fill('lyra-test'); await page.locator('#passwordInput').press('Enter');
      await page.waitForFunction(() => document.querySelector('#loading').hidden && document.querySelector('.textLayer'));
      await page.goto(`${base}/index.html?file=fixtures/encrypted.pdf`); await page.waitForSelector('#passwordDialog[open]');
      await page.locator('#passwordCancel').click(); assert(await page.locator('#empty').isVisible());
    });
    if (process.env.LYRA_TEST_PDF) await check('real PDF rendering, search and screenshot', async () => {
      await open('real.pdf', '2509.17609v1.pdf'); await jump(2);
      await page.locator('#searchBtn').click(); await page.locator('#searchInput').fill('the');
      await page.waitForFunction(() => /\d+ \/ \d+/.test(document.querySelector('#searchCount').textContent));
      await page.locator('#searchClose').click(); await jump(1);
      await page.screenshot({ path: path.join(artifacts,'reader-real.png') });
    });
    assert.deepEqual(errors, [], 'uncaught browser errors');
    fs.writeFileSync(path.join(artifacts,'test-results.json'), JSON.stringify({ passed:results, errors },null,2));
    console.log(JSON.stringify({ passed:results.filter(item => typeof item === 'string').length, errors, artifacts }));
  } catch (error) {
    await page.screenshot({ path:path.join(artifacts,'failure.png') });
    fs.writeFileSync(path.join(artifacts,'test-results.json'), JSON.stringify({ passed:results, errors, failure:error.stack },null,2));
    throw error;
  } finally { await browser.close(); await new Promise(resolve=>server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; server.close(); });
