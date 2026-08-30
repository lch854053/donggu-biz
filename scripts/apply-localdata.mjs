import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const profilePath = resolve(root, ".playwright/data-go-personal");
const portalOrigin = "https://www.data.go.kr";
const loginUrl = `${portalOrigin}/uim/login/loginView.do`;
const applicationPurpose = "광주 동구 사업자·상권 조회 서비스의 지역 업소 지도 및 통계 제공";

const priorityApplications = [
  ["15154791", "안전상비의약품 판매업소"],
  ["15155253", "석유판매업"],
  ["15155258", "석유 및 석유대체연료 판매업체"],
  ["15155022", "무도장업"],
  ["15155029", "무도학원업"],
  ["15154981", "산후조리업"],
  ["15155093", "유료직업소개소"],
  ["15155099", "무료직업소개소"],
  ["15155130", "관광사업자"],
  ["15155015", "쓰레기종량제봉투판매업"]
];

const optionalApplications = [
  ["15154864", "의료유사업"],
  ["15154897", "관광식당"],
  ["15154910", "외국인전용유흥음식점업"],
  ["15154903", "관광유흥음식점업"],
  ["15154983", "관광극장유흥업"]
];

const applications = [...priorityApplications, ...optionalApplications]
  .map(([datasetId, title]) => ({
    datasetId,
    title,
    url: `${portalOrigin}/data/${datasetId}/openapi.do`
  }));

const args = new Set(process.argv.slice(2));
const priorityOnly = args.has("--priority");
const submit = args.has("--submit");
const listOnly = args.has("--list");
const targets = priorityOnly
  ? applications.filter(({ datasetId }) => priorityApplications.some(([id]) => id === datasetId))
  : applications;

function printTargets() {
  for (const target of targets) console.log(`${target.datasetId}\t${target.title}\t${target.url}`);
}

if (listOnly) {
  printTargets();
  process.exit(0);
}

const readline = createInterface({ input, output });
const ask = (message) => readline.question(message);

async function isLoggedIn(page) {
  const body = await page.locator("body").innerText().catch(() => "");
  return /로그아웃/.test(body) || await page.locator('a[href*="logout"], button:has-text("로그아웃")').count() > 0;
}

async function ensureLoggedIn(page) {
  await page.goto(loginUrl, { waitUntil: "domcontentloaded" });
  if (await isLoggedIn(page)) return;
  console.log("브라우저에서 공공데이터포털 개인회원 로그인을 완료하세요.");
  await ask("로그인 완료 후 이 터미널에서 Enter를 누르세요: ");
  if (!await isLoggedIn(page)) throw new Error("로그인 상태를 확인하지 못했습니다.");
}

async function waitForReady(page) {
  await page.waitForLoadState("domcontentloaded", { timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(400);
}

async function clickAndCapturePopup(page, locator) {
  const popupPromise = page.waitForEvent("popup", { timeout: 10000 }).catch(() => null);
  await locator.click();
  const popup = await popupPromise;
  if (popup) await waitForReady(popup);
  return popup || page;
}

async function visible(locator) {
  return await locator.count() > 0 && await locator.first().isVisible().catch(() => false);
}

async function selectPersonalServiceKey(page) {
  const personalButton = page.locator("#confirmN");
  if (!await visible(personalButton)) return page;
  return clickAndCapturePopup(page, personalButton);
}

async function findPurposeField(page) {
  const fields = page.locator("textarea, input[type=text]");
  for (let index = 0; index < await fields.count(); index += 1) {
    const field = fields.nth(index);
    if (!await field.isVisible().catch(() => false)) continue;
    const context = await field.evaluate((element) => {
      const label = element.id ? document.querySelector(`label[for="${element.id}"]`) : null;
      return [element.name, element.id, element.placeholder, label?.textContent]
        .filter(Boolean).join(" ");
    });
    if (/활용목적|사용목적|purpose|use/i.test(context)) return field;
  }
  return null;
}

async function elementIsRequired(locator) {
  return await locator.getAttribute("required") !== null;
}

async function checkRequiredConsents(page) {
  const checkboxes = page.locator('input[type="checkbox"]');
  for (let index = 0; index < await checkboxes.count(); index += 1) {
    const checkbox = checkboxes.nth(index);
    if (!await checkbox.isVisible().catch(() => false) || await checkbox.isChecked()) continue;
    const context = await checkbox.evaluate((element) => {
      const label = element.id ? document.querySelector(`label[for="${element.id}"]`) : null;
      return [element.name, element.id, element.getAttribute("aria-label"), label?.textContent, element.parentElement?.textContent]
        .filter(Boolean).join(" ");
    });
    if (await elementIsRequired(checkbox) || /필수|이용약관|개인정보|동의/.test(context)) await checkbox.check();
  }
}

async function findSubmitButton(page) {
  const buttons = page.locator('button, input[type="submit"]');
  const matches = [];
  for (let index = 0; index < await buttons.count(); index += 1) {
    const button = buttons.nth(index);
    if (!await button.isVisible().catch(() => false)) continue;
    const text = (await button.innerText().catch(() => "")) || await button.getAttribute("value") || "";
    if (/활용신청|신청하기|신청/.test(text) && !/취소|목록|검색/.test(text)) matches.push(button);
  }
  return matches.at(-1) || null;
}

async function pageSummary(page) {
  const controls = await page.locator("input, textarea, select, button").evaluateAll((elements) => elements
    .filter((element) => {
      const style = getComputedStyle(element);
      return style.display !== "none" && style.visibility !== "hidden";
    })
    .map((element) => ({
      tag: element.tagName,
      type: element.getAttribute("type"),
      text: (element.innerText || element.value || element.getAttribute("aria-label") || "").replace(/\s+/g, " ").trim(),
      name: element.getAttribute("name"),
      id: element.id
    }))
    .slice(-30));
  return { url: page.url(), title: await page.title(), controls };
}

async function applyTarget(page, target) {
  await page.goto(target.url, { waitUntil: "domcontentloaded" });
  await waitForReady(page);

  const applyButton = page.locator('button[title*="활용신청"]');
  if (!await visible(applyButton)) {
    return { status: "already-applied-or-unavailable", url: page.url() };
  }

  const formPage = await clickAndCapturePopup(page, applyButton);
  const selectedPage = await selectPersonalServiceKey(formPage);
  await waitForReady(selectedPage);
  if (/login/i.test(selectedPage.url()) || !await isLoggedIn(selectedPage)) {
    throw new Error(`${target.datasetId}: 신청 페이지에서 로그인 상태를 잃었습니다.`);
  }

  const purposeField = await findPurposeField(selectedPage);
  if (purposeField) await purposeField.fill(applicationPurpose);
  await checkRequiredConsents(selectedPage);
  const submitButton = await findSubmitButton(selectedPage);
  if (!submitButton) return { status: "form-needs-manual-review", ...(await pageSummary(selectedPage)) };

  await submitButton.click();
  await waitForReady(selectedPage);
  const body = await selectedPage.locator("body").innerText().catch(() => "");
  const completed = /신청.*완료|신청.*되었|활용신청.*완료|승인/.test(body);
  if (selectedPage !== page) await selectedPage.close().catch(() => {});
  return { status: completed ? "submitted" : "submitted-needs-review", url: selectedPage.url() };
}

let context;
try {
  console.log(`개인 서비스키 신청 대상 ${targets.length}개`);
  printTargets();
  context = await chromium.launchPersistentContext(profilePath, {
    headless: false,
    locale: "ko-KR",
    viewport: { width: 1440, height: 1000 }
  });
  const page = context.pages()[0] || await context.newPage();
  await ensureLoggedIn(page);

  if (!submit) {
    console.log("현재는 확인 모드입니다. 실제 신청은 --submit을 붙여 다시 실행하세요.");
  } else {
    const confirmation = await ask("전체 대상에 활용신청을 제출하려면 APPLY_PERSONAL을 입력하세요: ");
    if (confirmation.trim() !== "APPLY_PERSONAL") throw new Error("일괄 신청을 취소했습니다.");

    for (const target of targets) {
      try {
        const result = await applyTarget(page, target);
        console.log(`[${result.status}] ${target.datasetId} ${target.title}`);
        if (result.status === "form-needs-manual-review") console.log(JSON.stringify(result));
      } catch (error) {
        console.error(`[failed] ${target.datasetId} ${target.title}: ${error.message}`);
      }
      await page.waitForTimeout(800);
    }
  }
} finally {
  await context?.close();
  await readline.close();
}
