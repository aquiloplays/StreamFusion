// Headless screenshot of StreamFusion's MAIN window (optionally with demo
// mode running so chat/events/stats are realistically populated), or of a
// generic #overlay modal opened by an expression.
//
// Usage: node scripts/main-shot.mjs <out.png> [demoSeconds] [evalExpr] [width] [height]
//   node scripts/main-shot.mjs main.png 6
//   node scripts/main-shot.mjs raid.png 0 "openRaidFinder()"
import { createRequire } from "node:module";
const require = createRequire("C:\\Users\\bishe\\AppData\\Local\\Temp\\pup\\package.json");
const puppeteer = require("puppeteer-core");

const [, , out = "main.png", demoSeconds = "6", evalExpr = "", width = "1440", height = "900"] = process.argv;
const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const URL = "file:///C:/Users/bishe/Desktop/Aquilo/StreamFusion/index.html";

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: "new",
  args: ["--disable-gpu", "--force-device-scale-factor=1.5"],
});
const page = await browser.newPage();
await page.setViewport({ width: +width, height: +height, deviceScaleFactor: 1.5 });
const errs = [];
page.on("pageerror", (e) => errs.push(String(e.message || e).slice(0, 110)));
await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 20000 });
await new Promise((r) => setTimeout(r, 2500));

await page.evaluate(() => {
  for (const id of ["sfBoot", "wOverlay", "changelogModal"]) {
    const el = document.getElementById(id);
    if (el) el.style.display = "none";
  }
});
if (+demoSeconds > 0) {
  // Leave demo running through the capture; stopping it first can clear the
  // feed. Some builds gate demo on the checkbox, so set that too.
  await page.evaluate(() => {
    const chk = document.getElementById("demoModeChk");
    if (chk) chk.checked = true;
    try { window.toggleDemoMode(true); } catch (e) {}
  });
  await new Promise((r) => setTimeout(r, +demoSeconds * 1000));
}
if (evalExpr) {
  await page.evaluate((x) => { try { (0, eval)(x); } catch (e) { console.warn(e); } }, evalExpr);
  await new Promise((r) => setTimeout(r, 800));
}
await page.screenshot({ path: out });
console.log("saved", out, "| pageerrors:", errs.length ? errs.slice(0, 3).join(" | ") : "none");
await browser.close();
