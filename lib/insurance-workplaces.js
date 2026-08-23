import { employmentIndustrySectionCode } from "./employment-insurance.js";

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

function businessNameKeys(value) {
  const raw = text(value);
  if (!raw) return { exact: new Set(), legal: new Set(), relaxed: new Set() };

  const legalName = raw
    .replace(/[（(]\s*(?:주|유)\s*[)）]/g, "")
    .replace(/㈜/g, "")
    .replace(/주식회사|유한회사|합자회사|합명회사|농업회사법인|영농조합법인|사회적협동조합|협동조합/g, "");
  const relaxedName = legalName
    .replace(/[（(][^()（）]*[)）]/g, "")
    .replace(/\s*[\/-]\s*(?:건설)?(?:업)?(?:일용)?(?:관리|일괄).*$/g, "")
    .replace(/(?:대표관리번호|직장)$/g, "");

  return {
    exact: new Set([normalized(raw)].filter(Boolean)),
    legal: new Set([normalized(legalName)].filter(Boolean)),
    relaxed: new Set([normalized(relaxedName)].filter(Boolean))
  };
}

function insuranceSourceRows(row) {
  return row?.sourceRows?.length ? row.sourceRows : row ? [row] : [];
}

function roadNames(row) {
  return new Set(insuranceSourceRows(row)
    .map((sourceRow) => roadName(sourceRow.address))
    .filter(Boolean));
}

/**
 * 국민연금은 사업자번호 앞 6자리와 건물번호 없는 도로명만 제공한다.
 * 법인 표기와 업무 꼬리표를 보정해도 후보가 여럿이면 도로명으로 좁히고,
 * 그래도 특정할 수 없을 때는 별도 행으로 남겨 잘못된 합산을 피한다.
 */
export function combineInsuranceWorkplaces(npsRows = [], employmentRows = []) {
  const employmentByKey = new Map();
  const legacyEmploymentByKey = new Map();
  const npsKeyCounts = {
    exact: new Map(),
    legal: new Map(),
    relaxed: new Map()
  };
  const legacyNpsKeyCounts = new Map();

  for (const row of employmentRows) {
    const key = joinKey(row.name, businessNumberPrefix(row.businessRegistrationNumber));
    if (!key) continue;
    const group = legacyEmploymentByKey.get(key) || [];
    group.push(row);
    legacyEmploymentByKey.set(key, group);
  }

  for (const row of employmentRows) {
    for (const sourceRow of insuranceSourceRows(row)) {
      const prefix = businessNumberPrefix(sourceRow.businessRegistrationNumber);
      const nameKeys = businessNameKeys(sourceRow.name);
      for (const nameKey of [...nameKeys.exact, ...nameKeys.legal, ...nameKeys.relaxed]) {
        const key = joinKey(nameKey, prefix);
        if (!key) continue;
        const group = employmentByKey.get(key) || [];
        if (!group.some((candidate) => candidate.id === row.id)) group.push(row);
        employmentByKey.set(key, group);
      }
    }
  }
  for (const row of npsRows) {
    const legacyKey = joinKey(row.name, text(row.bizNoPrefix));
    if (legacyKey) legacyNpsKeyCounts.set(legacyKey, (legacyNpsKeyCounts.get(legacyKey) || 0) + 1);
    const prefix = text(row.bizNoPrefix);
    const nameKeys = businessNameKeys(row.name);
    for (const level of ["exact", "legal", "relaxed"]) {
      for (const nameKey of nameKeys[level]) {
        const key = joinKey(nameKey, prefix);
        if (key) npsKeyCounts[level].set(key, (npsKeyCounts[level].get(key) || 0) + 1);
      }
    }
  }

  const npsInfos = npsRows.map((nps, npsIndex) => {
    const prefix = text(nps.bizNoPrefix);
    const nameKeys = businessNameKeys(nps.name);
    const collectCandidates = (keys, keyCounts, candidateMap = employmentByKey) => {
      const matched = new Map();
      let ambiguous = false;
      for (const nameKey of keys) {
        const key = joinKey(nameKey, prefix);
        if (!key) continue;
        if (keyCounts.get(key) > 1) ambiguous = true;
        for (const row of candidateMap.get(key) || []) matched.set(row.id, row);
      }
      return { candidates: [...matched.values()], ambiguous };
    };
    return {
      nps,
      npsIndex,
      legacy: collectCandidates(nameKeys.exact, legacyNpsKeyCounts, legacyEmploymentByKey),
      exact: collectCandidates(nameKeys.exact, npsKeyCounts.exact),
      legal: collectCandidates(nameKeys.legal, npsKeyCounts.legal),
      relaxed: collectCandidates(nameKeys.relaxed, npsKeyCounts.relaxed)
    };
  });

  const usedEmploymentIds = new Set();
  const assignments = new Map();
  const assignCandidates = (info, match, relaxed) => {
    let candidates = match.candidates.filter((row) => !usedEmploymentIds.has(row.id));
    if (!candidates.length) return;
    if (candidates.length > 1 || match.ambiguous || relaxed) {
      const npsRoad = roadName(info.nps.address);
      const roadMatches = npsRoad ? candidates.filter((row) => roadNames(row).has(npsRoad)) : [];
      candidates = roadMatches.length ? roadMatches : [];
      if ((match.ambiguous || relaxed) && candidates.length !== 1) return;
    }
    if (!candidates.length) return;
    assignments.set(info.npsIndex, candidates);
    candidates.forEach((row) => usedEmploymentIds.add(row.id));
  };

  // Preserve the original exact-name matching before applying any aliases.
  npsInfos.forEach((info) => assignCandidates(info, info.legacy, false));
  // Exact names from any source row win before legal-name and relaxed labels.
  npsInfos.forEach((info) => {
    if (assignments.has(info.npsIndex) || info.legacy.candidates.length) return;
    assignCandidates(info, info.exact, false);
  });
  npsInfos.forEach((info) => {
    if (assignments.has(info.npsIndex) || info.legacy.candidates.length || info.exact.candidates.length) return;
    assignCandidates(info, info.legal, false);
  });
  npsInfos.forEach((info) => {
    if (assignments.has(info.npsIndex) || info.legacy.candidates.length || info.exact.candidates.length || info.legal.candidates.length) return;
    assignCandidates(info, info.relaxed, true);
  });

  const combined = [];
  npsInfos.forEach(({ nps, npsIndex }) => {
    const candidates = assignments.get(npsIndex);
    if (!candidates?.length) {
      combined.push({ key: `nps:${text(nps.seq) || npsIndex}`, nps, employmentInsurance: null, source: "nps" });
      return;
    }
    for (const employmentInsurance of candidates) {
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

function businessNumberValues(row) {
  return [
    row.nps?.bizNoPrefix,
    ...insuranceSourceRows(row.employmentInsurance).map((sourceRow) => sourceRow.businessRegistrationNumber)
  ].map((value) => text(value).replace(/[^0-9]/g, "")).filter(Boolean);
}

function matchesBusinessNumber(row, query) {
  const digits = text(query).replace(/[^0-9]/g, "");
  if (digits.length < 6) return false;
  return businessNumberValues(row).some((value) => value.startsWith(digits) || digits.startsWith(value));
}

function includesInsuranceStatus(row, status) {
  return insuranceSourceRows(row.employmentInsurance).some((sourceRow) => [
    sourceRow.industrialStatus,
    sourceRow.employmentStatus
  ].includes(status));
}

function employmentIndustrySections(row) {
  return new Set(insuranceSourceRows(row)
    .map((sourceRow) => employmentIndustrySectionCode(sourceRow.employmentIndustryCode11 || sourceRow.employmentIndustryCode))
    .filter(Boolean));
}

/** 국민연금 업종을 기준으로 삼고, 국민연금이 미상일 때만 고용·산재로 보강한다. */
export function insuranceIndustrySectionCodes(row) {
  if (row?.nps?.sectionCode) return new Set([row.nps.sectionCode]);
  return employmentIndustrySections(row?.employmentInsurance);
}

/** 통합 조회 화면의 국민연금·고용·산재 조건을 적용한다. */
export function matchesInsuranceWorkplaceCriteria(row, criteria = {}) {
  const {
    query = "",
    businessNumber = "",
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
  if (businessNumber && !matchesBusinessNumber(row, businessNumber)) return false;
  if (source === "nps" && !row.nps) return false;
  if (source === "employment" && !row.employmentInsurance) return false;

  // The old NPS default excluded withdrawn NPS rows. Employment-only rows have
  // no NPS status, so they remain visible in the combined default view.
  if (!includeWithdrawn && source !== "employment" && row.nps && row.nps.statusCode !== "1" && !row.employmentInsurance) {
    return false;
  }
  if (styleCode && (!row.nps || row.nps.styleCode !== styleCode)) return false;
  const industrySections = insuranceIndustrySectionCodes(row);
  if (sectionCode && !industrySections.has(sectionCode)) return false;
  if (unknownIndustryOnly && industrySections.size) return false;

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
