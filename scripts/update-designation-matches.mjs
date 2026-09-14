import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { designationNameKey } from "../lib/insurance-workplaces.js";

// 지정 목록 세 가지(사회적경제·장애인기업·여성기업)를 4대보험 사업장 조회가
// 걸러 쓸 수 있는 키 색인으로 접는다. 여성기업명부는 사업자번호가 있어 번호로
// 정확히 맞추고, 나머지는 이름 키로 맞춘다. 4대보험 사업장은 동구뿐이므로
// 전남·광주 전체 목록을 섞어 넣어도 동구 밖 이름이 동구 사업장과 겹치는 경우만
// 걸릴 뿐이다.
//
//   npm run update-designation-matches

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outputPath = resolve(root, "data/designation_matches_donggu.json");
const tempPath = resolve(root, "data/.designation-matches-donggu.tmp");

const SOURCES = [
  {
    file: "data/social_economy_donggu.json",
    listKey: "organizations",
    source: "광주사회적경제지원센터 사회적경제현황",
    // 자활기업·마을기업은 네 지정유형에 해당하지 않아 남기지 않는다.
    labels(kindLists) {
      return [...new Set(kindLists.flatMap((kind) => ({ 사회적기업: "사회적기업", 예비사회적기업: "사회적기업", 사회적협동조합: "협동조합", 협동조합: "협동조합", 협동조합연합회: "협동조합" }[kind] || [])))];
    }
  },
  {
    file: "data/disabled_enterprises_jeonnam_gwangju.json",
    listKey: "enterprises",
    source: "(재)장애인기업종합지원센터 SMPP 등록 리스트",
    labels() {
      return ["장애인기업"];
    }
  },
  {
    file: "data/women_enterprises_gwangju.json",
    listKey: "enterprises",
    source: "한국여성경제인협회 광주지회 여성기업명부",
    labels() {
      return ["여성기업"];
    }
  }
];

const byName = new Map();
const byBusinessNumber = new Map();
const sourceCounts = {};
let skippedShortNames = 0;

const addName = (name, labels) => {
  const key = designationNameKey(name);
  if (!key) return;
  // 두 글자 이하 이름("공감" 등)은 동명 업소와 섞일 위험이 크다.
  if ([...key].length < 3) {
    skippedShortNames += 1;
    return;
  }
  const merged = new Set(byName.get(key) || []);
  for (const label of labels) merged.add(label);
  byName.set(key, [...merged]);
};

for (const { file, listKey, source, labels } of SOURCES) {
  const payload = JSON.parse(await readFile(resolve(root, file), "utf8"));
  const rows = payload[listKey] || [];
  let used = 0;
  for (const row of rows) {
    const rowLabels = labels(row.kinds || []);
    if (!rowLabels.length) continue;
    used += 1;
    addName(row.name, rowLabels);
    const digits = String(row.businessNumber ?? "").replace(/[^0-9]/g, "");
    if (digits) {
      const merged = new Set(byBusinessNumber.get(digits) || []);
      for (const label of rowLabels) merged.add(label);
      byBusinessNumber.set(digits, [...merged]);
    }
  }
  sourceCounts[source] = { rows: rows.length, matched: used };
}

const labelCounts = {};
for (const labels of byName.values()) for (const label of labels) labelCounts[label] = (labelCounts[label] || 0) + 1;
if ((labelCounts.사회적기업 || 0) < 10 || (labelCounts.협동조합 || 0) < 100 || (labelCounts.장애인기업 || 0) < 100 || (labelCounts.여성기업 || 0) < 1000) {
  throw new Error(`지정 목록이 비정상적으로 적습니다: ${JSON.stringify(labelCounts)}`);
}

const payload = {
  meta: {
    generatedAt: new Date().toISOString(),
    sources: sourceCounts,
    nameKeyCount: byName.size,
    businessNumberKeyCount: byBusinessNumber.size,
    labelCounts,
    skippedShortNames
  },
  byName: Object.fromEntries([...byName].sort(([left], [right]) => left.localeCompare(right, "ko"))),
  byBusinessNumber: Object.fromEntries([...byBusinessNumber].sort(([left], [right]) => left.localeCompare(right)))
};

await writeFile(tempPath, `${JSON.stringify(payload, null, 1)}\n`, "utf8");
const rename = await import("node:fs/promises").then((fs) => fs.rename);
await rename(tempPath, outputPath);
console.log(`[designations] 이름 키 ${byName.size}개, 사업자번호 키 ${byBusinessNumber.size}개를 ${outputPath}에 기록했습니다 (${JSON.stringify(labelCounts)})`);
