import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { hydrateSnapshotWorkplace } from "../lib/nps.js";
import { mergeEmploymentInsuranceRows } from "../lib/employment-insurance.js";
import { DONGGU_ADMIN_DONGS } from "../lib/admin-dong.js";
import {
  combineInsuranceWorkplaces,
  designationNameKey,
  insuranceAdminDongs,
  insuranceIndustrySectionCodes,
  matchesInsuranceWorkplaceCriteria,
  resolveWorkplaceDesignations,
  sortInsuranceWorkplaces
} from "../lib/insurance-workplaces.js";

const [npsSnapshot, employmentSnapshot, indexHtml, appJs] = await Promise.all([
  readFile(new URL("../data/nps_donggu.json", import.meta.url), "utf8").then(JSON.parse),
  readFile(new URL("../data/employment_insurance_donggu.json", import.meta.url), "utf8").then(JSON.parse),
  readFile(new URL("../index.html", import.meta.url), "utf8"),
  readFile(new URL("../app.js", import.meta.url), "utf8")
]);

const nps = {
  seq: "nps-1",
  name: "광주동구청",
  bizNoPrefix: "408815",
  address: "광주광역시 동구 서남로",
  adminDong: "서남동",
  statusCode: "1",
  styleCode: "1",
  sectionCode: "N",
  registeredDate: "20050301",
  subscriberCount: 12,
  historyRows: []
};

const employment = {
  id: "ei-1",
  insuranceType: "0",
  insuranceTypeName: "고용·산재",
  name: "광주동구청",
  address: "광주 동구 서남로 1",
  adminDong: "서남동",
  businessRegistrationNumber: "4088152345",
  employmentWorkerCount: 8,
  industrialWorkerCount: 7,
  employmentStatus: "계속",
  industrialStatus: "계속"
};

test("combines matching records and keeps unmatched records in the same result", () => {
  const rows = combineInsuranceWorkplaces([nps], [employment, { ...employment, id: "ei-2", name: "다른 사업장", businessRegistrationNumber: "1234567890" }]);

  assert.equal(rows.length, 2);
  assert.equal(rows[0].source, "combined");
  assert.equal(rows[0].nps.seq, "nps-1");
  assert.equal(rows[0].employmentInsurance.id, "ei-1");
  assert.equal(rows[1].source, "employment");
  assert.equal(rows[1].nps, null);
});

test("does not merge an ambiguous same-name workplace without a matching road", () => {
  const rows = combineInsuranceWorkplaces(
    [nps, { ...nps, seq: "nps-2", address: "광주광역시 동구 중앙로" }],
    [{ ...employment, address: "광주 동구 금남로 1" }]
  );

  assert.equal(rows.length, 3);
  assert.ok(rows.every((row) => row.source !== "combined"));
});

test("combined criteria search both data sources and insurance filters", () => {
  const [row] = combineInsuranceWorkplaces([nps], [employment]);

  assert.equal(matchesInsuranceWorkplaceCriteria(row, { query: "서남로" }), true);
  assert.equal(matchesInsuranceWorkplaceCriteria(row, { insuranceType: "2" }), false);
  assert.equal(matchesInsuranceWorkplaceCriteria(row, { insuranceStatus: "계속" }), true);
  assert.equal(matchesInsuranceWorkplaceCriteria(row, { source: "employment", subscriberMin: 20 }), false);
  assert.equal(matchesInsuranceWorkplaceCriteria(row, { source: "nps", sectionCode: "N" }), true);
  assert.equal(matchesInsuranceWorkplaceCriteria(row, { adminDong: "서남동" }), true);
  assert.equal(matchesInsuranceWorkplaceCriteria(row, { adminDong: "충장동" }), false);
  assert.deepEqual([...insuranceAdminDongs(row)], ["서남동"]);
});

test("business registration search accepts a six-digit prefix or full number", () => {
  const [row] = combineInsuranceWorkplaces([nps], [employment]);

  assert.equal(matchesInsuranceWorkplaceCriteria(row, { businessNumber: "408815" }), true);
  assert.equal(matchesInsuranceWorkplaceCriteria(row, { businessNumber: "4088152345" }), true);
  assert.equal(matchesInsuranceWorkplaceCriteria(row, { businessNumber: "408815-2345" }), true);
  assert.equal(matchesInsuranceWorkplaceCriteria(row, { businessNumber: "40881" }), false);
  assert.equal(matchesInsuranceWorkplaceCriteria(row, { businessNumber: "408816" }), false);
});

test("employment-only rows remain visible in the default combined view", () => {
  const [row] = combineInsuranceWorkplaces([], [employment]);
  assert.equal(matchesInsuranceWorkplaceCriteria(row, {}), true);
  assert.equal(matchesInsuranceWorkplaceCriteria(row, { source: "nps" }), false);
  assert.equal(matchesInsuranceWorkplaceCriteria(row, { source: "employment" }), true);
});

test("designation name key strips legal forms and cooperative suffixes", () => {
  assert.equal(designationNameKey("(사)아이티케어복지회"), designationNameKey("아이티케어복지회"));
  assert.equal(designationNameKey("라이프공동체 사회적협동조합"), designationNameKey("라이프공동체협동조합"));
  assert.equal(designationNameKey("(주)그린나라기업"), designationNameKey("그린나라기업"));
  assert.notEqual(designationNameKey("한성회관"), designationNameKey("금남회관"));
});

test("resolves workplace designations from business numbers and names", () => {
  const index = {
    byName: { 아이티케어복지회: ["사회적기업"] },
    byBusinessNumber: { "4163260145": ["여성기업"] }
  };
  const row = {
    nps: { name: "(사)아이티케어복지회", bizNoPrefix: "123456" },
    employmentInsurance: { name: "아이티케어복지회", businessRegistrationNumber: "416-32-60145" }
  };
  assert.deepEqual(resolveWorkplaceDesignations(row, index).sort(), ["사회적기업", "여성기업"]);
  // 색인에 없는 사업장은 지정이 비어 있다.
  assert.deepEqual(resolveWorkplaceDesignations({ nps: { name: "금빛치과의원", bizNoPrefix: "999999" }, employmentInsurance: null }, index), []);
});

test("designation criteria keep rows matching any selected designation", () => {
  const coopRow = { nps: null, employmentInsurance: null, designations: ["협동조합"] };
  assert.equal(matchesInsuranceWorkplaceCriteria(coopRow, { designations: ["사회적기업", "협동조합"] }), true);
  assert.equal(matchesInsuranceWorkplaceCriteria(coopRow, { designations: ["여성기업"] }), false);
  // 아무 것도 선택하지 않으면 지정 조건은 작동하지 않는다.
  assert.equal(matchesInsuranceWorkplaceCriteria(coopRow, { designations: [] }), true);
  assert.equal(matchesInsuranceWorkplaceCriteria({ nps: null, employmentInsurance: null }, { designations: ["여성기업"] }), false);
});

test("grouped insurance rows remain searchable by every source record", () => {
  const [group] = mergeEmploymentInsuranceRows(employmentSnapshot.items.filter((row) => row.businessRegistrationNumber === "4088608817"));
  const [row] = combineInsuranceWorkplaces([], [group]);

  assert.equal(matchesInsuranceWorkplaceCriteria(row, { insuranceType: "1" }), true);
  assert.equal(matchesInsuranceWorkplaceCriteria(row, { query: "92110258797" }), true);
});

test("industry section filtering includes employment-only workplaces", () => {
  const groups = mergeEmploymentInsuranceRows(employmentSnapshot.items);
  const group = groups.find((item) => item.sourceRows.some((sourceRow) => String(sourceRow.employmentIndustryCode11 || sourceRow.employmentIndustryCode).startsWith("41")));
  const [row] = combineInsuranceWorkplaces([], [group]);

  assert.equal(row.nps, null);
  assert.equal(matchesInsuranceWorkplaceCriteria(row, { sectionCode: "F" }), true);
  assert.equal(matchesInsuranceWorkplaceCriteria(row, { sectionCode: "O" }), false);
});

test("employment industry supplements an unknown NPS industry", () => {
  const unknownNps = { ...nps, sectionCode: "", sectionName: "업종 미상", industryCode: "999999" };
  const healthEmployment = {
    ...employment,
    id: "ei-health",
    employmentIndustryCode11: "86105",
    employmentIndustryName11: "요양 병원",
    employmentIndustryCode: "86105",
    employmentIndustryName: "요양 병원"
  };
  const [row] = combineInsuranceWorkplaces([unknownNps], [healthEmployment]);

  assert.deepEqual([...insuranceIndustrySectionCodes(row)], ["P"]);
  assert.equal(matchesInsuranceWorkplaceCriteria(row, { sectionCode: "P" }), true);
  assert.equal(matchesInsuranceWorkplaceCriteria(row, { unknownIndustryOnly: true }), false);
});

test("known NPS industry takes precedence over a different employment industry", () => {
  const qEmployment = {
    ...employment,
    id: "ei-leisure",
    employmentIndustryCode11: "91229",
    employmentIndustryName11: "기타 오락장 운영업",
    employmentIndustryCode: "91229",
    employmentIndustryName: "기타 오락장 운영업"
  };
  const [row] = combineInsuranceWorkplaces([{ ...nps, sectionCode: "H", sectionName: "숙박 및 음식점업" }], [qEmployment]);

  assert.deepEqual([...insuranceIndustrySectionCodes(row)], ["H"]);
  assert.equal(matchesInsuranceWorkplaceCriteria(row, { sectionCode: "H" }), true);
  assert.equal(matchesInsuranceWorkplaceCriteria(row, { sectionCode: "Q" }), false);
});

test("the current snapshot does not leak a different employment industry into NPS filtering", () => {
  const npsRows = npsSnapshot.items
    .filter((item) => item.name === "데블다이스(주)")
    .map(hydrateSnapshotWorkplace);
  const employmentRows = mergeEmploymentInsuranceRows(employmentSnapshot.items)
    .filter((item) => item.name === "데블다이스(주)");
  const [row] = combineInsuranceWorkplaces(npsRows, employmentRows);

  assert.equal(row.nps.sectionCode, "H");
  assert.deepEqual([...insuranceIndustrySectionCodes(row)], ["H"]);
  assert.equal(matchesInsuranceWorkplaceCriteria(row, { sectionCode: "Q" }), false);
});

test("the current snapshot supplements an unknown NPS industry from employment data", () => {
  const npsRows = npsSnapshot.items
    .filter((item) => item.name === "로뎀의집")
    .map(hydrateSnapshotWorkplace);
  const employmentRows = mergeEmploymentInsuranceRows(employmentSnapshot.items)
    .filter((item) => item.name === "로뎀의집");
  const [row] = combineInsuranceWorkplaces(npsRows, employmentRows);

  assert.equal(row.nps.sectionCode, "");
  assert.equal(row.employmentInsurance.sourceRows[0].employmentIndustryCode11, "87131");
  assert.equal(matchesInsuranceWorkplaceCriteria(row, { sectionCode: "P" }), true);
  assert.equal(matchesInsuranceWorkplaceCriteria(row, { unknownIndustryOnly: true }), false);
});

test("an unknown NPS company keeps every employment industry section it has", () => {
  const npsRows = npsSnapshot.items
    .filter((item) => item.name === "광주동구지역자활센터")
    .map(hydrateSnapshotWorkplace);
  const employmentRows = mergeEmploymentInsuranceRows(employmentSnapshot.items)
    .filter((item) => item.name === "광주동구지역자활센터");
  const [row] = combineInsuranceWorkplaces(npsRows, employmentRows);
  const sections = insuranceIndustrySectionCodes(row);

  assert.equal(row.nps.sectionCode, "");
  assert.ok(sections.has("Q"));
  assert.ok(sections.has("H"));
  assert.equal(matchesInsuranceWorkplaceCriteria(row, { sectionCode: "Q" }), true);
  assert.equal(matchesInsuranceWorkplaceCriteria(row, { sectionCode: "H" }), true);
});

test("links Jeil Construction despite legal and project-name differences", () => {
  const groups = mergeEmploymentInsuranceRows(employmentSnapshot.items);
  const [row] = combineInsuranceWorkplaces(
    // seq는 자료생성월 배치마다 새로 매겨지므로 이름으로 고른다.
    npsSnapshot.items.filter((item) => item.name === "제일건설 주식회사"),
    groups.filter((item) => item.businessRegistrationNumber === "1248609636")
  );

  assert.equal(row.source, "combined");
  assert.equal(row.nps.name, "제일건설 주식회사");
  assert.equal(row.employmentInsurance.name, "제일건설(주)/건설일괄");
  assert.deepEqual(row.employmentInsurance.workplaceManagementNumbers, ["12486096366", "90700137121"]);
});

test("the current snapshot links most workplaces on both sides", () => {
  const groups = mergeEmploymentInsuranceRows(employmentSnapshot.items);
  const rows = combineInsuranceWorkplaces(npsSnapshot.items, groups);
  const linked = rows.filter((row) => row.nps && row.employmentInsurance);

  // 사업장은 매달 생기고 없어지므로 건수를 정확히 묶지 않는다. 결합 로직이
  // 깨져 연결이 대량으로 끊기는지만 본다.
  assert.ok(linked.length >= Math.floor(npsSnapshot.items.length / 2));
  assert.ok(linked.length <= npsSnapshot.items.length);
  assert.ok(rows.filter((row) => !row.nps && row.employmentInsurance).length >= Math.floor(groups.length / 2));
});

test("sorts combined rows by either insurance source without mutating input", () => {
  const rows = combineInsuranceWorkplaces([nps], [employment, { ...employment, id: "ei-2", name: "가나다", businessRegistrationNumber: "1234567890", employmentWorkerCount: 20 }]);
  const sorted = sortInsuranceWorkplaces(rows, "employment-desc");

  assert.equal(sorted[0].employmentInsurance.name, "가나다");
  assert.notEqual(sorted, rows);
  assert.equal(rows[0].nps.seq, "nps-1");
});

test("current snapshots keep every source record in the integrated result", () => {
  const rows = combineInsuranceWorkplaces(npsSnapshot.items, employmentSnapshot.items);
  const npsIds = new Set(rows.filter((row) => row.nps).map((row) => row.nps.seq));
  const employmentIds = new Set(rows.filter((row) => row.employmentInsurance).map((row) => row.employmentInsurance.id));

  assert.ok(rows.length > npsSnapshot.items.length);
  assert.equal(npsIds.size, new Set(npsSnapshot.items.map((row) => row.seq)).size);
  assert.equal(employmentIds.size, new Set(employmentSnapshot.items.map((row) => row.id)).size);
  assert.ok(rows.some((row) => row.source === "combined"));
  assert.ok(rows.some((row) => row.source === "nps"));
  assert.ok(rows.some((row) => row.source === "employment"));
});

test("current snapshots expose only confirmed Dong-gu administrative dongs", () => {
  const rows = combineInsuranceWorkplaces(
    npsSnapshot.items.map(hydrateSnapshotWorkplace),
    mergeEmploymentInsuranceRows(employmentSnapshot.items)
  );
  const matched = rows.filter((row) => insuranceAdminDongs(row).size);
  const dongs = new Set(matched.flatMap((row) => [...insuranceAdminDongs(row)]));

  // 건수는 매달 달라진다. 대부분의 행이 행정동과 매치되는지와, 동 목록이
  // 확정된 것만인지를 본다.
  assert.ok(rows.length > 0);
  assert.ok(matched.length >= Math.floor(rows.length * 0.75));
  assert.deepEqual([...dongs].sort(), [...DONGGU_ADMIN_DONGS].sort());
  assert.ok(rows.some((row) => matchesInsuranceWorkplaceCriteria(row, { adminDong: "충장동" })));
});

test("the insurance lookup uses one renamed tab", () => {
  assert.match(indexHtml, /4대보험 사업장 조회/);
  assert.match(indexHtml, /<h2 id="nps-result-title">조회 결과<\/h2>/);
  assert.match(indexHtml, /출처 : 국민연금공단·근로복지공단 자료 \(연 1회 갱신\)/);
  assert.match(indexHtml, /자료 범위 : 국민연금·고용·산재보험 \(건강보험 자료는 제공하지 않습니다\.\)/);
  assert.doesNotMatch(indexHtml, /npsBasis/);
  assert.doesNotMatch(indexHtml, /고용·산재보험 가입 현황/);
  assert.doesNotMatch(indexHtml, /tab-employment-insurance|subpanel-employment-insurance/);
  assert.match(indexHtml, /<span>업종 대분류<\/span>/);
  assert.match(indexHtml, /사업자등록번호 검색/);
  assert.match(indexHtml, /id="npsBusinessNumberInput"/);
  assert.match(indexHtml, /id="npsAdminDongSelect"/);
  assert.match(indexHtml, /6자리 이상 입력/);
  assert.match(indexHtml, /도로명주소 검색 API로 확정된 주소만 표시/);
  assert.match(indexHtml, /국민연금만 표시되거나 고용·산재만 표시되거나 가입 데이터가 조회되지 않는 것은 미가입을 뜻하지 않습니다/);
  assert.doesNotMatch(indexHtml, /자료 구분|사업장 형태|사업 구분 \(고용·산재\)/);
  assert.doesNotMatch(indexHtml, /업종 대분류 \(국민연금\)/);
  assert.doesNotMatch(indexHtml, /보험 구분 \(고용·산재\)|사업장 등록일/);
  assert.doesNotMatch(indexHtml, /사업장명 오름차순|고용보험 근로자 많은 순|산재보험 근로자 많은 순/);
  assert.doesNotMatch(indexHtml, /npsStatsRow|class="hint"/);
  assert.match(appJs, /const managementGroups = new Map\(\)/);
  assert.match(appJs, /class="insurance-workplace-group"/);
  assert.match(appJs, /사업장관리번호 <span class="insurance-workplace-number mono"/);
  assert.match(appJs, /employment\?\.businessRegistrationNumber/);
  assert.match(appJs, /insurancePostalCodeValues\(employment\)/);
  assert.match(appJs, /사업자 상태 확인/);
  assert.match(appJs, /callBusinessProxy\(\[businessNumber\]\)/);
  assert.match(appJs, /businessNumber: \$\("npsBusinessNumberInput"\)/);
  assert.match(appJs, /adminDong: \$\("npsAdminDongSelect"\)/);
  assert.match(appJs, /insuranceAdminDongLabel\(row\)/);
  assert.doesNotMatch(appJs, /npsSourceSelect|npsStyleTabs|npsInsuranceStatusSelect|npsStyleCode/);
  assert.match(appJs, /insuranceIndustrySectionCodes\(row\)/);
  assert.match(appJs, /국민연금 월별 추이/);
  assert.match(appJs, /<h3>고용·산재보험 정보/);
  assert.match(appJs, /기업 재무정보/);
  assert.match(appJs, /법인 전체 재무제표/);
  assert.match(appJs, /corporateRegistrationNumberHtml/);
  assert.match(appJs, /formattedCorporateNumber \? escapeHtml\(formattedCorporateNumber\) : "-"/);
  assert.match(appJs, /사업자등록번호", escapeHtml\([^)]*businessNumber/);
  assert.match(appJs, /법인등록번호", corporateRegistrationNumberHtml\([^)]*businessNumber/);
  assert.doesNotMatch(appJs, /corporate-number-inline/);
  assert.doesNotMatch(appJs, /통합 사업장/);
  assert.doesNotMatch(appJs, /npsInsuranceTypeSelect|npsYearRange|npsPeopleRange/);
});
