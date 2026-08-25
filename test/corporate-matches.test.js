import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  buildCorporatePilotCandidates,
  corporateNameQueries,
  hasCorporateMarker,
  normalizeBusinessNumber,
  resolveCorporateMatch
} from "../lib/corporate-matches.js";

test("corporate pilot candidates require a full business number and a corporate marker", () => {
  const candidates = buildCorporatePilotCandidates([
    { name: "주식회사 동구", businessRegistrationNumber: "123-45-67890" },
    { name: "동구상사", businessRegistrationNumber: "1234567891" },
    { name: "(주)번호없음", businessRegistrationNumber: "123456" },
    { name: "주식회사 동구 광주지점", businessRegistrationNumber: "1234567890" }
  ]);
  assert.equal(normalizeBusinessNumber("123-45-67890"), "1234567890");
  assert.equal(hasCorporateMarker("주식회사 동구"), true);
  assert.deepEqual(candidates, [{
    businessRegistrationNumber: "1234567890",
    names: ["주식회사 동구", "주식회사 동구 광주지점"]
  }]);
  assert.deepEqual(corporateNameQueries(candidates[0].names), ["동구", "주식회사 동구", "동구 광주지점", "주식회사 동구 광주지점"]);
});

test("corporate matches require an exact business number and one corporate number", () => {
  const items = [
    { bzno: "1234567890", crno: "2001110000001", corpNm: "동구", lastOpegDt: "20250101" },
    { bzno: "1234567890", crno: "2001110000001", corpNm: "(주)동구", lastOpegDt: "20260101" },
    { bzno: "9999999999", crno: "2001110000002", corpNm: "동구" }
  ];
  const match = resolveCorporateMatch("123-45-67890", items);
  assert.equal(match.status, "matched");
  assert.equal(match.company.corporateRegistrationNumber, "2001110000001");
  assert.equal(match.company.name, "(주)동구");

  const ambiguous = resolveCorporateMatch("1234567890", [
    ...items,
    { bzno: "1234567890", crno: "2001110000003", corpNm: "동구 신설법인" }
  ]);
  assert.equal(ambiguous.status, "ambiguous");
  assert.deepEqual(ambiguous.corporateRegistrationNumbers, ["2001110000001", "2001110000003"]);
  assert.equal(resolveCorporateMatch("1111111111", items).status, "unmatched");
});

test("corporate match snapshot contains only exact, auditable pilot results", async () => {
  const snapshot = JSON.parse(await readFile(new URL("../data/corporate_matches_donggu.json", import.meta.url), "utf8"));
  assert.equal(snapshot.meta.source, "금융위원회_기업기본정보");
  assert.ok(snapshot.meta.processedCandidateCount > 0);
  assert.equal(snapshot.matches.length, snapshot.meta.processedCandidateCount);
  assert.equal(new Set(snapshot.matches.map((item) => item.businessRegistrationNumber)).size, snapshot.matches.length);
  assert.equal(snapshot.matches.filter((item) => item.status === "matched").length, snapshot.meta.matched);
  assert.ok(snapshot.matches.filter((item) => item.status === "matched")
    .every((item) => /^\d{13}$/.test(item.company.corporateRegistrationNumber)
      && item.company.businessRegistrationNumber === item.businessRegistrationNumber));
});
