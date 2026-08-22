import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const inputPath = resolve(root, "data/medical_stores_donggu.csv");
const outputPath = resolve(root, "data/medical_stores_donggu.json");
const tempPath = resolve(root, "data/.medical-stores-donggu.tmp");
const sourceUpdatedAt = process.argv.find((value) => value.startsWith("--source-updated-at="))?.split("=")[1]
  || process.argv[process.argv.indexOf("--source-updated-at") + 1];

if (!/^\d{4}-\d{2}-\d{2}$/.test(sourceUpdatedAt || "")) {
  throw new Error("사용법: npm run update-medical-stores -- --source-updated-at YYYY-MM-DD");
}

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

function value(row, field) {
  return String(row[field] ?? "").trim();
}

const rows = parseCsv(await readFile(inputPath, "utf8"));
const [header, ...data] = rows;
const requiredFields = [
  "상가업소번호", "상호명", "상권업종대분류코드", "상권업종대분류명",
  "상권업종중분류코드", "상권업종중분류명", "상권업종소분류코드", "상권업종소분류명",
  "시도코드", "시도명", "시군구코드", "시군구명", "행정동코드", "행정동명",
  "법정동코드", "법정동명", "지번주소", "도로명주소", "건물명", "신우편번호",
  "동정보", "층정보", "호정보", "경도", "위도"
];

for (const field of requiredFields) {
  if (!header.includes(field)) throw new Error(`필수 컬럼이 없습니다: ${field}`);
}

const records = data.map((values) => Object.fromEntries(header.map((field, index) => [field, values[index] ?? ""])));
const dongguRows = records.filter((row) => value(row, "시도코드") === "29" && value(row, "시군구코드") === "29110");
if (!dongguRows.length) throw new Error("광주 동구(시도코드 29, 시군구코드 29110) 데이터가 없습니다.");
if (dongguRows.some((row) => value(row, "상권업종대분류명") !== "의료")) {
  throw new Error("의료기관 자료가 아닌 업종이 포함되어 있습니다.");
}

const ids = new Set();
const stores = dongguRows.map((row) => {
  const id = value(row, "상가업소번호");
  const longitude = Number(value(row, "경도"));
  const latitude = Number(value(row, "위도"));
  if (!id) throw new Error("상가업소번호가 비어 있는 행이 있습니다.");
  if (ids.has(id)) throw new Error(`상가업소번호가 중복됩니다: ${id}`);
  if (!Number.isFinite(longitude) || !Number.isFinite(latitude)) {
    throw new Error(`좌표가 올바르지 않습니다: ${id}`);
  }
  ids.add(id);
  return {
    id,
    name: value(row, "상호명"),
    branch: value(row, "지점명"),
    largeCode: value(row, "상권업종대분류코드"),
    largeName: value(row, "상권업종대분류명"),
    middleCode: value(row, "상권업종중분류코드"),
    middleName: value(row, "상권업종중분류명"),
    smallCode: value(row, "상권업종소분류코드"),
    smallName: value(row, "상권업종소분류명"),
    standardIndustryCode: value(row, "표준산업분류코드"),
    standardIndustryName: value(row, "표준산업분류명"),
    adminDongCode: value(row, "행정동코드"),
    adminDong: value(row, "행정동명"),
    legalDongCode: value(row, "법정동코드"),
    legalDong: value(row, "법정동명"),
    address: value(row, "도로명주소") || value(row, "지번주소"),
    lotAddress: value(row, "지번주소"),
    buildingName: value(row, "건물명"),
    postalCode: value(row, "신우편번호") || value(row, "구우편번호"),
    dong: value(row, "동정보"),
    floor: value(row, "층정보"),
    room: value(row, "호정보"),
    longitude,
    latitude
  };
}).sort((a, b) => a.id.localeCompare(b.id));

const payload = {
  meta: {
    source: "소상공인시장진흥공단_상가(상권)정보_의료기관",
    sourceUpdatedAt,
    importedAt: new Date().toISOString(),
    sigunguCode: "29110",
    totalCount: stores.length,
    sourceFile: "data/medical_stores_donggu.csv"
  },
  quality: {
    missingStandardIndustry: stores.filter((store) => !store.standardIndustryCode || !store.standardIndustryName).length,
    missingBuildingName: stores.filter((store) => !store.buildingName).length,
    missingFloor: stores.filter((store) => !store.floor).length,
    missingRoom: stores.filter((store) => !store.room).length
  },
  stores
};

await mkdir(dirname(outputPath), { recursive: true });
await writeFile(tempPath, `${JSON.stringify(payload)}\n`, "utf8");
await rename(tempPath, outputPath);
console.log(`[medical-stores] wrote ${stores.length} stores from ${inputPath}`);
