import { pointInGeometry } from "./market.js";
import { closureYear, licenseDateParts } from "./store-closure.js";

export const ZONE_CLOSURE_RATE_YEARS = 10;

function openedYear(record) {
  return licenseDateParts(record?.licenseDate)?.year ?? null;
}

// 폐업 기록의 87%만 좌표를 갖고 있다. 좌표가 없는 행은 어느 상권에도 넣을 수 없으므로
// 상권별 집계는 실제보다 조금 적게 잡히고, 그 사실을 호출부가 알 수 있게 함께 돌려준다.
export function closuresInZone(licenses, geometry) {
  const rows = [];
  let missingCoordinates = 0;
  for (const row of licenses || []) {
    if (row.statusKind !== "closed") continue;
    if (!Number.isFinite(row.longitude) || !Number.isFinite(row.latitude)) {
      missingCoordinates += 1;
      continue;
    }
    if (geometry && !pointInGeometry(row.longitude, row.latitude, geometry)) continue;
    rows.push(row);
  }
  return { rows, missingCoordinates };
}

// 연도별 폐업률의 분모는 "그 해에 영업 중이던 곳"이다. 지금 영업 중인 업소와 그 뒤에 닫은
// 업소를 인허가 연도로 되돌려 세면 과거 시점의 모수가 복원된다. 인허가일이 없는 업소는
// 어느 해에 열었는지 알 수 없어 분모에서 빠지므로, 비율은 인허가 자료 안에서만 비교해야 한다.
export function zoneClosureYearRates(activeStores, closedRows, { fromYear, toYear }) {
  const openedActive = (activeStores || []).map(openedYear).filter((year) => year !== null);
  const spans = (closedRows || [])
    .map((row) => ({ opened: openedYear(row), closed: closureYear(row) }))
    .filter(({ opened, closed }) => opened !== null && closed !== null);

  const years = [];
  for (let year = fromYear; year <= toYear; year += 1) {
    const carriedOver = openedActive.filter((opened) => opened <= year).length
      + spans.filter(({ opened, closed }) => opened <= year && closed >= year).length;
    const closedCount = spans.filter(({ closed }) => closed === year).length;
    years.push({
      year,
      closedCount,
      activeCount: carriedOver,
      rate: carriedOver > 0 ? closedCount / carriedOver : null
    });
  }
  return years;
}

export function averageClosureRate(years) {
  const rates = (years || []).map(({ rate }) => rate).filter((rate) => Number.isFinite(rate));
  if (!rates.length) return null;
  return rates.reduce((total, rate) => total + rate, 0) / rates.length;
}

// 그래프의 가로축은 스냅샷이 자라도 흔들리지 않게 최근 10년으로 고정한다.
// 수집 중인 해는 폐업이 아직 다 쌓이지 않아 비율이 실제보다 낮게 나오므로 throughYear로 잘라낸다.
export function recentRateYearRange(closedRows, { span = ZONE_CLOSURE_RATE_YEARS, throughYear = null } = {}) {
  const years = (closedRows || []).map(closureYear).filter((year) => year !== null);
  if (!years.length) return null;
  const latest = Math.max(...years);
  const toYear = throughYear === null ? latest : Math.min(latest, throughYear);
  if (toYear < Math.min(...years)) return null;
  return { fromYear: toYear - span + 1, toYear };
}
