import test from "node:test";
import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import {
  buildLocationFilter,
  buildLocationSelection,
  compactStore,
  filterStores,
  geometryAreaSqm,
  pointInGeometry,
  sortStores,
  summarizeStores,
  toLegacyPnu
} from "../lib/market.js";
import { assertSnapshotHealthy } from "../lib/store-update.js";
import { assertZoneSnapshotHealthy, filterVworldZones, mergeZoneFeatures } from "../lib/zone-update.js";
import {
  boundsIntersect,
  filterBuildingsInZone,
  geometryDistanceMeters,
  geometryBounds,
  geometryCenter,
  matchBuildingIndustries
} from "../lib/building-outline.js";
import {
  compactLicense,
  compareStoreSources,
  deduplicateBaseStores,
  deduplicateLicenseStores,
  deduplicateStoreSources,
  epsg5174ToWgs84,
  LOCALDATA_SOURCES,
  mergeStoreSources,
  parseLocaldataResponse
} from "../lib/store-license.js";

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

test("converts LocalData EPSG:5174 coordinates to WGS84", () => {
  const coordinates = epsg5174ToWgs84("193104.410616951", "183418.411238483");
  assert.ok(coordinates);
  assert.ok(Math.abs(coordinates.longitude - 126.9251016594) < 1e-9);
  assert.ok(Math.abs(coordinates.latitude - 35.1500089129) < 1e-9);
  assert.equal(epsg5174ToWgs84("", ""), null);
});

test("parses the LocalData response envelope", () => {
  const page = parseLocaldataResponse({
    response: {
      header: { resultCode: "0", resultMsg: "정상" },
      body: { pageNo: 1, numOfRows: 1, totalCount: 1, items: { item: [{ MNG_NO: "license-1" }] } }
    }
  });
  assert.deepEqual(page, { pageNo: 1, numOfRows: 1, totalCount: 1, items: [{ MNG_NO: "license-1" }] });
  assert.throws(() => parseLocaldataResponse({ response: { header: { resultCode: "30", resultMsg: "실패" } } }), /실패/);
});

test("declares every approved supplemental LocalData source once", () => {
  const approvedIds = [
    "15154822", "15154874", "15154458", "15154899", "15154952", "15155272", "15154944", "15155083", "15155055",
    "15155077", "15155085", "15154975", "15155011", "15155038", "15155071", "15155091", "15154927", "15154951",
    "15154955", "15154958", "15154945", "15154890", "15154883", "15155245", "15155144", "15155126", "15155170",
    "15155221", "15155090", "15155113", "15155103", "15154791", "15155253", "15155258", "15155022", "15155029",
    "15154981", "15155093", "15155099", "15155130", "15155015", "15154864", "15154897", "15154910", "15154903",
    "15154983"
  ];
  assert.equal(LOCALDATA_SOURCES.length, 54);
  const sources = LOCALDATA_SOURCES.filter((source) => approvedIds.includes(source.datasetId));
  assert.equal(sources.length, approvedIds.length);
  assert.equal(new Set(sources.map((source) => source.datasetId)).size, approvedIds.length);
  assert.ok(sources.every((source) => source.endpoint.startsWith("https://apis.data.go.kr/1741000/") && source.endpoint.endsWith("/info")));
});

test("merges active license records without double-counting known stores", () => {
  const restaurantSource = LOCALDATA_SOURCES.find((source) => source.slug === "general_restaurants");
  const bakerySource = LOCALDATA_SOURCES.find((source) => source.slug === "bakeries");
  const base = [{
    ...stores[0],
    id: "sdsc-1",
    name: "동명카페",
    address: "전남광주통합특별시 동구 동명로 1",
    lotAddress: "전남광주통합특별시 동구 동명동 1"
  }];
  const matching = compactLicense({
    MNG_NO: "restaurant-1",
    BPLC_NM: "동명카페",
    ROAD_NM_ADDR: "전남광주통합특별시 동구 동명로 1",
    LOTNO_ADDR: "전남광주통합특별시 동구 동명동 1",
    CRD_INFO_X: "193104.410616951",
    CRD_INFO_Y: "183418.411238483",
    SALS_STTS_CD: "01",
    SALS_STTS_NM: "영업/정상"
  }, restaurantSource);
  const added = compactLicense({
    MNG_NO: "bakery-1",
    BPLC_NM: "새로운 제과점",
    ROAD_NM_ADDR: "전남광주통합특별시 동구 제봉로 1",
    LOTNO_ADDR: "전남광주통합특별시 동구 대인동 2",
    CRD_INFO_X: "192031.813112322",
    CRD_INFO_Y: "183922.104625861",
    SALS_STTS_CD: "01",
    SALS_STTS_NM: "영업/정상"
  }, bakerySource);
  const duplicate = compactLicense({
    MNG_NO: "bakery-2",
    BPLC_NM: "새로운 제과점",
    ROAD_NM_ADDR: "전남광주통합특별시 동구 제봉로 1",
    LOTNO_ADDR: "전남광주통합특별시 동구 대인동 2",
    CRD_INFO_X: "192031.813112322",
    CRD_INFO_Y: "183922.104625861",
    SALS_STTS_CD: "01",
    SALS_STTS_NM: "영업/정상"
  }, restaurantSource);
  const result = mergeStoreSources(base, [matching, added, duplicate]);
  assert.equal(deduplicateLicenseStores([added, duplicate]).length, 1);
  assert.equal(result.comparison.rawLicenseCount, 3);
  assert.equal(result.comparison.matchedCount, 1);
  assert.equal(result.comparison.addedCount, 1);
  assert.deepEqual(result.comparison.matchTypeCounts, { "name-address": 1 });
  assert.equal(result.stores.length, 2);
  assert.deepEqual(result.added[0].sourceSlugs, ["bakeries", "general_restaurants"]);
});

test("matches a license record against a split branch name and detailed address", () => {
  const base = {
    ...stores[0],
    id: "sdsc-gongcha",
    name: "공차광주",
    branch: "충장점",
    address: "전남광주통합특별시 동구 중앙로 162-1",
    lotAddress: "전남광주통합특별시 동구 황금동 5-7",
    longitude: 126.913677204943,
    latitude: 35.148372266374
  };
  const license = {
    id: "license:rest_cafes:gongcha",
    name: "공차 광주충장점",
    branch: "",
    sourceSlug: "rest_cafes",
    largeCode: "I2",
    address: "전남광주통합특별시 동구 중앙로 162-1, 1층 (황금동)",
    lotAddress: "전남광주통합특별시 동구 황금동 5-7 1층",
    longitude: 126.91369986751238,
    latitude: 35.1484592395591
  };
  const result = mergeStoreSources([base], [license]);
  assert.equal(result.comparison.matchedCount, 1);
  assert.equal(result.added.length, 0);
});

test("deduplicates duplicate source rows without merging nearby different addresses", () => {
  const duplicateBase = deduplicateBaseStores([
    { ...stores[0], id: "base-1", name: "같은 업소", address: "동구 중앙로 1", lotAddress: "동구 황금동 1" },
    { ...stores[0], id: "base-2", name: "같은 업소", address: "동구 중앙로 1", lotAddress: "동구 황금동 1" },
    { ...stores[0], id: "base-3", name: "같은 업소", address: "동구 중앙로 2", lotAddress: "동구 황금동 2", longitude: 126.921, latitude: 35.151 },
    { ...stores[0], id: "base-4", name: "같은 업소", address: "동구 중앙로 3", lotAddress: "동구 황금동 3" }
  ]);
  assert.equal(duplicateBase.length, 2);

  const licenseRows = [
    {
      id: "license:one",
      name: "공차 광주충장점",
      branch: "",
      sourceSlug: "rest_cafes",
      address: "전남광주통합특별시 동구 중앙로 162-1, 1층",
      lotAddress: "전남광주통합특별시 동구 황금동 5-7 1층",
      longitude: 126.91369986751238,
      latitude: 35.1484592395591
    },
    {
      id: "license:two",
      name: "공차광주",
      branch: "충장점",
      sourceSlug: "general_restaurants",
      address: "전남광주통합특별시 동구 중앙로 162-1",
      lotAddress: "전남광주통합특별시 동구 황금동 5-7",
      longitude: 126.913677204943,
      latitude: 35.148372266374
    }
  ];
  assert.equal(deduplicateLicenseStores(licenseRows).length, 1);
  assert.equal(deduplicateLicenseStores([
    ...licenseRows,
    { ...licenseRows[0], id: "license:three", address: "전남광주통합특별시 동구 중앙로 300", lotAddress: "전남광주통합특별시 동구 계림동 100-1", longitude: 126.92, latitude: 35.15 }
  ]).length, 2);
  const baseForLicense = {
    ...stores[0],
    id: "base-gongcha",
    name: "공차광주",
    branch: "충장점",
    address: "전남광주통합특별시 동구 중앙로 162-1",
    lotAddress: "전남광주통합특별시 동구 황금동 5-7",
    longitude: 126.913677204943,
    latitude: 35.148372266374
  };
  const result = deduplicateStoreSources([baseForLicense], licenseRows);
  assert.equal(result.stores.length, 1);
  assert.equal(result.licenseDuplicatesRemoved, 1);
  assert.equal(result.matchedCount, 1);
});

test("filters stores by administrative dong, category and query", () => {
  assert.deepEqual(filterStores(stores, { adminDong: "동명동" }).map((store) => store.name), ["동명카페"]);
  assert.deepEqual(filterStores(stores, { largeCode: "G2", query: "본점" }).map((store) => store.name), ["충장서점"]);
  assert.deepEqual(filterStores(stores, { storeName: "충장" }).map((store) => store.name), ["충장서점"]);
  assert.deepEqual(filterStores(stores, { storeName: "충장로" }), []);
});

test("uses either a zone or an administrative dong, never both", () => {
  const zoneGeometry = { type: "Polygon", coordinates: [] };
  assert.deepEqual(buildLocationFilter("계림1동", zoneGeometry), { zoneGeometry });
  assert.deepEqual(buildLocationFilter("계림1동", null), { adminDong: "계림1동" });
  assert.deepEqual(buildLocationFilter("", null), {});
});

test("switches between zone and administrative-dong selections", () => {
  assert.deepEqual(buildLocationSelection("dong", "계림1동"), { adminDong: "계림1동", zoneNo: "" });
  assert.deepEqual(buildLocationSelection("zone", "9735"), { adminDong: "", zoneNo: "9735" });
  assert.deepEqual(buildLocationSelection("zone", ""), { adminDong: "", zoneNo: "" });
  assert.throws(() => buildLocationSelection("unknown", "value"), /지원하지 않는/);
});

test("summarizes store categories", () => {
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
  assert.deepEqual(filterStores(stores, { adminDong: "동명동", largeCode: "I2", zoneGeometry: geometry }).map((store) => store.name), ["동명카페"]);
});

test("sorts stores by name or large industry without mutating the source", () => {
  assert.deepEqual(sortStores(stores, "name-asc").map((store) => store.name), ["동명카페", "충장서점"]);
  assert.deepEqual(sortStores(stores, "name-desc").map((store) => store.name), ["충장서점", "동명카페"]);
  assert.deepEqual(sortStores(stores, "industry-asc").map((store) => store.name), ["충장서점", "동명카페"]);
  assert.deepEqual(sortStores(stores, "industry-desc").map((store) => store.name), ["동명카페", "충장서점"]);
  assert.deepEqual(stores.map((store) => store.name), ["동명카페", "충장서점"]);
});

test("finds building cell bounds and filters footprints by zone center", () => {
  const zone = { type: "Polygon", coordinates: [[[126.9, 35.1], [127, 35.1], [127, 35.2], [126.9, 35.2], [126.9, 35.1]]] };
  const inside = { id: "inside", geometry: { type: "Polygon", coordinates: [[[126.92, 35.12], [126.93, 35.12], [126.93, 35.13], [126.92, 35.13], [126.92, 35.12]]] } };
  const outside = { id: "outside", geometry: { type: "Polygon", coordinates: [[[127.02, 35.12], [127.03, 35.12], [127.03, 35.13], [127.02, 35.13], [127.02, 35.12]]] } };
  assert.deepEqual(geometryBounds(inside.geometry), [126.92, 35.12, 126.93, 35.13]);
  const center = geometryCenter(inside.geometry);
  assert.ok(Math.abs(center[0] - 126.925) < 1e-12);
  assert.equal(center[1], 35.125);
  assert.equal(boundsIntersect(geometryBounds(inside.geometry), geometryBounds(zone)), true);
  assert.equal(boundsIntersect(geometryBounds(outside.geometry), geometryBounds(zone)), false);
  assert.deepEqual(filterBuildingsInZone([inside, outside], zone), [inside]);
});

test("joins building footprints to stores using current and legacy PNUs", () => {
  const feature = {
    id: "building-1",
    properties: { pnu: "1221010800102870025" },
    geometry: { type: "Polygon", coordinates: [[[126.92, 35.14], [126.921, 35.14], [126.921, 35.141], [126.92, 35.141], [126.92, 35.14]]] }
  };
  const fallbackFeature = {
    id: "building-2",
    properties: { pnu: "1221010800102880025" },
    geometry: { type: "Polygon", coordinates: [[[126.93, 35.14], [126.931, 35.14], [126.931, 35.141], [126.93, 35.141], [126.93, 35.14]]] }
  };
  const result = matchBuildingIndustries([feature, fallbackFeature], [
    { id: "legacy-store", pnu: "2911010800102870025", largeName: "음식", longitude: 126.92, latitude: 35.14 },
    { id: "current-store", pnu: "1221010800102870025", largeName: "음식", longitude: 126.92, latitude: 35.14 },
    { id: "coordinate-store", pnu: "", largeName: "소매", longitude: 126.9305, latitude: 35.1405 }
  ]);
  assert.equal(result.byId.get("building-1"), "음식");
  assert.equal(result.byId.get("building-2"), "소매");
  assert.deepEqual([...result.matchedStoreIds].sort(), ["coordinate-store", "current-store", "legacy-store"]);

  const unknownIndustry = matchBuildingIndustries([feature], [{ id: "unknown-industry-store", pnu: feature.properties.pnu, largeName: "", longitude: 126.92, latitude: 35.14 }]);
  assert.equal(unknownIndustry.byId.get(feature.id), "업종 미확인");
  assert.equal(unknownIndustry.storesById.has(feature.id), false);
});

test("classifies a building by its most common industry and keeps known stores for hover details", () => {
  const feature = {
    id: "multi-store-building",
    properties: { pnu: "1221010800102870025" },
    geometry: { type: "Polygon", coordinates: [[[126.92, 35.14], [126.921, 35.14], [126.921, 35.141], [126.92, 35.141], [126.92, 35.14]]] }
  };
  const result = matchBuildingIndustries([feature], [
    { id: "food-1", pnu: feature.properties.pnu, name: "첫 카페", largeName: "음식", smallName: "카페", address: "동구 1번지", longitude: 126.92, latitude: 35.14 },
    { id: "food-2", pnu: feature.properties.pnu, name: "둘 카페", largeName: "음식", smallName: "카페", address: "동구 1번지", longitude: 126.92, latitude: 35.14 },
    { id: "retail-1", pnu: feature.properties.pnu, name: "서점", largeName: "소매", smallName: "서점", address: "동구 1번지", longitude: 126.92, latitude: 35.14 }
  ]);
  assert.equal(result.byId.get(feature.id), "음식");
  assert.deepEqual(result.storesById.get(feature.id).map((store) => store.id), ["food-1", "food-2", "retail-1"]);
});

test("recovers a nearby store when its PNU differs within the same lot", () => {
  const building = {
    id: "same-lot-building",
    properties: { pnu: "1221010800102870001" },
    geometry: { type: "Polygon", coordinates: [[[126.92, 35.14], [126.921, 35.14], [126.921, 35.141], [126.92, 35.141], [126.92, 35.14]]] }
  };
  const store = { id: "same-lot-store", pnu: "1221010800102870004", largeName: "음식", longitude: 126.92102, latitude: 35.1405 };
  assert.ok(geometryDistanceMeters(store.longitude, store.latitude, building.geometry) < 3);
  const result = matchBuildingIndustries([building], [store]);
  assert.equal(result.byId.get(building.id), "음식");
  assert.deepEqual([...result.matchedStoreIds], [store.id]);
});

test("does not guess between equally close buildings without a lot match", () => {
  const buildings = [
    { id: "left", properties: { pnu: "1221010800100010001" }, geometry: { type: "Polygon", coordinates: [[[126.92, 35.14], [126.9201, 35.14], [126.9201, 35.141], [126.92, 35.141], [126.92, 35.14]]] } },
    { id: "right", properties: { pnu: "1221010800100020001" }, geometry: { type: "Polygon", coordinates: [[[126.9202, 35.14], [126.9203, 35.14], [126.9203, 35.141], [126.9202, 35.141], [126.9202, 35.14]]] } }
  ];
  const result = matchBuildingIndustries(buildings, [{ id: "ambiguous-store", pnu: "1221010800100990001", largeName: "소매", longitude: 126.92015, latitude: 35.1405 }]);
  assert.equal(result.byId.size, 0);
  assert.equal(result.matchedStoreIds.size, 0);
});

test("ships a complete building-outline cell snapshot", async () => {
  const manifest = JSON.parse(await readFile(new URL("../data/figure-ground/manifest.json", import.meta.url), "utf8"));
  assert.equal(manifest.schemaVersion, 2);
  assert.equal(manifest.cells.length, 50);
  assert.equal(manifest.cells.reduce((sum, cell) => sum + cell.count, 0), manifest.featureCount);
  await Promise.all(manifest.cells.map((cell) => access(new URL(`../data/figure-ground/${cell.file}`, import.meta.url))));
});

test("keeps building-outline analysis under the market service", async () => {
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  const app = await readFile(new URL("../app.js", import.meta.url), "utf8");
  assert.match(html, /id="panel-market"/);
  assert.match(html, /id="tab-market"[\s\S]*?>\s*상가·상권 조회/);
  assert.match(html, /id="marketTitle">동구 상가·상권 조회</);
  assert.match(html, /id="marketMap"/);
  assert.deepEqual(
    [...html.matchAll(/data-market-view="([^"]+)">([^<]+)</g)].map(([, view, label]) => [view, label]),
    [["table", "상가 조회"], ["map", "상권 지도"], ["analysis", "상권 분석"]]
  );
  assert.match(html, /id="marketTableNameInput"/);
  assert.doesNotMatch(html, /id="marketTableNameInput"[^>]*placeholder=/);
  assert.match(html, /id="outlineZoneFilter"/);
  assert.match(html, /id="buildingOutlineMap"/);
  assert.match(html, /id="outlineIndustryToggle"[^>]*checked/);
  assert.match(html, /class="outline-legend" id="outlineLegend" hidden/);
  assert.doesNotMatch(html, /id="panel-analysis"/);
  assert.doesNotMatch(html, /id="tab-analysis"/);
  assert.match(app, /if \(\$\("dongFilter"\)\.value \|\| selectedZoneNo\)/);
  assert.match(app, /storeName: \$\("marketTableNameInput"\)\.value\.trim\(\)/);
  assert.match(app, /\$\("marketTableNameInput"\)\.addEventListener\("keydown"[\s\S]*event\.key !== "Enter"[\s\S]*runMarketTableSearch\(\)/);
  assert.doesNotMatch(app, /outlineZoneLayer/);
  assert.doesNotMatch(app, /function initializeBuildingOutline\(\)[\s\S]*?tileLayer/);
  assert.match(app, /outlineMap\.fitBounds\(leafletBounds/);
  assert.doesNotMatch(app, /marketMap\.setMaxBounds\(leafletBounds\.pad/);
  assert.doesNotMatch(app, /marketMap\.setMinZoom\(Math\.max\(12/);
});

test("ships the market snapshot without duplicate source rows", async () => {
  const payload = await readFile(new URL("../data/stores_donggu.json", import.meta.url), "utf8").then(JSON.parse);
  const base = payload.stores.filter((store) => !String(store.id).startsWith("license:"));
  const licenses = payload.stores.filter((store) => String(store.id).startsWith("license:"));
  const result = deduplicateStoreSources(base, licenses);
  assert.equal(result.baseDuplicatesRemoved, 0);
  assert.equal(result.licenseDuplicatesRemoved, 0);
  assert.equal(result.matchedCount, 0);
  assert.equal(result.stores.length, payload.stores.length);
  assert.equal(payload.meta.totalCount, payload.stores.length);
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

test("loads the manually registered commercial-zone boundaries", async () => {
  const [payload, storePayload, vworldPayload] = await Promise.all([
    readFile(new URL("../data/manual_mainbiz_zones_donggu.geojson", import.meta.url), "utf8").then(JSON.parse),
    readFile(new URL("../data/stores_donggu.json", import.meta.url), "utf8").then(JSON.parse),
    readFile(new URL("../data/mainbiz_zones_donggu.geojson", import.meta.url), "utf8").then(JSON.parse)
  ]);
  assert.equal(payload.meta.zoneCount, 9);
  assertZoneSnapshotHealthy({ features: payload.features, minimumCount: 9 });
  const sansu = payload.features.find((feature) => feature.properties.no === "manual-sansu-market");
  const artStreet = payload.features.find((feature) => feature.properties.no === "manual-art-street");
  const electronicsStreet = payload.features.find((feature) => feature.properties.no === "manual-electronics-street");
  const daeinMarket = payload.features.find((feature) => feature.properties.no === "manual-daein-market");
  const namgwangjuMarket = payload.features.find((feature) => feature.properties.no === "manual-namgwangju-market");
  const printingStreet = payload.features.find((feature) => feature.properties.no === "manual-printing-street");
  const weddingStreet = payload.features.find((feature) => feature.properties.no === "manual-wedding-street");
  const honsuStreet = payload.features.find((feature) => feature.properties.no === "manual-honsu-street");
  const boribapStreet = payload.features.find((feature) => feature.properties.no === "manual-mudeungsan-boribap-street");
  assert.equal(pointInGeometry(126.930954807232, 35.1537139906824, sansu.geometry), true);
  assert.equal(pointInGeometry(126.9189161085083, 35.14964229752389, artStreet.geometry), true);
  assert.equal(pointInGeometry(126.91363895181567, 35.15341760540318, electronicsStreet.geometry), true);
  assert.equal(pointInGeometry(126.91680470501554, 35.153897541407304, daeinMarket.geometry), true);
  assert.equal(pointInGeometry(126.92126911677772, 35.13927142984483, namgwangjuMarket.geometry), true);
  assert.equal(pointInGeometry(126.91790655694692, 35.14409148564109, printingStreet.geometry), true);
  assert.equal(pointInGeometry(126.91539780867934, 35.14533138568136, weddingStreet.geometry), true);
  assert.equal(pointInGeometry(126.91251131075357, 35.15083214530407, honsuStreet.geometry), true);
  assert.equal(pointInGeometry(126.9425714556449, 35.14940569033853, boribapStreet.geometry), true);
  assert.ok(Math.abs(geometryAreaSqm(sansu.geometry) - sansu.properties.areaSqm) < 1);
  assert.ok(Math.abs(geometryAreaSqm(artStreet.geometry) - artStreet.properties.areaSqm) < 1);
  assert.ok(Math.abs(geometryAreaSqm(electronicsStreet.geometry) - electronicsStreet.properties.areaSqm) < 1);
  assert.ok(Math.abs(geometryAreaSqm(daeinMarket.geometry) - daeinMarket.properties.areaSqm) < 1);
  assert.ok(Math.abs(geometryAreaSqm(namgwangjuMarket.geometry) - namgwangjuMarket.properties.areaSqm) < 1);
  assert.ok(Math.abs(geometryAreaSqm(printingStreet.geometry) - printingStreet.properties.areaSqm) < 1);
  assert.ok(Math.abs(geometryAreaSqm(weddingStreet.geometry) - weddingStreet.properties.areaSqm) < 1);
  assert.ok(Math.abs(geometryAreaSqm(honsuStreet.geometry) - honsuStreet.properties.areaSqm) < 1);
  assert.ok(Math.abs(geometryAreaSqm(boribapStreet.geometry) - boribapStreet.properties.areaSqm) < 1);
  assert.equal(filterStores(storePayload.stores, { zoneGeometry: electronicsStreet.geometry }).length, 113);
  assert.equal(filterStores(storePayload.stores, { zoneGeometry: daeinMarket.geometry }).length, 319);
  assert.equal(filterStores(storePayload.stores, { zoneGeometry: namgwangjuMarket.geometry }).length, 180);
  assert.equal(filterStores(storePayload.stores, { zoneGeometry: printingStreet.geometry }).length, 422);
  assert.equal(filterStores(storePayload.stores, { zoneGeometry: weddingStreet.geometry }).length, 173);
  assert.equal(filterStores(storePayload.stores, { zoneGeometry: honsuStreet.geometry }).length, 127);
  assert.equal(filterStores(storePayload.stores, { zoneGeometry: boribapStreet.geometry }).length, 38);
  const mergedZones = mergeZoneFeatures(vworldPayload, payload);
  assert.equal(mergedZones.filter((feature) => feature.properties.name === "대인시장").length, 1);
  assert.equal(mergedZones.find((feature) => feature.properties.name === "대인시장").properties.source, "manual");
  assert.equal(mergedZones.filter((feature) => feature.properties.name === "남광주시장").length, 1);
  assert.equal(mergedZones.find((feature) => feature.properties.name === "남광주시장").properties.source, "manual");
  assert.equal(storePayload.stores.filter((store) => mergedZones
    .some((feature) => pointInGeometry(store.longitude, store.latitude, feature.geometry))).length, 1656);
});

test("merges VWorld and manual zones while rejecting duplicate numbers", () => {
  const feature = (no) => ({ properties: { no } });
  assert.deepEqual(mergeZoneFeatures({ features: [feature("1")] }, { features: [feature("manual-1")] }).map((item) => item.properties.no), ["1", "manual-1"]);
  assert.deepEqual(mergeZoneFeatures(
    { features: [feature("1"), feature("2")] },
    { features: [{ properties: { no: "manual-1", replacesVworldNo: "1" } }] }
  ).map((item) => item.properties.no), ["2", "manual-1"]);
  assert.throws(() => mergeZoneFeatures({ features: [feature("1")] }, { features: [feature("1")] }), /중복/);
});

test("excludes configured VWorld zones", () => {
  const feature = (no, name) => ({ properties: { no, name } });
  const zones = [
    feature("9730", "금남로4가역_1"),
    feature("9731", "금남로4가역_2"),
    feature("9732", "금남로4가역_3"),
    feature("9733", "금남로4가역_4"),
    feature("changed-number", "금남로4가역_1"),
    feature("9734", "문화전당역"),
    feature("changed-culture-number", "문화전당역"),
    feature("9735", "대인시장")
  ];
  assert.deepEqual(filterVworldZones(zones).map((zone) => zone.properties.no), ["9735"]);
});

test("publishes only retained VWorld zones", async () => {
  const payload = JSON.parse(await readFile(new URL("../data/mainbiz_zones_donggu.geojson", import.meta.url), "utf8"));
  assert.equal(payload.meta.zoneCount, 2);
  assert.deepEqual(payload.features.map((feature) => feature.properties.name), ["대인시장", "남광주시장"]);
  assert.deepEqual(filterVworldZones(payload.features), payload.features);
});
