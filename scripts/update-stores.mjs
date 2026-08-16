import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { compactStore, countBy } from "../lib/market.js";
import { assertSnapshotHealthy } from "../lib/store-update.js";

const API_URL = "https://apis.data.go.kr/B553077/api/open/sdsc2/storeListInDong";
const SIGNGU_CODE = "12210";
const PAGE_SIZE = 1000;
const MAX_RETRIES = 3;
const key = process.env.SDSC_SERVICE_KEY;

if (!key) throw new Error("SDSC_SERVICE_KEY 환경변수가 필요합니다.");

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outputPath = resolve(root, "data/stores_donggu.json");
const tempPath = resolve(root, "data/.stores-donggu.tmp");

const sleep = (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms));

async function fetchPage(pageNo) {
  const url = new URL(API_URL);
  url.search = new URLSearchParams({
    serviceKey: key,
    pageNo: String(pageNo),
    numOfRows: String(PAGE_SIZE),
    divId: "signguCd",
    key: SIGNGU_CODE,
    type: "json"
  }).toString();

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt += 1) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(20000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      if (data?.header?.resultCode !== "00") {
        throw new Error(`${data?.header?.resultCode}: ${data?.header?.resultMsg}`);
      }
      return data;
    } catch (error) {
      if (attempt === MAX_RETRIES) throw error;
      await sleep(attempt * 1000);
    }
  }
}

const first = await fetchPage(1);
const totalCount = Number(first.body.totalCount || 0);
const pageCount = Math.ceil(totalCount / PAGE_SIZE);
const sourceItems = [...(first.body.items || [])];

for (let pageNo = 2; pageNo <= pageCount; pageNo += 1) {
  const page = await fetchPage(pageNo);
  sourceItems.push(...(page.body.items || []));
  console.log(`[stores] ${pageNo}/${pageCount} pages, ${sourceItems.length}/${totalCount} rows`);
  await sleep(150);
}

const seen = new Set();
const stores = sourceItems
  .filter((item) => item.signguCd === SIGNGU_CODE)
  .map(compactStore)
  .filter((store) => {
    if (!store.id || seen.has(store.id)) return false;
    seen.add(store.id);
    return Number.isFinite(store.longitude) && Number.isFinite(store.latitude);
  })
  .sort((a, b) => a.id.localeCompare(b.id));

if (sourceItems.length !== totalCount) {
  throw new Error(`수집 건수 불일치: expected ${totalCount}, received ${sourceItems.length}`);
}
let previousCount = null;
try {
  const previous = JSON.parse(await readFile(outputPath, "utf8"));
  previousCount = Number(previous?.meta?.totalCount);
} catch (error) {
  if (error?.code !== "ENOENT") throw new Error(`기존 데이터 파일을 읽을 수 없습니다: ${error.message}`);
}
assertSnapshotHealthy({ totalCount, validCount: stores.length, previousCount });

const payload = {
  meta: {
    standardMonth: String(first.header.stdrYm || ""),
    generatedAt: new Date().toISOString(),
    source: "소상공인시장진흥공단 상가(상권)정보 API",
    signguCode: SIGNGU_CODE,
    totalCount: stores.length,
    sourceTotalCount: totalCount
  },
  dimensions: {
    adminDongs: countBy(stores, "adminDong").map(({ name }) => name),
    largeCategories: countBy(stores, (store) => `${store.largeCode}|${store.largeName}`)
      .map(({ name, count }) => {
        const [code, label] = name.split("|");
        return { code, name: label, count };
      })
  },
  quality: {
    removedRows: sourceItems.length - stores.length,
    missingBuildingName: stores.filter((store) => !store.buildingName).length,
    missingFloor: stores.filter((store) => !store.floor).length
  },
  stores
};

await mkdir(dirname(outputPath), { recursive: true });
await writeFile(tempPath, `${JSON.stringify(payload)}\n`, "utf8");
await rename(tempPath, outputPath);
console.log(`[stores] wrote ${stores.length} stores to ${outputPath}`);
