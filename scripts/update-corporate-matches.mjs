import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  applyManualCorporateOverride,
  buildCorporatePilotCandidates,
  corporateNameQueries,
  resolveCorporateAddressMatch,
  resolveCorporateMatch
} from "../lib/corporate-matches.js";

const API_URL = "https://apis.data.go.kr/1160100/service/GetCorpBasicInfoService_V2/getCorpOutline_V2";
const MAX_RETRIES = 4;
const REQUEST_TIMEOUT_MS = 20000;
const CONCURRENCY = 4;
const PAUSE_MS = 80;
const ROWS_PER_PAGE = 1000;
const MAX_PAGES_PER_QUERY = 10;

function normalizeServiceKey(value) {
  const key = String(value || "").trim();
  if (!key.includes("%")) return key;
  try {
    return decodeURIComponent(key);
  } catch {
    return key;
  }
}

const apiKey = normalizeServiceKey(process.env.FSC_SERVICE_KEY);
if (!apiKey) throw new Error("FSC_SERVICE_KEY 환경변수가 필요합니다.");

const limitArgument = process.argv.find((value) => value.startsWith("--limit="));
const limit = limitArgument ? Number(limitArgument.slice("--limit=".length)) : null;
if (limitArgument && (!Number.isInteger(limit) || limit <= 0)) throw new Error("--limit은 1 이상의 정수여야 합니다.");

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const inputPath = resolve(root, "data/employment_insurance_donggu.json");
const outputPath = resolve(root, "data/corporate_matches_donggu.json");
const tempPath = resolve(root, "data/.corporate-matches-donggu.tmp");
const numbersOutputPath = resolve(root, "data/corporate_numbers_donggu.json");
const numbersTempPath = resolve(root, "data/.corporate-numbers-donggu.tmp");
const overridesPath = resolve(root, "data/corporate_match_overrides.json");
const sleep = (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms));

let apiQueryCount = 0;
async function requestPage(query, pageNo) {
  const url = new URL(API_URL);
  url.searchParams.set("serviceKey", apiKey);
  url.searchParams.set("pageNo", String(pageNo));
  url.searchParams.set("numOfRows", String(ROWS_PER_PAGE));
  url.searchParams.set("resultType", "json");
  url.searchParams.set("corpNm", query);

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt += 1) {
    try {
      apiQueryCount += 1;
      const response = await fetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      const text = await response.text();
      if (!response.ok) throw new Error(`HTTP ${response.status}: ${text.slice(0, 200)}`);
      const payload = JSON.parse(text);
      const code = String(payload?.response?.header?.resultCode || "");
      if (code !== "00") throw new Error(`${code}: ${payload?.response?.header?.resultMsg || "API 오류"}`);
      const body = payload.response.body || {};
      const rawItems = body.items?.item;
      const items = Array.isArray(rawItems) ? rawItems : rawItems ? [rawItems] : [];
      return { items, totalCount: Number(body.totalCount || 0) };
    } catch (error) {
      if (attempt === MAX_RETRIES) throw error;
      const wait = Math.min(10000, 500 * 2 ** attempt);
      console.warn(`[corporate-matches] ${query} 요청 실패 ${attempt}/${MAX_RETRIES}: ${error.message}`);
      await sleep(wait);
    }
  }
}

async function searchCompany(query) {
  const first = await requestPage(query, 1);
  const items = [...first.items];
  const pageCount = Math.min(MAX_PAGES_PER_QUERY, Math.ceil(first.totalCount / ROWS_PER_PAGE) || 1);
  for (let pageNo = 2; pageNo <= pageCount; pageNo += 1) {
    const page = await requestPage(query, pageNo);
    items.push(...page.items);
    await sleep(PAUSE_MS);
  }
  return items;
}

function uniqueApiItems(items) {
  const records = new Map();
  for (const item of items) {
    const key = [item.crno, item.bzno, item.corpNm, item.enpBsadr, item.lastOpegDt, item.fssCorpChgDtm].join("|");
    records.set(key, item);
  }
  return [...records.values()];
}

async function matchCandidate(candidate) {
  const queries = corporateNameQueries(candidate.names);
  const collected = [];
  let resolution = resolveCorporateMatch(candidate.businessRegistrationNumber, collected);
  for (const query of queries) {
    collected.push(...await searchCompany(query));
    resolution = resolveCorporateMatch(candidate.businessRegistrationNumber, collected);
    if (resolution.status === "matched") break;
    await sleep(PAUSE_MS);
  }
  const apiItems = uniqueApiItems(collected);
  resolution = resolveCorporateMatch(candidate.businessRegistrationNumber, apiItems);
  if (resolution.status === "unmatched") resolution = resolveCorporateAddressMatch(candidate, apiItems);
  const override = overridesByBusinessNumber.get(candidate.businessRegistrationNumber);
  if (override && ["matched", "address-matched"].includes(resolution.status)
    && resolution.company.corporateRegistrationNumber !== override.corporateRegistrationNumber) {
    throw new Error(`자동 매칭과 수동 확정이 충돌합니다: ${candidate.businessRegistrationNumber}`);
  }
  if (override) resolution = applyManualCorporateOverride(candidate, apiItems, override);
  return {
    businessRegistrationNumber: candidate.businessRegistrationNumber,
    sourceNames: candidate.names,
    sourceAddresses: candidate.addresses,
    searchedNames: queries,
    candidateCount: apiItems.length,
    ...resolution
  };
}

const employmentSnapshot = JSON.parse(await readFile(inputPath, "utf8"));
const allCandidates = buildCorporatePilotCandidates(employmentSnapshot.items || []);
let overridePayload = { overrides: [] };
try {
  overridePayload = JSON.parse(await readFile(overridesPath, "utf8"));
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
const overrides = Array.isArray(overridePayload.overrides) ? overridePayload.overrides : [];
const overridesByBusinessNumber = new Map();
for (const override of overrides) {
  const businessNumber = String(override.businessRegistrationNumber || "").replace(/[^0-9]/g, "");
  const corporateNumber = String(override.corporateRegistrationNumber || "").replace(/[^0-9]/g, "");
  if (!/^\d{10}$/.test(businessNumber) || !/^\d{13}$/.test(corporateNumber)) {
    throw new Error("수동 확정 파일의 사업자등록번호 또는 법인등록번호 형식이 올바르지 않습니다.");
  }
  if (!/^https:\/\//.test(String(override.evidenceUrl || ""))) {
    throw new Error(`수동 확정에는 https 공식 근거 URL이 필요합니다: ${businessNumber}`);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(override.reviewedAt || "")) || !String(override.reviewedBy || "").trim()) {
    throw new Error(`수동 확정에는 검토일과 검토자가 필요합니다: ${businessNumber}`);
  }
  if (overridesByBusinessNumber.has(businessNumber)) throw new Error(`수동 확정 사업자번호가 중복됩니다: ${businessNumber}`);
  overridesByBusinessNumber.set(businessNumber, { ...override, businessRegistrationNumber: businessNumber, corporateRegistrationNumber: corporateNumber });
}
const candidateBusinessNumbers = new Set(allCandidates.map((candidate) => candidate.businessRegistrationNumber));
for (const businessNumber of overridesByBusinessNumber.keys()) {
  if (!candidateBusinessNumbers.has(businessNumber)) throw new Error(`수동 확정 대상이 법인 후보에 없습니다: ${businessNumber}`);
}
const candidates = limit ? allCandidates.slice(0, limit) : allCandidates;
const results = [];

for (let offset = 0; offset < candidates.length; offset += CONCURRENCY) {
  const batch = candidates.slice(offset, offset + CONCURRENCY);
  results.push(...await Promise.all(batch.map(matchCandidate)));
  const completed = Math.min(offset + batch.length, candidates.length);
  if (completed % 100 < CONCURRENCY || completed === candidates.length) {
    const confirmed = results.filter((result) => ["matched", "address-matched", "manual"].includes(result.status)).length;
    console.log(`[corporate-matches] ${completed}/${candidates.length} 처리, ${confirmed}개 확정, API ${apiQueryCount}회`);
  }
  await sleep(PAUSE_MS);
}

const counts = Object.fromEntries(["matched", "address-matched", "manual", "unmatched", "ambiguous"]
  .map((status) => [status, results.filter((result) => result.status === status).length]));
if (!results.length || counts.matched + counts["address-matched"] + counts.manual === 0) {
  throw new Error("확정된 법인 매칭이 없어 스냅샷을 쓰지 않습니다.");
}
if (new Set(results.map((result) => result.businessRegistrationNumber)).size !== results.length) {
  throw new Error("파일럿 결과에 사업자등록번호 중복이 있습니다.");
}

const snapshot = {
  meta: {
    source: "금융위원회_기업기본정보",
    sourceUpdatedAt: new Date().toISOString().slice(0, 10),
    collectedAt: new Date().toISOString(),
    region: employmentSnapshot.meta?.region || "광주광역시 동구",
    employmentSourceUpdatedAt: employmentSnapshot.meta?.sourceUpdatedAt || "",
    mode: limit ? "limited-pilot" : "corporate-marker-pilot",
    sourceCandidateCount: allCandidates.length,
    processedCandidateCount: results.length,
    apiQueryCount,
    ...counts
  },
  matches: results.sort((left, right) => left.businessRegistrationNumber.localeCompare(right.businessRegistrationNumber))
};
const confirmedResults = results.filter((result) => ["matched", "address-matched", "manual"].includes(result.status));
const numberSnapshot = {
  meta: {
    source: "금융위원회_기업기본정보",
    collectedAt: snapshot.meta.collectedAt,
    region: snapshot.meta.region,
    totalCount: confirmedResults.length,
    automaticCount: counts.matched,
    addressMatchedCount: counts["address-matched"],
    manualCount: counts.manual
  },
  companies: confirmedResults.map((result) => ({
    businessRegistrationNumber: result.businessRegistrationNumber,
    corporateRegistrationNumber: result.company.corporateRegistrationNumber,
    name: result.company.name,
    matchType: result.status
  })).sort((left, right) => left.businessRegistrationNumber.localeCompare(right.businessRegistrationNumber))
};

await mkdir(dirname(outputPath), { recursive: true });
await writeFile(tempPath, `${JSON.stringify(snapshot)}\n`, "utf8");
await rename(tempPath, outputPath);
await writeFile(numbersTempPath, `${JSON.stringify(numberSnapshot)}\n`, "utf8");
await rename(numbersTempPath, numbersOutputPath);
console.log(`[corporate-matches] 사업자번호 ${counts.matched}, 주소 ${counts["address-matched"]}, 수동 ${counts.manual}, 미확정 ${counts.unmatched}, 모호 ${counts.ambiguous}`);
