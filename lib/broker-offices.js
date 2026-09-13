// 국토교통부 부동산중개업정보(VWorld 국가중점데이터API). req/data 레이어가 아니라
// ned/data 전용 엔드포인트를 쓰며, 같은 VWorld 키에 발급 때 등록한 도메인을
// domain 파라미터로 보내야 한다. 좌표는 응답에 없으므로 카카오 주소 검색으로 따로 채운다.
//
// 광주·전남 행정통합으로 시군구 코드가 바뀌었다: 광주 동구는 29110이 아니라 12210.
const OFFICES_URL = "https://api.vworld.kr/ned/data/getEBOfficeInfo";
const KAKAO_ADDRESS_URL = "https://dapi.kakao.com/v2/local/search/address.json";

export const GWANGJU_DONGGU_LD_CODE = "12210";
export const BROKER_STATUS_ACTIVE = "1";

const DEFAULT_MAX_RETRIES = 4;
const DEFAULT_TIMEOUT_MS = 30000;
const DEFAULT_PAUSE_MS = 150;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function clean(value) {
  return String(value ?? "").trim();
}

// EDOffices 응답은 성공할 때 response 래퍼가 없고 실패할 때만 붙는다.
export function parseBrokerOffices(payload) {
  const body = payload?.EDOffices ?? payload?.response?.EDOffices ?? {};
  const fields = Array.isArray(body.field) ? body.field : body.field ? [body.field] : [];
  return {
    totalCount: Number(body.totalCount ?? body.total ?? fields.length) || 0,
    offices: fields
  };
}

// mergeStoreSources가 기대하는 인허가 행(compactLicense 결과)과 같은 모양으로 접는다.
export function normalizeBrokerOffice(item, { adminDong = "" } = {}) {
  const registryNo = clean(item.jurirno);
  const name = clean(item.bsnmCmpnm);
  const address = clean(item.rdnmadr);
  const lotAddress = clean(item.mnnmadr);
  const statusName = clean(item.sttusSeCodeNm);
  const fallbackId = `${name}:${address}`;
  return {
    id: `license:vworld_broker_offices:${registryNo || fallbackId}`,
    source: "국토교통부 부동산중개업정보",
    sourceSlug: "vworld_broker_offices",
    sourceDatasetId: "ned.getEBOfficeInfo",
    sourceName: "국토교통부_부동산중개업정보(VWorld 국가중점데이터API)",
    licenseId: registryNo,
    sourceAdminCode: clean(item.ldCode),
    name,
    branch: "",
    largeCode: "L",
    largeName: "부동산",
    middleCode: "",
    middleName: "",
    smallCode: "",
    smallName: "부동산중개",
    adminDong: adminDong || (address || lotAddress).replace(/[(),]/g, " "),
    legalDong: "",
    address,
    lotAddress,
    pnu: "",
    legacyPnu: "",
    buildingNo: "",
    buildingName: "",
    floor: "",
    longitude: null,
    latitude: null,
    licenseType: "부동산중개",
    statusCode: clean(item.sttusSeCode),
    statusName,
    detailStatusName: "",
    licenseDate: clean(item.registDe),
    closedDate: "",
    lastModifiedAt: clean(item.lastUpdtDt),
    brokerName: clean(item.brkrNm),
    employmentCount: Number.isFinite(Number(item.emplym_co)) && clean(item.emplym_co) !== ""
      ? Number(item.emplym_co)
      : null
  };
}

async function requestJson(url, { fetchImpl = globalThis.fetch, timeoutMs, maxRetries, label, sleepImpl = sleep }) {
  let lastError;
  for (let attempt = 1; attempt <= maxRetries; attempt += 1) {
    try {
      const response = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
      const text = await response.text();
      if (!response.ok) throw new Error(`HTTP ${response.status}: ${text.slice(0, 120)}`);
      return JSON.parse(text);
    } catch (error) {
      lastError = error;
      if (attempt < maxRetries) await sleepImpl(attempt * 1000);
    }
  }
  throw new Error(`[${label}] ${lastError.message}`);
}

// 영업 중(기본) 사무소를 시군구 코드로 모두 받아온다. 한 페이지 최대 1000건이라
// 광주 동구(322건)는 한 번에 끝난다.
export async function fetchBrokerOffices({
  key,
  domain,
  ldCode = GWANGJU_DONGGU_LD_CODE,
  statusCode = BROKER_STATUS_ACTIVE,
  fetchImpl,
  maxRetries = DEFAULT_MAX_RETRIES,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  pauseMs = DEFAULT_PAUSE_MS,
  sleepImpl = sleep
} = {}) {
  if (!key) throw new Error("VWORLD_KEY 환경변수가 필요합니다.");
  if (!domain) throw new Error("VWORLD_DOMAIN 환경변수가 필요합니다.");

  const options = { fetchImpl, timeoutMs, maxRetries, label: "broker", sleepImpl };
  const offices = [];
  let totalCount = 0;
  for (let pageNo = 1; ; pageNo += 1) {
    const url = `${OFFICES_URL}?${new URLSearchParams({
      key,
      domain,
      ldCode,
      ...(statusCode ? { sttusSeCode: statusCode } : {}),
      format: "json",
      numOfRows: "1000",
      pageNo: String(pageNo)
    })}`;
    const payload = await requestJson(url, options);
    const parsed = parseBrokerOffices(payload);
    totalCount = parsed.totalCount;
    if (!parsed.offices.length) break;
    offices.push(...parsed.offices);
    if (offices.length >= totalCount || pageNo >= 50) break;
    await sleepImpl(pauseMs);
  }
  if (totalCount && offices.length !== totalCount) {
    throw new Error(`부동산중개 수집 건수 불일치: expected ${totalCount}, received ${offices.length}`);
  }
  return {
    totalCount,
    offices,
    lastUpdatedAt: offices.map((office) => clean(office.lastUpdtDt)).filter(Boolean).sort().at(-1) || ""
  };
}

// 카카오 주소 검색으로 도로명·지번 주소의 좌표를 찾는다. 실패해도 null을 돌려
// 나머지 수집이 막히지 않게 한다.
export async function fetchAddressCoordinate(address, apiKey, {
  fetchImpl = globalThis.fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxRetries = 2,
  sleepImpl = sleep
} = {}) {
  const query = clean(address);
  if (!query || !apiKey) return null;
  const url = `${KAKAO_ADDRESS_URL}?${new URLSearchParams({ query, analyze_type: "similar" })}`;
  for (let attempt = 1; attempt <= maxRetries; attempt += 1) {
    try {
      const response = await fetchImpl(url, {
        headers: { Authorization: `KakaoAK ${apiKey}` },
        signal: AbortSignal.timeout(timeoutMs)
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const payload = await response.json();
      const doc = payload?.documents?.[0];
      if (!doc) return null;
      const longitude = Number(doc.road_address?.x ?? doc.address?.x);
      const latitude = Number(doc.road_address?.y ?? doc.address?.y);
      if (!Number.isFinite(longitude) || !Number.isFinite(latitude)) return null;
      return { longitude, latitude };
    } catch (error) {
      if (attempt >= maxRetries) return null;
      await sleepImpl(attempt * 1000);
    }
  }
  return null;
}
