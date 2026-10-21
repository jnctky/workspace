import { createRequire } from "node:module";

const require = createRequire("D:/work/trade/workspace/terminalpro/package.json");
const { chromium } = require("playwright");

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });

page.on("request", (r) => {
  if (r.url().includes(":7777")) console.log("REQ", r.method(), r.url());
});
page.on("response", (r) => {
  if (r.url().includes(":7777")) console.log("RES", r.status(), r.url());
});
page.on("requestfailed", (r) => {
  console.log("FAILED", r.method(), r.url(), "|", r.failure()?.errorText);
});
page.on("console", (m) => {
  if (m.type() === "error") console.log("CONSOLE", m.text().slice(0, 300));
});

await page.goto("http://127.0.0.1:3000/login", { waitUntil: "domcontentloaded" });
await page.waitForTimeout(2000);
await page.locator('button[type="submit"]').first().click({ timeout: 15000 }).catch(() => {});
await page.waitForURL("**/app**", { timeout: 90000 });
console.log("logged in");

await page.goto("http://127.0.0.1:3000/app", { waitUntil: "domcontentloaded" });
await page.waitForTimeout(2500);
await page.locator("text=Harmony Glasswing").first().click({ timeout: 10000 }).catch(() => {});
await page.waitForTimeout(5000);

const visibleInput = page.locator("#copilot-input:visible").first();
if (!(await visibleInput.count())) {
  await page.evaluate(() => document.getElementById("toggle-copilot-btn")?.click());
  await page.waitForTimeout(3000);
}
console.log("panel open:", Boolean(await page.locator("#copilot-input:visible").count()));

// The panel defaults to the built-in (dead) OpenBB Copilot — switch to ours.
await page.locator("._manage-copilots").first().click({ timeout: 10000 }).catch(() => {});
await page.waitForTimeout(1500);
const pick = page.locator("text=MiniMax Copilot").last();
console.log("switcher entries:", await page.locator("text=MiniMax Copilot").count());
await pick.click({ timeout: 10000 }).catch(() => {});
await page.waitForTimeout(1500);
console.log("after switch:", (await page.evaluate(() => document.body.innerText)).match(/[^\n]*Copilot[^\n]*/g)?.slice(0, 3));

// Which copilot is selected right now?
const selected = await page.evaluate(() => {
  const el = document.querySelector("[data-selected-copilot]");
  const txt = document.body.innerText;
  const m = txt.match(/[^\n]*Copilot[^\n]*/g) || [];
  return { attr: el?.getAttribute("data-selected-copilot"), lines: m.slice(0, 6) };
});
console.log("selected hints:", JSON.stringify(selected));

const input = page.locator("#copilot-input").first();
await input.click({ timeout: 8000 }).catch(() => {});
await input.fill("ping: 一句话回答 1+1 等于几");
await page.waitForTimeout(300);
await page.keyboard.press("Enter");
console.log("sent");

await page.waitForTimeout(45000);
const text = await page.evaluate(() => document.body.innerText);
console.log("tail:", text.replace(/\s+/g, " ").slice(-400));
await page.screenshot({ path: "D:/work/trade/workspace/my_tools/_tmp/minimax_diag.png" });
await browser.close();
