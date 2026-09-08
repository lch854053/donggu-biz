// 승인이 확인된 후보를 LOCALDATA_SOURCES로 옮긴다.
//
//   npm run promote-localdata            옮길 대상만 보여 준다
//   npm run promote-localdata -- --write 실제로 lib/store-license.js를 고친다
//
// 기본은 실제로 조회되는지 확인한 원천만 옮긴다. --skip-probe를 주면 확인을 건너뛰지만,
// 승인되지 않은 원천이 섞이면 수집이 통째로 실패하므로 권하지 않는다.
import { readFile, writeFile } from "node:fs/promises";
import { setDefaultResultOrder } from "node:dns";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  LOCALDATA_ADMIN_CODE,
  LOCALDATA_STATUS_CODES,
  parseLocaldataResponse
} from "../lib/store-license.js";
import { insertLocaldataSources } from "../lib/localdata-source-file.js";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const candidatesPath = resolve(root, "data/localdata_source_candidates.json");
const sourceFilePath = resolve(root, "lib/store-license.js");
const REQUEST_TIMEOUT_MS = 60000;

setDefaultResultOrder("ipv4first");

function parseArgs(argv) {
  const args = { write: false, probe: true, priorities: null };
  for (const argument of argv) {
    const [flag, value = ""] = argument.split("=");
    if (flag === "--write") args.write = true;
    else if (flag === "--skip-probe") args.probe = false;
    else if (flag === "--priority") args.priorities = new Set(value.split(",").map(Number).filter(Boolean));
    else if (flag) throw new Error(`알 수 없는 인자입니다: ${flag}`);
  }
  return args;
}

async function probeReady(endpoint, serviceKey) {
  const url = new URL(endpoint);
  url.search = new URLSearchParams({
    serviceKey,
    pageNo: "1",
    numOfRows: "1",
    returnType: "json",
    "cond[OPN_ATMY_GRP_CD::EQ]": LOCALDATA_ADMIN_CODE,
    "cond[SALS_STTS_CD::EQ]": LOCALDATA_STATUS_CODES.active
  }).toString();
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    const payload = JSON.parse(await response.text());
    const code = String(payload?.OpenAPI_ServiceResponse?.cmmMsgHeader?.returnReasonCode || "");
    if (code === "30") return { ready: false, note: "활용 승인이 아직 없습니다." };
    if (code) return { ready: false, note: `게이트웨이 코드 ${code}` };
    const parsed = parseLocaldataResponse(payload);
    return { ready: true, note: `동구 ${parsed.totalCount}건` };
  } catch (error) {
    return { ready: false, note: error.message };
  }
}

const args = parseArgs(process.argv.slice(2));
const candidates = JSON.parse(await readFile(candidatesPath, "utf8"));
let pool = (candidates.newCandidates || []).filter(({ datasetId, endpoint }) => datasetId && endpoint);
if (args.priorities) pool = pool.filter(({ priority }) => args.priorities.has(priority));

if (!pool.length) {
  console.log("옮길 후보가 없습니다. npm run authorize-localdata를 먼저 실행하세요.");
  process.exit(0);
}

const serviceKey = process.env.LOCALDATA_SERVICE_KEY;
if (args.probe && !serviceKey) {
  throw new Error("LOCALDATA_SERVICE_KEY 환경변수가 필요합니다. 확인 없이 옮기려면 --skip-probe를 붙이세요.");
}

const ready = [];
const held = [];
for (const candidate of pool) {
  if (!args.probe) {
    ready.push(candidate);
    continue;
  }
  const result = await probeReady(candidate.endpoint, serviceKey);
  console.log(`[${result.ready ? "ready" : "hold "}] ${candidate.slug.padEnd(38)} ${result.note}`);
  (result.ready ? ready : held).push(result.ready ? candidate : { ...candidate, holdNote: result.note });
}

console.log(`\n옮길 수 있는 원천 ${ready.length}종 / 보류 ${held.length}종`);
for (const entry of ready) console.log(`  + ${entry.slug}\t${entry.title}`);

if (!args.write) {
  console.log("\n확인 모드입니다. 실제로 옮기려면 --write를 붙여 다시 실행하세요.");
  process.exit(0);
}
if (!ready.length) process.exit(0);

const fileText = await readFile(sourceFilePath, "utf8");
const { text, added, skipped } = insertLocaldataSources(fileText, ready);
for (const entry of skipped) console.log(`  - ${entry.slug}: ${entry.reason}`);
if (!added.length) {
  console.log("추가된 원천이 없습니다.");
  process.exit(0);
}
await writeFile(sourceFilePath, text, "utf8");

const promoted = new Set(added.map(({ slug }) => slug));
candidates.newCandidates = (candidates.newCandidates || []).filter(({ slug }) => !promoted.has(slug));
candidates.meta = { ...candidates.meta, promotedAt: new Date().toISOString() };
await writeFile(candidatesPath, `${JSON.stringify(candidates, null, 2)}\n`, "utf8");

console.log(`\nLOCALDATA_SOURCES에 ${added.length}종을 추가했습니다. npm test로 확인한 뒤 수집을 돌리세요.`);
