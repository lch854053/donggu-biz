import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { setDefaultResultOrder } from "node:dns";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  compactLicense,
  deduplicateLicenseStores,
  latestSourceTimestamp,
  licenseStatusKind,
  LOCALDATA_SOURCES,
  LOCALDATA_STATUS_CODES,
  statusCodeFor
} from "../lib/store-license.js";
import { fetchLocaldataSource } from "../lib/localdata-client.js";
import { createLicenseAdminDongResolver } from "../lib/license-admin-dong.js";
import { createAdminDongLookup } from "../lib/admin-dong.js";
import {
  assertClosureSnapshotHealthy,
  closureRates,
  closureYear,
  licenseDateParts,
  summarizeClosures
} from "../lib/store-closure.js";

const DEFAULT_SINCE_YEAR = 2016;
const COLLECTED_STATUSES = Object.freeze([
  { kind: "closed", code: LOCALDATA_STATUS_CODES.closed, label: "폐업" },
  { kind: "suspended", code: LOCALDATA_STATUS_CODES.suspended, label: "휴업" }
]);

const localdataKey = process.env.LOCALDATA_SERVICE_KEY;
if (!localdataKey) throw new Error("LOCALDATA_SERVICE_KEY 환경변수가 필요합니다.");

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const storesPath = resolve(root, "data/stores_donggu.json");
const outputPath = resolve(root, "data/closed_licenses_donggu.json");
const tempPath = resolve(root, "data/.closed-licenses-donggu.tmp");

setDefaultResultOrder("ipv4first");

function parseArgs(argv) {
  const args = { sinceYear: DEFAULT_SINCE_YEAR, statuses: COLLECTED_STATUSES.map(({ kind }) => kind) };
  for (const argument of argv) {
    const [flag, value = ""] = argument.split("=");
    if (flag === "--since") {
      const year = Number(value);
      if (!Number.isInteger(year) || year < 1960) throw new Error(`--since 값이 올바르지 않습니다: ${value}`);
      args.sinceYear = year;
    } else if (flag === "--statuses") {
      const statuses = value.split(",").map((entry) => entry.trim()).filter(Boolean);
      const unknown = statuses.filter((status) => !COLLECTED_STATUSES.some(({ kind }) => kind === status));
      if (!statuses.length || unknown.length) throw new Error(`--statuses 값이 올바르지 않습니다: ${value}`);
      args.statuses = statuses;
    } else if (flag) {
      throw new Error(`알 수 없는 인자입니다: ${flag}`);
    }
  }
  return args;
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

// 폐업 이력은 누적 자료라 기준 연도로 잘라야 스냅샷 크기와 분석 구간이 함께 안정된다.
function withinRange(license, sinceYear) {
  if (license.statusKind !== "closed") return true;
  const year = closureYear(license);
  return year === null ? true : year >= sinceYear;
}

function compactClosedLicense(license) {
  return {
    id: license.id,
    sourceSlug: license.sourceSlug,
    sourceDatasetId: license.sourceDatasetId,
    licenseId: license.licenseId,
    name: license.name,
    largeCode: license.largeCode,
    largeName: license.largeName,
    middleCode: license.middleCode,
    middleName: license.middleName,
    smallName: license.smallName,
    licenseType: license.licenseType,
    adminDong: license.adminDong,
    address: license.address,
    lotAddress: license.lotAddress,
    longitude: license.longitude,
    latitude: license.latitude,
    statusKind: license.statusKind,
    statusCode: license.statusCode,
    statusName: license.statusName,
    detailStatusName: license.detailStatusName,
    licenseDate: license.licenseDate,
    closedDate: license.closedDate,
    lastModifiedAt: license.lastModifiedAt
  };
}

const args = parseArgs(process.argv.slice(2));
const statuses = COLLECTED_STATUSES.filter(({ kind }) => args.statuses.includes(kind));

let storesPayload;
try {
  storesPayload = JSON.parse(await readFile(storesPath, "utf8"));
} catch (error) {
  throw new Error(`data/stores_donggu.json이 필요합니다. 먼저 npm run update-stores를 실행하세요: ${error.message}`);
}
const activeStores = storesPayload.stores || [];
const adminDongForLicense = createLicenseAdminDongResolver(activeStores, await loadAdminDongLookup());

const collected = [];
const sourceReports = [];
for (const source of LOCALDATA_SOURCES) {
  const report = {
    datasetId: source.datasetId,
    slug: source.slug,
    title: source.title,
    endpoint: source.endpoint,
    counts: {},
    sourceUpdatedAt: ""
  };
  for (const status of statuses) {
    const statusCode = statusCodeFor(source, status.kind);
    if (!statusCode) continue; // 이 원천에는 해당 상태 코드가 없다(모범음식점은 휴업 코드가 없다).
    const result = await fetchLocaldataSource(source, { serviceKey: localdataKey, statusCode });
    if (result.error) {
      report.error = result.error.message;
      report.errorCode = result.error.code;
      continue;
    }
    report.counts[status.kind] = result.totalCount;
    const licenses = result.items
      .filter((item) => licenseStatusKind(item, source) === status.kind)
      .map((item) => {
        const compacted = compactLicense(item, source);
        return {
          ...compacted,
          statusKind: status.kind,
          adminDong: adminDongForLicense(compacted.address || compacted.lotAddress, compacted)
        };
      });
    const timestamp = latestSourceTimestamp(licenses);
    if (timestamp > report.sourceUpdatedAt) report.sourceUpdatedAt = timestamp;
    collected.push(...licenses);
    console.log(`[closures:${source.slug}] ${status.label} ${licenses.length}/${result.totalCount}건`);
  }
  sourceReports.push(report);
}

const inRange = collected.filter((license) => withinRange(license, args.sinceYear));
const deduplicated = deduplicateLicenseStores(inRange)
  .map(compactClosedLicense)
  .sort((left, right) => String(right.closedDate).localeCompare(String(left.closedDate))
    || left.id.localeCompare(right.id));

let previousPayload = null;
try {
  previousPayload = JSON.parse(await readFile(outputPath, "utf8"));
} catch (error) {
  if (error?.code !== "ENOENT") throw new Error(`기존 폐업 스냅샷을 읽을 수 없습니다: ${error.message}`);
}
assertClosureSnapshotHealthy({
  totalCount: deduplicated.length,
  previousCount: Number(previousPayload?.meta?.totalCount)
});

const closedRows = deduplicated.filter((license) => license.statusKind === "closed");
const unavailableSources = sourceReports.filter((report) => report.error);
const payload = {
  meta: {
    generatedAt: new Date().toISOString(),
    source: "행정안전부 지방행정 인허가 데이터(폐업·휴업)",
    adminCode: "5805000",
    sinceYear: args.sinceYear,
    statuses: statuses.map(({ kind, code, label }) => ({ kind, code, label })),
    rawCount: collected.length,
    inRangeCount: inRange.length,
    duplicatesRemoved: inRange.length - deduplicated.length,
    totalCount: deduplicated.length,
    activeStoreCount: activeStores.length,
    activeStoreSnapshotMonth: String(storesPayload?.meta?.standardMonth || ""),
    unavailableSourceCount: unavailableSources.length,
    sources: sourceReports
  },
  summary: summarizeClosures(deduplicated),
  closureRates: {
    // 영업 중 스냅샷과 폐업 이력의 원천·기준일이 달라 지역 간 비교용 참고 지표로만 쓴다.
    note: "영업 중 상가 스냅샷(소상공인시장진흥공단+인허가)과 인허가 폐업 이력을 합쳐 계산한 참고 지표입니다.",
    byAdminDong: closureRates(activeStores, closedRows, (row) => row.adminDong),
    byLargeName: closureRates(activeStores, closedRows, (row) => row.largeName)
  },
  licenses: deduplicated
};

await mkdir(dirname(outputPath), { recursive: true });
await writeFile(tempPath, `${JSON.stringify(payload)}\n`, "utf8");
await rename(tempPath, outputPath);

const oldestClosure = closedRows
  .map((license) => licenseDateParts(license.closedDate)?.year)
  .filter(Boolean)
  .sort((left, right) => left - right)[0];
console.log(`[closures] wrote ${deduplicated.length} rows (${closedRows.length} closed since ${oldestClosure || args.sinceYear}) to ${outputPath}`);
if (unavailableSources.length) {
  console.warn(`[closures] ${unavailableSources.length} sources unavailable: ${unavailableSources.map((report) => report.slug).join(", ")}`);
}
