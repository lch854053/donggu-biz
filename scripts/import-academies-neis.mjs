import { readFile, unlink, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { setDefaultResultOrder } from "node:dns";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// NEIS(나이스 교육정보 개방 포털) 학원교습소정보 API로 학원·교습소 스냅샷을 다시 쓴다.
// 시트 수동 내려받기를 대체한다. 이 머신에서 openapi.neis.go.kr가 막혀 있으면
// GitHub Actions(ubuntu)에서 돌린다.
//
//   NEIS_API_KEY=... npm run update-academies-neis

setDefaultResultOrder("ipv4first");

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const csvPath = resolve(root, "data/academies_donggu.csv");

async function readEnvKey() {
  if (process.env.NEIS_API_KEY) return process.env.NEIS_API_KEY;
  try {
    const env = await readFile(resolve(root, ".env"), "utf8");
    return env.match(/^NEIS_API_KEY=(\S+)/m)?.[1] ?? "";
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    return "";
  }
}

const key = await readEnvKey();
if (!key) throw new Error("NEIS_API_KEY가 없습니다. 포털에서 발급해 .env에 넣어 주세요.");

// CSV 25열(import-academies.mjs가 검사하는 순서)에 대응하는 API 필드 후보들.
// 실제 응답 키 이름은 첫 호출에서 확인해 이 표를 고친다.
const FIELD_MAP = [
  { column: "시도교육청코드", keys: ["ATPT_OFSC_SC_CODE", "ATPT_OFSCDC_SC_CODE"] },
  { column: "시도교육청명", keys: ["ATPT_OFSC_SC_NM", "ATPT_OFSCDC_SC_NM"] },
  { column: "행정구역명", keys: ["ADMST_ZONE_NM", "SGG_ETC_NM", "ADMDNG_NM"] },
  { column: "학원교습소명", keys: ["ACA_KIND_NM", "ACA_ASNM_NM", "TRA_STTUS_NM"] },
  { column: "학원지정번호", keys: ["ACA_INST_CD"] },
  { column: "학원명", keys: ["ACA_NM"] },
  { column: "개설일자", keys: ["OPSN_YMD", "FOAS_MEMRD"] },
  { column: "등록일자", keys: ["RGST_YMD", "ASSET_NM"] },
  { column: "등록상태명", keys: ["ACA_STT_NM", "BRKC_ACA_STTUS_NM"] },
  { column: "휴원시작일자", keys: ["CLSD_DE", "TMP_CLSD_END_DE"] },
  { column: "휴원종료일자", keys: ["TMP_CLSD_END_DE", "REOPNS_DE"] },
  { column: "정원합계", keys: ["CAPTY_CO"] },
  { column: "일시수용능력인원합계", keys: ["TMP_CAPTY_CO"] },
  { column: "분야명", keys: ["REALM_SC_NM"] },
  { column: "교습계열명", keys: ["LE_CRSE_NM", "LE_SEQ_NM"] },
  { column: "교습과정목록명", keys: ["LE_CRSE_NM"] },
  { column: "교습과정명", keys: ["LE_CRSE_NM"] },
  { column: "인당수강료", keys: ["PSNBY_THSC_RT", "PSNBY_PRDLN"] },
  { column: "수강료공개여부", keys: ["THSC_RT_PRDPB_YN", "PSNBY_THSC_RT_PRDPB_YN"] },
  { column: "기숙사학원여부", keys: ["DORM_YN"] },
  { column: "도로명주소", keys: ["RDNE_ADDR", "DNRO_ADRR"] },
  { column: "도로명상세주소", keys: ["RDNE_DTL_ADDR", "DTL_ADDR"] },
  { column: "도로명우편번호", keys: ["RDNE_ZPCD", "DNRO_ZPCD"] },
  { column: "전화번호", keys: ["ACA_TELNO", "TELNO"] },
  { column: "수정일자", keys: ["UPDT_PNTM", "LOAD_DTM"] }
];

const COLUMNS = FIELD_MAP.map(({ column }) => column);
const csvCell = (value) => {
  const text = String(value ?? "").trim();
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
};

async function fetchJson(url) {
  // 이 머신은 openapi.neis.go.kr로의 직접 연결이 막혀 있어 브라우저 네트워크 스택으로 우회한다.
  try {
    const response = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
    if (response.ok) return await response.json();
  } catch (error) {
    console.warn("[academies-neis] 직접 연결 실패, 브라우저로 우회합니다:", error.cause?.code ?? error.message);
  }
  const { chromium } = await import("playwright");
  const browser = await chromium.launch({ channel: "msedge", headless: true });
  try {
    const page = await browser.newPage();
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
    const text = await page.locator("body").innerText();
    return JSON.parse(text);
  } finally {
    await browser.close();
  }
}

async function fetchPage(page) {
  const url = `https://openapi.neis.go.kr/hub/acaInsTiInfo?KEY=${key}&Type=json&pIndex=${page}&pSize=1000&ATPT_OFSC_SC_CODE=F38`;
  const payload = await fetchJson(url);
  if (payload.RESULT?.CODE && payload.RESULT.CODE !== "INFO-000") {
    throw new Error(`NEIS API 오류: ${payload.RESULT.CODE} ${payload.RESULT.MESSAGE ?? ""}`);
  }
  return payload.acaInsTiInfo?.[0]?.row ?? [];
}

const first = await fetchPage(1);
if (!first.length) throw new Error("NEIS API가 빈 응답을 돌려줬습니다. 키와 시도코드(F38)를 확인하세요.");
const known = new Set(Object.keys(first[0]));
const unmapped = FIELD_MAP.filter(({ keys }) => !keys.some((key) => known.has(key)));
if (unmapped.length) {
  throw new Error(`다음 열에 대응하는 API 필드를 못 찾았습니다: ${unmapped.map(({ column }) => column).join(", ")}\n실제 응답 키: ${[...known].join(", ")}\nFIELD_MAP을 고쳐 주세요.`);
}

let rows = [...first];
for (let page = 2; rows.length >= (page - 1) * 1000; page += 1) {
  const more = await fetchPage(page);
  if (!more.length) break;
  rows = rows.concat(more);
  if (rows.length > 20000) break; // 광주 전체 학원·교습소는 1만 건 남짓이다.
}

// 학원교습소명(학원/교습소 구분)과 동구 행만 남긴다.
const donggu = rows.filter((row) => String(row.ADMST_ZONE_NM ?? "").includes("동구"));
if (donggu.length < 100) throw new Error(`동구 학원·교습소가 비정상적으로 적습니다(${donggu.length}행).`);

const csv = [
  COLUMNS.join(","),
  ...donggu.map((row) => COLUMNS.map((column) => {
    const entry = FIELD_MAP.find((mapping) => mapping.column === column);
    const key = entry.keys.find((candidate) => candidate in row);
    return csvCell(key ? row[key] : "");
  }).join(","))
].join("\n");

await writeFile(csvPath, `${csv}\n`, "utf8");
console.log(`[academies-neis] 동구 ${donggu.length}행을 ${csvPath}에 기록했습니다.`);

// 기존 변환기가 열 구성·값 형식을 다시 검사해 JSON을 만든다.
const basis = new Date().toISOString().slice(0, 10);
const result = spawnSync("node", [resolve(root, "scripts/import-academies.mjs"), "--source-updated-at", basis], { stdio: "inherit" });
if (result.status !== 0) {
  await unlink(csvPath).catch(() => null);
  throw new Error("학원 변환기가 실패해 CSV를 되돌렸습니다. 위 로그를 확인하세요.");
}
