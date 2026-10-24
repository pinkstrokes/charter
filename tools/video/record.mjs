// Records the live UI scene by scene, doing what a person would do — typing an
// email, pressing release, correcting a decision — paced to each scene's
// narration. A drawn cursor shows where each click lands.
//   node tools/video/record.mjs <scenes.json with seconds filled in> <out dir>
// A scene: {url?, ready?, seconds, steps: [...]}; a step is one of
//   {wait: ms} {click: "visible text", within?: "text of its table row"} {type: "field label", text} {scroll: "#main" | ".drawer", by: px} {scrollTo: "heading text"}
//   {waitText: "text", timeout: ms} {call: {db, as, fn, args}} (a reducer, as an identity in data/company*/identities.json)
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import puppeteer from 'puppeteer-core';

const [, , specPath, outDir] = process.argv;
const scenes = JSON.parse(readFileSync(specPath, 'utf8'));
mkdirSync(outDir, { recursive: true });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const W = 1920;
const H = 930;

const CURSOR = `
  if (!document.getElementById('fake-cursor')) {
    const c = document.createElement('div');
    c.id = 'fake-cursor';
    Object.assign(c.style, { position: 'fixed', left: '960px', top: '500px', width: '22px', height: '22px', margin: '-11px 0 0 -11px', borderRadius: '50%',
      background: 'rgba(235,104,52,0.35)', border: '2px solid rgba(235,104,52,0.95)', zIndex: 99999, pointerEvents: 'none', transition: 'left 450ms ease, top 450ms ease, transform 120ms' });
    document.body.appendChild(c);
  }`;

// A visible control by its text; with `within`, only inside the table row that mentions it.
async function find(page, text, within) {
  return page.evaluateHandle(
    (t, w) => {
      const scope = w ? [...document.querySelectorAll('tr')].find(r => r.textContent?.includes(w)) : document;
      if (!scope) return null;
      const all = [...scope.querySelectorAll('button, a, [role="button"], [role="tab"], .persona')].filter(e => e.offsetParent !== null);
      return all.find(e => e.textContent?.trim() === t) ?? all.find(e => e.textContent?.includes(t)) ?? null;
    },
    text,
    within ?? ''
  );
}

async function pointAt(page, el) {
  const box = await el.boundingBox();
  if (!box) return;
  await page.evaluate(CURSOR);
  await page.evaluate((x, y) => {
    const c = document.getElementById('fake-cursor');
    c.style.left = `${x}px`;
    c.style.top = `${y}px`;
  }, box.x + box.width / 2, box.y + box.height / 2);
  await sleep(520);
}

async function press(page) {
  await page.evaluate(() => {
    const c = document.getElementById('fake-cursor');
    if (c) c.style.transform = 'scale(0.7)';
  });
  await sleep(140);
  await page.evaluate(() => {
    const c = document.getElementById('fake-cursor');
    if (c) c.style.transform = 'scale(1)';
  });
}

async function call({ db, as, fn, args }) {
  const company = db === 'charter-a' ? 'companyA' : 'companyB';
  const ids = JSON.parse(readFileSync(new URL(`../../data/${company}/identities.json`, import.meta.url), 'utf8'));
  const token = ids[as]?.token;
  const res = await fetch(`http://127.0.0.1:3000/v1/database/${db}/call/${fn}`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(args) });
  if (!res.ok) console.log(`  ${fn}: ${res.status} ${(await res.text()).slice(0, 200)}`);
}

async function step(page, s) {
  if (s.wait) return sleep(s.wait);
  if (s.call) return call(s.call);
  if (s.waitText)
    return page.waitForFunction(t => document.body.innerText.includes(t), { timeout: s.timeout ?? 30_000, polling: 250 }, s.waitText).catch(() => console.log(`  "${s.waitText}" never appeared`));
  if (s.scroll) {
    await page.evaluate(
      (sel, by) =>
        new Promise(done => {
          let el = document.querySelector(sel);
          if (el && el.scrollHeight <= el.clientHeight + 1) el = document.scrollingElement; // the page itself scrolls
          if (!el) return done();
          const from = el.scrollTop;
          const t0 = performance.now();
          const tick = () => {
            const k = Math.min(1, (performance.now() - t0) / 1200);
            el.scrollTop = from + by * (1 - Math.pow(1 - k, 3));
            if (k < 1) requestAnimationFrame(tick);
            else done();
          };
          requestAnimationFrame(tick);
        }),
      s.scroll,
      s.by
    );
    return sleep(300);
  }
  if (s.scrollTo) {
    // Bring a heading or row into view, smoothly, clear of the sticky header.
    await page.evaluate(
      t =>
        new Promise(done => {
          const target = [...document.querySelectorAll('h1, h2, h3, h4, td, [class*="title"]')].find(e => e.textContent?.trim().startsWith(t));
          if (!target) return done();
          const box = target.closest('.drawer') ?? document.scrollingElement;
          const scroller = box.classList?.contains('drawer') ? box : document.scrollingElement;
          const from = scroller.scrollTop;
          const by = target.getBoundingClientRect().top - 120;
          const t0 = performance.now();
          const tick = () => {
            const k = Math.min(1, (performance.now() - t0) / 1400);
            scroller.scrollTop = from + by * (1 - Math.pow(1 - k, 3));
            if (k < 1) requestAnimationFrame(tick);
            else done();
          };
          requestAnimationFrame(tick);
        }),
      s.scrollTo
    );
    return sleep(300);
  }
  if (s.click) {
    const el = (await find(page, s.click, s.within)).asElement();
    if (!el) return console.log(`  nothing to click for "${s.click}"`);
    await pointAt(page, el);
    await press(page);
    await el.click();
    return sleep(400);
  }
  if (s.type) {
    const el = (
      await page.evaluateHandle(label => {
        const f = [...document.querySelectorAll('label.field')].find(l => l.querySelector('span')?.textContent?.trim().startsWith(label));
        return f?.querySelector('input, textarea') ?? null;
      }, s.type)
    ).asElement();
    if (!el) return console.log(`  no field "${s.type}"`);
    await pointAt(page, el);
    // Empty the field the way React notices, then type into it.
    await el.evaluate(e => {
      const proto = e instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(e, '');
      e.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await el.click();
    await el.type(s.text, { delay: s.delay ?? 18 });
    return sleep(250);
  }
}

const browser = await puppeteer.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
  defaultViewport: { width: W, height: H, deviceScaleFactor: 1 },
});
const page = await browser.newPage();
const recorded = {};
for (const [i, sc] of scenes.entries()) {
  if (sc.title) continue;
  if (sc.url) await page.goto(sc.url, { waitUntil: 'networkidle2', timeout: 60_000 }).catch(() => undefined);
  if (sc.ready) await step(page, { waitText: sc.ready, timeout: 45_000 });
  for (const s of sc.before ?? []) await step(page, s);
  await sleep(600);
  const recorder = await page.screencast({ path: `${outDir}/scene-${i}.webm` });
  const t0 = Date.now();
  for (const s of sc.steps ?? []) await step(page, s);
  const left = sc.seconds * 1000 - (Date.now() - t0);
  if (left > 0) await sleep(left);
  await recorder.stop();
  recorded[i] = (Date.now() - t0) / 1000;
  console.log(`scene ${i}: ${recorded[i].toFixed(1)}s`);
}
await browser.close();
writeFileSync(`${outDir}/recorded.json`, JSON.stringify(recorded));
