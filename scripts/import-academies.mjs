import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// NEIS 학원교습소정보는 Open API가 아니라 시트(CSV)로만 내려온다. 받아 둔 원본을
// 그대로 두고 검사를 통과한 정규화 JSON을 함께 커밋한다.
//
//   npm run update-academies -- --source-updated-at YYYY-MM-DD

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const inputPath = resolve(root, "data/academies_donggu.csv");
const outputPath = resolve(root, "data/academies_donggu.json");
const tempPath = resolve(root, "data/.academies-donggu.tmp");
const sourceUpdatedAtArgument = process.argv.find((value) => value.startsWith("--source-updated-at="));
const sourceUpdatedAtIndex = process.argv.indexOf("--source-updated-at");
const sourceUpdatedAt = sourceUpdatedAtArgument?.slice("--source-updated-at=".length)
  || (sourceUpdatedAtIndex >= 0 ? process.argv[sourceUpdatedAtIndex + 1] : "");

if (!/^\d{4}-\d{2}-\d{2}$/.test(sourceUpdatedAt || "")) {
  throw new Error("사용법: npm run update-academies -- --source-updated-at YYYY-MM-DD");
}

const EXPECTED_HEADER = [
  "시도교육청코드",
  "시도교육청명",
  "행정구역명",
  "학원교습소명",
  "학원지정번호",
  "학원명",
  "개설일자",
  "등록일자",
  "등록상태명",
  "휴원시작일자",
  "휴원종료일자",
  "정원합계",
  "일시수용능력인원합계",
  "분야명",
  "교습계열명",
  "교습과정목록명",
  "교습과정명",
  "인당수강료",
  "수강료공개여부",
  "기숙사학원여부",
  "도로명주소",
  "도로명상세주소",
  "도로명우편번호",
  "전화번호",
  "수정일자"
];

const STATUS_NAMES = new Set(["개원", "휴원", "폐원", "말소"]);

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;
  const source = text.replace(/^\uFEFF/, "");

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
  return rows.filter((values) => values.some((value) => value !== ""));
}

function value(row, index) {
  return String(row[index] ?? "").trim();
}

function nullableDate(raw) {
  const trimmed = raw.trim();
  if (!trimmed || /^9{8}$/.test(trimmed)) return null;
  if (!/^\d{8}$/.test(trimmed)) throw new Error(`날짜 형식이 올바르지 않습니다: ${trimmed}`);
  return `${trimmed.slice(0, 4)}-${trimmed.slice(4, 6)}-${trimmed.slice(6, 8)}`;
}

function nullableCount(raw, designationNo, field) {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const parsed = Number(trimmed);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${field} 값이 올바르지 않습니다 (${designationNo}): ${raw}`);
  }
  return parsed;
}

// "국어논술(고등):210000, 국어논술(초등)A:140000" → 과정별 수강료 목록.
// 과정 이름에도 쉼표가 들어가므로(예: "리코더, 오카리나 등(초급):70000")
// 콤마로 자른 조각이 ":금액"으로 끝날 때까지 이어 붙여 한 과정으로 묶는다.
function parseFees(raw, designationNo) {
  const trimmed = raw.trim().replace(/^[,\s]+|[,\s]+$/g, "");
  if (!trimmed) return [];
  const fees = [];
  let buffered = "";
  for (const part of trimmed.split(",")) {
    buffered = buffered ? `${buffered},${part}` : part;
    if (!/:\s*\d+$/.test(buffered.trim())) continue;
    const separator = buffered.lastIndexOf(":");
    const fee = Number(buffered.slice(separator + 1).trim());
    if (!Number.isFinite(fee)) throw new Error(`수강료 값이 올바르지 않습니다 (${designationNo}): ${buffered}`);
    fees.push({ course: buffered.slice(0, separator).trim(), fee });
    buffered = "";
  }
  if (buffered.trim()) {
    throw new Error(`수강료 형식이 올바르지 않습니다 (${designationNo}): ${buffered}`);
  }
  return fees;
}

const text = await readFile(inputPath, "utf8");
const rows = parseCsv(text);
const header = rows[0];
if (header.length !== EXPECTED_HEADER.length || EXPECTED_HEADER.some((name, index) => header[index] !== name)) {
  throw new Error(`열 구성이 바뀌었습니다. NEIS 시트 양식 변화를 확인하세요.\n기대: ${EXPECTED_HEADER.join(", ")}\n실제: ${header.join(", ")}`);
}

const seen = new Set();
const academies = rows.slice(1).map((row) => {
  if (row.length !== EXPECTED_HEADER.length) {
    throw new Error(`열 개수가 ${row.length}개인 행이 있습니다(기대 ${EXPECTED_HEADER.length}개): ${row.slice(0, 6).join(" / ")}`);
  }
  const designationNo = value(row, 4);
  if (!designationNo) throw new Error("학원지정번호가 빈 행이 있습니다.");
  if (seen.has(designationNo)) throw new Error(`학원지정번호가 중복됩니다: ${designationNo}`);
  seen.add(designationNo);

  const statusName = value(row, 8);
  if (!STATUS_NAMES.has(statusName)) {
    throw new Error(`등록상태명 값이 추가되었습니다 (${designationNo}): ${statusName}`);
  }

  return {
    officeCode: value(row, 0),
    officeName: value(row, 1),
    regionName: value(row, 2),
    kind: value(row, 3),
    designationNo,
    name: value(row, 5),
    openedAt: nullableDate(row[6]),
    registeredAt: nullableDate(row[7]),
    statusName,
    breakStartAt: nullableDate(row[9]),
    breakEndAt: nullableDate(row[10]),
    capacityTotal: nullableCount(row[11], designationNo, "정원합계"),
    momentaryCapacity: nullableCount(row[12], designationNo, "일시수용능력인원합계"),
    fieldName: value(row, 13),
    courseSeriesName: value(row, 14),
    courseListName: value(row, 15),
    courseName: value(row, 16),
    fees: parseFees(row[17], designationNo),
    feePublic: value(row, 18) === "Y",
    dormitory: value(row, 19) === "Y",
    roadAddress: value(row, 20),
    roadDetailAddress: value(row, 21),
    roadZip: value(row, 22),
    phone: value(row, 23) && value(row, 23) !== "null" ? value(row, 23) : "",
    updatedAt: nullableDate(row[24])
  };
});

const payload = {
  meta: {
    generatedAt: new Date().toISOString(),
    source: "NEIS 학원교습소정보(광주 동구)",
    sourceUpdatedAt,
    totalCount: academies.length,
    counts: {
      byKind: Object.fromEntries([...new Set(academies.map((academy) => academy.kind))]
        .map((kind) => [kind, academies.filter((academy) => academy.kind === kind).length])),
      byStatus: Object.fromEntries([...new Set(academies.map((academy) => academy.statusName))]
        .map((status) => [status, academies.filter((academy) => academy.statusName === status).length]))
    }
  },
  academies
};

await mkdir(dirname(outputPath), { recursive: true });
await writeFile(tempPath, `${JSON.stringify(payload, null, 2)}\n`);
await rename(tempPath, outputPath);
console.log(`[academies] ${academies.length}건을 data/academies_donggu.json으로 변환했습니다 (기준일 ${sourceUpdatedAt}).`);
