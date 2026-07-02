// Headless screenshot of StreamFusion's Settings modal on a given tab.
// Loads the renderer's index.html as a plain page (no Electron; electronAPI
// guards make app JS degrade quietly), force-opens the settings modal,
// switches to the requested tab, and captures the modal element.
//
// Usage: node sf-settings-shot.mjs <tab> <out.png> [width] [height]
import { createRequire } from "node:module";
const require = createRequire("C:\\Users\\bishe\\AppData\\Local\\Temp\\pup\\package.json");
const puppeteer = require("puppeteer-core");

const [, , tab = "accounts", out = "settings.png", width = "1500", height = "980"] = process.argv;
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
page.on("pageerror", (e) => errs.push(String(e.message || e).slice(0, 120)));
await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 20000 });
await new Promise((r) => setTimeout(r, 2500));

await page.evaluate((tabName) => {
  // Clear anything that could cover the modal.
  for (const id of ["sfBoot", "wOverlay", "changelogModal"]) {
    const el = document.getElementById(id);
    if (el) el.style.display = "none";
  }
  const ov = document.getElementById("settingsOverlay");
  if (ov) ov.classList.add("show");
  try { window.switchSettingsTab(tabName); }
  catch (e) {
    document.querySelectorAll(".settings-tab").forEach((t) => t.classList.toggle("active", t.dataset.tab === tabName));
    document.querySelectorAll(".settings-pane").forEach((p) => p.classList.toggle("active", p.id === "pane-" + tabName));
  }
}, tab);
await new Promise((r) => setTimeout(r, 700));

const modal = await page.$(".settings-modal");
if (!modal) { console.error("no .settings-modal found"); process.exit(1); }
await modal.screenshot({ path: out });
console.log("saved", out, "| pageerrors:", errs.length ? errs.slice(0, 3).join(" | ") : "none");
await browser.close();
