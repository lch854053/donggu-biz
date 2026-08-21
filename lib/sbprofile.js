// 금융위원회 개인사업자기본정보(GetSBProfileInfoService) 응답 처리
//
// 응답 한 행이 익명처리된 개인사업자 한 명이다. 건수 필드가 없으므로 행 수가 곧 사업자 수다.
// 국민연금 사업장 내역과 마찬가지로 기준년월(basYm)마다 한 행씩 쌓이므로, 집계는 반드시
// 기준월 하나로 좁혀야 한다. 전 기준월을 한꺼번에 세면 사업자 수가 개월 수만큼 부풀려진다.
//
// 업종은 API가 중분류명(bizBzcCdNm)을 그대로 내려주므로 자체 분류표를 두지 않는다.
// 국민연금(옛 표준산업분류)과 달리 최신 한국표준산업분류 기준이라 두 화면의 업종을 섞으면 안 된다.

export const SB_REGIONS = [
  { id: "donggu", label: "광주 동구", bizAreaNm: "광주광역시 동구" },
  { id: "gwangju", label: "광주광역시 전체", bizAreaNm: "광주광역시" }
];

export const UNKNOWN_LABEL = "미상";

export const SEX_ORDER = ["남성", "여성"];
export const TENURE_ORDER = ["1년 미만", "1~4년", "5~9년", "10~19년", "20년 이상"];

// API가 업종명의 쉼표를 공백으로 바꿔 내려 "기타 전문  과학 및 기술 서비스업"처럼
// 공백이 겹치는 이름이 있다. 화면에 그대로 쓰기 위해 공백을 하나로 줄인다.
function text(value) {
  const trimmed = String(value ?? "").replace(/\s+/g, " ").trim();
  return trimmed || UNKNOWN_LABEL;
}

export function normalizeProfile(item) {
  const year = Number(String(item?.estbYr ?? "").trim());
  return {
    basYm: String(item?.basYm ?? "").trim(),
    area: String(item?.bizAreaNm ?? "").trim(),
    sexName: text(item?.rprSexNm),
    ageName: text(item?.rprAggrNm),
    industryCode: String(item?.bizBzcCd ?? "").trim(),
    industryName: text(item?.bizBzcCdNm),
    employeeName: text(item?.empeCntNm),
    establishedYear: Number.isInteger(year) && year > 1900 ? year : null
  };
}

/**
 * "30세 미만", "30대", "1명 이상 5명 미만"처럼 구간 이름 앞머리에 붙은 숫자로 크기 순서를 잡는다.
 * 구간 목록을 하드코딩하면 API가 구간을 늘렸을 때 조용히 빠지므로 숫자만 읽는다.
 */
export function leadingNumber(name) {
  const label = String(name);
  const match = label.match(/\d+/);
  if (!match) return Number.POSITIVE_INFINITY;
  const value = Number(match[0]);
  // "30세 미만"처럼 위쪽만 막힌 구간은 같은 숫자로 시작하는 "30대"보다 앞에 와야 한다.
  // "1명 이상 5명 미만"은 아래쪽이 막혀 있으므로 앞머리 숫자를 그대로 쓴다.
  return label.includes("미만") && !label.includes("이상") ? value - 0.5 : value;
}

export function tenureBucket(establishedYear, basYm) {
  const baseYear = Number(String(basYm ?? "").slice(0, 4));
  if (!establishedYear || !baseYear) return UNKNOWN_LABEL;
  const years = baseYear - establishedYear;
  if (years < 0) return UNKNOWN_LABEL;
  if (years < 1) return "1년 미만";
  if (years < 5) return "1~4년";
  if (years < 10) return "5~9년";
  if (years < 20) return "10~19년";
  return "20년 이상";
}

function tally(rows, pick) {
  const counts = new Map();
  for (const row of rows) {
    const name = pick(row);
    counts.set(name, (counts.get(name) || 0) + 1);
  }
  return [...counts].map(([name, count]) => ({ name, count }));
}

export function rankCounts(rows, pick) {
  return tally(rows, pick).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, "ko"));
}

/** 미상은 크기 순서가 없으므로 항상 맨 뒤로 보낸다. */
function unknownLast(a, b) {
  if (a.name === UNKNOWN_LABEL) return 1;
  if (b.name === UNKNOWN_LABEL) return -1;
  return 0;
}

export function scaleCounts(rows, pick) {
  return tally(rows, pick).sort((a, b) =>
    unknownLast(a, b) || leadingNumber(a.name) - leadingNumber(b.name) || a.name.localeCompare(b.name, "ko"));
}

export function fixedCounts(rows, pick, order) {
  return tally(rows, pick).sort((a, b) => {
    const rankA = order.indexOf(a.name);
    const rankB = order.indexOf(b.name);
    if (rankA !== -1 && rankB !== -1) return rankA - rankB;
    if (rankA !== -1) return -1;
    if (rankB !== -1) return 1;
    return b.count - a.count;
  });
}

function indicator(matched, total) {
  return { count: matched, ratio: total ? matched / total : 0 };
}

export function summarizeProfiles(rows) {
  const total = rows.length;
  const tenures = fixedCounts(rows, (row) => tenureBucket(row.establishedYear, row.basYm), TENURE_ORDER);
  const veteran = tenures
    .filter((item) => item.name === "10~19년" || item.name === "20년 이상")
    .reduce((sum, item) => sum + item.count, 0);

  return {
    total,
    sexes: fixedCounts(rows, (row) => row.sexName, SEX_ORDER),
    ages: scaleCounts(rows, (row) => row.ageName),
    employees: scaleCounts(rows, (row) => row.employeeName),
    industries: rankCounts(rows, (row) => row.industryName),
    tenures,
    indicators: {
      female: indicator(rows.filter((row) => row.sexName === "여성").length, total),
      under40: indicator(rows.filter((row) => leadingNumber(row.ageName) < 40).length, total),
      over60: indicator(rows.filter((row) => {
        const age = leadingNumber(row.ageName);
        return Number.isFinite(age) && age >= 60;
      }).length, total),
      solo: indicator(rows.filter((row) => leadingNumber(row.employeeName) === 0).length, total),
      veteran: indicator(veteran, total)
    }
  };
}

/** 기준월별로 나눠 각각 집계한다. 최신 기준월이 앞에 온다. */
export function summarizeByMonth(rows) {
  const groups = new Map();
  for (const row of rows) {
    if (!row.basYm) continue;
    if (!groups.has(row.basYm)) groups.set(row.basYm, []);
    groups.get(row.basYm).push(row);
  }
  const months = [...groups.keys()].sort((a, b) => b.localeCompare(a));
  const byMonth = {};
  for (const month of months) byMonth[month] = summarizeProfiles(groups.get(month));
  return { months, byMonth };
}

export function formatMonth(basYm) {
  return String(basYm ?? "").replace(/^(\d{4})(\d{2})$/, "$1.$2") || UNKNOWN_LABEL;
}

export function formatRatio(ratio) {
  return `${Math.round((ratio || 0) * 1000) / 10}%`;
}

/**
 * 공공데이터포털 표준 응답 껍질을 벗긴다. items가 한 건일 때 배열이 아니라 객체로 오는
 * 경우가 있어 항상 배열로 맞춘다.
 */
export function parseSbResponse(payload) {
  const response = payload?.response ?? payload ?? {};
  const header = response.header ?? {};
  const body = response.body ?? {};
  const code = String(header.resultCode ?? "");
  if (code && code !== "00" && code !== "0") {
    throw new Error(`개인사업자 API 오류 ${code}: ${header.resultMsg || "알 수 없는 오류"}`);
  }
  const raw = body.items?.item ?? body.items ?? body.item ?? [];
  return {
    totalCount: Number(body.totalCount ?? 0),
    items: (Array.isArray(raw) ? raw : [raw]).filter(Boolean)
  };
}

/**
 * 공공데이터 게이트웨이는 부하에 따라 5xx(특히 504)를 낸다. 이건 기다리면 풀리므로 재시도한다.
 * 인증키가 틀렸거나 요청이 잘못된 4xx는 몇 번을 더 불러도 같으므로 바로 실패시킨다.
 */
export function isRetryableStatus(status) {
  return status >= 500 || status === 429 || status === 408;
}
