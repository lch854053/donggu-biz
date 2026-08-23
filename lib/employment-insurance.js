export const EMPLOYMENT_INSURANCE_SNAPSHOT_URL = "data/employment_insurance_donggu.json";

export const INSURANCE_TYPE_NAMES = Object.freeze({
  "0": "고용·산재",
  "1": "산재",
  "2": "고용"
});

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

function searchValue(value) {
  return String(value ?? "").toLocaleLowerCase("ko-KR").replace(/\s+/g, "");
}

function managementBase(value) {
  const digits = String(value ?? "").replace(/[^0-9]/g, "");
  return /^\d{11}$/.test(digits) ? digits.slice(0, -1) : "";
}

function coverageManagementKey(row) {
  const base = managementBase(row.workplaceManagementNumber);
  const businessNumber = String(row.businessRegistrationNumber ?? "").replace(/[^0-9]/g, "");
  return base && businessNumber ? `${businessNumber}|${base}` : "";
}

function normalizedIdentity(value) {
  return String(value ?? "").replace(/[\s()（）.,·\-_/]/g, "").toLocaleLowerCase("ko-KR");
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

function mergeCoveragePair(employment, industrial) {
  const employmentRow = withManagementFields(employment);
  const industrialRow = withManagementFields(industrial);
  const managementNumbers = [...new Set([
    employmentRow.workplaceManagementNumber,
    industrialRow.workplaceManagementNumber
  ].filter(Boolean))];
  return {
    ...employmentRow,
    id: `coverage:${employmentRow.id}:${industrialRow.id}`,
    insuranceType: "0",
    insuranceTypeName: INSURANCE_TYPE_NAMES["0"],
    name: employmentRow.name || industrialRow.name,
    postalCode: employmentRow.postalCode || industrialRow.postalCode,
    address: employmentRow.address || industrialRow.address,
    employmentIndustryCode: employmentRow.employmentIndustryCode || industrialRow.employmentIndustryCode,
    employmentIndustryName: employmentRow.employmentIndustryName || industrialRow.employmentIndustryName,
    employmentIndustryCode11: employmentRow.employmentIndustryCode11 || industrialRow.employmentIndustryCode11,
    employmentIndustryName11: employmentRow.employmentIndustryName11 || industrialRow.employmentIndustryName11,
    industrialEstablishedDate: industrialRow.industrialEstablishedDate || employmentRow.industrialEstablishedDate,
    industrialWorkerCount: industrialRow.industrialWorkerCount ?? employmentRow.industrialWorkerCount,
    industrialStatus: industrialRow.industrialStatus || employmentRow.industrialStatus,
    workplaceManagementNumber: managementNumbers.join(" / "),
    workplaceManagementNumbers: managementNumbers,
    employmentWorkplaceManagementNumber: employmentRow.workplaceManagementNumber || null,
    industrialWorkplaceManagementNumber: industrialRow.workplaceManagementNumber || null,
    sourceIds: [employmentRow.id, industrialRow.id]
  };
}

/**
 * 같은 사업장관리번호 본체의 고용 전용(2)·산재 전용(1) 행만 한 사업장으로 합친다.
 * 사업자번호가 같다는 이유만으로 다른 관리번호나 고용·산재 동시가입(0) 행을 합치면
 * 본사·지점·일괄유기 이력이 섞일 수 있으므로, 보완 쌍이 정확히 두 행일 때만 합친다.
 */
export function mergeEmploymentInsuranceRows(rows = []) {
  const groups = new Map();
  for (const row of rows) {
    const key = coverageManagementKey(row);
    if (!key || !["1", "2"].includes(row.insuranceType)) continue;
    const group = groups.get(key) || [];
    group.push(row);
    groups.set(key, group);
  }

  const mergedByKey = new Map();
  for (const [key, group] of groups) {
    const employmentRows = group.filter((row) => row.insuranceType === "2");
    const industrialRows = group.filter((row) => row.insuranceType === "1");
    const identities = new Set(group.map((row) => [
      normalizedIdentity(row.name),
      normalizedIdentity(row.postalCode),
      normalizedIdentity(row.address)
    ].join("|")));
    if (group.length !== 2 || employmentRows.length !== 1 || industrialRows.length !== 1 || identities.size !== 1) continue;
    mergedByKey.set(key, mergeCoveragePair(employmentRows[0], industrialRows[0]));
  }

  const emitted = new Set();
  return rows.map((row) => {
    const key = coverageManagementKey(row);
    const merged = key && mergedByKey.get(key);
    if (!merged) return withManagementFields(row);
    if (emitted.has(key)) return null;
    emitted.add(key);
    return merged;
  }).filter(Boolean);
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
