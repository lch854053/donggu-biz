const DATASET_LINK = /href="\/data\/(\d{6,10})\/openapi\.do[^"]*"[^>]*>([\s\S]{0,300}?)<\/a>/g;
const API_URL = /https?:\/\/apis\.data\.go\.kr\/[A-Za-z0-9_\-./]+/g;
const LOCALDATA_PATH = /^https?:\/\/apis\.data\.go\.kr\/1741000\/([A-Za-z0-9_-]+)\//;

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

// 승인된 API의 요청주소는 공개 상세 페이지가 아니라 마이페이지 개발계정 상세에만 있는 경우가 있다.
const ACCOUNT_LINK = /href="([^"]*(?:selectAPIAcountView|selectDevAcountView)\.do[^"]*)"[^>]*>([\s\S]{0,300}?)<\/a>/g;

export function extractAccountLinks(html, origin = "https://www.data.go.kr") {
  const links = new Map();
  for (const [, href, label] of String(html ?? "").matchAll(ACCOUNT_LINK)) {
    const url = new URL(href.replace(/&amp;/g, "&"), origin).toString();
    if (!links.has(url)) links.set(url, { url, title: stripTags(label) });
  }
  return [...links.values()];
}

// 추출이 실패했을 때 페이지에 무엇이 있었는지 짧게 보고해 선택자를 고칠 수 있게 한다.
export function findEndpointDiagnostics(html, { limit = 6, radius = 90 } = {}) {
  const text = String(html ?? "");
  const marks = /apis\.data\.go\.kr|요청주소|호출\s*URL|End\s*Point|엔드포인트/gi;
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
