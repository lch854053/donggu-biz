const DATASET_LINK = /href="\/data\/(\d{6,10})\/openapi\.do[^"]*"[^>]*>([\s\S]{0,300}?)<\/a>/g;
const API_URL = /(?:https?:\/\/)?apis\.data\.go\.kr\/[A-Za-z0-9_\-./]+/g;
// 포털은 요청주소를 End Point 항목의 기본 주소로도, Swagger 스펙의 host 값으로도 적는다.
// host에는 스킴이 없고 둘 다 오퍼레이션 경로가 없어, 스킴과 뒤 슬래시를 모두 선택으로 둔다.
const LOCALDATA_PATH = /^(?:https?:\/\/)?apis\.data\.go\.kr\/1741000\/([A-Za-z0-9_-]+)/;

function stripTags(value) {
  return String(value ?? "")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

// 상세 페이지에는 오퍼레이션마다 요청주소가 흩어져 있어, 인허가 서비스(1741000) 주소만
// 남기고 오퍼레이션 경로를 떼어 서비스 단위 엔드포인트로 접는다.
export function extractApiEndpoints(pageText) {
  const found = String(pageText ?? "").match(API_URL) || [];
  const endpoints = new Map();
  for (const url of found) {
    const match = url.match(LOCALDATA_PATH);
    if (!match) continue;
    const slug = match[1];
    if (!endpoints.has(slug)) endpoints.set(slug, `https://apis.data.go.kr/1741000/${slug}/info`);
  }
  return [...endpoints.entries()].map(([slug, endpoint]) => ({ slug, endpoint }));
}

export function extractDatasetLinks(html) {
  const links = new Map();
  for (const [, datasetId, label] of String(html ?? "").matchAll(DATASET_LINK)) {
    const title = stripTags(label);
    if (!links.has(datasetId)) links.set(datasetId, { datasetId, title });
    else if (!links.get(datasetId).title && title) links.get(datasetId).title = title;
  }
  return [...links.values()];
}

// 마이페이지 목록은 링크를 href가 아니라 onclick 스크립트로 거는 행이 있어,
// 태그 구조를 믿지 않고 문서 전체에서 계정 상세 경로를 그대로 긁는다.
const ACCOUNT_PATH = /(?:\/iim\/api\/)?(?:selectAPIAcountView|selectDevAcountView)\.do(?:\?[^"'<>\s\\]*)?/g;
const ACCOUNT_ANCHOR = /href="([^"]*(?:selectAPIAcountView|selectDevAcountView)\.do[^"]*)"[^>]*>([\s\S]{0,300}?)<\/a>/g;

export function extractAccountLinks(html, origin = "https://www.data.go.kr") {
  const text = String(html ?? "");
  const links = new Map();
  const add = (raw, title = "") => {
    const path = raw.replace(/&amp;/g, "&");
    const url = new URL(path.startsWith("/") || /^https?:/.test(path) ? path : `/iim/api/${path}`, origin).toString();
    if (!links.has(url)) links.set(url, { url, title });
    else if (!links.get(url).title && title) links.get(url).title = title;
  };
  for (const [, href, label] of text.matchAll(ACCOUNT_ANCHOR)) add(href, stripTags(label));
  for (const [match] of [...text.matchAll(ACCOUNT_PATH)].map((entry) => [entry[0]])) add(match);
  return [...links.values()];
}

// 진단은 요청주소를 가리키는 표기만 본다. 로그인 스크립트의 endPoint 변수까지 잡으면 잡음만 남는다.
export function findEndpointDiagnostics(html, { limit = 6, radius = 90 } = {}) {
  const text = String(html ?? "");
  const marks = /apis\.data\.go\.kr|1741000|요청주소|호출\s*URL|서비스\s*URL/g;
  const snippets = [];
  for (const match of text.matchAll(marks)) {
    if (snippets.length >= limit) break;
    const start = Math.max(0, match.index - radius);
    snippets.push(stripTags(text.slice(start, match.index + radius)));
  }
  return [...new Set(snippets)];
}

export function datasetSearchUrl(keyword) {
  const url = new URL("https://www.data.go.kr/tcs/dss/selectDataSetList.do");
  url.searchParams.set("keyword", keyword);
  url.searchParams.set("dType", "API");
  url.searchParams.set("perPage", "20");
  return url.toString();
}

// "행정안전부_기타_통신판매업 조회서비스" → "통신판매업". 접두 분류까지 붙여 검색하면 결과가 비어버린다.
export function searchKeywordFromTitle(title) {
  return String(title ?? "")
    .replace(/\s*조회서비스\s*$/, "")
    .split("_")
    .at(-1)
    .trim();
}

function squeeze(value) {
  return String(value ?? "").replace(/\s+/g, "");
}

// 검색 결과에는 같은 업종의 파일데이터·표준데이터가 섞여 들어온다. 제목이 그대로 일치하는
// 것을 먼저 찾고, 없으면 업종명이 든 행안부 데이터셋이 하나뿐일 때만 후보로 인정한다.
// 둘 이상이면 사람이 골라야 하므로 아무것도 돌려주지 않는다.
export function pickDatasetMatch(matches, title) {
  const rows = (matches || []).filter(({ datasetId }) => datasetId);
  const wanted = squeeze(title);
  const exact = rows.find((row) => squeeze(row.title) === wanted);
  if (exact) return { ...exact, confidence: "exact" };

  const keyword = squeeze(searchKeywordFromTitle(title));
  if (!keyword) return null;
  const named = rows.filter((row) => {
    const rowTitle = squeeze(row.title);
    return rowTitle.includes("행정안전부") && rowTitle.includes(keyword) && rowTitle.includes("조회서비스");
  });
  return named.length === 1 ? { ...named[0], confidence: "keyword" } : null;
}

export function datasetDetailUrl(datasetId) {
  return `https://www.data.go.kr/data/${datasetId}/openapi.do`;
}

// 활용신청 버튼이 남아 있으면 미신청, 마이페이지 안내나 일반 인증키가 보이면 신청·승인된 것으로 읽는다.
export function readApplicationState(pageText) {
  const text = String(pageText ?? "");
  if (/승인|일반 인증키|개발계정 상세보기|활용신청 상세기능/.test(text)) return "approved-or-applied";
  if (/활용신청/.test(text)) return "not-applied";
  return "unknown";
}
