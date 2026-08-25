import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { validFinancialStatements } from "../lib/corporate-financials.js";

const API_URL = "https://apis.data.go.kr/1160100/service/GetFinaStatInfoService_V2/getSummFinaStat_V2";
const MAX_RETRIES = 4;
const REQUEST_TIMEOUT_MS = 20000;
const CONCURRENCY = 4;
const PAUSE_MS = 80;

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

const yearsArgument = process.argv.find((value) => value.startsWith("--years="));
const currentYear = new Date().getUTCFullYear();
const years = yearsArgument
  ? yearsArgument.slice("--years=".length).split(",").map((value) => value.trim())
  : [currentYear - 3, currentYear - 2, currentYear - 1].map(String);
if (!years.length || years.some((year) => !/^\d{4}$/.test(year))) {
  throw new Error("--years는 쉼표로 구분한 4자리 연도여야 합니다.");
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const inputPath = resolve(root, "data/corporate_matches_donggu.json");
const outputPath = resolve(root, "data/corporate_financials_donggu.json");
const tempPath = resolve(root, "data/.corporate-financials-donggu.tmp");
const sleep = (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms));

let apiQueryCount = 0;
async function fetchStatements(corporateRegistrationNumber, businessYear) {
  const url = new URL(API_URL);
  url.searchParams.set("serviceKey", apiKey);
  url.searchParams.set("pageNo", "1");
  url.searchParams.set("numOfRows", "10");
  url.searchParams.set("resultType", "json");
  url.searchParams.set("crno", corporateRegistrationNumber);
  url.searchParams.set("bizYear", businessYear);

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt += 1) {
    try {
      apiQueryCount += 1;
      const response = await fetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      const text = await response.text();
      if (!response.ok) throw new Error(`HTTP ${response.status}: ${text.slice(0, 200)}`);
      const payload = JSON.parse(text);
      const code = String(payload?.response?.header?.resultCode || "");
      if (code !== "00") throw new Error(`${code}: ${payload?.response?.header?.resultMsg || "API 오류"}`);
      const rawItems = payload?.response?.body?.items?.item;
      const items = Array.isArray(rawItems) ? rawItems : rawItems ? [rawItems] : [];
      return validFinancialStatements(items, corporateRegistrationNumber, businessYear);
    } catch (error) {
      if (attempt === MAX_RETRIES) throw error;
      const wait = Math.min(10000, 500 * 2 ** attempt);
      console.warn(`[corporate-financials] ${corporateRegistrationNumber}/${businessYear} 실패 ${attempt}/${MAX_RETRIES}: ${error.message}`);
      await sleep(wait);
    }
  }
}

const matchSnapshot = JSON.parse(await readFile(inputPath, "utf8"));
const matches = matchSnapshot.matches.filter((item) => ["matched", "address-matched", "manual"].includes(item.status));
const companies = [];
let completed = 0;

for (let offset = 0; offset < matches.length; offset += CONCURRENCY) {
  const batch = matches.slice(offset, offset + CONCURRENCY);
  const collected = await Promise.all(batch.map(async (match) => {
    const statements = [];
    for (const year of years) {
      statements.push(...await fetchStatements(match.company.corporateRegistrationNumber, year));
      await sleep(PAUSE_MS);
    }
    if (!statements.length) return null;
    return {
      businessRegistrationNumber: match.businessRegistrationNumber,
      corporateRegistrationNumber: match.company.corporateRegistrationNumber,
      name: match.company.name,
      statements
    };
  }));
  companies.push(...collected.filter(Boolean));
  completed += batch.length;
  if (completed % 50 < CONCURRENCY || completed === matches.length) {
    console.log(`[corporate-financials] ${completed}/${matches.length} 처리, 재무자료 ${companies.length}개 법인, API ${apiQueryCount}회`);
  }
  await sleep(PAUSE_MS);
}

if (!companies.length) throw new Error("수집된 재무정보가 없어 스냅샷을 쓰지 않습니다.");
if (new Set(companies.map((company) => company.corporateRegistrationNumber)).size !== companies.length) {
  throw new Error("재무정보 결과에 법인등록번호 중복이 있습니다.");
}

const statementCountsByYear = Object.fromEntries(years.map((year) => [year, companies
  .filter((company) => company.statements.some((statement) => statement.businessYear === year)).length]));
const snapshot = {
  meta: {
    source: "금융위원회_기업 재무정보",
    collectedAt: new Date().toISOString(),
    region: matchSnapshot.meta?.region || "광주광역시 동구",
    corporateMatchCollectedAt: matchSnapshot.meta?.collectedAt || "",
    years,
    matchedCorporateCount: matches.length,
    financialCorporateCount: companies.length,
    noFinancialDataCount: matches.length - companies.length,
    apiQueryCount,
    statementCountsByYear
  },
  companies: companies.sort((left, right) => left.businessRegistrationNumber.localeCompare(right.businessRegistrationNumber))
};

await mkdir(dirname(outputPath), { recursive: true });
await writeFile(tempPath, `${JSON.stringify(snapshot)}\n`, "utf8");
await rename(tempPath, outputPath);
console.log(`[corporate-financials] ${companies.length}/${matches.length}개 법인 저장 → data/corporate_financials_donggu.json`);
