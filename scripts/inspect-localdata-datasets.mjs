import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { LOCALDATA_SOURCES } from "../lib/store-license.js";
import {
  datasetDetailUrl,
  extractAccountLinks,
  findEndpointDiagnostics,
  searchKeywordFromTitle,
  readApplicationState
} from "../lib/localdata-portal.js";
import {
  ACCOUNT_LIST_URL,
  collectEndpoints,
  ensureLoggedIn,
  pageText,
  searchDatasets
} from "../lib/localdata-browser.js";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const profilePath = process.env.PLAYWRIGHT_PROFILE_PATH
  ? resolve(process.env.PLAYWRIGHT_PROFILE_PATH)
  : resolve(root, ".playwright/data-go-personal");
const executablePath = process.env.PLAYWRIGHT_EXECUTABLE_PATH || undefined;
const candidatesPath = resolve(root, "data/localdata_source_candidates.json");
const outputPath = resolve(root, "data/localdata_dataset_endpoints.json");

function parseArgs(argv) {
  const args = { ids: [], search: [], useCandidates: true, myPage: false, expand: false };
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
    } else if (flag === "--expand") {
      args.expand = true;
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

async function inspectDataset(page, { datasetId, title }, options) {
  const url = datasetDetailUrl(datasetId);
  const { endpoints, html } = await collectEndpoints(page, url, options);
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
async function inspectMyAccounts(page, options) {
  await page.goto(ACCOUNT_LIST_URL, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(600);
  const listHtml = await page.content();
  const links = extractAccountLinks(listHtml);
  if (!links.length) {
    console.log("개발계정 목록에서 상세 링크를 찾지 못했습니다. 페이지 진단:");
    for (const snippet of findEndpointDiagnostics(listHtml)) console.log(`    ↳ ${snippet}`);
  }
  const accounts = [];
  let index = 0;
  for (const link of links) {
    index += 1;
    console.log(`  [${index}/${links.length}] ${link.title || link.url}`);
    const { endpoints, html } = await collectEndpoints(page, link.url, options);
    if (!endpoints.length) {
      accounts.push({ title: link.title, url: link.url, endpoints: [], diagnostics: findEndpointDiagnostics(html) });
      continue;
    }
    accounts.push({ title: link.title, url: link.url, endpoints });
    console.log(`${endpoints.map(({ endpoint }) => endpoint).join(" ")}\t${link.title}`);
  }
  return { listedCount: links.length, accounts };
}

const args = parseArgs(process.argv.slice(2));
const candidates = await loadCandidates();
const configuredIds = new Set(LOCALDATA_SOURCES.map((source) => source.datasetId));

const datasetTargets = args.useCandidates
  ? (candidates.pendingApplications || []).filter(({ datasetId }) => !configuredIds.has(datasetId))
  : args.ids.map((datasetId) => ({ datasetId, title: "" }));
const searchTargets = args.useCandidates
  ? [...new Set((candidates.newCandidates || [])
      // 이미 없는 것으로 확인된 업종은 다시 검색하지 않는다.
      .filter(({ datasetId, status }) => !datasetId && status === "endpoint-unknown")
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
  page.setDefaultTimeout(15000);
  page.setDefaultNavigationTimeout(30000);
  await ensureLoggedIn(page, { ask });

  if (args.myPage) {
    console.log("\n[마이페이지 개발계정] 승인된 API의 요청주소를 읽습니다.");
    report.myAccounts = await inspectMyAccounts(page, { expand: args.expand });
    console.log(`개발계정 ${report.myAccounts.listedCount}건 중 ${report.myAccounts.accounts.length}건에서 요청주소를 찾았습니다.`);
  }

  for (const target of datasetTargets) {
    try {
      const result = await inspectDataset(page, target, { expand: args.expand });
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
      const { matches, url } = await searchDatasets(page, keyword);
      const result = { keyword, url, matches: matches.slice(0, 10) };
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
