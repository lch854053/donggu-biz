import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  excelSerialDate,
  matchesEmploymentInsuranceCriteria,
  sortEmploymentInsuranceRows,
  mergeEmploymentInsuranceRows
} from "../lib/employment-insurance.js";

const snapshot = JSON.parse(await readFile(new URL("../data/employment_insurance_donggu.json", import.meta.url), "utf8"));

test("employment insurance snapshot contains the validated Dong-gu dataset", () => {
  assert.equal(snapshot.meta.source, "근로복지공단_고용 산재보험 가입 현황");
  assert.equal(snapshot.meta.sourceUpdatedAt, "2025-12-31");
  assert.equal(snapshot.meta.totalCount, 6924);
  assert.equal(snapshot.items.length, snapshot.meta.totalCount);
  assert.equal(new Set(snapshot.items.map((item) => item.id)).size, snapshot.items.length);
  assert.deepEqual([...new Set(snapshot.items.map((item) => item.insuranceType))].sort(), ["0", "1", "2"]);
  assert.equal(snapshot.items[0].industrialEstablishedDate, "2023-04-01");
  assert.equal(snapshot.items[0].employmentWorkerCount, 7);
  assert.ok(snapshot.items.every((item) => item.name && item.address));
});

test("employment insurance helpers convert dates and filter searchable fields", () => {
  assert.equal(excelSerialDate(45017), "2023-04-01");
  assert.equal(excelSerialDate(""), null);

  const row = snapshot.items[0];
  assert.equal(matchesEmploymentInsuranceCriteria(row, { query: "청소년문화의집" }), true);
  assert.equal(matchesEmploymentInsuranceCriteria(row, { query: "없는 사업장" }), false);
  assert.equal(matchesEmploymentInsuranceCriteria(row, { insuranceType: "1" }), false);
  assert.equal(matchesEmploymentInsuranceCriteria(row, { status: "계속" }), true);
});

test("employment insurance sort keeps source rows untouched", () => {
  const rows = snapshot.items.slice(0, 3);
  const sorted = sortEmploymentInsuranceRows(rows, "employment-desc");
  assert.notEqual(sorted, rows);
  assert.deepEqual(rows.map((row) => row.id), snapshot.items.slice(0, 3).map((row) => row.id));
  assert.ok(sorted[0].employmentWorkerCount >= sorted[1].employmentWorkerCount);
});

test("merges paired employment and industrial management numbers", () => {
  const [merged] = mergeEmploymentInsuranceRows([
    {
      id: "employment", insuranceType: "2", insuranceTypeName: "고용", name: "회사",
      postalCode: "61470", address: "광주 동구 제봉로 1", businessRegistrationNumber: "1234567890",
      workplaceManagementNumber: "12345678900", employmentWorkerCount: 10,
      employmentStatus: "계속", employmentEstablishedDate: "2020-01-01"
    },
    {
      id: "industrial", insuranceType: "1", insuranceTypeName: "산재", name: "회사",
      postalCode: "61470", address: "광주 동구 제봉로 1", businessRegistrationNumber: "1234567890",
      workplaceManagementNumber: "12345678906", industrialWorkerCount: 8,
      industrialStatus: "계속", industrialEstablishedDate: "2020-02-01"
    }
  ]);

  assert.equal(merged.insuranceType, "0");
  assert.equal(merged.employmentWorkerCount, 10);
  assert.equal(merged.industrialWorkerCount, 8);
  assert.deepEqual(merged.workplaceManagementNumbers, ["12345678900", "12345678906"]);
  assert.equal(merged.employmentWorkplaceManagementNumber, "12345678900");
  assert.equal(merged.industrialWorkplaceManagementNumber, "12345678906");
});

test("keeps a different management base as a separate workplace", () => {
  const bankRows = snapshot.items.filter((row) => row.businessRegistrationNumber === "4088608817");
  const merged = mergeEmploymentInsuranceRows(bankRows);
  const paired = merged.find((row) => row.insuranceType === "0" && row.employmentWorkerCount === 1764);
  const separate = merged.find((row) => row.workplaceManagementNumber === "92110258797");

  assert.equal(merged.length, 2);
  assert.equal(paired.industrialWorkerCount, 1762);
  assert.deepEqual(paired.workplaceManagementNumbers, ["40881001820", "40881001826"]);
  assert.equal(separate.insuranceType, "1");
  assert.equal(separate.industrialWorkerCount, 1765);
});
