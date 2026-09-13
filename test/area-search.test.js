import test from "node:test";
import assert from "node:assert/strict";
import {
  aggregateIndustries,
  AREA_SHAPES,
  filterRowsInArea,
  haversineMeters,
  industryClosureTable,
  pointInArea
} from "../lib/area-search.js";

// 광주 동구 동계천로 39 부근 실제 좌표를 중심으로 쓴다.
const CENTER = { latitude: 35.1526, longitude: 126.9196 };

test("하버사인 거리는 알려진 구간과 수 미터 안에서 일치한다", () => {
  // 같은 점은 0
  assert.equal(haversineMeters(35.1526, 126.9196, 35.1526, 126.9196), 0);
  // 위도 1도 ≈ 111.2km
  const meters = haversineMeters(35, 126.9, 36, 126.9);
  assert.ok(Math.abs(meters - 111190) < 1000, `위도 1도 거리 ${meters}m`);
});

test("원형 반경은 중심에서 반경 안쪽만 안에 속한다", () => {
  // 300m 북쪽
  const north = { latitude: CENTER.latitude + 300 / 111320, longitude: CENTER.longitude };
  assert.equal(pointInArea(north.latitude, north.longitude, CENTER, { shape: AREA_SHAPES.circle, radiusM: 300 }), true);
  const far = { latitude: CENTER.latitude + 600 / 111320, longitude: CENTER.longitude };
  assert.equal(pointInArea(far.latitude, far.longitude, CENTER, { shape: AREA_SHAPES.circle, radiusM: 300 }), false);
  assert.equal(pointInArea(NaN, CENTER.longitude, CENTER, { radiusM: 300 }), false);
  assert.equal(pointInArea(CENTER.latitude, CENTER.longitude, null, { radiusM: 300 }), false);
  assert.equal(pointInArea(CENTER.latitude, CENTER.longitude, CENTER, { radiusM: 0 }), false);
});

test("정사각형은 변 절반 기준으로 안에 속한다", () => {
  // 동쪽으로 300m는 한 변 600m 정사각형의 변 위쪽 경계다.
  const east = { latitude: CENTER.latitude, longitude: CENTER.longitude + 250 / (111320 * Math.cos(CENTER.latitude * Math.PI / 180)) };
  assert.equal(pointInArea(east.latitude, east.longitude, CENTER, { shape: AREA_SHAPES.square, radiusM: 300 }), true);
  // 북쪽 300m, 동쪽 300m 코너 밖은 원형과 달리 정사각형엔 속한다.
  const corner = {
    latitude: CENTER.latitude + 290 / 111320,
    longitude: CENTER.longitude + 290 / (111320 * Math.cos(CENTER.latitude * Math.PI / 180))
  };
  assert.equal(pointInArea(corner.latitude, corner.longitude, CENTER, { shape: AREA_SHAPES.square, radiusM: 300 }), true);
  assert.equal(pointInArea(corner.latitude, corner.longitude, CENTER, { shape: AREA_SHAPES.circle, radiusM: 300 }), false);
  const far = {
    latitude: CENTER.latitude + 350 / 111320,
    longitude: CENTER.longitude
  };
  assert.equal(pointInArea(far.latitude, far.longitude, CENTER, { shape: AREA_SHAPES.square, radiusM: 300 }), false);
});

test("좌표가 없는 행은 반경에 들지 않는다", () => {
  const rows = [
    { latitude: CENTER.latitude, longitude: CENTER.longitude, name: "안" },
    { latitude: null, longitude: null, name: "밖" },
    { name: "및" }
  ];
  const inside = filterRowsInArea(rows, CENTER, { shape: AREA_SHAPES.circle, radiusM: 500 });
  assert.deepEqual(inside.map((row) => row.name), ["안"]);
});

test("업종 대분류·소분류를 건수 순으로 집계한다", () => {
  const rows = [
    { largeName: "음식", smallName: "한식" },
    { largeName: "음식", smallName: "한식" },
    { largeName: "음식", smallName: "커피전문점" },
    { largeName: "소매", smallName: "편의점" },
    { largeName: "", smallName: "" }
  ];
  const { large, small } = aggregateIndustries(rows);
  assert.deepEqual(large[0], { name: "음식", count: 3 });
  // 동률인 나머지는 건수만 확인한다(가나다 정렬은 환경 콜레이션에 따른다).
  assert.deepEqual(
    large.slice(1).map((row) => row.count).sort((a, b) => a - b),
    [1, 1]
  );
  assert.deepEqual(small[0], { name: "한식", count: 2 });
  assert.deepEqual(
    small.slice(1).map((row) => row.count).sort((a, b) => a - b),
    [1, 1, 1]
  );
  assert.ok(small.slice(1).every((row) => ["미분류", "편의점", "커피전문점"].includes(row.name)));
});

test("업종 대분류별 영업·폐업·폐업률 표를 만든다", () => {
  const active = [
    { largeName: "음식" }, { largeName: "음식" }, { largeName: "음식" },
    { largeName: "소매" }
  ];
  const closed = [
    { largeName: "음식" },
    { largeName: "부동산" }
  ];
  const rows = industryClosureTable(active, closed);
  assert.deepEqual(rows.map((row) => row.name), ["음식", "소매", "부동산"]);
  assert.deepEqual(rows.map((row) => row.activeCount), [3, 1, 0]);
  assert.deepEqual(rows.map((row) => row.closedCount), [1, 0, 1]);
  assert.equal(rows[0].closureRate, 0.25);
  assert.equal(rows[1].closureRate, 0);
  assert.equal(rows[2].closureRate, 1);
});
