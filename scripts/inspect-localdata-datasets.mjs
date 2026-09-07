import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { LOCALDATA_SOURCES } from "../lib/store-license.js";
import {
  datasetDetailUrl,
  datasetSearchUrl,
  extractAccountLinks,
  extractApiEndpoints,
  extractDatasetLinks,
  findEndpointDiagnostics,
  searchKeywordFromTitle,
  readApplicationState
} from "../lib/localdata-portal.js";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const profilePath = process.env.PLAYWRIGHT_PROFILE_PATH
  ? resolve(process.env.PLAYWRIGHT_PROFILE_PATH)
  : resolve(root, ".playwright/data-go-personal");
const executablePath = process.env.PLAYWRIGHT_EXECUTABLE_PATH || undefined;
const candidatesPath = resolve(root, "data/localdata_source_candidates.json");
const outputPath = resolve(root, "data/localdata_dataset_endpoints.json");
const loginUrl = "https://www.data.go.kr/uim/login/loginView.do";

function parseArgs(argv) {
  const args = { ids: [], search: [], useCandidates: true, myPage: false };
  for (const argument of argv) {
    const [flag, value = ""] = argument.split("=");
    if (flag === "--ids") {
      args.ids = value.split(",").map((entry) => entry.trim()).filter(Boolean);
      args.useCandidates = false;
    } else if (flag === "--search") {
      args.search = value.split(",").map((entry) => entry.trim()).filter(Boolean);
      args.useCandidates = false;
    } else if (flag === "--mypage") {
      args.myPage = true;
    } else if (flag) {
      throw new Error(`알 수 없는 인자입니다: ${flag}`);
    }
  }
  return args;
}

async function loadCandidates() {
  try {
    return JSON.parse(await readFile(candidatesPath, "utf8"));
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    return { pendingApplications: [], newCandidates: [] };
  }
}

async function pageText(page) {
  return await page.locator("body").innerText().catch(() => "");
}

async function isLoggedIn(page) {
  const text = await pageText(page);
  return /로그아웃/.test(text);
}

async function ensureLoggedIn(page, ask) {
  await page.goto(loginUrl, { waitUntil: "domcontentloaded" });
  if (await isLoggedIn(page)) return;
  console.log("브라우저에서 공공데이터포털 로그인을 완료하세요. (엔드포인트는 로그인해야 보이는 경우가 있습니다)");
  await ask("로그인 완료 후 이 터미널에서 Enter를 누르세요: ");
}

// 상세기능은 접힌 영역이나 탭 안에 있을 수 있어, 눌러서 펼친 뒤 다시 훑는다.
async function expandDetailSections(page) {
  const triggers = page.locator('a, button, [role="tab"]');
  const count = Math.min(await triggers.count(), 60);
  for (let index = 0; index < count; index += 1) {
    const trigger = triggers.nth(index);
    const label = (await trigger.innerText().catch(() => "")).replace(/\s+/g, " ").trim();
    if (!/상세기능|요청변수|출력결과|미리보기|더보기/.test(label)) continue;
    await trigger.click({ timeout: 2000 }).catch(() => {});
    await page.waitForTimeout(300);
  }
}

async function inspectDataset(page, { datasetId, title }) {
  const url = datasetDetailUrl(datasetId);
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(500);
  let html = await page.content();
  let endpoints = extractApiEndpoints(html);
  if (!endpoints.length) {
    await expandDetailSections(page);
    html = await page.content();
    endpoints = extractApiEndpoints(html);
  }
  const text = await pageText(page);
  const heading = await page.locator("h1, .page-tit, .tit").first().innerText().catch(() => "");
  return {
    datasetId,
    title: title || heading.replace(/\s+/g, " ").trim(),
    url,
    applicationState: readApplicationState(text),
    endpoints,
    ...(endpoints.length ? {} : { diagnostics: findEndpointDiagnostics(html) })
  };
}

// 마이페이지 개발계정 상세에는 승인된 API의 요청주소가 오퍼레이션별로 그대로 적혀 있다.
async function inspectMyAccounts(page) {
  await page.goto("https://www.data.go.kr/iim/api/selectAcountList.do", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(600);
  const links = extractAccountLinks(await page.content());
  const accounts = [];
  for (const link of links) {
    await page.goto(link.url, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(400);
    let html = await page.content();
    let endpoints = extractApiEndpoints(html);
    if (!endpoints.length) {
      await expandDetailSections(page);
      html = await page.content();
      endpoints = extractApiEndpoints(html);
    }
    if (!endpoints.length) continue;
    accounts.push({ title: link.title, url: link.url, endpoints });
    console.log(`${endpoints.map(({ endpoint }) => endpoint).join(" ")}\t${link.title}`);
  }
  return { listedCount: links.length, accounts };
}

async function searchDatasets(page, keyword) {
  const url = datasetSearchUrl(keyword);
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(500);
  const links = extractDatasetLinks(await page.content());
  return { keyword, url, matches: links.slice(0, 10) };
}

const args = parseArgs(process.argv.slice(2));
const candidates = await loadCandidates();
const configuredIds = new Set(LOCALDATA_SOURCES.map((source) => source.datasetId));

const datasetTargets = args.useCandidates
  ? (candidates.pendingApplications || []).filter(({ datasetId }) => !configuredIds.has(datasetId))
  : args.ids.map((datasetId) => ({ datasetId, title: "" }));
const searchTargets = args.useCandidates
  ? [...new Set((candidates.newCandidates || [])
      .filter(({ datasetId }) => !datasetId)
      .map(({ title }) => searchKeywordFromTitle(title)))]
  : args.search;

if (!args.myPage && !datasetTargets.length && !searchTargets.length) {
  console.log("확인할 대상이 없습니다. --ids=15155146,15155018 또는 --search=통신판매업 형태로 지정하세요.");
  process.exit(0);
}

const readline = createInterface({ input, output });
const ask = (message) => readline.question(message);

let context;
const report = { generatedAt: new Date().toISOString(), datasets: [], searches: [] };
try {
  context = await chromium.launchPersistentContext(profilePath, {
    headless: false,
    executablePath,
    locale: "ko-KR",
    viewport: { width: 1440, height: 1000 }
  });
  const page = context.pages()[0] || await context.newPage();
  await ensureLoggedIn(page, ask);

  if (args.myPage) {
    console.log("\n[마이페이지 개발계정] 승인된 API의 요청주소를 읽습니다.");
    report.myAccounts = await inspectMyAccounts(page);
    console.log(`개발계정 ${report.myAccounts.listedCount}건 중 ${report.myAccounts.accounts.length}건에서 요청주소를 찾았습니다.`);
  }

  for (const target of datasetTargets) {
    try {
      const result = await inspectDataset(page, target);
      report.datasets.push(result);
      const endpoint = result.endpoints[0]?.endpoint || "(엔드포인트를 찾지 못함)";
      console.log(`${result.datasetId}\t${result.applicationState}\t${endpoint}\t${result.title}`);
      for (const snippet of result.diagnostics || []) console.log(`    ↳ ${snippet}`);
    } catch (error) {
      report.datasets.push({ ...target, error: error.message });
      console.error(`[failed] ${target.datasetId}: ${error.message}`);
    }
    await page.waitForTimeout(600);
  }

  for (const keyword of searchTargets) {
    try {
      const result = await searchDatasets(page, keyword);
      report.searches.push(result);
      console.log(`\n[검색] ${keyword}`);
      for (const match of result.matches) console.log(`  ${match.datasetId}\t${match.title}`);
      if (!result.matches.length) console.log("  결과 없음");
    } catch (error) {
      report.searches.push({ keyword, error: error.message });
      console.error(`[failed] ${keyword}: ${error.message}`);
    }
    await page.waitForTimeout(600);
  }
} finally {
  await context?.close();
  await readline.close();
}

await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.log(`\n결과를 ${outputPath}에 저장했습니다. 이 파일 내용을 그대로 공유하면 반영할 수 있습니다.`);
