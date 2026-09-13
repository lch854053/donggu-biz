// 한국부동산원 상업용부동산 임대동향조사 공실률 CSV(충남 데이터포털 올담 재배포본, EUC-KR)를
// data/commercial_vacancy_donggu.json 스냅샷으로 바꾼다.
//
// 사용법:
//   node scripts/import-commercial-vacancy.mjs <공실률 CSV 경로>
//
// 재배포본 받는 곳: 충남 데이터포털 올담 "공실률 조회"
//   https://alldam.chungnam.go.kr/bigdata/collect/view.chungnam?menuCd=DOM_000000201001001000&apiIdx=2548
// 원천: 한국부동산원 상업용부동산 임대동향조사 (분기 공표, data.go.kr 15069726 계열 파일은
// 2016년까지만 담겨 있어 재배포본이 가장 최신을 담는다)
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { setDefaultResultOrder } from "node:dns";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { TextDecoder } from "node:util";
import { buildVacancySnapshot, parseVacancyCsv, assertVacancySnapshotHealthy } from "../lib/commercial-vacancy.js";

setDefaultResultOrder("ipv4first");

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outputPath = resolve(root, "data/commercial_vacancy_donggu.json");
const tempPath = resolve(root, "data/.commercial-vacancy-donggu.tmp");

const inputPath = process.argv[2];
if (!inputPath) throw new Error("사용법: node scripts/import-commercial-vacancy.mjs <공실률 CSV 경로>");

const raw = await readFile(resolve(process.cwd(), inputPath));
// 올담 배포본은 EUC-KR이다. UTF-8로도 읽히는 파일이 들어오면 디코딩 오류 문자를 없애기 위해 두 인코딩을 다 시도한다.
const decoders = ["euc-kr", "utf-8"];
let text = "";
let decoded = false;
for (const encoding of decoders) {
  const candidate = new TextDecoder(encoding, { fatal: false }).decode(raw);
  if (!candidate.includes("\uFFFD") || encoding === decoders.at(-1)) {
    text = candidate;
    decoded = true;
    break;
  }
}
if (!decoded) throw new Error("공실률 CSV를 디코딩하지 못했습니다.");

const areas = parseVacancyCsv(text);
const snapshot = buildVacancySnapshot(areas);
assertVacancySnapshotHealthy(snapshot);

await mkdir(dirname(outputPath), { recursive: true });
await writeFile(tempPath, `${JSON.stringify(snapshot)}\n`, "utf8");
const { rename } = await import("node:fs/promises");
await rename(tempPath, outputPath);
console.log(`[vacancy] 광주 지역 ${snapshot.areas.length}곳, 분기 ${snapshot.meta.quarters.length}개(=${snapshot.meta.quarters[0]}~${snapshot.meta.quarters.at(-1)}) → ${outputPath}`);
