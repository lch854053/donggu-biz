import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// 광주사회적경제지원센터(gjsec.kr) 사회적경제현황은 로그인 없이 CSV로 내려온다.
// EUC-KR 원본을 받아 동구 조직만 골라 정규화 JSON으로 남긴다.
//
//   npm run update-social-economy

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourceUrl = "https://www.gjsec.kr/sub/sub01_03_act.php?mode=dn";
const outputPath = resolve(root, "data/social_economy_donggu.json");
const tempPath = resolve(root, "data/.social-economy-donggu.tmp");

const EXPECTED_HEADER = [
  "기업현황",
  "업체명",
  "대표자",
  "대표번호",
  "주소",
  "구 부분",
  "공식채널",
  "업종·업태",
  "주요사업",
  "인·지정연도"
];

function parseCsv(source) {
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (quoted) {
      if (char === '"' && source[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        cell += char;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === ",") {
      row.push(cell);
      cell = "";
    } else if (char === "\n") {
      row.push(cell.replace(/\r$/, ""));
      rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += char;
    }
  }
  if (cell.length || row.length) rows.push([...row, cell.replace(/\r$/, "")]);
  return rows.filter((values) => values.some((value) => value.trim() !== ""));
}

const response = await fetch(sourceUrl, { headers: { "User-Agent": "Mozilla/5.0" } });
if (!response.ok) throw new Error(`광주사회적경제지원센터 내려받기 실패: HTTP ${response.status}`);
const text = new TextDecoder("euc-kr").decode(Buffer.from(await response.arrayBuffer()));

const rows = parseCsv(text);
const header = rows[0];
if (EXPECTED_HEADER.some((name, index) => header[index] !== name)) {
  throw new Error(`열 구성이 바뀌었습니다. 광주사회적경제지원센터 양식 변화를 확인하세요.\n기대: ${EXPECTED_HEADER.join(", ")}\n실제: ${header.join(", ")}`);
}

const donggu = rows.slice(1)
  .map((row) => ({
    kinds: String(row[0] ?? "").trim().split("/").map((kind) => kind.trim()).filter(Boolean),
    name: String(row[1] ?? "").trim(),
    representative: String(row[2] ?? "").trim(),
    phone: String(row[3] ?? "").trim(),
    address: String(row[4] ?? "").trim(),
    gu: String(row[5] ?? "").trim(),
    website: String(row[6] ?? "").trim(),
    industry: String(row[7] ?? "").trim(),
    business: String(row[8] ?? "").trim(),
    designatedYear: String(row[9] ?? "").trim()
  }))
  .filter((org) => org.name && org.gu === "동구");

const count = (kind) => donggu.filter((org) => org.kinds.includes(kind)).length;
if (donggu.length < 150 || count("사회적기업") < 10 || count("협동조합") + count("사회적협동조합") < 100) {
  throw new Error(`동구 조직 수가 비정상적으로 적습니다(총 ${donggu.length}). 내려받은 목록을 확인하세요.`);
}

const payload = {
  meta: {
    generatedAt: new Date().toISOString(),
    source: "광주사회적경제지원센터 사회적경제현황 (https://www.gjsec.kr/sub/sub01_03.php)",
    region: "광주광역시 동구",
    totalCount: donggu.length,
    kindCounts: Object.fromEntries([...new Set(donggu.flatMap((org) => org.kinds))]
      .map((kind) => [kind, count(kind)]).sort((left, right) => right[1] - left[1]))
  },
  organizations: donggu
};

await mkdir(dirname(outputPath), { recursive: true });
await writeFile(tempPath, `${JSON.stringify(payload, null, 1)}\n`, "utf8");
await rename(tempPath, outputPath);
console.log(`[social-economy] 동구 ${donggu.length}곳을 ${outputPath}에 기록했습니다 (${JSON.stringify(payload.meta.kindCounts)})`);
