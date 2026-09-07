import { closureRates, closureYear, licenseLifespanDays } from "./store-closure.js";

export const UNKNOWN_ADMIN_DONG = "미확인";

function clean(value) {
  return String(value ?? "").trim();
}

export function closureFilterOptions(licenses) {
  const rows = licenses || [];
  const years = rows.map(closureYear).filter((year) => Number.isFinite(year));
  return {
    adminDongs: [...new Set(rows.map((row) => clean(row.adminDong)).filter(Boolean))]
      .sort((left, right) => left.localeCompare(right, "ko")),
    largeNames: [...new Set(rows.map((row) => clean(row.largeName)).filter(Boolean))]
      .sort((left, right) => left.localeCompare(right, "ko")),
    minYear: years.length ? Math.min(...years) : null,
    maxYear: years.length ? Math.max(...years) : null
  };
}

// 폐업일자가 없는 행은 연도 조건을 걸면 빠진다. 연도를 비워 두었을 때만 남긴다.
export function filterClosureRows(licenses, filters = {}) {
  const { adminDong = "", largeName = "", fromYear = null, toYear = null, statusKind = "closed" } = filters;
  return (licenses || []).filter((row) => {
    if (statusKind && row.statusKind !== statusKind) return false;
    if (adminDong && clean(row.adminDong) !== adminDong) return false;
    if (largeName && clean(row.largeName) !== largeName) return false;
    if (fromYear === null && toYear === null) return true;
    const year = closureYear(row);
    if (year === null) return false;
    if (fromYear !== null && year < fromYear) return false;
    if (toYear !== null && year > toYear) return false;
    return true;
  });
}

export function closureYearCounts(rows) {
  const counts = new Map();
  for (const row of rows || []) {
    const year = closureYear(row);
    if (year === null) continue;
    counts.set(year, (counts.get(year) || 0) + 1);
  }
  return [...counts.entries()]
    .sort((left, right) => left[0] - right[0])
    .map(([year, count]) => ({ year, count }));
}

export function closureLifespanMedianDays(rows) {
  const days = (rows || []).map(licenseLifespanDays).filter((value) => Number.isFinite(value));
  if (!days.length) return null;
  const sorted = days.sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : Math.round((sorted[middle - 1] + sorted[middle]) / 2);
}

// 폐업 행은 주소가 오래돼 행정동 판정이 자주 실패하는데, 영업 중 업소는 그렇지 않다.
// 두 자료를 그대로 나누면 미확인 행의 폐업률이 100%에 가깝게 나오므로 표에서 덜어내고 따로 센다.
export function closureRateTable(activeStores, closedRows, keyFn) {
  const rows = closureRates(activeStores, closedRows, keyFn);
  const unknown = rows.find((row) => row.name === UNKNOWN_ADMIN_DONG) || null;
  return {
    rows: rows.filter((row) => row.name !== UNKNOWN_ADMIN_DONG),
    unknownClosedCount: unknown?.closedCount || 0,
    unknownActiveCount: unknown?.activeCount || 0
  };
}

export function closureRateTableWithLifespan(activeStores, closedRows, keyFn) {
  const grouped = new Map();
  for (const row of closedRows || []) {
    const name = clean(keyFn(row)) || UNKNOWN_ADMIN_DONG;
    if (!grouped.has(name)) grouped.set(name, []);
    grouped.get(name).push(row);
  }
  const table = closureRateTable(activeStores, closedRows, keyFn);
  return {
    ...table,
    rows: table.rows.map((row) => ({
      ...row,
      medianLifespanDays: closureLifespanMedianDays(grouped.get(row.name) || [])
    }))
  };
}
