import test from "node:test";
import assert from "node:assert/strict";
import {
  compactStore,
  distanceMeters,
  filterStores,
  geometryAreaSqm,
  pointInGeometry,
  storesInRadius,
  summarizeStores,
  toLegacyPnu
} from "../lib/market.js";
import { assertSnapshotHealthy } from "../lib/store-update.js";
import { assertZoneSnapshotHealthy } from "../lib/zone-update.js";

const stores = [
  { name: "동명카페", branch: "", address: "동명로", lotAddress: "동명동", buildingName: "", adminDong: "동명동", largeCode: "I2", largeName: "음식", middleCode: "I212", smallCode: "I21201", smallName: "카페", longitude: 126.92, latitude: 35.15 },
  { name: "충장서점", branch: "본점", address: "충장로", lotAddress: "충장로1가", buildingName: "", adminDong: "충장동", largeCode: "G2", largeName: "소매", middleCode: "G213", smallCode: "G21301", smallName: "서점", longitude: 126.921, latitude: 35.151 }
];

test("converts the new Dong-gu PNU prefix for legacy joins", () => {
  assert.equal(toLegacyPnu("1221010800102870025"), "2911010800102870025");
});

test("compacts an API store row", () => {
  const store = compactStore({
    bizesId: "A1", bizesNm: " 테스트 ", indsLclsCd: "G2", indsLclsNm: "소매",
    adongNm: "충장동", lnoCd: "1221010800102870025", lon: "126.92", lat: "35.15"
  });
  assert.equal(store.name, "테스트");
  assert.equal(store.legacyPnu, "2911010800102870025");
  assert.equal(store.longitude, 126.92);
});

test("filters stores by administrative dong, category and query", () => {
  assert.deepEqual(filterStores(stores, { adminDong: "동명동" }).map((store) => store.name), ["동명카페"]);
  assert.deepEqual(filterStores(stores, { largeCode: "G2", query: "본점" }).map((store) => store.name), ["충장서점"]);
});

test("calculates radius membership and summary", () => {
  const center = { longitude: 126.92, latitude: 35.15 };
  assert.equal(Math.round(distanceMeters(center, stores[0])), 0);
  assert.equal(storesInRadius(stores, center, 20).length, 1);
  assert.deepEqual(summarizeStores(stores).topLarge, { name: "소매", count: 1 });
});

test("rejects empty and sharply reduced update snapshots", () => {
  assert.throws(() => assertSnapshotHealthy({ totalCount: 0, validCount: 0 }), /비정상/);
  assert.throws(() => assertSnapshotHealthy({ totalCount: 7000, validCount: 7000, previousCount: 9363 }), /20% 이상 감소/);
  assert.doesNotThrow(() => assertSnapshotHealthy({ totalCount: 9363, validCount: 9363, previousCount: 9300 }));
});

test("matches stores inside a polygon while excluding its hole", () => {
  const geometry = {
    type: "Polygon",
    coordinates: [
      [[126.9, 35.1], [127, 35.1], [127, 35.2], [126.9, 35.2], [126.9, 35.1]],
      [[126.94, 35.14], [126.96, 35.14], [126.96, 35.16], [126.94, 35.16], [126.94, 35.14]]
    ]
  };
  assert.equal(pointInGeometry(126.92, 35.12, geometry), true);
  assert.equal(pointInGeometry(126.95, 35.15, geometry), false);
  assert.equal(pointInGeometry(126.9, 35.15, geometry), true);
  assert.equal(pointInGeometry(126.94, 35.15, geometry), true);
  assert.equal(pointInGeometry(127.1, 35.15, geometry), false);
  assert.ok(geometryAreaSqm(geometry) > 0);
});

test("filters stores by a selected commercial-zone geometry", () => {
  const geometry = { type: "Polygon", coordinates: [[[126.91, 35.14], [126.93, 35.14], [126.93, 35.16], [126.91, 35.16], [126.91, 35.14]]] };
  assert.deepEqual(filterStores(stores, { zoneGeometry: geometry }).map((store) => store.name), ["동명카페", "충장서점"]);
});

test("rejects invalid or sharply reduced zone snapshots", () => {
  const coordinates = [[[126.9, 35.1], [126.91, 35.1], [126.91, 35.11], [126.9, 35.1]]];
  const feature = (no) => ({ properties: { no }, geometry: { type: "Polygon", coordinates } });
  assert.throws(() => assertZoneSnapshotHealthy({ features: [] }), /비정상/);
  assert.throws(() => assertZoneSnapshotHealthy({ features: ["1", "2", "3", "4", "5"].map((no) => ({ properties: { no }, geometry: { type: "Polygon", coordinates: [] } })) }), /좌표/);
  assert.throws(() => assertZoneSnapshotHealthy({ features: ["1", "2", "3", "4", "5"].map((no) => ({ properties: { no }, geometry: { type: "Polygon", coordinates: [coordinates[0], []] } })) }), /좌표/);
  assert.throws(() => assertZoneSnapshotHealthy({ features: [1, 2, 3, 4, 5].map(() => feature("1")) }), /중복/);
  assert.throws(() => assertZoneSnapshotHealthy({ features: ["1", "2", "3", "4", "5"].map(feature), previousCount: 7 }), /20% 이상 감소/);
  assert.doesNotThrow(() => assertZoneSnapshotHealthy({ features: ["1", "2", "3", "4", "5", "6", "7"].map(feature), previousCount: 7 }));
});
