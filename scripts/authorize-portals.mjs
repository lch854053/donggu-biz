import { appendFile, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { ensureLoggedIn, isLoggedIn } from "../lib/localdata-browser.js";
import { extractAccountLinks } from "../lib/localdata-portal.js";

// 활용신청·키 발급이 필요한 세 포털을 브라우저 한 세션으로 처리한다. 포털 세션
// 쿠키는 브라우저를 닫으면 사라지므로, 로그인은 포털마다 한 번씩 직접 하고
// 스크립트는 키가 화면에 나타나는 것을 기다려 .env에 적는다.
//
//   npm run authorize-portals                       # 전체(포털 로그인 3회)
//   npm run authorize-portals -- --skip-portal --skip-kosis   # NEIS만

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const profilePath = resolve(root, ".playwright/data-go-personal");
const envPath = resolve(root, ".env");

const wants = (name) => !process.argv.includes(`--skip-${name}`);

async function saveEnvKey(name, value) {
  let current = "";
  try {
    current = await readFile(envPath, "utf8");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const line = `${name}=${value}`;
  if (new RegExp(`^${name}=`, "m").test(current)) {
    current = current.replace(new RegExp(`^${name}=.*$`, "m"), line);
  } else {
    current = `${current.replace(/\s*$/, "")}\n${line}\n`;
  }
  await writeFile(envPath, current, "utf8");
  console.log(`[env] ${name}을(를) .env에 저장했습니다.`);
}

async function bodyText(page) {
  return page.locator("body").innerText().catch(() => "");
}

/** 로그인·키 발급처럼 사용자 손이 필요한 단계를, 화면에 조건이 보일 때까지 기다린다. */
async function waitUntil(pageOrContext, probe, { timeoutMs = 600000, everyMs = 3000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await probe().catch(() => null);
    if (value) return value;
    await new Promise((pause) => setTimeout(pause, everyMs));
  }
  return null;
}

const context = await chromium.launchPersistentContext(profilePath, {
  channel: "msedge",
  headless: false,
  viewport: { width: 1440, height: 900 }
});

try {
  // 1) 공공데이터포털: 근로복지공단 고용/산재보험 현황정보(15059256) 상태·키 확인
  if (wants("portal")) {
    const page = context.pages().at(0) ?? await context.newPage();
    await ensureLoggedIn(page, { waitForLogin: true, timeoutMs: 600000 });
    await page.goto("https://www.data.go.kr/iim/api/selectAcountList.do", { waitUntil: "domcontentloaded" }).catch(() => null);
    await page.waitForTimeout(2000);
    // 신청 목록이 수백 건이면 목록 검색으로 좁힌다.
    const keywordField = page.locator("#searchKeyword1");
    if (await keywordField.count()) {
      await keywordField.fill("근로복지공단");
      await page.locator('button:has-text("검색")').first().click().catch(() => null);
      await page.waitForTimeout(2000);
    }
    const text = await bodyText(page);
    const block = text.split("\n").map((line) => line.trim()).filter(Boolean);
    const index = block.findIndex((line) => line.includes("근로복지공단"));
    if (index < 0) {
      console.log("[portal] 마이페이지 목록에서 근로복지공단 행을 찾지 못했습니다. 목록 앞부분:");
      console.log(block.slice(0, 25).join(" | "));
    } else {
      console.log("[portal] 근로복지공단 행 주변:");
      console.log(block.slice(Math.max(0, index - 2), index + 6).join(" | "));
    }
    // 상세 화면들을 돌며 15059256·인증키를 찾는다.
    const links = extractAccountLinks(await page.content());
    for (const link of links.slice(0, 40)) {
      await page.goto(link.url, { waitUntil: "domcontentloaded" }).catch(() => null);
      await page.waitForTimeout(700);
      const detail = await bodyText(page);
      if (!detail.includes("15059256") && !detail.includes("근로복지공단")) continue;
      const status = detail.match(/(?:승인|신청|반려|보류|재신청)/)?.[0] ?? "";
      const key = detail.match(/([A-Za-z0-9+/=]{100,})/)?.[1] ?? "";
      const endpoint = detail.match(/https?:\/\/apis\.data\.go\.kr\/[A-Za-z0-9_\-./]+/)?.[0] ?? "";
      console.log(JSON.stringify({ datasetId: "15059256", status, keyFound: Boolean(key), endpoint }, null, 1));
      if (key) await saveEnvKey("KCOMWEL_SERVICE_KEY", key);
      break;
    }
  }

  // 2) NEIS: 로그인 후 학원교습소정보 API 키 발급. 키는 32자리 16진수다.
  if (wants("neis")) {
    const page = context.pages().find((candidate) => candidate !== context.pages().at(0)) ?? await context.newPage();
    await page.goto("https://open.neis.go.kr/", { waitUntil: "domcontentloaded" }).catch(() => null);
    console.log("[neis] 브라우저에서 나이스 교육정보 개방 포털에 로그인하고, 데이터셋 목록에서 '학원교습소정보'의 활용신청을 마쳐 주세요. 키가 보이면 자동으로 읽습니다.");
    const loggedIn = await waitUntil(page, async () => ((await bodyText(page)).includes("로그아웃") ? true : null), { timeoutMs: 600000 });
    if (!loggedIn) {
      console.log("[neis] 로그인을 확인하지 못했습니다. 이 단계는 건너뜁니다.");
    } else {
      console.log("[neis] 로그인을 확인했습니다. 발급된 API 키를 기다립니다.");
      const key = await waitUntil(context, async () => {
        for (const open of context.pages()) {
          const text = await bodyText(open);
          if (!/API\s*키|인증키/.test(text)) continue;
          const match = text.match(/\b[a-f0-9]{32}\b/i);
          if (match) return match[0];
        }
        return null;
      }, { timeoutMs: 600000 });
      if (key) await saveEnvKey("NEIS_API_KEY", key);
      else console.log("[neis] 키를 읽지 못했습니다. 나중에 마이페이지에서 복사해 .env의 NEIS_API_KEY에 붙여 주세요.");
    }
  }

  // 3) KOSIS: 로그인 후 OPEN API 인증키 신청. 키는 30자 내외 영숫자다.
  if (wants("kosis")) {
    const page = context.pages().at(-1) ?? await context.newPage();
    await page.goto("https://kosis.kr/", { waitUntil: "domcontentloaded" }).catch(() => null);
    console.log("[kosis] 브라우저에서 KOSIS에 로그인하고 OPEN API 인증키를 신청해 주세요. 키가 보이면 자동으로 읽습니다.");
    const loggedIn = await waitUntil(page, async () => ((await bodyText(page)).includes("로그아웃") ? true : null), { timeoutMs: 600000 });
    if (!loggedIn) {
      console.log("[kosis] 로그인을 확인하지 못했습니다. 이 단계는 건너뜁니다.");
    } else {
      console.log("[kosis] 로그인을 확인했습니다. 발급된 인증키를 기다립니다.");
      const key = await waitUntil(context, async () => {
        for (const open of context.pages()) {
          const text = await bodyText(open);
          if (!/인증키/.test(text)) continue;
          const match = text.match(/\b[A-Za-z0-9]{28,40}\b/g)?.filter((token) => /[A-Z]/.test(token) || /[a-z]/.test(token)) ?? [];
          if (match.length) return match.at(-1);
        }
        return null;
      }, { timeoutMs: 600000 });
      if (key) await saveEnvKey("KOSIS_SERVICE_KEY", key);
      else console.log("[kosis] 키를 읽지 못했습니다. 나중에 마이페이지에서 복사해 .env의 KOSIS_SERVICE_KEY에 붙여 주세요.");
    }
  }
} finally {
  await context.close();
}
