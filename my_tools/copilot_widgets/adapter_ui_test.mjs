import { createRequire } from "node:module";

const require = createRequire("D:/work/trade/workspace/terminalpro/package.json");
const { chromium } = require("playwright");

const OUT = "D:/work/trade/workspace/my_tools/_tmp";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });

// The dialog is mounted twice (two stacked copies); the last one is interactive,
// so everything below targets index 1 and uses real mouse coordinates.
async function clickButtonByText(text, index = 1) {
  const point = await page.evaluate(
    ({ text, index }) => {
      const buttons = [...document.querySelectorAll("button")].filter(
        (b) => b.textContent.trim() === text,
      );
      const target = buttons[index];
      if (!target) return null;
      const rect = target.getBoundingClientRect();
      return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
    },
    { text, index },
  );
  if (!point) throw new Error(`button "${text}" #${index} not found`);
  await page.mouse.click(point.x, point.y);
}

await page.goto("http://127.0.0.1:3000/login", { waitUntil: "domcontentloaded" });
await page.waitForTimeout(1500);
await page.locator('button[type="submit"]').first().click({ timeout: 10000 }).catch(() => {});
await page.waitForURL("**/app**", { timeout: 25000 });
console.log("1. logged in");

await page.goto("http://127.0.0.1:3000/app/ai", { waitUntil: "domcontentloaded" });
await page.waitForTimeout(3000);
await page.getByRole("button", { name: "Add Agent" }).first().click({ timeout: 15000 });
await page.waitForTimeout(1200);
console.log("2. dialog opened");

const box = await page.evaluate(() => {
  const el = document.querySelectorAll('input[placeholder="https://example.com"]')[1];
  const rect = el.getBoundingClientRect();
  return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
});
await page.mouse.click(box.x, box.y);
await page.keyboard.type("http://127.0.0.1:7777", { delay: 15 });
await page.waitForTimeout(500);

await clickButtonByText("Test");
await page.waitForTimeout(4000);

const bodyText = await page.evaluate(() => document.body.innerText);
const match = bodyText.match(/[\d]+ agents? found/i);
console.log("3. connection test:", match ? match[0] : "(no match)");
await page.screenshot({ path: `${OUT}/adapter_add_dialog.png` });

if (!match) {
  console.log("!! test failed");
  await browser.close();
  process.exit(1);
}

await clickButtonByText("Add");
await page.waitForTimeout(3000);
const afterAdd = await page.evaluate(() => document.body.innerText);
console.log("4. added:", /successfully added/i.test(afterAdd) ? "toast OK" : "no toast");
await page.screenshot({ path: `${OUT}/adapter_added.png` });

// Open a dashboard and chat with the agent through the real Copilot panel.
await page.goto("http://127.0.0.1:3000/app", { waitUntil: "domcontentloaded" });
await page.waitForTimeout(2500);
const dash = page.locator("text=Harmony Glasswing").first();
if (await dash.count()) {
  await dash.click({ timeout: 10000 }).catch(() => {});
  await page.waitForTimeout(5000);
  console.log("5. dashboard opened");
}

await page.evaluate(() => document.getElementById("toggle-copilot-btn")?.click());
await page.waitForTimeout(2500);

const input = page.locator("#copilot-input").first();
if (await input.count()) {
  await input.click({ timeout: 8000 }).catch(() => {});
  await input.fill("用一句话说明你能看到哪些仪表盘数据");
  await page.waitForTimeout(300);
  await page.keyboard.press("Enter");
  await page.waitForTimeout(12000);
  const text = await page.evaluate(() => document.body.innerText);
  console.log("6. mock reply rendered:", /mock-openai/i.test(text));
  console.log("   snippet:", text.replace(/\s+/g, " ").slice(-400));
} else {
  console.log("6. copilot input not found");
}

await page.screenshot({ path: `${OUT}/adapter_chat.png` });
await browser.close();
