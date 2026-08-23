import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  excelSerialDate,
  matchesEmploymentInsuranceCriteria,
  sortEmploymentInsuranceRows
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
