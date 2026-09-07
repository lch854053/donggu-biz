import { readFile } from "node:fs/promises";
import { setDefaultResultOrder } from "node:dns";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  LOCALDATA_ADMIN_CODE,
  LOCALDATA_SOURCES,
  LOCALDATA_STATUS_CODES,
  parseLocaldataResponse
} from "../lib/store-license.js";

const REQUEST_TIMEOUT_MS = 20000;
const REQUEST_PAUSE_MS = 200;

const localdataKey = process.env.LOCALDATA_SERVICE_KEY;
if (!localdataKey) throw new Error("LOCALDATA_SERVICE_KEY 환경변수가 필요합니다.");
// 안내 문구의 자리표시자를 그대로 붙여 넣으면 모든 원천이 코드 30으로 떨어져 승인 문제처럼 보인다.
if (/[^\x20-\x7E]/.test(localdataKey) || localdataKey.trim().length < 20) {
  throw new Error(`LOCALDATA_SERVICE_KEY가 서비스키 형태가 아닙니다(${localdataKey.length}자). 공공데이터포털의 일반 인증키를 넣으세요.`);
}
// 인코딩 키를 넣으면 URLSearchParams가 퍼센트 표기를 한 번 더 감싸 게이트웨이가 키를 알아보지 못한다.
if (/%[0-9A-Fa-f]{2}/.test(localdataKey)) {
  console.warn("[probe] 서비스키에 퍼센트 표기가 있습니다. 공공데이터포털의 '일반 인증키(Decoding)'를 사용하세요.");
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const candidatesPath = resolve(root, "data/localdata_source_candidates.json");

setDefaultResultOrder("ipv4first");

const sleep = (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms));

function parseArgs(argv) {
  const args = { scope: "all", status: LOCALDATA_STATUS_CODES.active };
  for (const argument of argv) {
    const [flag, value = ""] = argument.split("=");
    if (flag === "--scope") {
      if (!["all", "configured", "candidates"].includes(value)) throw new Error(`--scope 값이 올바르지 않습니다: ${value}`);
      args.scope = value;
    } else if (flag === "--status") {
      const code = LOCALDATA_STATUS_CODES[value] || value;
      if (!Object.values(LOCALDATA_STATUS_CODES).includes(code)) throw new Error(`--status 값이 올바르지 않습니다: ${value}`);
      args.status = code;
    } else if (flag) {
      throw new Error(`알 수 없는 인자입니다: ${flag}`);
    }
  }
  return args;
}

// 승인 전에도 서비스키 오류(30)와 없는 엔드포인트는 다르게 돌아오므로,
// 엔드포인트가 실재하는지와 활용 승인이 났는지를 한 번에 구분할 수 있다.
function verdict({ httpStatus, serviceCode, parsed, parseError }) {
  if (parsed) return { status: "ready", message: `승인 완료, 동구 ${parsed.totalCount}건` };
  if (serviceCode === "30") return { status: "unapproved", message: "엔드포인트는 있으나 활용 승인이 없습니다 (SERVICE_KEY_IS_NOT_REGISTERED_ERROR)" };
  if (serviceCode === "12" || httpStatus === 404) return { status: "missing", message: `엔드포인트를 찾을 수 없습니다 (HTTP ${httpStatus}${serviceCode ? `, code ${serviceCode}` : ""})` };
  return { status: "error", message: parseError || `HTTP ${httpStatus}${serviceCode ? `, code ${serviceCode}` : ""}` };
}

// 게이트웨이가 이따금 한 요청만 늦어지므로, 통신 실패는 한 번 더 확인한 뒤에 보고한다.
async function probe(endpoint, statusCode) {
  const first = await probeOnce(endpoint, statusCode);
  if (first.status !== "error") return first;
  await sleep(1000);
  return probeOnce(endpoint, statusCode);
}

async function probeOnce(endpoint, statusCode) {
  const url = new URL(endpoint);
  url.search = new URLSearchParams({
    serviceKey: localdataKey,
    pageNo: "1",
    numOfRows: "1",
    returnType: "json",
    "cond[OPN_ATMY_GRP_CD::EQ]": LOCALDATA_ADMIN_CODE,
    "cond[SALS_STTS_CD::EQ]": statusCode
  }).toString();

  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    const text = await response.text();
    let payload = null;
    try {
      payload = JSON.parse(text);
    } catch {
      return verdict({ httpStatus: response.status, serviceCode: "", parseError: "JSON 응답이 아닙니다." });
    }
    const serviceCode = String(payload?.OpenAPI_ServiceResponse?.cmmMsgHeader?.returnReasonCode || "");
    if (serviceCode) return verdict({ httpStatus: response.status, serviceCode });
    try {
      return verdict({ httpStatus: response.status, serviceCode: "", parsed: parseLocaldataResponse(payload) });
    } catch (error) {
      return verdict({ httpStatus: response.status, serviceCode: "", parseError: error.message });
    }
  } catch (error) {
    return { status: "error", message: error.message };
  }
}

async function loadCandidates() {
  try {
    const payload = JSON.parse(await readFile(candidatesPath, "utf8"));
    // 엔드포인트를 유추조차 못 한 후보는 조회할 대상이 없으므로 제외한다.
    return [...(payload.pendingApplications || []), ...(payload.newCandidates || [])]
      .filter((candidate) => candidate.endpoint);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    return [];
  }
}

const args = parseArgs(process.argv.slice(2));
const groups = [];
if (args.scope !== "candidates") {
  groups.push({ label: "설정된 원천", verified: true, sources: LOCALDATA_SOURCES });
}
if (args.scope !== "configured") {
  groups.push({ label: "미도입 후보(엔드포인트 미검증)", verified: false, sources: await loadCandidates() });
}

const counts = {};
for (const group of groups) {
  if (!group.sources.length) continue;
  console.log(`\n== ${group.label} (${group.sources.length}개) ==`);
  for (const source of group.sources) {
    const result = await probe(source.endpoint, args.status);
    counts[result.status] = (counts[result.status] || 0) + 1;
    console.log(`[${result.status.padEnd(10)}] ${source.slug.padEnd(30)} ${source.title} — ${result.message}`);
    await sleep(REQUEST_PAUSE_MS);
  }
}

const probed = Object.values(counts).reduce((total, value) => total + value, 0);
console.log(`\n[probe] ready ${counts.ready || 0} / unapproved ${counts.unapproved || 0} / missing ${counts.missing || 0} / error ${counts.error || 0}`);
// 이미 수집에 쓰던 원천까지 한꺼번에 미승인으로 나오면 승인이 아니라 서비스키를 의심해야 한다.
if (probed && counts.unapproved === probed) {
  console.log("[probe] 모든 원천이 미승인으로 나왔습니다. 개별 승인 문제가 아니라 서비스키가 승인 계정과 다를 가능성이 높습니다.");
  console.log("[probe] 저장소 Secret LOCALDATA_SERVICE_KEY(없으면 SDSC_SERVICE_KEY)에 등록해 둔 키와 같은 값인지 확인하세요.");
} else if (counts.unapproved) {
  console.log("[probe] unapproved 원천은 npm run apply-localdata로 활용신청을 제출하세요.");
}
if (counts.ready) {
  console.log("[probe] 후보 중 ready인 원천만 datasetId를 확인해 lib/store-license.js의 LOCALDATA_SOURCES로 옮기세요.");
}
if (counts.missing) {
  console.log("[probe] missing 후보는 유추한 엔드포인트가 틀린 것이므로 data.go.kr 상세 페이지에서 실제 주소를 확인해야 합니다.");
}
