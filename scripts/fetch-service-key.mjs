import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { ACCOUNT_LIST_URL, ensureLoggedIn } from "../lib/localdata-browser.js";
import { extractAccountLinks } from "../lib/localdata-portal.js";

// 공공데이터포털 마이페이지에서 특정 데이터셋의 활용신청 상태·일반 인증키·요청주소를 읽어
// .env에 저장한다. 포털 세션 쿠키는 브라우저를 닫으면 사라지므로 실행마다 로그인이 필요하다.
//
//   npm run fetch-service-key -- --dataset=15059256 --keyword=근로복지공단 --env=KCOMWEL_SERVICE_KEY

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const profilePath = process.env.PLAYWRIGHT_PROFILE_PATH
  ? resolve(process.env.PLAYWRIGHT_PROFILE_PATH)
  : resolve(root, ".playwright/data-go-personal");
const envPath = resolve(root, ".env");

const argumentValue = (name) => {
  const withEquals = process.argv.find((value) => value.startsWith(`--${name}=`));
  return withEquals ? withEquals.slice(name.length + 3) : "";
};
const datasetId = argumentValue("dataset");
const keyword = argumentValue("keyword");
const envName = argumentValue("env");
if (!datasetId && !keyword) {
  console.log("사용법: npm run fetch-service-key -- --dataset=데이터셋ID [--keyword=이름일부] [--env=ENV이름]");
  process.exit(0);
}

async function saveEnvKey(name, value) {
  let current = "";
  try {
    current = await readFile(envPath, "utf8");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const line = `${name}=${value}`;
  if (new RegExp(`^${name}=`, "m").test(current)) current = current.replace(new RegExp(`^${name}=.*$`, "m"), line);
  else current = `${current.replace(/\s*$/, "")}\n${line}\n`;
  await writeFile(envPath, current, "utf8");
  console.log(`[env] ${name}을(를) .env에 저장했습니다.`);
}

const context = await chromium.launchPersistentContext(profilePath, {
  channel: "msedge",
  headless: false,
  viewport: { width: 1440, height: 900 }
});
try {
  const page = context.pages().at(0) ?? await context.newPage();
  await ensureLoggedIn(page, { waitForLogin: true, timeoutMs: 600000 });
  await page.goto(ACCOUNT_LIST_URL, { waitUntil: "domcontentloaded" }).catch(() => null);
  await page.waitForTimeout(2000);

  // 수백 건 목록은 검색으로 좁힌다.
  const keywordField = page.locator("#searchKeyword1");
  if (await keywordField.count()) {
    await keywordField.fill(keyword || datasetId);
    await page.locator('button:has-text("검색")').first().click().catch(() => null);
    await page.waitForTimeout(2000);
  }

  const text = await page.locator("body").innerText().catch(() => "");
  const status = text.match(/\[(?:승인|신청|반려|보류|재신청)\]/)?.[0] ?? text.match(/(?:승인|신청|반려)/)?.[0] ?? "";
  console.log(`[key] 목록 상태: ${status || "확인 못 함"}`);

  // 상세 화면들을 돌며 데이터셋·인증키를 찾는다. 키는 텍스트뿐 아니라 input 값으로도 그려진다.
  const readKey = async (targetPage) => {
    const detail = await targetPage.locator("body").innerText().catch(() => "");
    const inputValues = await targetPage.evaluate(() =>
      [...document.querySelectorAll("input,textarea")].map((node) => String(node.value ?? "")).filter(Boolean)
    ).catch(() => []);
    const haystack = detail + "\n" + inputValues.join("\n");
    if (!haystack.includes(datasetId) && !(keyword && haystack.includes(keyword))) return null;
    const key = haystack.match(/([A-Za-z0-9+/=]{80,})/)?.[1] ?? "";
    const endpoint = haystack.match(/https?:\/\/apis\.data\.go\.kr\/[A-Za-z0-9_\-./]+/)?.[0] ?? "";
    return { key, endpoint };
  };

  // 행 안의 "계정개발" 버튼이 인증키 팝업을 연다. 없으면 상세 링크들을 순회한다.
  const rowButton = page.locator('button:has-text("계정개발"), a:has-text("계정개발")').first();
  if (await rowButton.count()) {
    const popupPromise = page.waitForEvent("popup", { timeout: 10000 }).catch(() => null);
    await rowButton.click().catch(() => null);
    const popup = await popupPromise;
    const keyPage = popup ?? page;
    await keyPage.waitForTimeout(1200);
    const found = await readKey(keyPage);
    if (found?.key) {
      console.log(JSON.stringify({ datasetId, status: status || "승인", keyFound: true, endpoint: found.endpoint }, null, 1));
      if (envName) await saveEnvKey(envName, found.key);
    } else {
      console.log("[key] 팝업에서 키를 찾지 못했습니다. 화면:", keyPage.url());
    }
    if (popup) await popup.close().catch(() => null);
  } else {
    const links = extractAccountLinks(await page.content());
    console.error(`[key] 계정 상세 링크 ${links.length}개를 확인합니다.`);
    for (const link of links.slice(0, 20)) {
      await page.goto(link.url, { waitUntil: "domcontentloaded" }).catch(() => null);
      await page.waitForTimeout(800);
      const found = await readKey(page);
      if (!found) continue;
      console.log(JSON.stringify({ datasetId, status: status || "승인", keyFound: Boolean(found.key), endpoint: found.endpoint }, null, 1));
      if (found.key && envName) await saveEnvKey(envName, found.key);
      break;
    }
  }
} finally {
  await context.close();
}
