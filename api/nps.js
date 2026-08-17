import { compactWorkplace, compactWorkplaceDetail, parseNpsBody, toBizNoPrefix } from '../lib/nps.js';

const BASE_URL = 'https://apis.data.go.kr/B552015/NpsBplcInfoInqireServiceV2';
const MAX_UPSTREAM_ATTEMPTS = 4;
const UPSTREAM_TIMEOUT_MS = 8000;
const MAX_ROWS = 1000;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export const maxDuration = 30;

function boundedInt(value, fallback, min, max) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
}

function digitsOnly(value, maxLength) {
  return String(value ?? '').replace(/[^0-9]/g, '').slice(0, maxLength);
}

function buildRequest(query, apiKey) {
  const action = String(query.action || 'search');
  const params = new URLSearchParams({ serviceKey: apiKey });

  if (action === 'detail') {
    const seq = digitsOnly(query.seq, 20);
    if (!seq) return { error: 'seq 값이 필요합니다.' };
    params.set('seq', seq);
    const month = digitsOnly(query.dataCrtYm, 6);
    if (month) params.set('data_crt_ym', month);
    return { action, url: `${BASE_URL}/getDetailInfoSearchV2?${params}` };
  }

  if (action !== 'search') return { error: `지원하지 않는 action 값입니다: ${action}` };

  params.set('pageNo', String(boundedInt(query.pageNo, 1, 1, 10000)));
  params.set('numOfRows', String(boundedInt(query.numOfRows, 100, 1, MAX_ROWS)));

  const name = String(query.wkplNm ?? '').trim().slice(0, 60);
  if (name) params.set('wkpl_nm', name);
  const bizNo = toBizNoPrefix(query.bzowrRgstNo);
  if (bizNo) params.set('bzowr_rgst_no', bizNo);
  const sido = digitsOnly(query.sido, 2);
  if (sido) params.set('ldong_addr_mgpl_dg_cd', sido);
  const sggu = digitsOnly(query.sggu, 5);
  if (sggu) params.set('ldong_addr_mgpl_sggu_cd', sggu);
  const emd = digitsOnly(query.emd, 5);
  if (emd) params.set('ldong_addr_mgpl_sggu_emd_cd', emd);

  if (!name && !bizNo && !sido) {
    return { error: '사업장명, 사업자등록번호, 지역 중 하나 이상의 조건이 필요합니다.' };
  }
  return { action, url: `${BASE_URL}/getBassInfoSearchV2?${params}` };
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

  const apiKey = process.env.NPS_SERVICE_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'API 키가 설정되지 않았습니다. Vercel 환경변수 NPS_SERVICE_KEY를 확인하세요.' });
  }

  const query = req.query || {};
  const request = buildRequest(query, apiKey);
  if (request.error) return res.status(400).json({ error: request.error });

  let lastFailure = null;
  for (let attempt = 1; attempt <= MAX_UPSTREAM_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetch(request.url, {
        headers: { Accept: 'application/xml, application/json' },
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS)
      });

      const body = await response.text();
      if (response.ok) {
        // 이 서비스는 XML로 응답하며, 서비스키 오류도 XML 오류 문서로 돌아온다.
        let parsed;
        try {
          parsed = parseNpsBody(body);
        } catch (error) {
          return res.status(502).json({ error: error.message, detail: body.slice(0, 300) });
        }
        const compact = request.action === 'detail' ? compactWorkplaceDetail : compactWorkplace;
        return res.status(200).json({
          items: parsed.items.map(compact),
          totalCount: parsed.totalCount,
          pageNo: parsed.pageNo,
          numOfRows: parsed.numOfRows
        });
      }

      lastFailure = { status: response.status, detail: body.slice(0, 500) };
      if (response.status < 500 && response.status !== 429) break;
    } catch (error) {
      lastFailure = { error };
    }
    if (attempt < MAX_UPSTREAM_ATTEMPTS) await sleep(250 * 2 ** (attempt - 1));
  }

  if (lastFailure?.status && lastFailure.status < 500 && lastFailure.status !== 429) {
    return res.status(502).json({
      error: `국민연금 API 요청이 거부되었습니다. HTTP ${lastFailure.status}`,
      detail: lastFailure.detail
    });
  }
  res.setHeader('Retry-After', '5');
  return res.status(503).json({
    error: '국민연금 API가 일시적으로 불안정합니다. 잠시 후 다시 조회해 주세요.',
    detail: lastFailure?.detail
  });
}
