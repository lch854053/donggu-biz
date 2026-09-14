// 광주 지역화폐(교통카드) 거래 원본(6일 단위 CSV 청크, EUC-KR)을 정류장·월·시간대별
// 승하차 스냅샷으로 합친다. 배포본 열 구조가 두 가지다.
// 구: 거래일자,거래요일,거래시간,노선코드,노선명,정류장코드,정류장명,자동응답시스템아이디,승하차,거래건수,거래금액,권종
// 신: 거래일자,요일,시간,버스ID,노선코드,노선명,정류장번호,정류장명,자동응답시스템아이디(ARS_ID),승하차,권종,거래건수,거래금액
// 승하차 열은 '승차' 또는 '하차'다. 열 구조가 섞이지 않게 헤더를 함께 넘기는 쪽을 권한다.

function addSide(entry, field, count) {
  if (field === "rides") entry.rides += count;
  else entry.alights += count;
}

function monthOf(dateText) {
  return String(dateText ?? "").slice(0, 7);
}

const COLUMN_ALIASES = {
  date: ["거래일자"],
  hour: ["거래시간", "시간"],
  code: ["정류장코드", "정류장번호"],
  name: ["정류장명"],
  direction: ["승하차"],
  count: ["거래건수"]
};

// 구 배포본의 열 순서. 헤더를 못 줄 때의 기본값으로만 쓴다.
const LEGACY_COLUMNS = { date: 0, hour: 2, code: 5, name: 6, direction: 8, count: 9 };

export function busColumnIndexMap(headerLine) {
  const names = String(headerLine ?? "").split(",").map((cell) => cell.trim());
  const map = {};
  for (const [field, aliases] of Object.entries(COLUMN_ALIASES)) {
    const index = names.findIndex((name) => aliases.includes(name));
    if (index < 0) throw new Error(`버스 원본 헤더에 ${aliases.join("/")} 열이 없습니다: ${String(headerLine).slice(0, 80)}`);
    map[field] = index;
  }
  return map;
}

export function createBusAccumulator() {
  return {
    stops: new Map(), // code -> { name, rides, alights, months: Map(month -> {rides, alights}) }
    months: new Map(), // month -> {rides, alights}
    hours: new Map() // hour -> {rides, alights}
  };
}

export function accumulateBusRows(accumulator, rows, headerLine) {
  const columns = headerLine ? busColumnIndexMap(headerLine) : LEGACY_COLUMNS;
  for (const cells of rows) {
    const date = cells[columns.date];
    const hour = cells[columns.hour];
    const code = cells[columns.code];
    const name = cells[columns.name];
    const direction = cells[columns.direction];
    const countText = cells[columns.count];
    if (cells.length < Math.max(...Object.values(columns)) + 1) continue;
    const count = Number(countText);
    if (!count || count < 0) continue;
    const rides = direction === "승차";
    const month = monthOf(date);
    const hourKey = String(Number(hour));
    if (!Number.isFinite(Number(hour))) continue;

    if (!accumulator.stops.has(code)) {
      accumulator.stops.set(code, { name, rides: 0, alights: 0, months: new Map() });
    }
    const stop = accumulator.stops.get(code);
    if (name) stop.name = name;
    addSide(stop, rides ? "rides" : "alights", count);
    const stopMonth = stop.months.get(month) ?? { rides: 0, alights: 0 };
    if (rides) stopMonth.rides += count;
    else stopMonth.alights += count;
    stop.months.set(month, stopMonth);

    const monthEntry = accumulator.months.get(month) ?? { rides: 0, alights: 0 };
    if (rides) monthEntry.rides += count;
    else monthEntry.alights += count;
    accumulator.months.set(month, monthEntry);

    const hourEntry = accumulator.hours.get(hourKey) ?? { rides: 0, alights: 0 };
    if (rides) hourEntry.rides += count;
    else hourEntry.alights += count;
    accumulator.hours.set(hourKey, hourEntry);
  }
  return accumulator;
}

export function buildBusSnapshot(accumulator, { generatedAt } = {}) {
  const stops = [...accumulator.stops.entries()]
    .map(([code, stop]) => ({
      code,
      name: stop.name,
      rides: stop.rides,
      alights: stop.alights,
      months: Object.fromEntries([...stop.months.entries()].sort()
        .map(([month, entry]) => [month, entry]))
    }))
    .sort((left, right) => (right.rides + right.alights) - (left.rides + left.alights));
  const months = [...accumulator.months.entries()].sort()
    .map(([month, entry]) => ({ month, ...entry }));
  const hours = [...accumulator.hours.entries()]
    .map(([hour, entry]) => ({ hour: Number(hour), ...entry }))
    .sort((left, right) => left.hour - right.hour);
  return {
    meta: {
      source: "광주광역시 시내버스 노선별 승하차 인원(지역화폐 교통카드 거래)",
      periodStart: months[0]?.month ?? "",
      periodEnd: months.at(-1)?.month ?? "",
      totalRides: months.reduce((sum, entry) => sum + entry.rides, 0),
      totalAlights: months.reduce((sum, entry) => sum + entry.alights, 0),
      stopCount: stops.length,
      generatedAt: generatedAt ?? new Date().toISOString()
    },
    months,
    hours,
    stops
  };
}

export function assertBusSnapshotHealthy(payload) {
  const { meta, months, hours, stops } = payload ?? {};
  if (!months?.length) throw new Error("버스 스냅샷에 월별 자료가 없습니다.");
  if (!hours?.length) throw new Error("버스 스냅샷에 시간대별 자료가 없습니다.");
  if (!stops?.length) throw new Error("버스 스냅샷에 정류장 자료가 없습니다.");
  if (!meta?.periodStart || !meta?.periodEnd) throw new Error("버스 스냅샷에 기간이 없습니다.");
  if (meta.periodStart > meta.periodEnd) throw new Error("버스 스냅샷 기간이 뒤집혀 있습니다.");
}
