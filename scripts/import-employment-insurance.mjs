import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  excelSerialDate,
  insuranceTypeName,
  INSURANCE_TYPE_NAMES,
  workerCount
} from "../lib/employment-insurance.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const inputPath = resolve(root, "data/employment_insurance_donggu.csv");
const outputPath = resolve(root, "data/employment_insurance_donggu.json");
const tempPath = resolve(root, "data/.employment-insurance-donggu.tmp");
const sourceUpdatedAtArgument = process.argv.find((value) => value.startsWith("--source-updated-at="));
const sourceUpdatedAtIndex = process.argv.indexOf("--source-updated-at");
const sourceUpdatedAt = sourceUpdatedAtArgument?.slice("--source-updated-at=".length)
  || (sourceUpdatedAtIndex >= 0 ? process.argv[sourceUpdatedAtIndex + 1] : "");

if (!/^\d{4}-\d{2}-\d{2}$/.test(sourceUpdatedAt || "")) {
  throw new Error("사용법: npm run update-employment-insurance -- --source-updated-at YYYY-MM-DD");
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

function nullableCount(row, field, id) {
  const raw = value(row, field);
  if (!raw) return null;
  const parsed = workerCount(raw);
  if (parsed == null) throw new Error(`${field} 값이 올바르지 않습니다: ${id}`);
  return parsed;
}

function nullableDate(row, field, id) {
  const raw = value(row, field);
  if (!raw) return null;
  const parsed = excelSerialDate(raw);
  if (!parsed) throw new Error(`${field} 값이 올바르지 않습니다: ${id}`);
  return parsed;
}

function countBy(rows, field) {
  return Object.fromEntries([...new Set(rows.map((row) => row[field] || "미기재"))]
    .sort((left, right) => left.localeCompare(right, "ko"))
    .map((key) => [key, rows.filter((row) => (row[field] || "미기재") === key).length]));
}

const rows = parseCsv(new TextDecoder("euc-kr").decode(await readFile(inputPath)));
const [header, ...data] = rows;
const requiredFields = [
  "연번", "보험구분", "사업장명", "사업장우편번호", "사업장주소",
  "고용보험 업종코드", "고용보험 업종명", "산재보험 성립일자", "고용보험 성립일자",
  "산재보험 상시근로자수", "고용보험 상시근로자수", "산재보험 사업구분", "고용보험 사업구분",
  "사업자등록번호", "사업장관리번호", "고용보험 업종코드(제11차)", "고용보험 업종명(제11차)"
];

if (!header || requiredFields.some((field) => !header.includes(field))) {
  throw new Error("필수 컬럼이 없거나 CSV 헤더를 읽지 못했습니다.");
}
if (data.some((values) => values.length !== header.length)) {
  throw new Error("열 개수가 맞지 않는 CSV 행이 있습니다.");
}

const ids = new Set();
const items = data.map((values) => {
  const row = Object.fromEntries(header.map((field, index) => [field, values[index] ?? ""]));
  const id = value(row, "연번");
  const insuranceType = value(row, "보험구분");
  if (!id || ids.has(id)) throw new Error(`연번이 비어 있거나 중복됩니다: ${id || "(blank)"}`);
  if (!Object.hasOwn(INSURANCE_TYPE_NAMES, insuranceType)) {
    throw new Error(`보험구분 값이 올바르지 않습니다: ${id}`);
  }
  if (!value(row, "사업장명")) throw new Error(`사업장명이 비어 있습니다: ${id}`);
  ids.add(id);
  return {
    id,
    insuranceType,
    insuranceTypeName: insuranceTypeName(insuranceType),
    name: value(row, "사업장명"),
    postalCode: value(row, "사업장우편번호"),
    address: value(row, "사업장주소"),
    employmentIndustryCode: value(row, "고용보험 업종코드"),
    employmentIndustryName: value(row, "고용보험 업종명"),
    industrialEstablishedDate: nullableDate(row, "산재보험 성립일자", id),
    employmentEstablishedDate: nullableDate(row, "고용보험 성립일자", id),
    industrialWorkerCount: nullableCount(row, "산재보험 상시근로자수", id),
    employmentWorkerCount: nullableCount(row, "고용보험 상시근로자수", id),
    industrialStatus: value(row, "산재보험 사업구분") || null,
    employmentStatus: value(row, "고용보험 사업구분") || null,
    businessRegistrationNumber: value(row, "사업자등록번호") || null,
    workplaceManagementNumber: value(row, "사업장관리번호") || null,
    employmentIndustryCode11: value(row, "고용보험 업종코드(제11차)"),
    employmentIndustryName11: value(row, "고용보험 업종명(제11차)")
  };
});

const payload = {
  meta: {
    source: "근로복지공단_고용 산재보험 가입 현황",
    sourceUpdatedAt,
    importedAt: new Date().toISOString(),
    region: "광주광역시 동구",
    totalCount: items.length,
    sourceFile: "data/employment_insurance_donggu.csv",
    encoding: "CP949"
  },
  quality: {
    missingIndustrialDate: items.filter((item) => !item.industrialEstablishedDate).length,
    missingEmploymentDate: items.filter((item) => !item.employmentEstablishedDate).length,
    missingIndustrialWorkerCount: items.filter((item) => item.industrialWorkerCount == null).length,
    missingEmploymentWorkerCount: items.filter((item) => item.employmentWorkerCount == null).length,
    missingBusinessRegistrationNumber: items.filter((item) => !item.businessRegistrationNumber).length,
    missingWorkplaceManagementNumber: items.filter((item) => !item.workplaceManagementNumber).length,
    insuranceTypeCounts: countBy(items, "insuranceTypeName"),
    industrialStatusCounts: countBy(items, "industrialStatus"),
    employmentStatusCounts: countBy(items, "employmentStatus")
  },
  items
};

await mkdir(dirname(outputPath), { recursive: true });
await writeFile(tempPath, `${JSON.stringify(payload)}\n`, "utf8");
await rename(tempPath, outputPath);
console.log(`[employment-insurance] wrote ${items.length} workplaces from ${inputPath}`);
