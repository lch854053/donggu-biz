import test from "node:test";
import assert from "node:assert/strict";
import { accumulateBusRows, buildBusSnapshot, assertBusSnapshotHealthy, createBusAccumulator } from "../lib/bus-boarding.js";

const ROWS = [
  // 거래일자,요일,거래시간,노선코드,노선명,정류장코드,정류장명,자동응답시스템아이디,승하차,거래건수,거래금액,권종
  ["2026-01-03", "토", "8", "33", "금남58", "1061", "운암도서관", "4455", "승차", "4", "5000", "일반"],
  ["2026-01-03", "토", "8", "33", "금남58", "1061", "운암도서관", "4455", "하차", "1", "0", "일반"],
  ["2026-02-11", "수", "18", "12", "일산61", "25", "경신여고", "4434", "승차", "2", "2500", "일반"],
  ["2026-03-31", "화", "25", "12", "일산61", "25", "경신여고", "4434", "하차", "3", "0", "일반"],
  ["2026-03-31", "화", "7", "12", "일산61", "25", "", "4434", "승차", "0", "0", "일반"]
];

test("aggregates bus rows into stop, month and hour buckets", () => {
  const accumulator = accumulateBusRows(createBusAccumulator(), ROWS);
  const snapshot = buildBusSnapshot(accumulator, { generatedAt: "2026-09-13T00:00:00Z" });

  assert.equal(snapshot.stops.length, 2);
  const stop1061 = snapshot.stops.find((stop) => stop.code === "1061");
  assert.deepEqual(stop1061, {
    code: "1061",
    name: "운암도서관",
    rides: 4,
    alights: 1,
    months: { "2026-01": { rides: 4, alights: 1 } }
  });
  assert.equal(snapshot.months.length, 3);
  assert.equal(snapshot.months[0].month, "2026-01");
  assert.equal(snapshot.months.at(-1).rides, 0);
  assert.equal(snapshot.months.at(-1).alights, 3);

  // 시간은 숫자 기준으로 정렬된다("25" 같은 이상치도 문자열이 아닌 수로).
  // 마지막 행은 거래건수 0이라 집계에서 빠진다.
  assert.deepEqual(snapshot.hours.map((entry) => entry.hour), [8, 18, 25]);
  assert.equal(snapshot.meta.stopCount, 2);
  assert.equal(snapshot.meta.totalRides, 6);
  assert.equal(snapshot.meta.totalAlights, 4);
});

test("keeps the newest name when a stop code repeats across chunks", () => {
  const accumulator = createBusAccumulator();
  accumulateBusRows(accumulator, [["2026-01-01", "목", "5", "33", "금남58", "1061", "옛이름", "4455", "승차", "1", "1250", "일반"]]);
  accumulateBusRows(accumulator, [["2026-02-01", "일", "5", "33", "금남58", "1061", "새이름", "4455", "승차", "1", "1250", "일반"]]);
  const snapshot = buildBusSnapshot(accumulator);
  assert.equal(snapshot.stops[0].name, "새이름");
  assert.equal(snapshot.stops[0].rides, 2);
});

test("rejects a snapshot without months or stops", () => {
  const empty = buildBusSnapshot(createBusAccumulator());
  assert.throws(() => assertBusSnapshotHealthy(empty));
  assert.throws(() => assertBusSnapshotHealthy({}));
});
