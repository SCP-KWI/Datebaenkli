// The handbook itself in a phone viewport, and the one number that matters:
// scrollWidth must equal the viewport width, or something overflows sideways.
import puppeteer from "puppeteer-core";
import { mkdirSync } from "node:fs";

const CHROME = process.env.CHROME_PATH || "/usr/bin/chromium";
const DOC = new URL("../handbuch.html", import.meta.url).href;
const OUT = new URL("./check/", import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: "new",
  args: ["--allow-file-access-from-files"],
});
const page = await browser.newPage();
await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true });
await page.goto(DOC, { waitUntil: "networkidle0" });
await new Promise((r) => setTimeout(r, 600));

const w = await page.evaluate(() => document.documentElement.scrollWidth);
console.log("scrollWidth", w, w === 390 ? "— ok" : "— OVERFLOWS");

// Name the culprits rather than leaving the number to be hunted down.
const wide = await page.evaluate(() =>
  [...document.querySelectorAll("body *")]
    .filter((el) => el.getBoundingClientRect().right > 391)
    .slice(0, 10)
    .map((el) => `${el.tagName.toLowerCase()}.${el.className || "-"}`)
);
if (wide.length) console.log("wider than the viewport:", wide);

const h = await page.evaluate(() => document.body.scrollHeight);
for (const [i, y] of [0, h * 0.25, h * 0.5, h * 0.75].entries()) {
  await page.evaluate((yy) => window.scrollTo(0, yy), Math.round(y));
  await new Promise((r) => setTimeout(r, 250));
  await page.screenshot({ path: `${OUT}mobile-${i}.png` });
}
await browser.close();
