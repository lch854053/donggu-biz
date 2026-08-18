// 국민연금 가입 사업장 내역을 지역 단위로 미리 받아 스냅샷으로 저장한다.
// 목록 API에는 업종코드가 없어 사업장마다 상세조회를 한 번 더 부른다. 호출 수가 많으므로
// 화면에서 실시간으로 할 일이 아니라 월 1회 배치로 돌린다.

import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { compactWorkplace, compactWorkplaceDetail, parseNpsBody } from "../lib/nps.js";
import { NPS_MAX_ROWS, NPS_VARIANTS, normalizeServiceKey, npsRequestUrl } from "../lib/nps-request.js";

const REGION = { label: "광주광역시 동구", sido: "29", sggu: "110" };
const MAX_PAGES = 500;
const MAX_RETRIES = 3;
const REQUEST_TIMEOUT_MS = 20000;
const DETAIL_CONCURRENCY = 4;
const DETAIL_PAUSE_MS = 60;

const apiKey = normalizeServiceKey(process.env.NPS_SERVICE_KEY);
if (!apiKey) throw new Error("NPS_SERVICE_KEY 환경변수가 필요합니다.");

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outputPath = resolve(root, "data/nps_donggu.json");
const tempPath = resolve(root, "data/.nps-donggu.tmp");

const sleep = (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms));

/** 본문을 파싱해 돌려준다. 네트워크 오류와 게이트웨이 오류 모두 재시도한다. */
async function request(url) {
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: { Accept: "application/xml, application/json" },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
      });
      const body = await response.text();
      if (!response.ok) throw new Error(`HTTP ${response.status}: ${body.slice(0, 200)}`);
      return parseNpsBody(body);
    } catch (error) {
      if (attempt === MAX_RETRIES) throw error;
      await sleep(attempt * 1000);
    }
  }
}

function searchUrl(pageNo, variant) {
  return npsRequestUrl({
    operation: "getBassInfoSearchV2",
    apiKey,
    params: { pageNo: String(pageNo), numOfRows: String(NPS_MAX_ROWS) },
    region: { sido: REGION.sido, sggu: REGION.sggu, emd: "" },
    variant
  });
}

/** 파라미터 표기·코드 형식 조합 중 실제로 결과가 나오는 것을 첫 페이지로 찾아낸다. */
async function pickVariant() {
  for (const variant of NPS_VARIANTS) {
    const page = await request(searchUrl(1, variant));
    if (page.items.length) return { variant, page };
    console.log(`[nps] ${variant.style}/${variant.region} 조합은 0건, 다음 조합을 시도합니다.`);
  }
  throw new Error("어떤 파라미터 조합으로도 사업장을 찾지 못했습니다.");
}

const { variant, page: firstPage } = await pickVariant();
console.log(`[nps] ${variant.style}/${variant.region} 조합 사용, 전체 ${firstPage.totalCount}건`);

const rawItems = [...firstPage.items];
const pageCount = Math.min(MAX_PAGES, Math.ceil(firstPage.totalCount / NPS_MAX_ROWS) || 1);
for (let pageNo = 2; pageNo <= pageCount; pageNo += 1) {
  const page = await request(searchUrl(pageNo, variant));
  if (!page.items.length) break;
  rawItems.push(...page.items);
  console.log(`[nps] 목록 ${pageNo}/${pageCount} 페이지, ${rawItems.length}/${firstPage.totalCount}건`);
  await sleep(DETAIL_PAUSE_MS);
}

// seq는 상세조회 키다. 같은 사업장이 여러 페이지에 겹쳐 오는 경우를 대비해 한 번만 남긴다.
const workplaces = new Map();
for (const item of rawItems) {
  const workplace = compactWorkplace(item);
  if (workplace.seq && !workplaces.has(workplace.seq)) workplaces.set(workplace.seq, workplace);
}
console.log(`[nps] 사업장 ${workplaces.size}개 수집, 상세조회로 업종을 채웁니다.`);

async function fetchDetail(seq) {
  const url = npsRequestUrl({ operation: "getDetailInfoSearchV2", apiKey, params: { seq }, variant });
  const [item] = (await request(url)).items;
  return item ? compactWorkplaceDetail(item) : null;
}

/** 상세조회를 몇 개씩 나눠 부른다. 실패한 사업장은 목록 정보만 남긴다. */
const seqs = [...workplaces.keys()];
let done = 0;
let failed = 0;
for (let offset = 0; offset < seqs.length; offset += DETAIL_CONCURRENCY) {
  const batch = seqs.slice(offset, offset + DETAIL_CONCURRENCY);
  await Promise.all(batch.map(async (seq) => {
    try {
      const detail = await fetchDetail(seq);
      if (detail) workplaces.set(seq, { ...workplaces.get(seq), ...detail, seq });
    } catch (error) {
      failed += 1;
      console.warn(`[nps] ${seq} 상세조회 실패: ${error.message}`);
    }
  }));
  done += batch.length;
  if (done % 500 < DETAIL_CONCURRENCY) console.log(`[nps] 상세 ${done}/${seqs.length}건`);
  await sleep(DETAIL_PAUSE_MS);
}

const items = [...workplaces.values()];
const withIndustry = items.filter((workplace) => workplace.industryCode).length;
if (!items.length) throw new Error("수집된 사업장이 없어 스냅샷을 쓰지 않습니다.");
if (failed > items.length / 4) throw new Error(`상세조회 실패가 너무 많습니다: ${failed}/${items.length}`);

const snapshot = {
  region: REGION.label,
  sido: REGION.sido,
  sggu: REGION.sggu,
  collectedAt: new Date().toISOString(),
  dataCreatedMonth: items.find((workplace) => workplace.dataCreatedMonth)?.dataCreatedMonth ?? "",
  totalCount: firstPage.totalCount,
  detailFailedCount: failed,
  items
};

await mkdir(dirname(outputPath), { recursive: true });
await writeFile(tempPath, `${JSON.stringify(snapshot)}\n`);
await rename(tempPath, outputPath);
console.log(`[nps] ${items.length}건 저장 완료 (업종 확보 ${withIndustry}건, 상세 실패 ${failed}건) → data/nps_donggu.json`);
