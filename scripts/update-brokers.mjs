import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  BROKER_STATUS_ACTIVE,
  fetchAddressCoordinate,
  fetchBrokerOffices,
  GWANGJU_DONGGU_LD_CODE,
  normalizeBrokerOffice
} from "../lib/broker-offices.js";

// 부동산중개업정보는 VWorld 국가중점데이터API에서 받는데, Actions 러너에서
// api.vworld.kr 연결이 자주 끊긴다. 그래서 한국 네트워크에서 이 스크립트를
// 실행해 스냅샷 파일로 만들고, update-stores는 파일을 읽는다.
//
//   npm run update-brokers

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outputPath = resolve(root, "data/broker_offices_donggu.json");
const tempPath = resolve(root, "data/.broker-offices-donggu.tmp");
const sleep = (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
const GEOCODE_PAUSE_MS = 120;

const key = process.env.VWORLD_KEY;
const domain = process.env.VWORLD_DOMAIN || "https://donggu-biz.vercel.app";
if (!key) throw new Error("VWORLD_KEY 환경변수가 필요합니다.");

const result = await fetchBrokerOffices({
  key,
  domain,
  ldCode: GWANGJU_DONGGU_LD_CODE,
  statusCode: BROKER_STATUS_ACTIVE
});

let geocodedCount = 0;
const offices = [];
for (const raw of result.offices) {
  const office = normalizeBrokerOffice(raw);
  const coordinate = await fetchAddressCoordinate(office.address || office.lotAddress, { key, domain });
  if (coordinate) {
    office.longitude = coordinate.longitude;
    office.latitude = coordinate.latitude;
    geocodedCount += 1;
  }
  offices.push(office);
  await sleep(GEOCODE_PAUSE_MS);
}

const payload = {
  meta: {
    generatedAt: new Date().toISOString(),
    source: "국토교통부_부동산중개업정보(VWorld 국가중점데이터API)",
    endpoint: "https://api.vworld.kr/ned/data/getEBOfficeInfo",
    sourceUpdatedAt: result.lastUpdatedAt,
    totalCount: result.totalCount,
    geocodedCount
  },
  offices
};

await mkdir(dirname(outputPath), { recursive: true });
await writeFile(tempPath, `${JSON.stringify(payload)}\n`);
await rename(tempPath, outputPath);
console.log(`[brokers] ${offices.length}건 (좌표 ${geocodedCount}건)을 data/broker_offices_donggu.json으로 저장했습니다.`);
