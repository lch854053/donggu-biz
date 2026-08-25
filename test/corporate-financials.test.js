import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { compactFinancialStatement, validFinancialStatements } from "../lib/corporate-financials.js";

test("financial statement fields preserve negative amounts and missing values", () => {
  const statement = compactFinancialStatement({
    basDt: "20251231", bizYear: "2025", fnclDcd: "120", fnclDcdNm: "별도요약재무제표",
    curCd: "KRW", enpSaleAmt: "1,000", enpBzopPft: "-20", enpCrtmNpf: ""
  });
  assert.equal(statement.sales, 1000);
  assert.equal(statement.operatingProfit, -20);
  assert.equal(statement.netIncome, null);
});

test("rejects undocumented and internally inconsistent summary rows", () => {
  const rows = validFinancialStatements([{
    crno: "2001110000001", bizYear: "2025", basDt: "20251016",
    fnclDcd: "999", fnclDcdNm: "NA", enpTastAmt: "68743000000",
    enpTdbtAmt: "26790000000", enpTcptAmt: "68743000000", fnclDebtRto: "0"
  }], "2001110000001", "2025");
  assert.deepEqual(rows, []);
});

test("calculates debt ratio from validated debt and equity amounts", () => {
  const [statement] = validFinancialStatements([{
    crno: "2001110000001", bizYear: "2025", basDt: "20251231",
    fnclDcd: "120", fnclDcdNm: "별도요약재무제표", enpTastAmt: "150",
    enpTdbtAmt: "50", enpTcptAmt: "100", fnclDebtRto: "0"
  }], "2001110000001", "2025");
  assert.equal(statement.debtRatio, 50);
});

test("financial rows must match both corporate number and business year", () => {
  const rows = validFinancialStatements([
    { crno: "2001110000001", bizYear: "2025", basDt: "20251231", fnclDcd: "110", fnclDcdNm: "연결" },
    { crno: "2001110000001", bizYear: "2024", basDt: "20241231", fnclDcd: "110", fnclDcdNm: "연결" },
    { crno: "2001110000002", bizYear: "2025", basDt: "20251231", fnclDcd: "120", fnclDcdNm: "별도" }
  ], "2001110000001", "2025");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].businessYear, "2025");
});

test("corporate financial snapshot contains matched, unique companies", async () => {
  const snapshot = JSON.parse(await readFile(new URL("../data/corporate_financials_donggu.json", import.meta.url), "utf8"));
  assert.equal(snapshot.meta.source, "금융위원회_기업 재무정보");
  assert.equal(snapshot.companies.length, snapshot.meta.financialCorporateCount);
  assert.equal(new Set(snapshot.companies.map((company) => company.corporateRegistrationNumber)).size, snapshot.companies.length);
  assert.ok(snapshot.companies.every((company) => company.statements.length > 0));
  assert.ok(snapshot.companies.flatMap((company) => company.statements)
    .every((statement) => snapshot.meta.years.includes(statement.businessYear)));
});
