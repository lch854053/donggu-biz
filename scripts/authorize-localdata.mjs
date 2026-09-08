// 후보 원천 하나마다 데이터셋 검색 → 활용신청 → 요청주소 확인을 한 번에 끝낸다.
// 예전에는 apply/inspect/probe를 따로 돌리며 datasetId를 손으로 옮겨 적어야 했다.
//
//   npm run authorize-localdata                    확인만 (신청하지 않음)
//   npm run authorize-localdata -- --submit        활용신청까지 제출
//   npm run authorize-localdata -- --priority=1,2  일부 순위만
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { LOCALDATA_SOURCES } from "../lib/store-license.js";
import {
  applyForDataset,
  collectEndpoints,
  ensureLoggedIn,
  pageText,
  searchDatasets
} from "../lib/localdata-browser.js";
import {
  datasetDetailUrl,
  pickDatasetMatch,
  readApplicationState,
  searchKeywordFromTitle
} from "../lib/localdata-portal.js";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const profilePath = process.env.PLAYWRIGHT_PROFILE_PATH
  ? resolve(process.env.PLAYWRIGHT_PROFILE_PATH)
  : resolve(root, ".playwright/data-go-personal");
const executablePath = process.env.PLAYWRIGHT_EXECUTABLE_PATH || undefined;
const candidatesPath = resolve(root, "data/localdata_source_candidates.json");
const reportPath = resolve(root, "data/localdata_authorization.json");

function parseArgs(argv) {
  const args = { submit: false, priorities: null, slugs: null, expand: false, limit: 0 };
  for (const argument of argv) {
    const [flag, value = ""] = argument.split("=");
    if (flag === "--submit") args.submit = true;
    else if (flag === "--expand") args.expand = true;
    else if (flag === "--priority") args.priorities = new Set(value.split(",").map(Number).filter(Boolean));
    else if (flag === "--slugs") args.slugs = new Set(value.split(",").map((entry) => entry.trim()).filter(Boolean));
    else if (flag === "--limit") args.limit = Number(value) || 0;
    else if (flag) throw new Error(`알 수 없는 인자입니다: ${flag}`);
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
const candidates = JSON.parse(await readFile(candidatesPath, "utf8"));
const configured = new Set(LOCALDATA_SOURCES.map((source) => source.slug));

let targets = (candidates.newCandidates || []).filter(({ slug }) => !configured.has(slug));
if (args.priorities) targets = targets.filter(({ priority }) => args.priorities.has(priority));
if (args.slugs) targets = targets.filter(({ slug }) => args.slugs.has(slug));
if (args.limit) targets = targets.slice(0, args.limit);

if (!targets.length) {
  console.log("처리할 후보가 없습니다. data/localdata_source_candidates.json을 확인하세요.");
  process.exit(0);
}

console.log(`대상 ${targets.length}종${args.submit ? " (활용신청 제출)" : " (확인만)"}`);

const readline = createInterface({ input, output });
const ask = (message) => readline.question(message);

// 유추한 요청주소가 실제로 열려 있는지는 상세 페이지가 알려 준다. 슬러그가 다르면
// 그 데이터셋의 진짜 주소로 갈아 끼운다.
function resolveEndpoint(candidate, endpoints) {
  const exact = endpoints.find(({ slug }) => slug === candidate.slug);
  if (exact) return { endpoint: exact.endpoint, endpointSource: "confirmed" };
  if (endpoints.length === 1) return { endpoint: endpoints[0].endpoint, endpointSource: "corrected" };
  if (endpoints.length > 1) return { endpoint: candidate.endpoint, endpointSource: "ambiguous" };
  return { endpoint: candidate.endpoint, endpointSource: "guessed" };
}

async function processCandidate(page, candidate) {
  const record = { ...candidate };

  if (!record.datasetId) {
    const keyword = searchKeywordFromTitle(record.title);
    const { matches } = await searchDatasets(page, keyword);
    const match = pickDatasetMatch(matches, record.title);
    if (!match) {
      record.status = matches.length ? "search-ambiguous" : "search-empty";
      record.searchNote = matches.length
        ? `검색 결과 ${matches.length}건 중 제목이 일치하는 것을 고르지 못했습니다: ${matches.slice(0, 5).map(({ datasetId, title }) => `${datasetId} ${title}`).join(" / ")}`
        : `"${keyword}" 검색 결과가 없습니다.`;
      return record;
    }
    record.datasetId = match.datasetId;
    record.searchNote = `검색 일치(${match.confidence}): ${match.title}`;
    await page.waitForTimeout(400);
  }

  const detailUrl = datasetDetailUrl(record.datasetId);
  const { endpoints } = await collectEndpoints(page, detailUrl, { expand: args.expand });
  Object.assign(record, resolveEndpoint(record, endpoints));
  record.applicationState = readApplicationState(await pageText(page));

  if (!args.submit) {
    record.status = record.applicationState === "approved-or-applied" ? "applied" : "ready-to-apply";
    return record;
  }

  const result = await applyForDataset(page, { datasetId: record.datasetId, title: record.title, url: detailUrl });
  record.applyStatus = result.status;
  if (result.status === "submitted" || result.status.startsWith("already-applied")) {
    record.status = "applied";
  } else {
    record.status = "apply-failed";
    record.applyNote = result.reason || result.url || "";
  }
  return record;
}

let context;
const report = { generatedAt: new Date().toISOString(), submitted: args.submit, results: [] };
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
  await ensureLoggedIn(page, { ask, waitForLogin: process.env.PLAYWRIGHT_WAIT_FOR_LOGIN === "1" });

  if (args.submit) {
    const confirmation = process.env.PLAYWRIGHT_CONFIRM
      || await ask(`${targets.length}종에 활용신청을 제출하려면 APPLY_PERSONAL을 입력하세요: `);
    if (confirmation.trim() !== "APPLY_PERSONAL") throw new Error("일괄 신청을 취소했습니다.");
  }

  let index = 0;
  for (const candidate of targets) {
    index += 1;
    let record;
    try {
      record = await processCandidate(page, candidate);
    } catch (error) {
      record = { ...candidate, status: "failed", error: error.message };
    }
    report.results.push(record);
    console.log(`[${index}/${targets.length}] ${String(record.status).padEnd(16)} ${record.slug.padEnd(38)} ${record.datasetId || "-"}\t${record.endpoint}`);
    if (record.searchNote) console.log(`    ↳ ${record.searchNote}`);
    if (record.applyNote) console.log(`    ↳ ${record.applyNote}`);
    if (record.error) console.log(`    ↳ ${record.error}`);
    await page.waitForTimeout(600);
  }
} finally {
  await context?.close();
  await readline.close();
}

// 찾아낸 datasetId와 요청주소는 후보 파일에 되써 둔다. 다시 돌릴 때 검색을 건너뛴다.
const byslug = new Map(report.results.map((record) => [record.slug, record]));
candidates.newCandidates = (candidates.newCandidates || []).map((candidate) => {
  const found = byslug.get(candidate.slug);
  return found ? { ...candidate, ...found } : candidate;
});
candidates.meta = { ...candidates.meta, authorizedAt: report.generatedAt };
await writeFile(candidatesPath, `${JSON.stringify(candidates, null, 2)}\n`, "utf8");
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");

const counts = {};
for (const record of report.results) counts[record.status] = (counts[record.status] || 0) + 1;
console.log(`\n[authorize] ${Object.entries(counts).map(([status, count]) => `${status} ${count}`).join(" / ")}`);
console.log(`후보 파일과 ${reportPath}를 갱신했습니다.`);
if (!args.submit) console.log("실제 신청은 --submit을 붙여 다시 실행하세요.");
else console.log("승인까지 몇 분 걸립니다. npm run probe-localdata-sources -- --scope=candidates 로 확인하세요.");
