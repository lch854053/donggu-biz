import test from "node:test";
import assert from "node:assert/strict";
import { buildVacancySnapshot, parseVacancyCsv, assertVacancySnapshotHealthy } from "../lib/commercial-vacancy.js";

const CSV = [
  "번호,지역코드,지역명,조사일자,건물구분,공실률,지역구분 레벨",
  "1,2900000,광주,202403,3,7.5,1",
  "2,2900101,금남로/충장로,202403,2,24.9,3",
  "3,0500511,금남로/충장로,202403,4,15.2,3",
  "4,0500000,광주,202401,4,7.1,1",
  "5,4100101,광주시가지,202403,4,12.2,3",
  "6,0500N42,광주시가지,202403,2,7.4,3",
  "7,4600N232N232,광주전남혁신도시,202403,3,39.2,3",
  "8,0111101,명동,202403,2,5.3,3"
].join("\n");

test("parses vacancy rows and keeps only Gwangju areas", () => {
  const areas = parseVacancyCsv(CSV);
  const snapshot = buildVacancySnapshot(areas, { generatedAt: "2026-09-13T00:00:00Z" });

  // 경기 광주시가지·광주전남혁신도시(전남 화순)·명동(서울)은 뺀다.
  assert.deepEqual(snapshot.areas.map((area) => area.name), ["광주", "금남로/충장로"]);
  const gwangju = snapshot.areas[0];
  assert.equal(gwangju.series["3"]["2024Q3"], 7.5);
  assert.equal(gwangju.series["4"]["2024Q1"], 7.1);

  const chungjang = snapshot.areas[1];
  // 조사 체계가 바뀌며 지역코드가 바뀌어도 지역명이 같으면 한 지역으로 합친다.
  assert.equal(chungjang.series["2"]["2024Q3"], 24.9);
  assert.equal(chungjang.series["4"]["2024Q3"], 15.2);
  assert.deepEqual(snapshot.meta.quarters, ["2024Q1", "2024Q3"]);
});

test("rejects an unexpected CSV header", () => {
  assert.throws(() => parseVacancyCsv("번호,지역,202403\n1,광주,7"));
  assert.throws(() => assertVacancySnapshotHealthy({ areas: [] }));
});

test("reports the latest quarter from the survey itself", () => {
  const snapshot = buildVacancySnapshot(parseVacancyCsv(CSV));
  assert.equal(snapshot.meta.quarters.at(-1), "2024Q3");
});
