import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  combineInsuranceWorkplaces,
  matchesInsuranceWorkplaceCriteria,
  sortInsuranceWorkplaces
} from "../lib/insurance-workplaces.js";

const [npsSnapshot, employmentSnapshot, indexHtml] = await Promise.all([
  readFile(new URL("../data/nps_donggu.json", import.meta.url), "utf8").then(JSON.parse),
  readFile(new URL("../data/employment_insurance_donggu.json", import.meta.url), "utf8").then(JSON.parse),
  readFile(new URL("../index.html", import.meta.url), "utf8")
]);

const nps = {
  seq: "nps-1",
  name: "광주동구청",
  bizNoPrefix: "408815",
  address: "광주광역시 동구 서남로",
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
});

test("employment-only rows remain visible in the default combined view", () => {
  const [row] = combineInsuranceWorkplaces([], [employment]);
  assert.equal(matchesInsuranceWorkplaceCriteria(row, {}), true);
  assert.equal(matchesInsuranceWorkplaceCriteria(row, { source: "nps" }), false);
  assert.equal(matchesInsuranceWorkplaceCriteria(row, { source: "employment" }), true);
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

test("the insurance lookup uses one renamed tab", () => {
  assert.match(indexHtml, /4대보험 사업장 조회/);
  assert.match(indexHtml, /출처 : 국민연금공단·근로복지공단 자료 \(연 1회 갱신\)/);
  assert.match(indexHtml, /자료 범위 : 국민연금·고용·산재보험 \(건강보험 자료는 제공하지 않습니다\.\)/);
  assert.doesNotMatch(indexHtml, /npsBasis/);
  assert.doesNotMatch(indexHtml, /고용·산재보험 가입 현황/);
  assert.doesNotMatch(indexHtml, /tab-employment-insurance|subpanel-employment-insurance/);
});
