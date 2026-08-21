import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SB_REGIONS, isRetryableStatus, normalizeProfile, parseSbResponse, summarizeByMonth } from "../lib/sbprofile.js";

const API_URL = "https://apis.data.go.kr/1160100/service/GetSBProfileInfoService/getOtlInfo";
// 한 장에 10,000행을 달라고 하면 게이트웨이가 504로 끊는 일이 있다. 하루 한도가 10,000회라
// 광주 전체를 1,000행씩 서른몇 장에 나눠 받아도 호출량은 문제가 되지 않는다.
const PAGE_SIZE = 1000;
const MAX_PAGES = 200;
const MAX_RETRIES = 5;
const key = process.env.FSC_SB_KEY;

if (!key) throw new Error("FSC_SB_KEY 환경변수가 필요합니다.");

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outputPath = resolve(root, "data/sbprofile_gwangju.json");
const tempPath = resolve(root, "data/.sbprofile-gwangju.tmp");

const sleep = (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms));

async function fetchPage(bizAreaNm, pageNo) {
  const url = new URL(API_URL);
  url.search = new URLSearchParams({
    serviceKey: key,
    pageNo: String(pageNo),
    numOfRows: String(PAGE_SIZE),
    resultType: "json",
    bizAreaNm
  }).toString();

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt += 1) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(60000) });
      if (!response.ok) {
        const error = new Error(`HTTP ${response.status}`);
        error.retryable = isRetryableStatus(response.status);
        throw error;
      }
      return parseSbResponse(await response.json());
    } catch (error) {
      if (attempt === MAX_RETRIES || error.retryable === false) throw error;
      const wait = 2 ** attempt * 1000;
      console.log(`[sbprofile] ${bizAreaNm} ${pageNo}쪽 ${error.message}, ${wait / 1000}초 뒤 재시도 (${attempt}/${MAX_RETRIES})`);
      await sleep(wait);
    }
  }
}

/**
 * bizAreaNm은 부분 일치라 "광주"로 조회하면 경기도 광주시가, "동구"로 조회하면 일산동구가
 * 섞여 들어온다. 전체 지역명으로 요청하고 응답에서 한 번 더 걸러 낸다.
 */
async function collect(region) {
  const rows = [];
  let total = Infinity;
  for (let pageNo = 1; pageNo <= MAX_PAGES && rows.length < total; pageNo += 1) {
    const page = await fetchPage(region.bizAreaNm, pageNo);
    total = page.totalCount || page.items.length;
    if (!page.items.length) break;
    rows.push(...page.items.map(normalizeProfile));
    console.log(`[sbprofile] ${region.label} ${rows.length}/${total}행 수집`);
    await sleep(200);
  }
  if (rows.length !== total) {
    throw new Error(`${region.label} 수집 건수 불일치: expected ${total}, received ${rows.length}`);
  }
  const kept = rows.filter((row) => row.area.startsWith(region.bizAreaNm));
  if (kept.length !== rows.length) {
    console.log(`[sbprofile] ${region.label} 지역명 불일치 ${rows.length - kept.length}행 제외`);
  }
  if (!kept.length) throw new Error(`${region.label} 수집 결과가 비었습니다.`);
  return kept;
}

const regions = {};
let months = [];

for (const region of SB_REGIONS) {
  const rows = await collect(region);
  const summary = summarizeByMonth(rows);
  regions[region.id] = { label: region.label, bizAreaNm: region.bizAreaNm, ...summary };
  months = [...new Set([...months, ...summary.months])].sort((a, b) => b.localeCompare(a));
}

const donggu = regions.donggu;
const latest = months[0];
if (!latest) throw new Error("기준년월을 찾지 못했습니다.");
if (!donggu?.byMonth?.[latest]?.total) throw new Error(`최신 기준월 ${latest}에 동구 자료가 없습니다.`);

const payload = {
  meta: {
    source: "금융위원회 개인사업자기본정보(개인사업자개요정보조회)",
    collectedAt: new Date().toISOString(),
    latestMonth: latest,
    months,
    note: "정책금융기관 거래 개인사업자를 익명처리한 자료로, 지역 전체 개인사업자 수와 다릅니다."
  },
  regions
};

await mkdir(dirname(outputPath), { recursive: true });
await writeFile(tempPath, `${JSON.stringify(payload)}\n`, "utf8");
await rename(tempPath, outputPath);
console.log(`[sbprofile] 기준월 ${months.join(", ")} · 동구 ${donggu.byMonth[latest].total}명 → ${outputPath}`);
