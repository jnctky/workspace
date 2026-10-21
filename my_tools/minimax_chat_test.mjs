import { createRequire } from "node:module";

const require = createRequire("D:/work/trade/workspace/terminalpro/package.json");
const { chromium } = require("playwright");

const OUT = "D:/work/trade/workspace/my_tools/_tmp";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });

page.on("console", (msg) => {
  if (msg.type() === "error") return; // keep noise down
});

await page.goto("http://127.0.0.1:3000/login", { waitUntil: "domcontentloaded" });
await page.waitForTimeout(2000);
await page.locator('button[type="submit"]').first().click({ timeout: 15000 }).catch(() => {});
await page.waitForURL("**/app**", { timeout: 90000 });
console.log("1. logged in");

await page.goto("http://127.0.0.1:3000/app", { waitUntil: "domcontentloaded" });
await page.waitForTimeout(2500);
const dash = page.locator("text=Harmony Glasswing").first();
if (await dash.count()) {
  await dash.click({ timeout: 10000 }).catch(() => {});
  await page.waitForTimeout(5000);
  console.log("2. dashboard opened");
}

await page.evaluate(() => document.getElementById("toggle-copilot-btn")?.click());
await page.waitForTimeout(3000);
const footer = await page.evaluate(() => document.body.innerText.slice(-300));
console.log("3. panel footer:", footer.replace(/\s+/g, " ").slice(-160));

const input = page.locator("#copilot-input").first();
if (!(await input.count())) {
  console.log("!! copilot input not found");
  await browser.close();
  process.exit(1);
}

await input.click({ timeout: 8000 }).catch(() => {});
await input.fill("一句话回答：我当前打开的这个仪表盘里有哪些数据？");
await page.waitForTimeout(300);
await page.keyboard.press("Enter");
console.log("4. message sent, waiting for MiniMax…");

const started = Date.now();
let lastLen = 0;
let stableTicks = 0;
while (Date.now() - started < 150000) {
  await page.waitForTimeout(5000);
  const text = await page.evaluate(() => document.body.innerText);
  const grew = text.length !== lastLen;
  lastLen = text.length;
  stableTicks = grew ? 0 : stableTicks + 1;
  const streaming = /Stop|Generating|thinking/i.test(text.slice(-400));
  console.log(`   …${Math.round((Date.now() - started) / 1000)}s len=${text.length}${streaming ? " (streaming)" : ""}`);
  if (Date.now() - started > 20000 && stableTicks >= 3 && !streaming) break;
}
const finalText = await page.evaluate(() => document.body.innerText);
console.log("5. tail:", finalText.replace(/\s+/g, " ").slice(-500));

await page.screenshot({ path: `${OUT}/minimax_chat.png` });
await browser.close();
