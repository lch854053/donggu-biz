// 한국부동산원 상업용부동산 임대동향조사의 지역별 공실률 CSV(충남 데이터포털 재배포본)를
// 서비스 스냅샷으로 바꾼다. 원본은 EUC-KR이며 열은 번호,지역코드,지역명,조사일자,건물구분,공실률,지역구분 레벨 순이다.
// 건물구분 코드 1~4는 데이터 패턴(등장 시점·서울 수치)으로 오피스·중대형상가·집합상가·소규모상가에
// 해당하는 것으로 판별했으며, 통계 자체는 부동산원이 분기마다 계속 공표 중이다.

export const VACANCY_BUILDING_TYPES = Object.freeze({
  "1": "오피스",
  "2": "중대형상가",
  "3": "집합상가",
  "4": "소규모상가"
});

// 서비스가 다루는 광주광역시 영역만 남긴다. '광주'는 시도 전체(레벨 1), 나머지는 상권(레벨 3)이다.
// '경기 광주시가지'·'광주시가지'는 경기도 광주시 계열이므로 제외한다.
const GWANGJU_AREA_NAMES = Object.freeze([
  "광주", "금남로/충장로", "봉선동", "송정동지구", "양산지구",
  "월산동지구", "상무지구", "첨단1지구", "첨단2지구", "수완지구"
]);

function quarterLabel(YYYYQQ) {
  const match = String(YYYYQQ ?? "").trim().match(/^(\d{4})(\d{2})$/);
  return match ? `${match[1]}Q${Number(match[2])}` : "";
}

export function parseVacancyCsv(text) {
  const lines = String(text ?? "").split(/\r?\n/).filter(Boolean);
  const rows = lines.map((line) => line.split(","));
  const header = rows[0] || [];
  if (header.slice(0, 5).join(",") !== "번호,지역코드,지역명,조사일자,건물구분") {
    throw new Error("공실률 CSV 헤더가 예상과 다릅니다.");
  }
  const areas = [];
  for (const cells of rows) {
    if (cells.length < 7) continue;
    const code = cells[1].trim();
    if (!/^\d+$/.test(code)) continue; // 헤더 행
    areas.push({
      code,
      name: cells[2].trim(),
      quarter: quarterLabel(cells[3]),
      buildingType: cells[4].trim(),
      vacancyRate: Number(cells[5]),
      level: Number(cells[6])
    });
  }
  return areas;
}

export function buildVacancySnapshot(areas, { generatedAt } = {}) {
  const byArea = new Map();
  for (const row of areas) {
    if (!GWANGJU_AREA_NAMES.includes(row.name)) continue;
    if (!Number.isFinite(row.vacancyRate)) continue;
    if (!byArea.has(row.name)) {
      byArea.set(row.name, {
        name: row.name,
        code: row.code,
        level: row.level,
        series: {}
      });
    }
    const area = byArea.get(row.name);
    area.series[row.buildingType] ??= {};
    area.series[row.buildingType][row.quarter] = row.vacancyRate;
  }
  const list = [...byArea.values()].map((area) => ({
    ...area,
    series: Object.fromEntries(Object.entries(area.series)
      .map(([type, points]) => [type, Object.fromEntries(Object.entries(points).sort())]))
  }));
  // '광주'(시도 전체)를 맨 앞에, 나머지는 이름 순으로 정렬한다.
  list.sort((left, right) => (left.name === "광주" ? -1 : right.name === "광주" ? 1 : left.name.localeCompare(right.name, "ko")));
  const quarters = [...new Set(areas.map((row) => row.quarter))].filter(Boolean).sort();
  return {
    meta: {
      source: "한국부동산원 상업용부동산 임대동향조사",
      redistributedBy: "충남 데이터포털(올담) 재배포본",
      buildingTypes: VACANCY_BUILDING_TYPES,
      quarters,
      generatedAt: generatedAt ?? new Date().toISOString()
    },
    areas: list
  };
}

export function assertVacancySnapshotHealthy(payload) {
  const areas = payload?.areas ?? [];
  if (!areas.length) throw new Error("공실률 스냅샷에 지역이 없습니다.");
  const gwangju = areas.find((area) => area.name === "광주");
  if (!gwangju) throw new Error("공실률 스냅샷에 광주광역시 자료가 없습니다.");
  if (!Object.keys(gwangju.series).length) throw new Error("공실률 스냅샷 광주 시도 자료가 비어 있습니다.");
}
