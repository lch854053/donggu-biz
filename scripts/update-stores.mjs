import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { setDefaultResultOrder } from "node:dns";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { compactStore, countBy } from "../lib/market.js";
import { assertSnapshotHealthy } from "../lib/store-update.js";
import {
  deduplicateBaseStores,
  deduplicateStoreSources,
  compactLicense,
  isActiveLicense,
  latestSourceTimestamp,
  LOCALDATA_SOURCES,
  statusCodeFor,
  mergeStoreSources
} from "../lib/store-license.js";
import { fetchLocaldataSource } from "../lib/localdata-client.js";
import { createLicenseAdminDongResolver } from "../lib/license-admin-dong.js";
import { createAdminDongLookup } from "../lib/admin-dong.js";
import { enrichStoreAddresses } from "../lib/kakao-local.js";
import {
  BROKER_STATUS_ACTIVE,
  fetchAddressCoordinate,
  fetchBrokerOffices,
  GWANGJU_DONGGU_LD_CODE,
  normalizeBrokerOffice
} from "../lib/broker-offices.js";

const API_URL = "https://apis.data.go.kr/B553077/api/open/sdsc2/storeListInDong";
const SIGNGU_CODE = "12210";
const PAGE_SIZE = 1000;
const MAX_RETRIES = 6;
const MAX_RETRY_WAIT_MS = 30000;
const REQUEST_TIMEOUT_MS = 20000;
const key = process.env.SDSC_SERVICE_KEY;
const localdataKey = process.env.LOCALDATA_SERVICE_KEY;
const kakaoKey = process.env.KAKAO_REST_API_KEY;
const vworldKey = process.env.VWORLD_KEY;
const vworldDomain = process.env.VWORLD_DOMAIN || "https://donggu-biz.vercel.app";
const GEOCODE_PAUSE_MS = 120;

if (!key) throw new Error("SDSC_SERVICE_KEY 환경변수가 필요합니다.");

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outputPath = resolve(root, "data/stores_donggu.json");
const tempPath = resolve(root, "data/.stores-donggu.tmp");

const sleep = (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms));

setDefaultResultOrder("ipv4first");

function retryWait(attempt) {
  return Math.min(MAX_RETRY_WAIT_MS, 1000 * 2 ** attempt);
}

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
      const response = await fetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      if (data?.header?.resultCode !== "00") {
        throw new Error(`${data?.header?.resultCode}: ${data?.header?.resultMsg}`);
      }
      return data;
    } catch (error) {
      if (attempt === MAX_RETRIES) {
        throw new Error(`[stores] ${pageNo}페이지 요청 실패: ${error.message}`, { cause: error });
      }
      const wait = retryWait(attempt);
      console.warn(`[stores] ${pageNo}페이지 요청 실패 ${attempt}/${MAX_RETRIES} (${error.message}), ${wait / 1000}초 뒤 다시 시도합니다.`);
      await sleep(wait);
    }
  }
}

async function loadAdminDongLookup() {
  try {
    const lookupPath = resolve(root, "data/insurance_admin_dongs.json");
    return createAdminDongLookup(JSON.parse(await readFile(lookupPath, "utf8")));
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    return new Map();
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
const baseStores = sourceItems
  .filter((item) => item.signguCd === SIGNGU_CODE)
  .map(compactStore)
  .filter((store) => {
    if (!store.id || seen.has(store.id)) return false;
    seen.add(store.id);
    return Number.isFinite(store.longitude) && Number.isFinite(store.latitude);
  })
  .sort((a, b) => a.id.localeCompare(b.id));
const uniqueBaseStores = deduplicateBaseStores(baseStores);
const baseDuplicateCount = baseStores.length - uniqueBaseStores.length;

let stores = uniqueBaseStores;
let supplementalMeta = null;
let postMergeDeduplication = null;
let kakaoAddressMeta = null;
const adminDongForLicense = createLicenseAdminDongResolver(uniqueBaseStores, await loadAdminDongLookup());
const supplementalLicenses = [];
const extraSources = [];
if (localdataKey) {
  const localdataResults = [];
  for (const source of LOCALDATA_SOURCES) {
    const result = await fetchLocaldataSource(source, {
      serviceKey: localdataKey,
      statusCode: statusCodeFor(source, "active")
    });
    const activeItems = result.items.filter((item) => isActiveLicense(item, source));
    const licenses = activeItems.map((item) => {
      const compacted = compactLicense(item, source);
      return {
        ...compacted,
        adminDong: adminDongForLicense(compacted.address || compacted.lotAddress, compacted)
      };
    });
    localdataResults.push({ ...result, activeItems, licenses });
  }
  supplementalLicenses.push(...localdataResults.flatMap(({ licenses }) => licenses));
  extraSources.push(...localdataResults.map(({ source, totalCount, activeItems, licenses, error }) => ({
    datasetId: source.datasetId,
    slug: source.slug,
    title: source.title,
    endpoint: source.endpoint,
    sourceCount: totalCount,
    activeCount: activeItems.length,
    sourceUpdatedAt: latestSourceTimestamp(licenses),
    ...(error ? { error: error.message, errorCode: error.code } : {})
  })));
  const unavailableCount = localdataResults.filter((result) => result.error).length;
  console.log(`[localdata] ${unavailableCount ? `${unavailableCount} sources unavailable, ` : ""}${extraSources.length} sources collected`);
}

// VWorld 국가중점데이터API의 부동산중개업정보(국토교통부). 인허가 API와 달리 좌표가
// 없어 카카오 주소 검색으로 좌표를 채운 뒤 같은 병합 파이프라인에 태운다.
if (vworldKey) {
  try {
    const brokerResult = await fetchBrokerOffices({
      key: vworldKey,
      domain: vworldDomain,
      ldCode: GWANGJU_DONGGU_LD_CODE,
      statusCode: BROKER_STATUS_ACTIVE
    });
    const brokerLicenses = brokerResult.offices.map((office) => {
      const license = normalizeBrokerOffice(office);
      license.adminDong = adminDongForLicense(license.address || license.lotAddress, license);
      return license;
    });
    let geocodedCount = 0;
    if (kakaoKey) {
      for (const license of brokerLicenses) {
        const coordinate = await fetchAddressCoordinate(license.address || license.lotAddress, kakaoKey);
        if (coordinate) {
          license.longitude = coordinate.longitude;
          license.latitude = coordinate.latitude;
          geocodedCount += 1;
        }
        await sleep(GEOCODE_PAUSE_MS);
      }
    } else {
      console.warn(`[broker] 좌표 보강을 건너뛴다: KAKAO_REST_API_KEY 환경변수가 없다.`);
    }
    supplementalLicenses.push(...brokerLicenses);
    extraSources.push({
      datasetId: "ned.getEBOfficeInfo",
      slug: "vworld_broker_offices",
      title: "국토교통부_부동산중개업정보(VWorld 국가중점데이터API)",
      endpoint: BROKER_OFFICES_URL,
      sourceCount: brokerResult.totalCount,
      activeCount: brokerLicenses.length,
      sourceUpdatedAt: brokerResult.lastUpdatedAt,
      geocodedCount
    });
    console.log(`[broker] ${brokerLicenses.length} offices (geocoded ${geocodedCount})`);
  } catch (error) {
    console.warn(`[broker] skipped: ${error.message}`);
    extraSources.push({
      datasetId: "ned.getEBOfficeInfo",
      slug: "vworld_broker_offices",
      title: "국토교통부_부동산중개업정보(VWorld 국가중점데이터API)",
      endpoint: BROKER_OFFICES_URL,
      sourceCount: null,
      activeCount: 0,
      sourceUpdatedAt: "",
      error: error.message
    });
  }
}

if (supplementalLicenses.length) {
  const merged = mergeStoreSources(uniqueBaseStores, supplementalLicenses);
  stores = merged.stores.sort((a, b) => a.id.localeCompare(b.id));
  const comparison = merged.comparison;
  supplementalMeta = {
    rawLicenseCount: comparison.rawLicenseCount,
    uniqueLicenseCount: comparison.uniqueLicenseCount,
    matchedCount: comparison.matchedCount,
    addedCount: comparison.addedCount,
    addedWithCoordinatesCount: comparison.addedWithCoordinatesCount,
    addedWithoutCoordinatesCount: comparison.addedWithoutCoordinatesCount,
    matchTypeCounts: comparison.matchTypeCounts,
    bySource: comparison.bySource,
    sources: extraSources
  };
  console.log(`[supplemental] ${comparison.uniqueLicenseCount} unique licenses, ${comparison.addedWithCoordinatesCount} stores added`);
}

const addressCandidates = stores.filter((store) => /[*＊]/.test(`${store.address || ""} ${store.lotAddress || ""}`)
  && Number.isFinite(store.longitude) && Number.isFinite(store.latitude));
if (!kakaoKey && addressCandidates.length) {
  throw new Error(`마스킹 주소 ${addressCandidates.length}건을 보강하려면 KAKAO_REST_API_KEY 환경변수가 필요합니다.`);
}
if (kakaoKey) {
  const enriched = await enrichStoreAddresses(stores, {
    apiKey: kakaoKey,
    onError(error, store) {
      console.warn(`[kakao] ${store.id} ${store.name}: ${error.message}`);
    }
  });
  stores = enriched.stores;
  kakaoAddressMeta = {
    source: "Kakao Local 좌표로 주소 변환",
    generatedAt: new Date().toISOString(),
    ...enriched.stats
  };
  console.log(`[kakao] enriched ${enriched.stats.enrichedCount}/${enriched.stats.candidateCount} stores with ${enriched.stats.requestCount} coordinate requests and ${enriched.stats.keywordRequestCount} keyword fallbacks (${enriched.stats.unresolvedCount} unresolved)`);
}

if (supplementalMeta) {
  const licenseRows = stores.filter((store) => String(store.id || "").startsWith("license:"));
  const deduplicated = deduplicateStoreSources(uniqueBaseStores, licenseRows);
  stores = deduplicated.stores.sort((a, b) => a.id.localeCompare(b.id));
  postMergeDeduplication = {
    baseInputCount: baseStores.length,
    baseOutputCount: deduplicated.baseStores.length,
    baseDuplicatesRemoved: baseDuplicateCount + deduplicated.baseDuplicatesRemoved,
    licenseInputCount: licenseRows.length,
    licenseUniqueCount: deduplicated.licenseStores.length,
    licenseDuplicatesRemoved: deduplicated.licenseDuplicatesRemoved,
    matchedCount: deduplicated.matchedCount,
    outputAddedCount: deduplicated.added.length,
    rowsRemoved: baseDuplicateCount + deduplicated.duplicateRowsRemoved
  };
  supplementalMeta = { ...supplementalMeta, postMergeDeduplication };
}

if (sourceItems.length !== totalCount) {
  throw new Error(`수집 건수 불일치: expected ${totalCount}, received ${sourceItems.length}`);
}
let previousPayload = null;
try {
  previousPayload = JSON.parse(await readFile(outputPath, "utf8"));
} catch (error) {
  if (error?.code !== "ENOENT") throw new Error(`기존 데이터 파일을 읽을 수 없습니다: ${error.message}`);
}
if (!localdataKey && previousPayload?.meta?.supplemental) {
  throw new Error("기존 보완 데이터가 있어 LOCALDATA_SERVICE_KEY가 필요합니다.");
}
const previousCount = Number(previousPayload?.meta?.totalCount);
assertSnapshotHealthy({ totalCount, validCount: stores.length, previousCount });

const payload = {
  meta: {
    standardMonth: String(first.header.stdrYm || ""),
    generatedAt: new Date().toISOString(),
    source: "소상공인시장진흥공단 상가(상권)정보 API",
    signguCode: SIGNGU_CODE,
    totalCount: stores.length,
    sourceTotalCount: totalCount,
    ...(supplementalMeta ? {
      source: "소상공인시장진흥공단 상가정보 + 행정안전부 인허가(영업 중)",
      supplemental: supplementalMeta
    } : {}),
    ...(kakaoAddressMeta ? { kakaoAddressEnrichment: kakaoAddressMeta } : {})
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
    removedRows: sourceItems.length - baseStores.length,
    missingBuildingName: stores.filter((store) => !store.buildingName).length,
    missingFloor: stores.filter((store) => !store.floor).length,
    ...(supplementalMeta ? {
      supplementalAdded: supplementalMeta.addedCount,
      supplementalAddedWithCoordinates: supplementalMeta.addedWithCoordinatesCount,
      supplementalAddedWithoutCoordinates: supplementalMeta.addedWithoutCoordinatesCount
    } : {}),
    ...(kakaoAddressMeta ? {
      kakaoAddressEnriched: kakaoAddressMeta.enrichedCount,
      kakaoAddressEnrichmentFailed: kakaoAddressMeta.failedCount,
      kakaoAddressEnrichmentUnresolved: kakaoAddressMeta.unresolvedCount
    } : {}),
    ...(postMergeDeduplication ? {
      deduplicatedRows: postMergeDeduplication.rowsRemoved,
      supplementalMatchedAfterEnrichment: postMergeDeduplication.matchedCount,
      supplementalOutputAdded: postMergeDeduplication.outputAddedCount
    } : {})
  },
  stores
};

await mkdir(dirname(outputPath), { recursive: true });
await writeFile(tempPath, `${JSON.stringify(payload)}\n`, "utf8");
await rename(tempPath, outputPath);
console.log(`[stores] wrote ${stores.length} stores to ${outputPath}`);
