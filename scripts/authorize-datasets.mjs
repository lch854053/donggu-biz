import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { applyForDataset, ensureLoggedIn, isLoggedIn, PORTAL_ORIGIN } from "../lib/localdata-browser.js";

// 공공데이터포털 오픈API 활용신청과 파일 내려받기를 한 세션에서 끝낸다.
// 브라우저 창이 뜨고, 로그인이 필요하면 사용자가 직접 로그인할 때까지 기다린다.
// 프로필은 localdata 도구와 같은 것을 써서 한 번 로그인하면 다음엔 바로 통과한다.
//
//   npm run authorize-datasets -- --ids=15059256          # 오픈API 활용신청
//   npm run authorize-datasets -- --download-file=15088456 # 파일데이터 내려받기

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const profilePath = process.env.PLAYWRIGHT_PROFILE_PATH
  ? resolve(process.env.PLAYWRIGHT_PROFILE_PATH)
  : resolve(root, ".playwright/data-go-personal");

const argumentValue = (name) => {
  const withEquals = process.argv.find((value) => value.startsWith(`--${name}=`));
  return withEquals ? withEquals.slice(name.length + 3) : "";
};
const ids = (argumentValue("ids") || "").split(",").map((value) => value.trim()).filter(Boolean);
const downloadFileId = argumentValue("download-file");

if (!ids.length && !downloadFileId) {
  console.log("사용법: npm run authorize-datasets -- [--ids=데이터셋ID,...] [--download-file=데이터셋ID]");
  process.exit(0);
}

const context = await chromium.launchPersistentContext(profilePath, {
  channel: "msedge",
  headless: false,
  viewport: { width: 1440, height: 900 }
});
const page = context.pages().at(0) ?? await context.newPage();

try {
  await ensureLoggedIn(page, { waitForLogin: true, timeoutMs: 900000 });

  for (const datasetId of ids) {
    console.log(`[apply] ${datasetId} 활용신청을 시도합니다.`);
    const result = await applyForDataset(page, { datasetId });
    console.log(`[apply] ${datasetId}: ${JSON.stringify(result)}`);
  }

  if (downloadFileId) {
    const url = `${PORTAL_ORIGIN}/data/${downloadFileId}/fileData.do`;
    await page.goto(url, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(1500);
    // 파일 다운로드 버튼은 양식에 따라 버튼/링크로 그려진다.
    const candidates = [
      page.locator('button:has-text("파일 다운로드")'),
      page.locator('a:has-text("파일 다운로드")'),
      page.locator('[title*="다운로드"]'),
      page.locator('button:has-text("다운로드"), a:has-text("다운로드")')
    ];
    let clicked = false;
    for (const candidate of candidates) {
      if (await candidate.count()) {
        const [download] = await Promise.all([
          page.waitForEvent("download", { timeout: 120000 }).catch(() => null),
          candidate.first().click().catch(() => null)
        ]);
        if (download) {
          const target = resolve(tmpdir(), `data-go-kr-${downloadFileId}.zip`);
          await download.saveAs(target);
          console.log(`[download] ${downloadFileId} → ${target}`);
          clicked = true;
          break;
        }
      }
    }
    if (!clicked) {
      console.log(`[download] ${downloadFileId}: 내려받기 단추를 찾지 못했습니다. 화면 URL: ${page.url()}`);
    }
  }

  console.log("[done] 세션 결과:", await isLoggedIn(page) ? "로그인 유지" : "로그아웃 상태");
} finally {
  await context.close();
}
