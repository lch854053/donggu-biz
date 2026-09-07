const MIN_YEAR = 1960;
const MILLISECONDS_PER_DAY = 86_400_000;

function clean(value) {
  return String(value ?? "").trim();
}

// LOCALDATA 원본에는 9999년·8202년 같은 입력 오류가 섞여 있어 실재하는 날짜만 통과시킨다.
export function licenseDateParts(value) {
  const digits = clean(value).replace(/[^0-9]/g, "").slice(0, 8);
  if (digits.length !== 8) return null;
  const year = Number(digits.slice(0, 4));
  const month = Number(digits.slice(4, 6));
  const day = Number(digits.slice(6, 8));
  const maxYear = new Date().getUTCFullYear() + 1;
  if (!(year >= MIN_YEAR && year <= maxYear)) return null;
  if (!(month >= 1 && month <= 12) || !(day >= 1 && day <= 31)) return null;
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return { year, month, day, date };
}

export function closureYear(license) {
  return licenseDateParts(license?.closedDate)?.year ?? null;
}

export function licenseLifespanDays(license) {
  const opened = licenseDateParts(license?.licenseDate);
  const closed = licenseDateParts(license?.closedDate);
  if (!opened || !closed) return null;
  const days = Math.round((closed.date - opened.date) / MILLISECONDS_PER_DAY);
  return days >= 0 ? days : null;
}

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : Math.round((sorted[middle - 1] + sorted[middle]) / 2);
}

function lifespanSummary(licenses) {
  const days = licenses.map(licenseLifespanDays).filter((value) => Number.isFinite(value));
  return {
    count: days.length,
    medianDays: median(days),
    meanDays: days.length ? Math.round(days.reduce((sum, value) => sum + value, 0) / days.length) : null
  };
}

function groupCounts(licenses, keyFn, { withLifespan = false } = {}) {
  const groups = new Map();
  for (const license of licenses) {
    const name = clean(keyFn(license)) || "미확인";
    if (!groups.has(name)) groups.set(name, []);
    groups.get(name).push(license);
  }
  return [...groups.entries()]
    .map(([name, rows]) => ({
      name,
      count: rows.length,
      ...(withLifespan ? { lifespan: lifespanSummary(rows) } : {})
    }))
    .sort((left, right) => right.count - left.count || left.name.localeCompare(right.name));
}

export function summarizeClosures(licenses) {
  const rows = licenses || [];
  const closed = rows.filter((license) => license.statusKind === "closed");
  const suspended = rows.filter((license) => license.statusKind === "suspended");
  const years = closed.map(closureYear).filter((year) => Number.isFinite(year));
  return {
    totalCount: rows.length,
    closedCount: closed.length,
    suspendedCount: suspended.length,
    missingClosedDateCount: closed.filter((license) => closureYear(license) === null).length,
    missingCoordinateCount: rows.filter((license) => !Number.isFinite(license.longitude)
      || !Number.isFinite(license.latitude)).length,
    missingAdminDongCount: rows.filter((license) => !clean(license.adminDong)).length,
    lifespan: lifespanSummary(closed),
    byYear: [...new Set(years)]
      .sort((left, right) => right - left)
      .map((year) => ({ year, count: years.filter((value) => value === year).length })),
    byAdminDong: groupCounts(closed, (license) => license.adminDong),
    byLargeName: groupCounts(closed, (license) => license.largeName, { withLifespan: true }),
    bySmallName: groupCounts(closed, (license) => license.smallName).slice(0, 50)
  };
}

// 폐업률은 같은 기준(행정동·업종)에서 현재 영업 중 업소와 폐업 이력을 함께 세어야 의미가 있다.
export function closureRates(activeStores, closedLicenses, keyFn) {
  const active = new Map();
  const closed = new Map();
  const bump = (map, name) => map.set(name, (map.get(name) || 0) + 1);
  for (const store of activeStores || []) bump(active, clean(keyFn(store)) || "미확인");
  for (const license of closedLicenses || []) bump(closed, clean(keyFn(license)) || "미확인");
  return [...new Set([...active.keys(), ...closed.keys()])]
    .map((name) => {
      const activeCount = active.get(name) || 0;
      const closedCount = closed.get(name) || 0;
      const total = activeCount + closedCount;
      return {
        name,
        activeCount,
        closedCount,
        closureRate: total ? Number((closedCount / total).toFixed(4)) : null
      };
    })
    .sort((left, right) => right.closedCount - left.closedCount || left.name.localeCompare(right.name));
}

export function assertClosureSnapshotHealthy({ totalCount, previousCount }) {
  if (!Number.isFinite(totalCount) || totalCount <= 0) {
    throw new Error("폐업·휴업 스냅샷이 비어 있어 기존 파일을 덮어쓰지 않습니다.");
  }
  if (Number.isFinite(previousCount) && previousCount > 0 && totalCount < previousCount * 0.8) {
    throw new Error(`폐업·휴업 건수가 이전 ${previousCount}건에서 ${totalCount}건으로 20% 넘게 줄어 갱신을 중단합니다.`);
  }
}
