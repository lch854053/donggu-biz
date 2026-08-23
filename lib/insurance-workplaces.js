function text(value) {
  return String(value ?? "").trim();
}

function normalized(value) {
  return text(value).replace(/[\s()（）.,·\-_/]/g, "").toLocaleLowerCase("ko-KR");
}

function businessNumberPrefix(value) {
  return text(value).replace(/[^0-9]/g, "").slice(0, 6);
}

function roadName(address) {
  const parts = text(address).split(/\s+/).filter(Boolean);
  return normalized(parts.find((part) => /(?:로|길)$/.test(part)) || "");
}

function joinKey(name, prefix) {
  const normalizedName = normalized(name);
  return normalizedName && prefix ? `${normalizedName}|${prefix}` : "";
}

function insuranceSourceRows(row) {
  return row?.sourceRows?.length ? row.sourceRows : row ? [row] : [];
}

/**
 * 국민연금은 사업자번호 앞 6자리와 건물번호 없는 도로명만 제공한다.
 * 이름·앞 6자리가 같은 고용·산재 행이 여럿이면 도로명으로 좁히고,
 * 그래도 특정할 수 없을 때는 별도 행으로 남겨 잘못된 합산을 피한다.
 */
export function combineInsuranceWorkplaces(npsRows = [], employmentRows = []) {
  const employmentByKey = new Map();
  const npsKeyCounts = new Map();

  for (const row of employmentRows) {
    for (const sourceRow of insuranceSourceRows(row)) {
      const key = joinKey(sourceRow.name, businessNumberPrefix(sourceRow.businessRegistrationNumber));
      if (!key) continue;
      const group = employmentByKey.get(key) || [];
      if (!group.some((candidate) => candidate.id === row.id)) group.push(row);
      employmentByKey.set(key, group);
    }
  }
  for (const row of npsRows) {
    const key = joinKey(row.name, text(row.bizNoPrefix));
    if (key) npsKeyCounts.set(key, (npsKeyCounts.get(key) || 0) + 1);
  }

  const usedEmploymentIds = new Set();
  const combined = [];
  npsRows.forEach((nps, npsIndex) => {
    const key = joinKey(nps.name, text(nps.bizNoPrefix));
    let candidates = (employmentByKey.get(key) || []).filter((row) => !usedEmploymentIds.has(row.id));
    const ambiguousNps = key && npsKeyCounts.get(key) > 1;

    if (candidates.length > 1 || ambiguousNps) {
      const npsRoad = roadName(nps.address);
      const roadMatches = npsRoad ? candidates.filter((row) => roadName(row.address) === npsRoad) : [];
      candidates = roadMatches.length ? roadMatches : [];
      if (ambiguousNps && candidates.length !== 1) candidates = [];
    }

    if (!candidates.length) {
      combined.push({ key: `nps:${text(nps.seq) || npsIndex}`, nps, employmentInsurance: null, source: "nps" });
      return;
    }

    for (const employmentInsurance of candidates) {
      usedEmploymentIds.add(employmentInsurance.id);
      combined.push({
        key: `combined:${text(nps.seq) || npsIndex}:${employmentInsurance.id}`,
        nps,
        employmentInsurance,
        source: "combined"
      });
    }
  });

  employmentRows.forEach((employmentInsurance, index) => {
    if (usedEmploymentIds.has(employmentInsurance.id)) return;
    combined.push({
      key: `employment:${text(employmentInsurance.id) || index}`,
      nps: null,
      employmentInsurance,
      source: "employment"
    });
  });

  return combined;
}

function searchableValues(row) {
  return [
    row.nps?.name,
    row.nps?.address,
    row.nps?.bizNoPrefix,
    ...insuranceSourceRows(row.employmentInsurance).flatMap((sourceRow) => [
      sourceRow.name,
      sourceRow.address,
      sourceRow.employmentIndustryName,
      sourceRow.employmentIndustryName11,
      sourceRow.employmentIndustryCode,
      sourceRow.businessRegistrationNumber,
      sourceRow.workplaceManagementNumber
    ])
  ].map(normalized).join(" ");
}

function includesInsuranceStatus(row, status) {
  return insuranceSourceRows(row.employmentInsurance).some((sourceRow) => [
    sourceRow.industrialStatus,
    sourceRow.employmentStatus
  ].includes(status));
}

/** 통합 조회 화면의 국민연금·고용·산재 조건을 적용한다. */
export function matchesInsuranceWorkplaceCriteria(row, criteria = {}) {
  const {
    query = "",
    source = "",
    includeWithdrawn = false,
    styleCode = "",
    sectionCode = "",
    unknownIndustryOnly = false,
    registeredFromYear = null,
    registeredToYear = null,
    subscriberMin = null,
    subscriberMax = null,
    insuranceType = "",
    insuranceStatus = ""
  } = criteria;

  if (query && !searchableValues(row).includes(normalized(query))) return false;
  if (source === "nps" && !row.nps) return false;
  if (source === "employment" && !row.employmentInsurance) return false;

  // The old NPS default excluded withdrawn NPS rows. Employment-only rows have
  // no NPS status, so they remain visible in the combined default view.
  if (!includeWithdrawn && source !== "employment" && row.nps && row.nps.statusCode !== "1" && !row.employmentInsurance) {
    return false;
  }
  if (styleCode && (!row.nps || row.nps.styleCode !== styleCode)) return false;
  if (sectionCode && (!row.nps || row.nps.sectionCode !== sectionCode)) return false;
  if (unknownIndustryOnly && (!row.nps || row.nps.sectionCode)) return false;

  if (registeredFromYear != null || registeredToYear != null) {
    const year = Number(String(row.nps?.registeredDate ?? "").slice(0, 4));
    if (!Number.isInteger(year) || year <= 1000) return false;
    if (registeredFromYear != null && year < registeredFromYear) return false;
    if (registeredToYear != null && year > registeredToYear) return false;
  }

  if (subscriberMin != null || subscriberMax != null) {
    const subscribers = row.nps?.subscriberCount;
    if (typeof subscribers !== "number") return false;
    if (subscriberMin != null && subscribers < subscriberMin) return false;
    if (subscriberMax != null && subscribers > subscriberMax) return false;
  }

  if (insuranceType && (!row.employmentInsurance || !insuranceSourceRows(row.employmentInsurance).some((sourceRow) => sourceRow.insuranceType === insuranceType))) return false;
  if (insuranceStatus && (!row.employmentInsurance || !includesInsuranceStatus(row, insuranceStatus))) return false;
  return true;
}

function nullableNumber(value) {
  return typeof value === "number" ? value : null;
}

/** 통합 결과의 정렬. 국민연금 값이 없는 고용·산재 행은 정렬 뒤로 보낸다. */
export function sortInsuranceWorkplaces(rows = [], sortKey = "") {
  const workerCount = (row, kind) => {
    const values = insuranceSourceRows(row.employmentInsurance)
      .filter((sourceRow) => kind === "employment" ? ["0", "2"].includes(sourceRow.insuranceType) : ["0", "1"].includes(sourceRow.insuranceType))
      .map((sourceRow) => sourceRow[kind === "employment" ? "employmentWorkerCount" : "industrialWorkerCount"])
      .filter((value) => typeof value === "number");
    return values.length ? Math.max(...values) : null;
  };
  const values = {
    "name-asc": (row) => row.nps?.name || row.employmentInsurance?.name || "",
    "registered-asc": (row) => row.nps?.registeredDate || "",
    "registered-desc": (row) => row.nps?.registeredDate || "",
    "subscriber-asc": (row) => nullableNumber(row.nps?.subscriberCount),
    "subscriber-desc": (row) => nullableNumber(row.nps?.subscriberCount),
    "employment-desc": (row) => workerCount(row, "employment"),
    "industrial-desc": (row) => workerCount(row, "industrial")
  };
  const valueOf = values[sortKey];
  if (!valueOf) return [...rows];
  const direction = sortKey.endsWith("-desc") ? -1 : 1;

  return rows
    .map((row, index) => ({ row, index, value: valueOf(row) }))
    .sort((left, right) => {
      const leftMissing = left.value == null || left.value === "";
      const rightMissing = right.value == null || right.value === "";
      if (leftMissing || rightMissing) {
        if (leftMissing && rightMissing) return left.index - right.index;
        return leftMissing ? 1 : -1;
      }
      const comparison = typeof left.value === "number" && typeof right.value === "number"
        ? left.value - right.value
        : String(left.value).localeCompare(String(right.value), "ko", { numeric: true, sensitivity: "base" });
      return comparison * direction || left.index - right.index;
    })
    .map(({ row }) => row);
}
