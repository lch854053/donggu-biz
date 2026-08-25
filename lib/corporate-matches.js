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
    const candidate = grouped.get(businessNumber) || { businessRegistrationNumber: businessNumber, names: new Set() };
    candidate.names.add(String(item.name || "").trim());
    grouped.set(businessNumber, candidate);
  }
  return [...grouped.values()]
    .map((candidate) => ({
      businessRegistrationNumber: candidate.businessRegistrationNumber,
      names: [...candidate.names].filter(Boolean).sort((left, right) => left.localeCompare(right, "ko"))
    }))
    .sort((left, right) => left.businessRegistrationNumber.localeCompare(right.businessRegistrationNumber));
}

function recordDate(item) {
  return [item.lastOpegDt, item.fssCorpChgDtm, item.fstOpegDt]
    .map((value) => String(value || "").replace(/[^0-9]/g, ""))
    .find(Boolean) || "";
}

function compactCompany(item) {
  return {
    corporateRegistrationNumber: String(item.crno || ""),
    businessRegistrationNumber: normalizeBusinessNumber(item.bzno),
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
