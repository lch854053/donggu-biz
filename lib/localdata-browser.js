// 공공데이터포털을 브라우저로 다루는 조각들. 활용신청과 요청주소 확인이 같은 화면을 쓰므로
// 스크립트마다 따로 구현하지 않고 여기에 모은다. Playwright page를 받아 쓰기만 한다.

import { extractApiEndpoints, extractDatasetLinks, datasetSearchUrl } from "./localdata-portal.js";

export const PORTAL_ORIGIN = "https://www.data.go.kr";
export const LOGIN_URL = `${PORTAL_ORIGIN}/uim/login/loginView.do`;
export const ACCOUNT_LIST_URL = `${PORTAL_ORIGIN}/iim/api/selectAcountList.do`;
const DEFAULT_PURPOSE = "개발";

export async function pageText(page) {
  return await page.locator("body").innerText().catch(() => "");
}

export async function isLoggedIn(page) {
  const text = await pageText(page);
  if (/로그아웃/.test(text)) return true;
  return await page.locator('a[href*="logout"], button:has-text("로그아웃")').count() > 0;
}

export async function ensureLoggedIn(page, { ask, waitForLogin = false, timeoutMs = 600000 } = {}) {
  await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded" });
  if (await isLoggedIn(page)) return;
  console.log("브라우저에서 공공데이터포털 개인회원 로그인을 완료하세요.");
  if (waitForLogin) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await isLoggedIn(page)) return;
      await page.waitForTimeout(1000);
    }
    throw new Error(`로그인 상태를 ${Math.round(timeoutMs / 60000)}분 안에 확인하지 못했습니다.`);
  }
  if (!ask) throw new Error("로그인 상태를 확인하지 못했습니다.");
  await ask("로그인 완료 후 이 터미널에서 Enter를 누르세요: ");
  if (!await isLoggedIn(page)) throw new Error("로그인 상태를 확인하지 못했습니다.");
}

async function waitForReady(page) {
  await page.waitForLoadState("domcontentloaded", { timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(400);
}

async function visible(locator) {
  return await locator.count() > 0 && await locator.first().isVisible().catch(() => false);
}

async function clickAndCapturePopup(page, locator) {
  const popupPromise = page.waitForEvent("popup", { timeout: 10000 }).catch(() => null);
  await locator.click();
  const popup = await popupPromise;
  if (popup) await waitForReady(popup);
  return popup || page;
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
    const required = await checkbox.getAttribute("required") !== null;
    if (required || /필수|이용약관|개인정보|동의/.test(context)) {
      try {
        await checkbox.check({ force: true });
      } catch {
        const id = await checkbox.getAttribute("id");
        const label = id ? page.locator(`label[for="${id}"]`) : null;
        if (!label || !await visible(label)) throw new Error(`동의 항목을 선택하지 못했습니다: ${id || "unknown"}`);
        await label.click({ force: true });
      }
    }
  }

  const licenseConsent = page.locator("#useScopeAgreAt");
  if (await visible(licenseConsent) && !await licenseConsent.isChecked()) {
    throw new Error("이용허락범위 동의를 선택하지 못했습니다.");
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

// 상세 페이지에서 활용신청 버튼을 눌러 개인 서비스키로 신청까지 끝낸다.
// 이미 신청·승인된 데이터셋은 버튼이 없어 already-applied-or-unavailable로 돌아온다.
export async function applyForDataset(page, target, { purpose = DEFAULT_PURPOSE } = {}) {
  const url = target.url || `${PORTAL_ORIGIN}/data/${target.datasetId}/openapi.do`;
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await waitForReady(page);

  const applyButton = page.locator('button[title="활용신청 바로가기"]');
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
  if (purposeField) await purposeField.fill(purpose);
  await checkRequiredConsents(selectedPage);
  const submitButton = await findSubmitButton(selectedPage);
  if (!submitButton) {
    const summary = await pageSummary(selectedPage);
    return {
      status: /\/iim\/api\/selectAcountList\.do/.test(summary.url) ? "already-applied" : "form-needs-manual-review",
      ...summary
    };
  }

  const dialogMessages = [];
  const dialogHandler = async (dialog) => {
    dialogMessages.push(`${dialog.type()}: ${dialog.message()}`);
    await dialog.accept();
  };
  selectedPage.on("dialog", dialogHandler);
  try {
    const saveResponsePromise = selectedPage.waitForResponse((response) =>
      response.request().method() === "POST"
      && response.url().includes("/iim/api/saveDevAcountRequest.do"), { timeout: 30000 }
    ).catch(() => null);

    await submitButton.click();
    const saveResponse = await saveResponsePromise;
    if (!saveResponse) {
      return {
        status: "submit-not-started",
        url: selectedPage.url(),
        reason: dialogMessages.at(-1) || "저장 요청이 발생하지 않았습니다.",
        dialogs: dialogMessages
      };
    }

    await selectedPage.waitForURL(/\/iim\/api\/selectAcountList\.do/, { timeout: 30000 }).catch(() => {});
    await waitForReady(selectedPage);
    const currentUrl = selectedPage.url();
    if (!/\/iim\/api\/selectAcountList\.do/.test(currentUrl)) {
      return {
        status: "submit-rejected",
        url: currentUrl,
        reason: dialogMessages.at(-1) || `저장 응답 HTTP ${saveResponse.status()} 후 목록으로 이동하지 않았습니다.`,
        dialogs: dialogMessages
      };
    }
    return { status: "submitted", url: currentUrl, dialogs: dialogMessages };
  } finally {
    selectedPage.off("dialog", dialogHandler);
    if (selectedPage !== page) await selectedPage.close().catch(() => {});
  }
}

// 요청주소가 정적 DOM에 없고 상세기능을 펼칠 때 AJAX로만 오는 화면이 있어, 응답 본문까지 함께 훑는다.
function createEndpointCollector(page) {
  const seen = new Map();
  const handler = async (response) => {
    const url = response.url();
    if (!/data\.go\.kr/.test(url)) return;
    const type = response.headers()["content-type"] || "";
    if (!/json|html|text|javascript/.test(type)) return;
    const body = await response.text().catch(() => "");
    if (!body || body.length > 4_000_000) return;
    for (const found of extractApiEndpoints(body)) seen.set(found.slug, found);
  };
  page.on("response", handler);
  return {
    endpoints: () => [...seen.values()],
    stop: () => page.off("response", handler)
  };
}

// 펼치기는 요청주소가 정적 화면에 없을 때만 쓰는 보조 수단이다. 아무 요소나 오래 누르면
// 화면이 멈춘 것처럼 보이므로 전체 시간을 제한하고 진행 상황을 남긴다.
const EXPAND_BUDGET_MS = 12000;

async function expandDetailSections(page) {
  const deadline = Date.now() + EXPAND_BUDGET_MS;
  const triggers = page.locator('a[href="#"], a[href^="javascript"], [role="tab"], [data-toggle]');
  const count = Math.min(await triggers.count().catch(() => 0), 25);
  let clicked = 0;
  for (let index = 0; index < count; index += 1) {
    if (Date.now() > deadline) break;
    const trigger = triggers.nth(index);
    const label = (await trigger.innerText().catch(() => "")).replace(/\s+/g, " ").trim();
    if (/로그아웃|로그인|삭제|취소|신청|닫기|이전|다음|목록/.test(label)) continue;
    await trigger.click({ timeout: 1200, noWaitAfter: true }).catch(() => {});
    clicked += 1;
    await page.waitForTimeout(200);
  }
  console.log(`    (상세기능 펼치기 ${clicked}회, ${Math.round((EXPAND_BUDGET_MS - (deadline - Date.now())) / 1000)}초)`);
}

export async function collectEndpoints(page, url, { expand = false } = {}) {
  const collector = createEndpointCollector(page);
  try {
    await page.goto(url, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(500);
    let html = await page.content();
    let endpoints = extractApiEndpoints(html);
    if (!endpoints.length && expand) {
      await expandDetailSections(page);
      html = await page.content();
      endpoints = extractApiEndpoints(html);
    }
    const merged = new Map();
    for (const found of [...endpoints, ...collector.endpoints()]) merged.set(found.slug, found);
    return { endpoints: [...merged.values()], html };
  } finally {
    collector.stop();
  }
}

export async function searchDatasets(page, keyword) {
  const url = datasetSearchUrl(keyword);
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(500);
  return { keyword, url, matches: extractDatasetLinks(await page.content()) };
}
