import { LOCALDATA_ADMIN_CODE, LOCALDATA_PAGE_SIZE, parseLocaldataResponse } from "./store-license.js";

const MAX_RETRIES = 6;
const MAX_RETRY_WAIT_MS = 30000;
// 미용업처럼 응답이 느린 원천이 있어 20초로는 여섯 번을 모두 태워도 한 장을 못 받는다.
const REQUEST_TIMEOUT_MS = 60000;
const REQUEST_PAUSE_MS = 120;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function retryWait(attempt) {
  return Math.min(MAX_RETRY_WAIT_MS, 1000 * 2 ** attempt);
}

export function localdataRequestUrl(source, {
  serviceKey,
  pageNo,
  statusCode,
  adminCode = LOCALDATA_ADMIN_CODE,
  pageSize = LOCALDATA_PAGE_SIZE
}) {
  const url = new URL(source.endpoint);
  url.search = new URLSearchParams({
    serviceKey,
    pageNo: String(pageNo),
    numOfRows: String(pageSize),
    returnType: "json",
    "cond[OPN_ATMY_GRP_CD::EQ]": adminCode,
    "cond[SALS_STTS_CD::EQ]": statusCode
  }).toString();
  return url;
}

export async function fetchLocaldataPage(source, pageNo, options) {
  const url = localdataRequestUrl(source, { ...options, pageNo });

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt += 1) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      const text = await response.text();
      let payload;
      try {
        payload = JSON.parse(text);
      } catch {
        throw new Error(`HTTP ${response.status}: JSON 응답이 아닙니다.`);
      }
      if (!response.ok) {
        const serviceError = payload?.OpenAPI_ServiceResponse?.cmmMsgHeader || {};
        const error = new Error(serviceError.errMsg || `HTTP ${response.status}`);
        error.code = String(serviceError.returnReasonCode || "");
        error.authorization = error.code === "30";
        throw error;
      }
      return parseLocaldataResponse(payload);
    } catch (error) {
      if (error.authorization) throw error;
      if (attempt === MAX_RETRIES) {
        throw new Error(`[localdata:${source.slug}] ${pageNo}페이지 요청 실패: ${error.message}`, { cause: error });
      }
      const wait = retryWait(attempt);
      console.warn(`[localdata:${source.slug}] ${pageNo}페이지 요청 실패 ${attempt}/${MAX_RETRIES} (${error.message}), ${wait / 1000}초 뒤 다시 시도합니다.`);
      await sleep(wait);
    }
  }
}

export async function fetchLocaldataSource(source, options) {
  const pageSize = options.pageSize || LOCALDATA_PAGE_SIZE;
  try {
    const first = await fetchLocaldataPage(source, 1, options);
    const pageCount = Math.ceil(first.totalCount / pageSize);
    const items = [...first.items];
    for (let pageNo = 2; pageNo <= pageCount; pageNo += 1) {
      const page = await fetchLocaldataPage(source, pageNo, options);
      items.push(...page.items);
      console.log(`[localdata:${source.slug}] ${pageNo}/${pageCount} pages, ${items.length}/${first.totalCount} rows`);
      await sleep(REQUEST_PAUSE_MS);
    }
    if (items.length !== first.totalCount) {
      throw new Error(`${source.slug} 수집 건수 불일치: expected ${first.totalCount}, received ${items.length}`);
    }
    return { source, totalCount: first.totalCount, items };
  } catch (error) {
    console.warn(`[localdata:${source.slug}] skipped: ${error.message}`);
    return { source, totalCount: null, items: [], error };
  }
}
