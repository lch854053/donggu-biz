const CORPORATE_MARKER = /㈜|\(주\)|\(유\)|주식회사|유한회사|유한책임회사|합자회사|합명회사|사단법인|재단법인|사회복지법인|의료법인|학교법인|농업회사법인|영농조합법인/;
const LEGAL_FORM = /㈜|\(주\)|\(유\)|주식회사|유한책임회사|유한회사|합자회사|합명회사/g;

export function normalizeBusinessNumber(value) {
  const digits = String(value || "").replace(/[^0-9]/g, "");
  return /^\d{10}$/.test(digits) ? digits : "";
}

export function hasCorporateMarker(name) {
  return CORPORATE_MARKER.test(String(name || ""));
}

export function corporateNameQueries(names) {
  const queries = new Set();
  for (const name of names) {
    const original = String(name || "").replace(/\s+/g, " ").trim();
    if (!original) continue;

    const withoutLegalForm = original.replace(LEGAL_FORM, "").replace(/\s+/g, " ").trim();
    if (withoutLegalForm.length >= 2) queries.add(withoutLegalForm);
    queries.add(original);

    const withoutWorkplaceSuffix = withoutLegalForm
      .replace(/[\s-]*(?:광주(?:광역시)?|동구)?(?:지점|지사|영업소|출장소|사업소|공장|현장)(?:[\s-].*)?$/, "")
      .trim();
    if (withoutWorkplaceSuffix.length >= 2) queries.add(withoutWorkplaceSuffix);
  }
  return [...queries];
}

export function buildCorporatePilotCandidates(items) {
  const grouped = new Map();
  for (const item of items) {
    const businessNumber = normalizeBusinessNumber(item.businessRegistrationNumber);
    if (!businessNumber || !hasCorporateMarker(item.name)) continue;
    const candidate = grouped.get(businessNumber) || {
      businessRegistrationNumber: businessNumber,
      names: new Set(),
      addresses: new Set()
    };
    candidate.names.add(String(item.name || "").trim());
    if (item.address) candidate.addresses.add(String(item.address).trim());
    grouped.set(businessNumber, candidate);
  }
  return [...grouped.values()]
    .map((candidate) => ({
      businessRegistrationNumber: candidate.businessRegistrationNumber,
      names: [...candidate.names].filter(Boolean).sort((left, right) => left.localeCompare(right, "ko")),
      addresses: [...candidate.addresses].filter(Boolean).sort((left, right) => left.localeCompare(right, "ko"))
    }))
    .sort((left, right) => left.businessRegistrationNumber.localeCompare(right.businessRegistrationNumber));
}

function recordDate(item) {
  return [item.lastOpegDt, item.fssCorpChgDtm, item.fstOpegDt]
    .map((value) => String(value || "").replace(/[^0-9]/g, ""))
    .find(Boolean) || "";
}

export function compactCompany(item, businessNumber = item.bzno) {
  return {
    corporateRegistrationNumber: String(item.crno || ""),
    businessRegistrationNumber: normalizeBusinessNumber(businessNumber),
    name: String(item.corpNm || "").trim(),
    englishName: String(item.corpEnsnNm || "").trim(),
    address: String(item.enpBsadr || "").trim(),
    postalCode: String(item.enpOzpno || "").trim(),
    homepage: String(item.enpHmpgUrl || "").trim(),
    industryName: String(item.sicNm || "").trim(),
    establishedDate: String(item.enpEstbDt || "").replace(/[^0-9]/g, ""),
    employeeCount: Number.isFinite(Number(item.enpEmpeCnt)) ? Number(item.enpEmpeCnt) : null,
    smallBusiness: String(item.smenpYn || "").trim(),
    mainBusiness: String(item.enpMainBizNm || "").trim(),
    fiscalMonth: String(item.enpStacMm || "").trim(),
    sourceLastOpenedDate: String(item.lastOpegDt || "").replace(/[^0-9]/g, "")
  };
}

export function normalizeCorporateName(value) {
  return String(value || "").replace(LEGAL_FORM, "").replace(/[^0-9a-zA-Z가-힣]/g, "").toLocaleLowerCase("ko");
}

export function normalizeCorporateAddress(value) {
  return String(value || "")
    .replace(/\([^)]*\)/g, "")
    .replace(/전남광주통합특별시|광주광역시|광주/g, "")
    .replace(/[^0-9a-zA-Z가-힣]/g, "")
    .toLocaleLowerCase("ko");
}

export function corporateAddressesMatch(sourceAddress, candidateAddress) {
  const source = normalizeCorporateAddress(sourceAddress);
  const candidate = normalizeCorporateAddress(candidateAddress);
  if (source.length < 6 || candidate.length < 6 || !/\d/.test(source) || !/\d/.test(candidate)) return false;
  return source.includes(candidate) || candidate.includes(source);
}

export function resolveCorporateAddressMatch(candidate, items) {
  const sourceNames = new Set(candidate.names.map(normalizeCorporateName));
  const byCorporateNumber = new Map();
  for (const item of items) {
    if (normalizeBusinessNumber(item.bzno)) continue;
    if (!sourceNames.has(normalizeCorporateName(item.corpNm))) continue;
    if (!candidate.addresses.some((address) => corporateAddressesMatch(address, item.enpBsadr))) continue;
    const corporateNumber = String(item.crno || "").replace(/[^0-9]/g, "");
    if (!/^\d{13}$/.test(corporateNumber) || corporateNumber === "0000000000000") continue;
    const records = byCorporateNumber.get(corporateNumber) || [];
    records.push(item);
    byCorporateNumber.set(corporateNumber, records);
  }
  if (!byCorporateNumber.size) return { status: "unmatched", addressCandidateCount: 0 };
  if (byCorporateNumber.size > 1) {
    return {
      status: "ambiguous",
      addressCandidateCount: byCorporateNumber.size,
      corporateRegistrationNumbers: [...byCorporateNumber.keys()].sort()
    };
  }
  const [[corporateNumber, records]] = byCorporateNumber;
  const selected = [...records].sort((left, right) => recordDate(right).localeCompare(recordDate(left)))[0];
  return {
    status: "address-matched",
    exactBusinessNumberCandidateCount: 0,
    addressCandidateCount: 1,
    corporateRegistrationNumbers: [corporateNumber],
    company: compactCompany(selected, candidate.businessRegistrationNumber)
  };
}

export function applyManualCorporateOverride(candidate, items, override) {
  if (!override) return null;
  const corporateNumber = String(override.corporateRegistrationNumber || "").replace(/[^0-9]/g, "");
  const records = items.filter((item) => String(item.crno || "").replace(/[^0-9]/g, "") === corporateNumber);
  if (!records.length) throw new Error(`수동 확정 법인이 API 후보에 없습니다: ${candidate.businessRegistrationNumber}/${corporateNumber}`);
  if (records.some((item) => {
    const itemBusinessNumber = normalizeBusinessNumber(item.bzno);
    return itemBusinessNumber && itemBusinessNumber !== candidate.businessRegistrationNumber;
  })) {
    throw new Error(`수동 확정 후보의 사업자등록번호가 원본과 다릅니다: ${candidate.businessRegistrationNumber}/${corporateNumber}`);
  }
  const selected = [...records].sort((left, right) => recordDate(right).localeCompare(recordDate(left)))[0];
  return {
    status: "manual",
    exactBusinessNumberCandidateCount: records.filter((item) => normalizeBusinessNumber(item.bzno) === candidate.businessRegistrationNumber).length,
    corporateRegistrationNumbers: [corporateNumber],
    company: compactCompany(selected, candidate.businessRegistrationNumber),
    manualReview: {
      evidenceUrl: override.evidenceUrl,
      reviewedAt: override.reviewedAt,
      reviewedBy: override.reviewedBy,
      note: String(override.note || "")
    }
  };
}

export function resolveCorporateMatch(businessNumber, items) {
  const normalized = normalizeBusinessNumber(businessNumber);
  const exact = items.filter((item) => normalizeBusinessNumber(item.bzno) === normalized);
  const byCorporateNumber = new Map();
  for (const item of exact) {
    const corporateNumber = String(item.crno || "").replace(/[^0-9]/g, "");
    if (!/^\d{13}$/.test(corporateNumber) || corporateNumber === "0000000000000") continue;
    const records = byCorporateNumber.get(corporateNumber) || [];
    records.push(item);
    byCorporateNumber.set(corporateNumber, records);
  }

  if (byCorporateNumber.size === 0) {
    return { status: "unmatched", exactBusinessNumberCandidateCount: exact.length };
  }
  if (byCorporateNumber.size > 1) {
    return {
      status: "ambiguous",
      exactBusinessNumberCandidateCount: exact.length,
      corporateRegistrationNumbers: [...byCorporateNumber.keys()].sort()
    };
  }

  const [[corporateNumber, records]] = byCorporateNumber;
  const selected = [...records].sort((left, right) => recordDate(right).localeCompare(recordDate(left)))[0];
  return {
    status: "matched",
    exactBusinessNumberCandidateCount: exact.length,
    corporateRegistrationNumbers: [corporateNumber],
    company: compactCompany(selected)
  };
}
