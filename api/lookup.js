const STATUS_API_URL = 'https://api.odcloud.kr/api/nts-businessman/v1/status';
const MAX_UPSTREAM_ATTEMPTS = 4;
const UPSTREAM_TIMEOUT_MS = 6000;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export const maxDuration = 30;

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

  let lastFailure = null;
  for (let attempt = 1; attempt <= MAX_UPSTREAM_ATTEMPTS; attempt += 1) {
    try {
      const url = `${STATUS_API_URL}?serviceKey=${encodeURIComponent(apiKey)}&returnType=JSON`;
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
        },
        body: JSON.stringify({ b_no }),
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      });

      if (response.ok) {
        const data = await response.json();
        return res.status(200).json(data);
      }

      const detail = await response.text();
      lastFailure = { status: response.status, detail };
      if (response.status < 500 && response.status !== 429) break;
    } catch (error) {
      lastFailure = { error };
    }
    if (attempt < MAX_UPSTREAM_ATTEMPTS) await sleep(250 * 2 ** (attempt - 1));
  }

  if (lastFailure?.status) {
    if (lastFailure.status < 500 && lastFailure.status !== 429) {
      return res.status(502).json({
        error: `국세청 API 요청이 거부되었습니다. HTTP ${lastFailure.status}`,
        detail: lastFailure.detail,
      });
    }
    res.setHeader('Retry-After', '5');
    return res.status(503).json({
      error: '국세청 API가 일시적으로 불안정합니다. 잠시 후 다시 조회해 주세요.',
      detail: lastFailure.detail,
    });
  }
  res.setHeader('Retry-After', '5');
  return res.status(504).json({ error: '국세청 API 응답 시간이 초과되었습니다. 잠시 후 다시 조회해 주세요.' });
}
