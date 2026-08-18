import {
  compactWorkplace,
  compactWorkplaceDetail,
  describeNpsError,
  isRequestShapeError,
  parseNpsBody,
  toBizNoPrefix
} from '../lib/nps.js';

const BASE_URL = 'https://apis.data.go.kr/B552015/NpsBplcInfoInqireServiceV2';
const MAX_UPSTREAM_ATTEMPTS = 4;
const UPSTREAM_TIMEOUT_MS = 8000;
// 이 서비스는 한 페이지 100건까지만 허용한다. 넘기면 게이트웨이가 CLIENT_ERROR(97)로 끊는다.
const MAX_ROWS = 100;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export const maxDuration = 30;

// 조회 조건 파라미터는 스펙 문서(스네이크)와 실제 게이트웨이(카멜) 표기가 엇갈리고,
// 법정동코드도 하위 코드만 받는 쪽과 상위 코드를 포함한 쪽 설명이 엇갈린다.
// 표기·코드 형식 조합을 순서대로 시도해 결과가 나오는 조합을 골라 기억한다.
const SNAKE_NAMES = {
  wkplNm: 'wkpl_nm',
  bzowrRgstNo: 'bzowr_rgst_no',
  ldongAddrMgplDgCd: 'ldong_addr_mgpl_dg_cd',
  ldongAddrMgplSgguCd: 'ldong_addr_mgpl_sggu_cd',
  ldongAddrMgplSgguEmdCd: 'ldong_addr_mgpl_sggu_emd_cd'
};
const VARIANTS = [
  { style: 'camel', region: 'asIs' },
  { style: 'camel', region: 'prefixed' },
  { style: 'snake', region: 'asIs' },
  { style: 'snake', region: 'prefixed' }
];
let preferredVariant = 0;

/** 성공한 조합 기억을 초기값으로 되돌린다. 테스트가 서로 간섭하지 않게 쓰는 훅이다. */
export function resetVariantPreference() {
  preferredVariant = 0;
}

function boundedInt(value, fallback, min, max) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
}

function digitsOnly(value, maxLength) {
  return String(value ?? '').replace(/[^0-9]/g, '').slice(0, maxLength);
}

/**
 * 발급 화면의 "인코딩 키"를 그대로 넣어두면 쿼리 조립 때 %가 한 번 더 인코딩되어
 * 키가 깨진다. 퍼센트 표기가 보이면 한 번 풀어서 디코딩 키로 맞춘다.
 */
function normalizeServiceKey(raw) {
  const key = String(raw ?? '').trim();
  if (!/%[0-9A-Fa-f]{2}/.test(key)) return key;
  try {
    return decodeURIComponent(key);
  } catch {
    return key;
  }
}

function maskKey(url) {
  return url.replace(/serviceKey=[^&]*/, 'serviceKey=***');
}

function buildRequest(query) {
  const action = String(query.action || 'search');

  if (action === 'detail') {
    const seq = digitsOnly(query.seq, 20);
    if (!seq) return { error: 'seq 값이 필요합니다.' };
    // getDetailInfoSearchV2는 seq만 받는다. 기준월을 함께 넘기면 요청이 거부된다.
    return { action, operation: 'getDetailInfoSearchV2', params: { seq }, region: { sido: '', sggu: '', emd: '' } };
  }

  if (action !== 'search') return { error: `지원하지 않는 action 값입니다: ${action}` };

  const pageNo = boundedInt(query.pageNo, 1, 1, 10000);
  const params = {
    pageNo: String(pageNo),
    numOfRows: String(boundedInt(query.numOfRows, MAX_ROWS, 1, MAX_ROWS))
  };

  const name = String(query.wkplNm ?? '').trim().slice(0, 60);
  if (name) params.wkplNm = name;
  const bizNo = toBizNoPrefix(query.bzowrRgstNo);
  if (bizNo) params.bzowrRgstNo = bizNo;

  // 법정동코드는 시도 2 + 시군구 3 + 읍면동 3자리로 쪼개진다. 화면은 하위 코드만 넘기고,
  // 상위 코드를 붙인 형식이 필요한 경우는 요청을 만들 때 조합한다.
  const region = {
    sido: digitsOnly(query.sido, 2),
    sggu: digitsOnly(query.sggu, 5),
    emd: digitsOnly(query.emd, 8)
  };

  if (!name && !bizNo && !region.sido) {
    return { error: '사업장명, 사업자등록번호, 지역 중 하나 이상의 조건이 필요합니다.' };
  }
  return { action, operation: 'getBassInfoSearchV2', params, region, pageNo };
}

/** 하위 코드만 들어온 시군구·읍면동 코드에 상위 코드를 붙여 누적 형식으로 만든다. */
function prefixRegion({ sido, sggu, emd }) {
  const fullSggu = sggu.length === 3 && sido ? `${sido}${sggu}` : sggu;
  const fullEmd = emd.length === 3 && fullSggu.length === 5 ? `${fullSggu}${emd}` : emd;
  return { sido, sggu: fullSggu, emd: fullEmd };
}

function requestUrl(request, apiKey, variant) {
  const region = variant.region === 'prefixed' ? prefixRegion(request.region) : request.region;
  const params = { ...request.params };
  if (region.sido) params.ldongAddrMgplDgCd = region.sido;
  if (region.sggu) params.ldongAddrMgplSgguCd = region.sggu;
  if (region.emd) params.ldongAddrMgplSgguEmdCd = region.emd;

  const search = new URLSearchParams({ serviceKey: apiKey });
  for (const [name, value] of Object.entries(params)) {
    search.set(variant.style === 'snake' ? SNAKE_NAMES[name] ?? name : name, value);
  }
  return `${BASE_URL}/${request.operation}?${search}`;
}

/** 시도해 볼 요청 URL 목록. 같은 URL이 되는 조합은 한 번만 부른다. */
function candidateUrls(request, apiKey) {
  const ordered = [preferredVariant, ...VARIANTS.keys()].filter((index, position, all) => all.indexOf(index) === position);
  const candidates = [];
  for (const index of ordered) {
    const url = requestUrl(request, apiKey, VARIANTS[index]);
    if (candidates.some((candidate) => candidate.url === url)) continue;
    candidates.push({ index, url });
  }
  return candidates;
}

/** 응답 본문을 그대로 돌려준다. 네트워크·5xx·429만 재시도한다. */
async function fetchUpstream(url) {
  let lastFailure = null;
  for (let attempt = 1; attempt <= MAX_UPSTREAM_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: { Accept: 'application/xml, application/json' },
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS)
      });
      const body = await response.text();
      if (response.ok) return { body };
      lastFailure = { status: response.status, detail: body.slice(0, 500) };
      if (response.status < 500 && response.status !== 429) break;
    } catch (error) {
      lastFailure = { error };
    }
    if (attempt < MAX_UPSTREAM_ATTEMPTS) await sleep(250 * 2 ** (attempt - 1));
  }
  return { failure: lastFailure };
}

function respondTransportFailure(res, failure) {
  if (failure?.status && failure.status < 500 && failure.status !== 429) {
    return res.status(502).json({
      error: `국민연금 API 요청이 거부되었습니다. HTTP ${failure.status}`,
      detail: failure.detail
    });
  }
  res.setHeader('Retry-After', '5');
  return res.status(503).json({
    error: '국민연금 API가 일시적으로 불안정합니다. 잠시 후 다시 조회해 주세요.',
    detail: failure?.detail
  });
}

function payloadFor(request, parsed, variant, attempts) {
  const compact = request.action === 'detail' ? compactWorkplaceDetail : compactWorkplace;
  return {
    items: parsed.items.map(compact),
    totalCount: parsed.totalCount,
    pageNo: parsed.pageNo,
    numOfRows: parsed.numOfRows,
    // 결과가 비었을 때 어떤 조합으로 물었는지 화면 콘솔에서 확인할 수 있게 남긴다.
    meta: { paramStyle: variant.style, regionForm: variant.region, attempts }
  };
}

export default async function handler(req, res) {
  const origin = req.headers.origin;
  const requestHost = req.headers.host;
  let allowedOrigin = '';
  if (origin) {
    try {
      if (new URL(origin).host === requestHost) allowedOrigin = origin;
    } catch {
      return res.status(400).json({ error: '올바르지 않은 Origin 헤더입니다.' });
    }
  }
  if (allowedOrigin) res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET만 허용됩니다.' });

  const apiKey = normalizeServiceKey(process.env.NPS_SERVICE_KEY);
  if (!apiKey) {
    return res.status(500).json({ error: 'API 키가 설정되지 않았습니다. Vercel 환경변수 NPS_SERVICE_KEY를 확인하세요.' });
  }

  const request = buildRequest(req.query || {});
  if (request.error) return res.status(400).json({ error: request.error });

  // 첫 페이지가 0건이면 조건이 정말 없는 것인지 표기·코드 형식이 어긋난 것인지 알 수 없다.
  // 다른 조합으로 한 번씩 더 물어보고, 그래도 0건이면 진짜 없는 것으로 본다.
  const probeEmpty = request.action === 'search' && request.pageNo === 1;
  const candidates = candidateUrls(request, apiKey);
  const attempts = [];
  let emptyResult = null;
  let lastError = null;

  for (const [position, candidate] of candidates.entries()) {
    const { body, failure } = await fetchUpstream(candidate.url);
    if (failure) return respondTransportFailure(res, failure);

    // 이 서비스는 XML로 응답하며, 서비스키·파라미터 오류도 XML 오류 문서로 돌아온다.
    let parsed;
    try {
      parsed = parseNpsBody(body);
    } catch (error) {
      attempts.push({ url: maskKey(candidate.url), error: error.message });
      lastError = { error, body };
      if (isRequestShapeError(error)) continue;
      break;
    }

    attempts.push({ url: maskKey(candidate.url), totalCount: parsed.totalCount, itemCount: parsed.items.length });
    const variant = VARIANTS[candidate.index];
    if (probeEmpty && !parsed.items.length && position < candidates.length - 1) {
      emptyResult = emptyResult ?? { parsed, variant };
      continue;
    }

    if (parsed.items.length) preferredVariant = candidate.index;
    return res.status(200).json(payloadFor(request, parsed, variant, attempts));
  }

  if (emptyResult) {
    return res.status(200).json(payloadFor(request, emptyResult.parsed, emptyResult.variant, attempts));
  }
  return res.status(502).json({
    error: describeNpsError(lastError.error),
    detail: lastError.body.slice(0, 300)
  });
}
