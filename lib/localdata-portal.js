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

export function datasetSearchUrl(keyword) {
  const url = new URL("https://www.data.go.kr/tcs/dss/selectDataSetList.do");
  url.searchParams.set("keyword", keyword);
  url.searchParams.set("dType", "API");
  url.searchParams.set("perPage", "20");
  return url.toString();
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
