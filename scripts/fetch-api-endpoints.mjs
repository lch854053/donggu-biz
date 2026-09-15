import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { ensureLoggedIn } from "../lib/localdata-browser.js";

// 공공데이터포털 오픈API 상세 페이지를 펼쳐 요청주소(apis.data.go.kr)와 오퍼레이션을 긁는다.
//   npm run fetch-api-endpoints -- --dataset=15059256

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const profilePath = process.env.PLAYWRIGHT_PROFILE_PATH
  ? resolve(process.env.PLAYWRIGHT_PROFILE_PATH)
  : resolve(root, ".playwright/data-go-personal");

const argumentValue = (name) => {
  const withEquals = process.argv.find((value) => value.startsWith(`--${name}=`));
  return withEquals ? withEquals.slice(name.length + 3) : "";
};
const datasetId = argumentValue("dataset");
if (!datasetId) {
  console.log("사용법: npm run fetch-api-endpoints -- --dataset=데이터셋ID");
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
  await page.goto(`https://www.data.go.kr/data/${datasetId}/openapi.do`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2000);

  // 접힌 상세 섹션(오퍼레이션 목록·요청주소)을 펼친다.
  for (const label of ["펼쳐보기", "더보기", "상세보기", "오픈API 목록"]) {
    const toggles = page.locator(`button:has-text("${label}"), a:has-text("${label}")`);
    const count = await toggles.count();
    for (let index = 0; index < Math.min(count, 5); index += 1) {
      await toggles.nth(index).click().catch(() => null);
      await page.waitForTimeout(500);
    }
  }

  const html = await page.content();
  const urls = [...new Set([...html.matchAll(/https?:\/\/apis\.data\.go\.kr\/[A-Za-z0-9_\-./%]+/g)].map((match) => match[0].replace(/&amp;/g, "&")))];
  console.log(JSON.stringify({ datasetId, endpoints: urls }, null, 1));

  // 오퍼레이션명 표도 함께 덤프한다.
  const text = await page.locator("body").innerText().catch(() => "");
  const opSection = text.split("오퍼레이션").slice(1).join("오퍼레이션").slice(0, 600);
  if (opSection) console.log("오퍼레이션 단서:\n" + opSection.replace(/\n{2,}/g, "\n"));
} finally {
  await context.close();
}
