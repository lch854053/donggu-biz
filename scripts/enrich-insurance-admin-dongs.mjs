import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  adminDongForAddress,
  createAdminDongLookup,
  normalizeAddressLookupKey,
  normalizeAdminDongName
} from "../lib/admin-dong.js";

const API_URL = "https://business.juso.go.kr/addrlink/addrLinkApi.do";
const MAX_RETRIES = 4;
const CONCURRENCY = 5;
const REQUEST_TIMEOUT_MS = 10000;
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const employmentPath = resolve(root, "data/employment_insurance_donggu.json");
const npsPath = resolve(root, "data/nps_donggu.json");
const lookupPath = resolve(root, "data/insurance_admin_dongs.json");
const tempLookupPath = resolve(root, "data/.insurance-admin-dongs.tmp");
const tempEmploymentPath = resolve(root, "data/.employment-insurance-admin-dongs.tmp");
const tempNpsPath = resolve(root, "data/.nps-admin-dongs.tmp");
const apiKey = String(process.env.JUSO_API_KEY || "").trim();

const sleep = (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms));

async function readJson(path, fallback = null) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT" && fallback !== null) return fallback;
    throw error;
  }
}

function comparableAddress(value) {
  return normalizeAddressLookupKey(value)
    .replace(/\s+(?:지하\s*)?\d+층(?:\s+\d+호)?$/g, "")
    .replace(/,.*$/g, "")
    .trim();
}

function candidateAdminDong(rows, totalCount, address) {
  const candidates = rows
    .map((row) => ({
      ...row,
      adminDong: normalizeAdminDongName(row.hemdNm)
    }))
    .filter((row) => row.adminDong && row.sggNm === "동구");
  if (!candidates.length) return null;

  const input = comparableAddress(address);
  const exact = candidates.filter((row) => [row.roadAddrPart1, row.roadAddr, row.jibunAddr]
    .some((candidate) => comparableAddress(candidate) === input));
  const exactDongs = [...new Set(exact.map((row) => row.adminDong))];
  if (exactDongs.length === 1) return exact[0];

  const candidateDongs = [...new Set(candidates.map((row) => row.adminDong))];
  if (Number(totalCount) <= candidates.length && candidateDongs.length === 1) return candidates[0];
  return null;
}

async function requestAddress(address) {
  if (!apiKey) throw new Error("JUSO_API_KEY 환경변수가 필요합니다.");
  let lastError;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt += 1) {
    try {
      const body = new URLSearchParams({
        confmKey: apiKey,
        currentPage: "1",
        countPerPage: "100",
        keyword: address,
        resultType: "json",
        addInfoYn: "Y"
      });
      const response = await fetch(API_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const payload = await response.json();
      const common = payload?.results?.common || {};
      if (["E0006", "E0008"].includes(common.errorCode)) {
        return { address, adminDong: "", matchedAddress: "", admCd: "" };
      }
      if (common.errorCode !== "0") throw new Error(`${common.errorCode}: ${common.errorMessage}`);
      const row = candidateAdminDong(payload?.results?.juso || [], common.totalCount, address);
      return row ? {
        address,
        adminDong: row.adminDong,
        matchedAddress: row.roadAddrPart1 || row.roadAddr || row.jibunAddr || "",
        admCd: row.admCd || ""
      } : { address, adminDong: "", matchedAddress: "", admCd: "" };
    } catch (error) {
      lastError = error;
      if (attempt < MAX_RETRIES) await sleep(250 * 2 ** (attempt - 1));
    }
  }
  throw new Error(`${address}: ${lastError?.message || "주소 조회 실패"}`);
}

async function runPool(items, worker, concurrency) {
  const results = new Array(items.length);
  let next = 0;
  let done = 0;
  async function runner() {
    while (next < items.length) {
      const index = next++;
      results[index] = await worker(items[index]);
      done += 1;
      if (done % 100 === 0 || done === items.length) console.log(`[admin-dong] ${done}/${items.length}`);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, runner));
  return results;
}

const [employment, nps, existingLookup] = await Promise.all([
  readJson(employmentPath),
  readJson(npsPath),
  readJson(lookupPath, { items: [] })
]);
const existingByAddress = new Map((existingLookup.items || [])
  .map((item) => [normalizeAddressLookupKey(item.address), item])
  .filter(([address]) => address));
const addresses = [...new Set([...employment.items, ...nps.items]
  .map((item) => normalizeAddressLookupKey(item.address))
  .filter(Boolean))];
const missingAddresses = addresses.filter((address) => !existingByAddress.has(address));
if (missingAddresses.length && !apiKey) {
  throw new Error(`주소 ${missingAddresses.length}건을 보강하려면 JUSO_API_KEY 환경변수가 필요합니다.`);
}

const fetched = await runPool(missingAddresses, async (address) => {
  try {
    return await requestAddress(address);
  } catch (error) {
    console.warn(`[admin-dong] ${error.message}`);
    return null;
  }
}, CONCURRENCY);
const lookupItems = [...existingByAddress.values(), ...fetched.filter(Boolean)]
  .sort((left, right) => left.address.localeCompare(right.address, "ko"));
const lookup = createAdminDongLookup({ items: lookupItems });
const applyAdminDong = (item) => ({ ...item, adminDong: adminDongForAddress(item.address, lookup) });
employment.items = employment.items.map(applyAdminDong);
nps.items = nps.items.map(applyAdminDong);
employment.quality = {
  ...employment.quality,
  adminDongMatched: employment.items.filter((item) => item.adminDong).length,
  adminDongMissing: employment.items.filter((item) => !item.adminDong).length
};
nps.adminDongMatchedCount = nps.items.filter((item) => item.adminDong).length;
nps.adminDongMissingCount = nps.items.filter((item) => !item.adminDong).length;

const lookupPayload = {
  meta: {
    source: "도로명주소 검색 API",
    generatedAt: new Date().toISOString(),
    addressCount: lookupItems.length,
    matchedCount: lookupItems.filter((item) => item.adminDong).length,
    unmatchedCount: lookupItems.filter((item) => !item.adminDong).length
  },
  items: lookupItems
};

await mkdir(dirname(lookupPath), { recursive: true });
await Promise.all([
  writeFile(tempLookupPath, `${JSON.stringify(lookupPayload)}\n`, "utf8"),
  writeFile(tempEmploymentPath, `${JSON.stringify(employment)}\n`, "utf8"),
  writeFile(tempNpsPath, `${JSON.stringify(nps)}\n`, "utf8")
]);
await Promise.all([
  rename(tempLookupPath, lookupPath),
  rename(tempEmploymentPath, employmentPath),
  rename(tempNpsPath, npsPath)
]);
console.log(`[admin-dong] matched ${lookupPayload.meta.matchedCount}/${lookupPayload.meta.addressCount} unique addresses`);
