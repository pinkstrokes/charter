// Full-resolution screenshots of the running UI for the video and the Devpost
// gallery: each shot is a URL (deep links like ?db=charter-a#/knowledge?why=12),
// optional text to wait for, and optional clicks by visible text.
//   node tools/video/capture.mjs tools/video/shots.json tools/video/shots/
import { mkdirSync, readFileSync } from 'node:fs';
import puppeteer from 'puppeteer-core';

const [, , listPath, outDir] = process.argv;
const shots = JSON.parse(readFileSync(listPath, 'utf8'));
mkdirSync(outDir, { recursive: true });
const browser = await puppeteer.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
  defaultViewport: { width: 1600, height: 900, deviceScaleFactor: 2 },
});
const page = await browser.newPage();
const sleep = ms => new Promise(r => setTimeout(r, ms));
for (const s of shots) {
  await page.goto(s.url, { waitUntil: 'networkidle2', timeout: 60_000 }).catch(() => undefined);
  if (s.waitFor) await page.waitForFunction(t => document.body.innerText.includes(t), { timeout: 30_000 }, s.waitFor).catch(() => console.log(`  ${s.name}: "${s.waitFor}" never appeared`));
  for (const text of s.click ?? []) {
    const clicked = await page.evaluate(t => {
      const el = [...document.querySelectorAll('button, a, [role="button"], [role="tab"]')].find(e => e.textContent?.trim().includes(t));
      if (el) (el).click();
      return !!el;
    }, text);
    if (!clicked) console.log(`  ${s.name}: nothing to click for "${text}"`);
    await sleep(800);
  }
  if (s.scroll) await page.evaluate(y => window.scrollTo(0, y), s.scroll);
  await sleep(s.settle ?? 1500);
  await page.screenshot({ path: `${outDir}/${s.name}.png` });
  console.log(`${s.name}.png`);
}
await browser.close();
