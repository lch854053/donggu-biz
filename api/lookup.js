const STATUS_API_URL = 'https://api.odcloud.kr/api/nts-businessman/v1/status';
const VALIDATE_API_URL = 'https://api.odcloud.kr/api/nts-businessman/v1/validate';
const MAX_UPSTREAM_ATTEMPTS = 4;
const UPSTREAM_TIMEOUT_MS = 6000;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export const maxDuration = 30;

const VALIDATE_FIELDS = ['b_no', 'start_dt', 'p_nm', 'p_nm2', 'b_nm', 'corp_no', 'b_sector', 'b_type', 'tax_type'];

function validateBusinesses(businesses) {
  if (!Array.isArray(businesses) || businesses.length === 0) {
    return { error: 'businesses 배열이 필요합니다.' };
  }
  if (businesses.length > 100) {
    return { error: '1회 최대 100건까지 가능합니다.' };
  }
  if (businesses.some((business) => !business || typeof business !== 'object' || Array.isArray(business))) {
    return { error: 'businesses에는 사업자 정보 객체가 필요합니다.' };
  }
  if (businesses.some((business) => typeof business.b_no !== 'string' || !/^\d{10}$/.test(business.b_no))) {
    return { error: '사업자등록번호는 10자리 숫자 문자열이어야 합니다.' };
  }
  if (businesses.some((business) => typeof business.start_dt !== 'string' || !/^\d{8}$/.test(business.start_dt))) {
    return { error: '개업일자는 8자리 숫자 문자열이어야 합니다.' };
  }
  if (businesses.some((business) => typeof business.p_nm !== 'string' || !business.p_nm.trim())) {
    return { error: '대표자명이 필요합니다.' };
  }

  return {
    businesses: businesses.map((business) => Object.fromEntries(
      VALIDATE_FIELDS
        .filter((field) => business[field] !== undefined && business[field] !== null && String(business[field]).trim())
        .map((field) => [field, typeof business[field] === 'string' ? business[field].trim() : String(business[field])])
    ))
  };
}

async function requestNtsApi(apiUrl, body, apiKey) {
  let lastFailure = null;
  for (let attempt = 1; attempt <= MAX_UPSTREAM_ATTEMPTS; attempt += 1) {
    try {
      const url = `${apiUrl}?serviceKey=${encodeURIComponent(apiKey)}&returnType=JSON`;
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      });

      if (response.ok) return { data: await response.json() };

      const detail = await response.text();
      lastFailure = { status: response.status, detail };
      if (response.status < 500 && response.status !== 429) break;
    } catch (error) {
      lastFailure = { error };
    }
    if (attempt < MAX_UPSTREAM_ATTEMPTS) await sleep(250 * 2 ** (attempt - 1));
  }
  return { failure: lastFailure };
}

function respondNtsFailure(res, failure) {
  if (failure?.status) {
    if (failure.status < 500 && failure.status !== 429) {
      return res.status(502).json({
        error: `국세청 API 요청이 거부되었습니다. HTTP ${failure.status}`,
        detail: failure.detail,
      });
    }
    res.setHeader('Retry-After', '5');
    return res.status(503).json({
      error: '국세청 API가 일시적으로 불안정합니다. 잠시 후 다시 조회해 주세요.',
      detail: failure.detail,
    });
  }
  res.setHeader('Retry-After', '5');
  return res.status(504).json({ error: '국세청 API 응답 시간이 초과되었습니다. 잠시 후 다시 조회해 주세요.' });
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
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'POST만 허용됩니다.' });
  }

  if (req.body?.action === 'validate') {
    const validated = validateBusinesses(req.body.businesses);
    if (validated.error) return res.status(400).json({ error: validated.error });

    const apiKey = process.env.NTS_API_KEY;
    if (!apiKey) {
      return res.status(500).json({ error: 'API 키가 설정되지 않았습니다. Vercel 환경변수를 확인하세요.' });
    }

    const result = await requestNtsApi(VALIDATE_API_URL, validated, apiKey);
    if (result.data) return res.status(200).json(result.data);
    return respondNtsFailure(res, result.failure);
  }

  const b_no = req.body?.b_no;

  if (!Array.isArray(b_no) || b_no.length === 0) {
    return res.status(400).json({ error: 'b_no 배열이 필요합니다.' });
  }

  if (b_no.length > 100) {
    return res.status(400).json({ error: '1회 최대 100건까지 가능합니다.' });
  }

  if (b_no.some((value) => typeof value !== 'string' || !/^\d{10}$/.test(value))) {
    return res.status(400).json({ error: '사업자등록번호는 10자리 숫자 문자열이어야 합니다.' });
  }

  const apiKey = process.env.NTS_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'API 키가 설정되지 않았습니다. Vercel 환경변수를 확인하세요.' });
  }

  const result = await requestNtsApi(STATUS_API_URL, { b_no }, apiKey);
  if (result.data) return res.status(200).json(result.data);
  return respondNtsFailure(res, result.failure);
}
