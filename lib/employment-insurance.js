export const EMPLOYMENT_INSURANCE_SNAPSHOT_URL = "data/employment_insurance_donggu.json";

export const INSURANCE_TYPE_NAMES = Object.freeze({
  "0": "고용·산재",
  "1": "산재",
  "2": "고용"
});

// 고용·산재 원본의 업종코드(제11차)는 국민연금의 옛 코드 체계와 숫자 구간이
// 다르다. 화면의 공통 대분류 코드에 업종 의미를 맞춰 고용·산재 전용 행도 같은
// 선택기로 조회할 수 있게 한다.
const EMPLOYMENT_INDUSTRY_SECTION_RANGES = Object.freeze([
  { code: "A", from: 1, to: 3 },
  { code: "C", from: 5, to: 8 },
  { code: "D", from: 10, to: 34 },
  { code: "E", from: 35, to: 39 },
  { code: "F", from: 41, to: 42 },
  { code: "G", from: 45, to: 47 },
  { code: "I", from: 49, to: 52 },
  { code: "H", from: 55, to: 56 },
  { code: "J", from: 58, to: 63 },
  { code: "K", from: 64, to: 66 },
  { code: "L", from: 68, to: 68 },
  { code: "M", from: 70, to: 76 },
  { code: "N", from: 84, to: 84 },
  { code: "O", from: 85, to: 85 },
  { code: "P", from: 86, to: 87 },
  { code: "Q", from: 90, to: 96 },
  { code: "R", from: 97, to: 98 },
  { code: "S", from: 99, to: 99 }
]);

export const EMPLOYMENT_INSURANCE_STATUS_NAMES = Object.freeze([
  "계속",
  "일괄유기",
  "일괄계속",
  "계속(일괄전환)",
  "유기"
]);

export function insuranceTypeName(value) {
  return INSURANCE_TYPE_NAMES[String(value ?? "")] || "알 수 없음";
}

/** 공공데이터 CSV의 Excel 날짜 serial을 화면과 JSON에서 쓰는 ISO 날짜로 바꾼다. */
export function excelSerialDate(value) {
  if (value == null || String(value).trim() === "") return null;
  const serial = Number(value);
  if (!Number.isInteger(serial) || serial <= 0) return null;
  const date = new Date(Date.UTC(1899, 11, 30) + serial * 86400000);
  return Number.isFinite(date.getTime()) ? date.toISOString().slice(0, 10) : null;
}

export function workerCount(value) {
  if (value == null || String(value).trim() === "") return null;
  const count = Number(value);
  return Number.isInteger(count) && count >= 0 ? count : null;
}

/** 고용·산재 제11차 업종코드를 통합 조회 화면의 대분류 코드로 바꾼다. */
export function employmentIndustrySectionCode(value) {
  const digits = String(value ?? "").replace(/[^0-9]/g, "");
  if (!digits || digits === "000000" || digits === "999999") return "";
  const division = Number(digits.slice(0, 2));
  if (!Number.isInteger(division)) return "";
  return EMPLOYMENT_INDUSTRY_SECTION_RANGES.find((range) => division >= range.from && division <= range.to)?.code || "";
}

function searchValue(value) {
  return String(value ?? "").toLocaleLowerCase("ko-KR").replace(/\s+/g, "");
}

function withManagementFields(row) {
  const management = String(row.workplaceManagementNumber ?? "").trim();
  const employmentCovered = ["0", "2"].includes(row.insuranceType);
  const industrialCovered = ["0", "1"].includes(row.insuranceType);
  return {
    ...row,
    workplaceManagementNumbers: management ? [management] : [],
    employmentWorkplaceManagementNumber: employmentCovered ? management || null : null,
    industrialWorkplaceManagementNumber: industrialCovered ? management || null : null
  };
}

/**
 * 같은 사업자등록번호의 원본 행을 한 사업장 그룹으로 만든다. 사업장관리번호는
 * 상세에서 원본별로 보존하고, 화면의 보험별 수치는 그룹 안의 모든 원본을 보여 준다.
 */
export function mergeEmploymentInsuranceRows(rows = []) {
  const groups = new Map();
  const ungrouped = [];
  for (const row of rows) {
    const businessNumber = String(row.businessRegistrationNumber ?? "").replace(/[^0-9]/g, "");
    if (!businessNumber) {
      ungrouped.push(withManagementFields(row));
      continue;
    }
    const group = groups.get(businessNumber) || [];
    group.push(withManagementFields(row));
    groups.set(businessNumber, group);
  }

  const grouped = [...groups.values()].map((sourceRows) => {
    const first = sourceRows[0];
    const types = [...new Set(sourceRows.map((row) => row.insuranceType))];
    const employmentRows = sourceRows.filter((row) => ["0", "2"].includes(row.insuranceType));
    const industrialRows = sourceRows.filter((row) => ["0", "1"].includes(row.insuranceType));
    const managementNumbers = [...new Set(sourceRows.flatMap((row) => row.workplaceManagementNumbers))];
    const insuranceType = types.includes("0") || (types.includes("1") && types.includes("2")) ? "0" : types[0] || "";
    return {
      ...first,
      id: `business:${first.businessRegistrationNumber}`,
      insuranceType,
      insuranceTypeName: types.map((type) => INSURANCE_TYPE_NAMES[type] || type).join(" · "),
      sourceRows,
      insuranceTypes: types,
      employmentWorkerCount: employmentRows[0]?.employmentWorkerCount ?? null,
      industrialWorkerCount: industrialRows[0]?.industrialWorkerCount ?? null,
      employmentStatus: employmentRows.find((row) => row.employmentStatus)?.employmentStatus || null,
      industrialStatus: industrialRows.find((row) => row.industrialStatus)?.industrialStatus || null,
      employmentEstablishedDate: employmentRows.find((row) => row.employmentEstablishedDate)?.employmentEstablishedDate || null,
      industrialEstablishedDate: industrialRows.find((row) => row.industrialEstablishedDate)?.industrialEstablishedDate || null,
      workplaceManagementNumber: managementNumbers.join(" / "),
      workplaceManagementNumbers: managementNumbers,
      employmentWorkplaceManagementNumber: employmentRows[0]?.workplaceManagementNumber || null,
      industrialWorkplaceManagementNumber: industrialRows[0]?.workplaceManagementNumber || null,
      sourceIds: sourceRows.map((row) => row.id)
    };
  });

  return [...grouped, ...ungrouped];
}

export function matchesEmploymentInsuranceCriteria(row, criteria = {}) {
  const query = searchValue(criteria.query);
  if (query) {
    const searchable = [
      row.name,
      row.address,
      row.employmentIndustryName,
      row.employmentIndustryName11,
      row.employmentIndustryCode,
      row.businessRegistrationNumber,
      row.workplaceManagementNumber
    ].map(searchValue).join(" ");
    if (!searchable.includes(query)) return false;
  }
  if (criteria.insuranceType && row.insuranceType !== criteria.insuranceType) return false;
  if (criteria.status && ![row.industrialStatus, row.employmentStatus].includes(criteria.status)) return false;
  return true;
}

function compareNullableNumber(left, right, direction) {
  const leftValue = typeof left === "number" ? left : -1;
  const rightValue = typeof right === "number" ? right : -1;
  return (leftValue - rightValue) * direction;
}

export function sortEmploymentInsuranceRows(rows, sort = "") {
  return [...rows].sort((left, right) => {
    if (sort === "employment-desc") {
      return compareNullableNumber(left.employmentWorkerCount, right.employmentWorkerCount, -1);
    }
    if (sort === "industrial-desc") {
      return compareNullableNumber(left.industrialWorkerCount, right.industrialWorkerCount, -1);
    }
    if (sort === "name-asc") {
      return String(left.name).localeCompare(String(right.name), "ko");
    }
    return String(left.id).localeCompare(String(right.id), "en", { numeric: true });
  });
}
