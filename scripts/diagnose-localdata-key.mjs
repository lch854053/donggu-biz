import { setDefaultResultOrder } from "node:dns";
import { LOCALDATA_ADMIN_CODE, LOCALDATA_SOURCES, LOCALDATA_STATUS_CODES } from "../lib/store-license.js";

// 코드 30이 계속 나올 때 원인이 키인지, 키를 실어 보내는 방식인지, 서비스인지 한 번에 가른다.
const REQUEST_TIMEOUT_MS = 20000;
const BODY_PREVIEW = 700;

setDefaultResultOrder("ipv4first");

// 이미 수집에 쓰고 있어 승인이 확실한 원천을 기준선으로 삼는다.
const baseline = LOCALDATA_SOURCES.find((source) => source.slug === "general_restaurants");

function describeKey(name, value) {
  if (!value) return `${name}: (설정되지 않음)`;
  const shape = /^[0-9a-f]+$/i.test(value) ? "16진수" : /^[A-Za-z0-9+/=]+$/.test(value) ? "base64" : "혼합";
  const percent = /%[0-9A-Fa-f]{2}/.test(value) ? ", 퍼센트 표기 있음" : "";
  const trimmed = value !== value.trim() ? ", 앞뒤 공백 있음" : "";
  return `${name}: ${value.length}자, ${shape}${percent}${trimmed}, ${value.slice(0, 6)}…${value.slice(-4)}`;
}

const query = {
  pageNo: "1",
  numOfRows: "1",
  returnType: "json",
  "cond[OPN_ATMY_GRP_CD::EQ]": LOCALDATA_ADMIN_CODE,
  "cond[SALS_STTS_CD::EQ]": LOCALDATA_STATUS_CODES.active
};

function encodedUrl(key) {
  const url = new URL(baseline.endpoint);
  url.search = new URLSearchParams({ serviceKey: key, ...query }).toString();
  return url.toString();
}

// 게이트웨이가 키를 그대로 받아야 하는 경우를 가려내려고, 재인코딩 없이 이어붙인 형태도 함께 본다.
function rawUrl(key) {
  const rest = new URLSearchParams(query).toString();
  return `${baseline.endpoint}?serviceKey=${key}&${rest}`;
}

async function attempt(label, url) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    const body = await response.text();
    let reason = "";
    try {
      const payload = JSON.parse(body);
      reason = String(payload?.OpenAPI_ServiceResponse?.cmmMsgHeader?.returnReasonCode
        || payload?.response?.header?.resultCode || "");
    } catch {
      reason = "(JSON 아님)";
    }
    console.log(`\n--- ${label} ---`);
    console.log(`HTTP ${response.status}, 코드 ${reason || "(없음)"}`);
    console.log(body.slice(0, BODY_PREVIEW).replace(/\s+/g, " "));
  } catch (error) {
    console.log(`\n--- ${label} ---`);
    console.log(`요청 실패: ${error.message}`);
  }
}

const keys = [
  ["LOCALDATA_SERVICE_KEY", process.env.LOCALDATA_SERVICE_KEY],
  ["SDSC_SERVICE_KEY", process.env.SDSC_SERVICE_KEY]
];

console.log(`기준 원천: ${baseline.title}`);
console.log(`엔드포인트: ${baseline.endpoint}`);
for (const [name, value] of keys) console.log(describeKey(name, value));

for (const [name, value] of keys) {
  if (!value) continue;
  await attempt(`${name} · URLSearchParams 인코딩`, encodedUrl(value.trim()));
  await attempt(`${name} · 원문 그대로`, rawUrl(value.trim()));
}

console.log(`
읽는 법
  코드 0 또는 totalCount가 보이면      → 그 키·방식이 정상입니다.
  두 방식 모두 코드 30                 → 이 키가 data.go.kr 계정과 연결돼 있지 않습니다.
  원문 그대로만 성공                   → 키를 재인코딩하지 않도록 수집 스크립트를 고쳐야 합니다.
  SDSC 키만 성공                       → LOCALDATA_SERVICE_KEY에 SDSC 키를 쓰면 됩니다.`);
