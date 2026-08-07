// Renders the built handbook and screenshots the figures plus full-page strips,
// in both colour schemes. Nothing is asserted — this exists so a human (or an
// agent) can look at the result instead of hoping.
import puppeteer from "puppeteer-core";
import { mkdirSync } from "node:fs";

const CHROME = process.env.CHROME_PATH || "/usr/bin/chromium";
const DOC = new URL("../handbuch.html", import.meta.url).href;
const OUT = new URL("./check/", import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: "new",
  args: ["--font-render-hinting=none", "--allow-file-access-from-files"],
});

for (const scheme of ["light", "dark"]) {
  const page = await browser.newPage();
  await page.emulateMediaFeatures([
    { name: "prefers-color-scheme", value: scheme },
  ]);
  await page.setViewport({ width: 1060, height: 1000, deviceScaleFactor: 1.4 });
  await page.goto(DOC, { waitUntil: "networkidle0" });
  await new Promise((r) => setTimeout(r, 700));

  const h = await page.evaluate(() => document.body.scrollHeight);
  console.log(scheme, "page height", h);

  if (scheme === "light") {
    const figs = await page.$$("svg.fig");
    for (let i = 0; i < figs.length; i++) {
      await figs[i].screenshot({
        path: `${OUT}fig-${String(i).padStart(2, "0")}.png`,
      });
    }
  }
  const strips = 8;
  for (let i = 0; i < strips; i++) {
    const y = Math.round((h / strips) * i);
    await page.evaluate((yy) => window.scrollTo(0, yy), y);
    await new Promise((r) => setTimeout(r, 250));
    await page.screenshot({ path: `${OUT}${scheme}-${i}.png` });
  }
  await page.close();
}
await browser.close();
console.log("ok");
