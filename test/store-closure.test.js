import test from "node:test";
import assert from "node:assert/strict";
import {
  compactLicense,
  isActiveLicense,
  isClosedLicense,
  isSuspendedLicense,
  licenseStatusKind,
  LOCALDATA_SOURCES,
  LOCALDATA_STATUS_CODES
} from "../lib/store-license.js";
import { localdataRequestUrl } from "../lib/localdata-client.js";
import { createLicenseAdminDongResolver } from "../lib/license-admin-dong.js";
import {
  assertClosureSnapshotHealthy,
  closureRates,
  closureYear,
  licenseDateParts,
  licenseLifespanDays,
  summarizeClosures
} from "../lib/store-closure.js";

const source = LOCALDATA_SOURCES.find((candidate) => candidate.slug === "general_restaurants");

function closedLicense(overrides = {}) {
  return {
    statusKind: "closed",
    adminDong: "충장동",
    largeName: "음식",
    smallName: "일반음식점",
    licenseDate: "20150301",
    closedDate: "20200115",
    longitude: 126.92,
    latitude: 35.15,
    ...overrides
  };
}

test("classifies LocalData sales status codes", () => {
  assert.equal(licenseStatusKind({ SALS_STTS_CD: "01" }), "active");
  assert.equal(licenseStatusKind({ SALS_STTS_CD: "02" }), "suspended");
  assert.equal(licenseStatusKind({ SALS_STTS_CD: "03" }), "closed");
  assert.equal(licenseStatusKind({ SALS_STTS_CD: "05" }), "other");
  assert.equal(licenseStatusKind({}), "");
});

test("falls back to the status name when the code is missing", () => {
  assert.equal(licenseStatusKind({ SALS_STTS_NM: "영업/정상" }), "active");
  assert.equal(licenseStatusKind({ SALS_STTS_NM: "휴업" }), "suspended");
  assert.equal(licenseStatusKind({ SALS_STTS_NM: "폐업" }), "closed");
  assert.equal(licenseStatusKind({ SALS_STTS_NM: "허가취소" }), "closed");
  assert.ok(isActiveLicense({ SALS_STTS_CD: "01" }));
  assert.ok(isClosedLicense({ SALS_STTS_NM: "폐업" }));
  assert.ok(isSuspendedLicense({ SALS_STTS_CD: "02" }));
  assert.ok(!isActiveLicense({ SALS_STTS_CD: "03" }));
});

test("keeps the closure fields when compacting a closed license row", () => {
  const license = compactLicense({
    MNG_NO: "5805000-101-2015-00001",
    BPLC_NM: "충장식당",
    ROAD_NM_ADDR: "전남광주통합특별시 동구 충장로 1",
    SALS_STTS_CD: "03",
    SALS_STTS_NM: "폐업",
    LCPMT_YMD: "20150301",
    CLSBIZ_YMD: "20200115"
  }, source);
  assert.equal(license.statusCode, "03");
  assert.equal(license.closedDate, "20200115");
  assert.equal(licenseLifespanDays(license), 1781);
});

test("rejects the impossible dates LocalData carries", () => {
  assert.equal(licenseDateParts("99991231"), null);
  assert.equal(licenseDateParts("82020101"), null);
  assert.equal(licenseDateParts("20200230"), null);
  assert.equal(licenseDateParts("2020011"), null);
  assert.equal(licenseDateParts("2020-01-15").year, 2020);
  assert.equal(closureYear({ closedDate: "20200115" }), 2020);
  assert.equal(closureYear({ closedDate: "99991231" }), null);
  assert.equal(licenseLifespanDays({ licenseDate: "20200115", closedDate: "20150301" }), null);
});

test("summarizes closures by year, admin dong and category", () => {
  const summary = summarizeClosures([
    closedLicense(),
    closedLicense({ closedDate: "20210620", adminDong: "동명동" }),
    closedLicense({ closedDate: "20210101", largeName: "소매", licenseDate: "20200101" }),
    closedLicense({ statusKind: "suspended", closedDate: "", longitude: null, latitude: null, adminDong: "" })
  ]);
  assert.equal(summary.totalCount, 4);
  assert.equal(summary.closedCount, 3);
  assert.equal(summary.suspendedCount, 1);
  assert.equal(summary.missingCoordinateCount, 1);
  assert.equal(summary.missingAdminDongCount, 1);
  assert.deepEqual(summary.byYear, [{ year: 2021, count: 2 }, { year: 2020, count: 1 }]);
  assert.deepEqual(summary.byAdminDong.map(({ name, count }) => [name, count]), [["충장동", 2], ["동명동", 1]]);
  assert.equal(summary.byLargeName[0].name, "음식");
  assert.equal(summary.byLargeName[0].lifespan.count, 2);
  assert.equal(summary.lifespan.count, 3);
});

test("counts suspended rows without a closure date as in-summary but undated", () => {
  const summary = summarizeClosures([closedLicense({ closedDate: "99991231" })]);
  assert.equal(summary.closedCount, 1);
  assert.equal(summary.missingClosedDateCount, 1);
  assert.deepEqual(summary.byYear, []);
});

test("computes closure rates against the active store snapshot", () => {
  const active = [{ adminDong: "충장동" }, { adminDong: "충장동" }, { adminDong: "동명동" }];
  const closed = [closedLicense(), closedLicense(), closedLicense({ adminDong: "지산동" })];
  const rates = closureRates(active, closed, (row) => row.adminDong);
  const chungjang = rates.find(({ name }) => name === "충장동");
  assert.deepEqual(chungjang, { name: "충장동", activeCount: 2, closedCount: 2, closureRate: 0.5 });
  assert.deepEqual(rates.find(({ name }) => name === "동명동"), {
    name: "동명동", activeCount: 1, closedCount: 0, closureRate: 0
  });
  assert.equal(rates.find(({ name }) => name === "지산동").activeCount, 0);
});

test("guards the closure snapshot against empty or shrunken collections", () => {
  assert.throws(() => assertClosureSnapshotHealthy({ totalCount: 0 }), /비어 있어/);
  assert.throws(() => assertClosureSnapshotHealthy({ totalCount: 700, previousCount: 1000 }), /20% 넘게/);
  assert.doesNotThrow(() => assertClosureSnapshotHealthy({ totalCount: 900, previousCount: 1000 }));
  assert.doesNotThrow(() => assertClosureSnapshotHealthy({ totalCount: 900, previousCount: NaN }));
});

test("requests one sales status at a time from the Dong-gu admin group", () => {
  const url = localdataRequestUrl(source, {
    serviceKey: "key",
    pageNo: 3,
    statusCode: LOCALDATA_STATUS_CODES.closed
  });
  assert.equal(url.searchParams.get("cond[SALS_STTS_CD::EQ]"), "03");
  assert.equal(url.searchParams.get("cond[OPN_ATMY_GRP_CD::EQ]"), "5805000");
  assert.equal(url.searchParams.get("pageNo"), "3");
  assert.equal(url.searchParams.get("numOfRows"), "100");
  assert.equal(url.searchParams.get("returnType"), "json");
});

test("resolves the admin dong for a license without guessing distant matches", () => {
  const stores = [
    { adminDong: "충장동", legalDong: "충장로1가", longitude: 126.92, latitude: 35.15 }
  ];
  const resolve = createLicenseAdminDongResolver(stores);
  assert.equal(resolve("전남광주통합특별시 동구 동명동 1", { longitude: 126.92, latitude: 35.15 }), "동명동");
  assert.equal(resolve("전남광주통합특별시 동구 충장로1가 1", { longitude: 126.9201, latitude: 35.1501 }), "충장동");
  assert.equal(resolve("전남광주통합특별시 동구 충장로1가 1", { longitude: 127.5, latitude: 35.9 }), "");
});
