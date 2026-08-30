import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { compactStore, countBy } from "../lib/market.js";
import { assertSnapshotHealthy } from "../lib/store-update.js";
import {
  deduplicateBaseStores,
  deduplicateStoreSources,
  distanceMeters,
  compactLicense,
  isActiveLicense,
  latestSourceTimestamp,
  LOCALDATA_ADMIN_CODE,
  LOCALDATA_PAGE_SIZE,
  LOCALDATA_SOURCES,
  mergeStoreSources,
  parseLocaldataResponse
} from "../lib/store-license.js";
import { adminDongForAddress, createAdminDongLookup, normalizeAdminDongName } from "../lib/admin-dong.js";
import { enrichStoreAddresses } from "../lib/kakao-local.js";

const API_URL = "https://apis.data.go.kr/B553077/api/open/sdsc2/storeListInDong";
const SIGNGU_CODE = "12210";
const PAGE_SIZE = 1000;
const MAX_RETRIES = 3;
const LOCALDATA_MAX_RETRIES = 3;
const LOCALDATA_REQUEST_PAUSE_MS = 120;
const key = process.env.SDSC_SERVICE_KEY;
const localdataKey = process.env.LOCALDATA_SERVICE_KEY;
const kakaoKey = process.env.KAKAO_REST_API_KEY;

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

async function fetchLocaldataPage(source, pageNo) {
  const url = new URL(source.endpoint);
  url.search = new URLSearchParams({
    serviceKey: localdataKey,
    pageNo: String(pageNo),
    numOfRows: String(LOCALDATA_PAGE_SIZE),
    returnType: "json",
    "cond[OPN_ATMY_GRP_CD::EQ]": LOCALDATA_ADMIN_CODE,
    "cond[SALS_STTS_CD::EQ]": "01"
  }).toString();

  for (let attempt = 1; attempt <= LOCALDATA_MAX_RETRIES; attempt += 1) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(30000) });
      const text = await response.text();
      let payload;
      try {
        payload = JSON.parse(text);
      } catch {
        throw new Error(`HTTP ${response.status}: JSON 응답이 아닙니다.`);
      }
      if (!response.ok) {
        const serviceError = payload?.OpenAPI_ServiceResponse?.cmmMsgHeader || {};
        const error = new Error(serviceError.errMsg || `HTTP ${response.status}`);
        error.code = String(serviceError.returnReasonCode || "");
        error.authorization = error.code === "30";
        throw error;
      }
      return parseLocaldataResponse(payload);
    } catch (error) {
      if (error.authorization || attempt === LOCALDATA_MAX_RETRIES) throw error;
      await sleep(attempt * 1000);
    }
  }
}

async function fetchLocaldataSource(source) {
  let first;
  try {
    first = await fetchLocaldataPage(source, 1);
  } catch (error) {
    if (!error.authorization) throw error;
    console.warn(`[localdata:${source.slug}] skipped: ${error.message}`);
    return { source, totalCount: null, items: [], error };
  }
  const pageCount = Math.ceil(first.totalCount / LOCALDATA_PAGE_SIZE);
  const items = [...first.items];
  for (let pageNo = 2; pageNo <= pageCount; pageNo += 1) {
    const page = await fetchLocaldataPage(source, pageNo);
    items.push(...page.items);
    console.log(`[localdata:${source.slug}] ${pageNo}/${pageCount} pages, ${items.length}/${first.totalCount} rows`);
    await sleep(LOCALDATA_REQUEST_PAUSE_MS);
  }
  if (items.length !== first.totalCount) {
    throw new Error(`${source.slug} 수집 건수 불일치: expected ${first.totalCount}, received ${items.length}`);
  }
  return { source, totalCount: first.totalCount, items };
}

function legalDongNames(address) {
  return [...new Set(String(address || "").match(/[가-힣]+동/g) || [])];
}

async function createLicenseAdminDongResolver(baseStores) {
  let addressLookup = new Map();
  try {
    const lookupPath = resolve(root, "data/insurance_admin_dongs.json");
    addressLookup = createAdminDongLookup(JSON.parse(await readFile(lookupPath, "utf8")));
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }

  const storesByLegalDong = new Map();
  for (const store of baseStores) {
    if (!store.legalDong || !store.adminDong) continue;
    if (!storesByLegalDong.has(store.legalDong)) storesByLegalDong.set(store.legalDong, []);
    storesByLegalDong.get(store.legalDong).push(store);
  }

  return (address, coordinates) => {
    const explicit = normalizeAdminDongName(String(address || "").replace(/[(),]/g, " "));
    if (explicit) return explicit;
    const known = adminDongForAddress(address, addressLookup);
    if (known) return known;

    const legalStores = legalDongNames(address).flatMap((name) => storesByLegalDong.get(name) || []);
    const nearestLegalStore = legalStores
      .filter((store) => Number.isFinite(store.longitude) && Number.isFinite(store.latitude))
      .map((store) => ({ store, distance: distanceMeters(coordinates, store) }))
      .sort((left, right) => left.distance - right.distance)[0];
    if (nearestLegalStore && nearestLegalStore.distance <= 250) return nearestLegalStore.store.adminDong;

    const nearestStore = baseStores
      .filter((store) => Number.isFinite(store.longitude) && Number.isFinite(store.latitude))
      .map((store) => ({ store, distance: distanceMeters(coordinates, store) }))
      .sort((left, right) => left.distance - right.distance)[0];
    return nearestStore && nearestStore.distance <= 120 ? nearestStore.store.adminDong : "";
  };
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
if (localdataKey) {
  const adminDongForLicense = await createLicenseAdminDongResolver(uniqueBaseStores);
  const localdataResults = [];
  for (const source of LOCALDATA_SOURCES) {
    const result = await fetchLocaldataSource(source);
    const activeItems = result.items.filter(isActiveLicense);
    const licenses = activeItems.map((item) => {
      const compacted = compactLicense(item, source);
      return {
        ...compacted,
        adminDong: adminDongForLicense(compacted.address || compacted.lotAddress, compacted)
      };
    });
    localdataResults.push({ ...result, activeItems, licenses });
  }
  const merged = mergeStoreSources(uniqueBaseStores, localdataResults.flatMap(({ licenses }) => licenses));
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
    sources: localdataResults.map(({ source, totalCount, activeItems, licenses, error }) => ({
      datasetId: source.datasetId,
      slug: source.slug,
      title: source.title,
      endpoint: source.endpoint,
      sourceCount: totalCount,
      activeCount: activeItems.length,
      sourceUpdatedAt: latestSourceTimestamp(licenses),
      ...(error ? { error: error.message, errorCode: error.code } : {})
    }))
  };
  const unavailableCount = localdataResults.filter((result) => result.error).length;
  console.log(`[localdata] ${comparison.uniqueLicenseCount} unique active licenses, ${comparison.addedWithCoordinatesCount} stores added${unavailableCount ? `, ${unavailableCount} sources unavailable` : ""}`);
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
