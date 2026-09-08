import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { applyForDataset, ensureLoggedIn, PORTAL_ORIGIN } from "../lib/localdata-browser.js";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const profilePath = process.env.PLAYWRIGHT_PROFILE_PATH
  ? resolve(process.env.PLAYWRIGHT_PROFILE_PATH)
  : resolve(root, ".playwright/data-go-personal");
const executablePath = process.env.PLAYWRIGHT_EXECUTABLE_PATH || undefined;
const portalOrigin = PORTAL_ORIGIN;

const priorityApplications = [
  ["15154963", "통신판매업"],
  ["15155004", "옥외광고업"],
  ["15155014", "인쇄사"],
  ["15155020", "출판사"],
  ["15154966", "공연장"],
  ["15154848", "영화상영관"],
  ["15155146", "박물관 및 미술관"],
  ["15155139", "외국인관광도시민박업"],
  ["15154923", "의료기기판매(임대)업"],
  ["15155018", "등록체육시설업"],
  ["15154933", "치과기공소"],
  ["15155155", "대중문화예술기획업"],
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
  ["15155168", "집단급식소"],
  ["15155159", "위탁급식영업"],
  ["15154784", "집단급식소식품판매업"],
  ["15155150", "식품제조가공업"],
  ["15154871", "축산판매업"],
  ["15154957", "동물생산업"],
  ["15155065", "동물장묘업"],
  ["15155024", "동물운송업"],
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
const requestedDatasetId = process.env.PLAYWRIGHT_DATASET_ID;
const targets = priorityOnly
  ? applications.filter(({ datasetId }) => priorityApplications.some(([id]) => id === datasetId))
  : applications;
const selectedTargets = requestedDatasetId
  ? targets.filter(({ datasetId }) => datasetId === requestedDatasetId)
  : targets;

if (listOnly) {
  for (const target of selectedTargets) console.log(`${target.datasetId}\t${target.title}\t${target.url}`);
  process.exit(0);
}

const readline = createInterface({ input, output });
const ask = (message) => readline.question(message);

let context;
try {
  console.log(`개인 서비스키 신청 대상 ${selectedTargets.length}개`);
  for (const target of selectedTargets) console.log(`${target.datasetId}\t${target.title}\t${target.url}`);
  context = await chromium.launchPersistentContext(profilePath, {
    headless: false,
    executablePath,
    locale: "ko-KR",
    viewport: { width: 1440, height: 1000 }
  });
  const page = context.pages()[0] || await context.newPage();
  await ensureLoggedIn(page, { ask, waitForLogin: process.env.PLAYWRIGHT_WAIT_FOR_LOGIN === "1" });

  if (!submit) {
    console.log("현재는 확인 모드입니다. 실제 신청은 --submit을 붙여 다시 실행하세요.");
  } else {
    const confirmation = process.env.PLAYWRIGHT_CONFIRM
      || await ask("전체 대상에 활용신청을 제출하려면 APPLY_PERSONAL을 입력하세요: ");
    if (confirmation.trim() !== "APPLY_PERSONAL") throw new Error("일괄 신청을 취소했습니다.");

    for (const target of selectedTargets) {
      try {
        const result = await applyForDataset(page, target);
        console.log(`[${result.status}] ${target.datasetId} ${target.title}`);
        if (result.status !== "submitted" && !result.status.startsWith("already-applied")) {
          console.log(JSON.stringify(result));
        }
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
