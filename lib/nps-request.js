// 국민연금 가입 사업장 내역 API 요청 URL 조립. 프록시(api/nps.js)와 수집 스크립트가 함께 쓴다.
//
// 조회 조건 파라미터는 스펙 문서(스네이크)와 실제 게이트웨이(카멜) 표기가 엇갈리고,
// 법정동코드도 하위 코드만 받는 쪽과 상위 코드를 포함한 쪽 설명이 엇갈린다.
// 그래서 표기·코드 형식 조합을 순서대로 시도해 결과가 나오는 조합을 고른다.

export const NPS_BASE_URL = 'https://apis.data.go.kr/B552015/NpsBplcInfoInqireServiceV2';

// 이 서비스는 한 페이지 100건까지만 허용한다. 넘기면 게이트웨이가 CLIENT_ERROR(97)로 끊는다.
export const NPS_MAX_ROWS = 100;

export const NPS_VARIANTS = [
  { style: 'camel', region: 'asIs' },
  { style: 'camel', region: 'prefixed' },
  { style: 'snake', region: 'asIs' },
  { style: 'snake', region: 'prefixed' }
];

const SNAKE_NAMES = {
  wkplNm: 'wkpl_nm',
  bzowrRgstNo: 'bzowr_rgst_no',
  ldongAddrMgplDgCd: 'ldong_addr_mgpl_dg_cd',
  ldongAddrMgplSgguCd: 'ldong_addr_mgpl_sggu_cd',
  ldongAddrMgplSgguEmdCd: 'ldong_addr_mgpl_sggu_emd_cd'
};

/** 하위 코드만 들어온 시군구·읍면동 코드에 상위 코드를 붙여 누적 형식으로 만든다. */
export function prefixRegion({ sido = '', sggu = '', emd = '' }) {
  const fullSggu = sggu.length === 3 && sido ? `${sido}${sggu}` : sggu;
  const fullEmd = emd.length === 3 && fullSggu.length === 5 ? `${fullSggu}${emd}` : emd;
  return { sido, sggu: fullSggu, emd: fullEmd };
}

/**
 * 오퍼레이션 URL을 만든다. params는 카멜 이름으로 주고, region은 시도·시군구·읍면동
 * 하위 코드를 담는다. variant에 따라 이름 표기와 코드 형식이 정해진다.
 */
export function npsRequestUrl({ operation, apiKey, params = {}, region = {}, variant = NPS_VARIANTS[0] }) {
  const codes = variant.region === 'prefixed' ? prefixRegion(region) : region;
  const all = { ...params };
  if (codes.sido) all.ldongAddrMgplDgCd = codes.sido;
  if (codes.sggu) all.ldongAddrMgplSgguCd = codes.sggu;
  if (codes.emd) all.ldongAddrMgplSgguEmdCd = codes.emd;

  const search = new URLSearchParams({ serviceKey: apiKey });
  for (const [name, value] of Object.entries(all)) {
    search.set(variant.style === 'snake' ? SNAKE_NAMES[name] ?? name : name, value);
  }
  return `${NPS_BASE_URL}/${operation}?${search}`;
}

/**
 * 발급 화면의 "인코딩 키"를 그대로 쓰면 쿼리 조립 때 %가 한 번 더 인코딩되어 키가 깨진다.
 * 퍼센트 표기가 보이면 한 번 풀어서 디코딩 키로 맞춘다.
 */
export function normalizeServiceKey(raw) {
  const key = String(raw ?? '').trim();
  if (!/%[0-9A-Fa-f]{2}/.test(key)) return key;
  try {
    return decodeURIComponent(key);
  } catch {
    return key;
  }
}
