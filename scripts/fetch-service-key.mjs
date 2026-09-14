import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { ACCOUNT_LIST_URL, ensureLoggedIn } from "../lib/localdata-browser.js";
import { extractAccountLinks } from "../lib/localdata-portal.js";

// 공공데이터포털 마이페이지에서 특정 데이터셋의 활용신청 상태·일반 인증키·요청주소를 읽는다.
//   npm run fetch-service-key -- --dataset=15059256 [--keyword=근로복지공단]

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const profilePath = process.env.PLAYWRIGHT_PROFILE_PATH
  ? resolve(process.env.PLAYWRIGHT_PROFILE_PATH)
  : resolve(root, ".playwright/data-go-personal");

const argumentValue = (name) => {
  const withEquals = process.argv.find((value) => value.startsWith(`--${name}=`));
  return withEquals ? withEquals.slice(name.length + 3) : "";
};
const datasetId = argumentValue("dataset");
const keyword = argumentValue("keyword");
if (!datasetId && !keyword) {
  console.log("사용법: npm run fetch-service-key -- --dataset=데이터셋ID [--keyword=이름일부]");
  process.exit(0);
}

const context = await chromium.launchPersistentContext(profilePath, {
  channel: "msedge",
  headless: false,
  viewport: { width: 1440, height: 900 }
});
try {
  const page = context.pages().at(0) ?? await context.newPage();
  await ensureLoggedIn(page, { waitForLogin: true, timeoutMs: 600000 });
  await page.goto(ACCOUNT_LIST_URL, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1500);

  const html = await page.content();
  const links = extractAccountLinks(html);
  console.error(`[key] 마이페이지 계정 링크 ${links.length}개를 찾았습니다.`);

  for (const link of links) {
    await page.goto(link.url, { waitUntil: "domcontentloaded" }).catch(() => null);
    await page.waitForTimeout(800);
    const text = await page.locator("body").innerText().catch(() => "");
    const matched = (datasetId && text.includes(datasetId)) || (keyword && text.includes(keyword));
    if (!matched) continue;
    const status = text.match(/(?:승인|신청|반려|보류|재신청|신청취소|중지)/)?.[0] ?? "";
    const key = text.match(/(?:일반|인증키)[^\n]{0,120}?([A-Za-z0-9+/=]{80,})/)?.[1]
      ?? text.match(/([A-Za-z0-9+/=]{120,})/)?.[1]
      ?? "";
    const endpoint = text.match(/https?:\/\/apis\.data\.go\.kr\/[A-Za-z0-9_\-./]+/)?.[0] ?? "";
    const title = text.split("\n").map((line) => line.trim()).find((line) => line.includes("근로복지공단") || /\d{6,10}/.test(line)) ?? "";
    console.log(JSON.stringify({ datasetId, title: title.slice(0, 80), status, key, endpoint }, null, 1));
    break;
  }
} finally {
  await context.close();
}
