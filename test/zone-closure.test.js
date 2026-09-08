import test from "node:test";
import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import {
  averageClosureRate,
  closuresInZone,
  recentRateYearRange,
  zoneClosureYearRates,
  ZONE_CLOSURE_RATE_YEARS
} from "../lib/zone-closure.js";
import { closureLifespanMedianDays, closureYearCounts } from "../lib/closure-view.js";

const square = {
  type: "Polygon",
  coordinates: [[[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]]]
};

function closed(overrides = {}) {
  return {
    statusKind: "closed",
    longitude: 5,
    latitude: 5,
    licenseDate: "2015-03-01",
    closedDate: "2020-01-15",
    ...overrides
  };
}

test("keeps only closed rows inside the zone and counts the ones it cannot place", () => {
  const { rows, missingCoordinates } = closuresInZone([
    closed(),
    closed({ longitude: 50, latitude: 50 }),
    closed({ longitude: null, latitude: null }),
    closed({ statusKind: "suspended" })
  ], square);
  assert.equal(rows.length, 1);
  assert.equal(missingCoordinates, 1);
});

test("counts every closed row when no zone is given", () => {
  const { rows } = closuresInZone([closed(), closed({ longitude: 50, latitude: 50 })], null);
  assert.equal(rows.length, 2);
});

test("rebuilds the businesses trading in each year from licence dates", () => {
  const active = [{ licenseDate: "2014-01-01" }, { licenseDate: "2019-06-01" }];
  const closedRows = [
    closed({ licenseDate: "2016-01-01", closedDate: "2018-05-01" }),
    closed({ licenseDate: "2010-01-01", closedDate: "2018-09-01" })
  ];
  const years = zoneClosureYearRates(active, closedRows, { fromYear: 2017, toYear: 2019 });
  // 2017년에는 영업 중 1곳(2014년 인허가)과 2018년에 닫는 2곳이 함께 장사하고 있었다.
  assert.deepEqual(years.map(({ year, closedCount, activeCount }) => [year, closedCount, activeCount]), [
    [2017, 0, 3],
    [2018, 2, 3],
    [2019, 0, 2]
  ]);
  assert.equal(years[1].rate, 2 / 3);
});

test("leaves a year without any traceable business unrated", () => {
  const years = zoneClosureYearRates([], [], { fromYear: 2020, toYear: 2020 });
  assert.equal(years[0].rate, null);
  assert.equal(averageClosureRate(years), null);
});

test("averages only the years that carry a rate", () => {
  assert.equal(averageClosureRate([{ rate: 0.1 }, { rate: null }, { rate: 0.3 }]), 0.2);
  assert.equal(averageClosureRate([]), null);
});

test("anchors the rate window on the last closure year", () => {
  assert.deepEqual(recentRateYearRange([closed({ closedDate: "2025-04-02" })]), { fromYear: 2016, toYear: 2025 });
  assert.deepEqual(recentRateYearRange([closed({ closedDate: "2025-04-02" })], { span: 3 }), { fromYear: 2023, toYear: 2025 });
  assert.equal(recentRateYearRange([]), null);
});

test("stops the rate window before a year that is still filling up", () => {
  const rows = [closed({ closedDate: "2020-01-01" }), closed({ closedDate: "2026-09-04" })];
  assert.deepEqual(recentRateYearRange(rows, { throughYear: 2025 }), { fromYear: 2016, toYear: 2025 });
  // 자를 해가 모든 폐업보다 앞서면 그릴 구간이 남지 않는다.
  assert.equal(recentRateYearRange(rows, { throughYear: 2019 }), null);
});

test("every committed zone can carry the three closure figures", async () => {
  for (const path of [
    "data/closed_licenses_donggu.json",
    "data/stores_donggu.json",
    "data/mainbiz_zones_donggu.geojson",
    "data/manual_mainbiz_zones_donggu.geojson"
  ]) {
    try {
      await access(path);
    } catch {
      return;
    }
  }
  const licenses = JSON.parse(await readFile("data/closed_licenses_donggu.json", "utf8")).licenses || [];
  const stores = JSON.parse(await readFile("data/stores_donggu.json", "utf8")).stores || [];
  const zones = [
    ...JSON.parse(await readFile("data/mainbiz_zones_donggu.geojson", "utf8")).features,
    ...JSON.parse(await readFile("data/manual_mainbiz_zones_donggu.geojson", "utf8")).features
  ];
  assert.ok(zones.length > 0, "주요상권 경계가 비어 있습니다");

  for (const zone of zones) {
    const { rows } = closuresInZone(licenses, zone.geometry);
    assert.ok(rows.length > 0, `${zone.properties?.name}에 잡히는 폐업 기록이 없습니다`);
    assert.ok(closureYearCounts(rows).length >= 5);
    assert.ok(Number.isFinite(closureLifespanMedianDays(rows)));

    const active = stores.filter((store) =>
      Number.isFinite(store.longitude) && Number.isFinite(store.latitude));
    const range = recentRateYearRange(rows);
    assert.equal(range.toYear - range.fromYear + 1, ZONE_CLOSURE_RATE_YEARS);
    const average = averageClosureRate(zoneClosureYearRates(active, rows, range));
    assert.ok(average > 0 && average < 1, `${zone.properties?.name}의 평균 폐업률이 비율 범위를 벗어납니다`);
  }
});
