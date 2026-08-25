import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildCorporatePilotCandidates,
  corporateNameQueries,
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
  return {
    businessRegistrationNumber: candidate.businessRegistrationNumber,
    sourceNames: candidate.names,
    searchedNames: queries,
    candidateCount: apiItems.length,
    ...resolution
  };
}

const employmentSnapshot = JSON.parse(await readFile(inputPath, "utf8"));
const allCandidates = buildCorporatePilotCandidates(employmentSnapshot.items || []);
const candidates = limit ? allCandidates.slice(0, limit) : allCandidates;
const results = [];

for (let offset = 0; offset < candidates.length; offset += CONCURRENCY) {
  const batch = candidates.slice(offset, offset + CONCURRENCY);
  results.push(...await Promise.all(batch.map(matchCandidate)));
  const completed = Math.min(offset + batch.length, candidates.length);
  if (completed % 100 < CONCURRENCY || completed === candidates.length) {
    const matched = results.filter((result) => result.status === "matched").length;
    console.log(`[corporate-matches] ${completed}/${candidates.length} 처리, ${matched}개 매칭, API ${apiQueryCount}회`);
  }
  await sleep(PAUSE_MS);
}

const counts = Object.fromEntries(["matched", "unmatched", "ambiguous"]
  .map((status) => [status, results.filter((result) => result.status === status).length]));
if (!results.length || !counts.matched) throw new Error("확정된 법인 매칭이 없어 스냅샷을 쓰지 않습니다.");
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

await mkdir(dirname(outputPath), { recursive: true });
await writeFile(tempPath, `${JSON.stringify(snapshot)}\n`, "utf8");
await rename(tempPath, outputPath);
console.log(`[corporate-matches] 확정 ${counts.matched}, 미확정 ${counts.unmatched}, 모호 ${counts.ambiguous} → data/corporate_matches_donggu.json`);
