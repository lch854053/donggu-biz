// 광주광역시 시내버스 승하차 원본(지역화폐 교통카드 거래, 6일 단위 CSV를 담은 ZIP, EUC-KR)을
// data/bus_boarding_gwangju.json 스냅샷으로 합친다.
//
// 사용법:
//   node scripts/import-bus-boarding.mjs <원본 ZIP 또는 CSV 디렉터리>
//
// 원본 받는 곳(data.go.kr, 로그인 불필요):
//   https://www.data.go.kr/data/15088456/fileData.do
//   파일 교체로 첨부 ID가 바뀌면 교육데이터 미러에서 현재 첨부 ID를 확인한다.
//   https://data.edmgr.kr/dataView.do?id=www-data-go-kr-data-filedata-15088456
import { readdir, writeFile, mkdir } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { setDefaultResultOrder } from "node:dns";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { accumulateBusRows, buildBusSnapshot, assertBusSnapshotHealthy, createBusAccumulator } from "../lib/bus-boarding.js";

setDefaultResultOrder("ipv4first");

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outputPath = resolve(root, "data/bus_boarding_gwangju.json");
const tempPath = resolve(root, "data/.bus-boarding-gwangju.tmp");

const inputPath = process.argv[2];
if (!inputPath) throw new Error("사용법: node scripts/import-bus-boarding.mjs <원본 ZIP 또는 CSV 디렉터리>");

// 원본은 EUC-KR이다. Node는 full-ICU로 euc-kr 디코딩을 지원한다.
const decode = (buffer) => new TextDecoder("euc-kr", { fatal: false }).decode(buffer);

async function* csvChunksFromZip(zipPath) {
  const listing = spawnSync("unzip", ["-Z1", zipPath], { encoding: "utf8", maxBuffer: 10 * 1024 * 1024 });
  if (listing.status !== 0) throw new Error(`ZIP 목록을 읽지 못했습니다: ${listing.stderr}`);
  for (const entry of listing.stdout.split(/\r?\n/).filter((name) => name.endsWith(".csv")).sort()) {
    const extracted = spawnSync("unzip", ["-p", zipPath, entry], { maxBuffer: 1024 * 1024 * 1024 });
    if (extracted.status !== 0) throw new Error(`"${entry}"을(를) 풀지 못했습니다: ${extracted.stderr}`);
    yield { name: entry, text: decode(extracted.stdout) };
  }
}

async function* csvChunksFromDir(dirPath) {
  const names = (await readdir(dirPath)).filter((name) => name.endsWith(".csv")).sort();
  if (!names.length) throw new Error(`"${dirPath}"에 CSV가 없습니다.`);
  const { readFile } = await import("node:fs/promises");
  for (const name of names) {
    yield { name, text: decode(await readFile(join(dirPath, name))) };
  }
}

const stat = await (async () => {
  const { stat: fsStat } = await import("node:fs/promises");
  return fsStat(resolve(process.cwd(), inputPath));
})();
const isZip = stat.isFile();

const accumulator = createBusAccumulator();
let chunkCount = 0;
const chunks = isZip ? csvChunksFromZip(resolve(process.cwd(), inputPath)) : csvChunksFromDir(resolve(process.cwd(), inputPath));
for await (const { name, text } of chunks) {
  const lines = text.split(/\r?\n/).filter(Boolean);
  // 배포본에 따라 헤더 열에 공백 패딩이 붙는다(예: "거래일자            ,거래,...").
  const header = lines[0].split(",").map((cell) => cell.trim()).join(",");
  if (!header.startsWith("거래일자,")) throw new Error(`"${name}" 헤더가 예상과 다릅니다: ${header.slice(0, 60)}`);
  const rows = lines.slice(1).map((line) => line.split(","));
  accumulateBusRows(accumulator, rows);
  chunkCount += 1;
  console.log(`[bus] ${name}: 누적 정류장 ${accumulator.stops.size}곳`);
}
if (!chunkCount) throw new Error("집계할 청크가 없습니다.");

const snapshot = buildBusSnapshot(accumulator);
assertBusSnapshotHealthy(snapshot);

await mkdir(dirname(outputPath), { recursive: true });
await writeFile(tempPath, `${JSON.stringify(snapshot)}\n`, "utf8");
const { rename } = await import("node:fs/promises");
await rename(tempPath, outputPath);
console.log(`[bus] ${snapshot.meta.periodStart}~${snapshot.meta.periodEnd}, 정류장 ${snapshot.meta.stopCount}곳, 승차 ${snapshot.meta.totalRides.toLocaleString("ko-KR")}·하차 ${snapshot.meta.totalAlights.toLocaleString("ko-KR")}건 → ${outputPath}`);
