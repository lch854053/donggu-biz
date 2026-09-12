import test from "node:test";
import assert from "node:assert/strict";
import {
  compactLicense,
  isActiveLicense,
  isClosedLicense,
  isSuspendedLicense,
  licenseStatusKind,
  LOCALDATA_SOURCES,
  statusCodeFor,
  statusCodesFor
} from "../lib/store-license.js";

const modelRestaurant = LOCALDATA_SOURCES.find((candidate) => candidate.slug === "excellent_restaurant_info");
const generalRestaurant = LOCALDATA_SOURCES.find((candidate) => candidate.slug === "general_restaurants");

test("모범음식점 원천이 LOCALDATA_SOURCES에 등록되어 있다", () => {
  assert.equal(modelRestaurant.datasetId, "15155052");
  assert.equal(modelRestaurant.endpoint, "https://apis.data.go.kr/1741000/excellent_restaurant_info/info");
});

test("모범음식점은 휴업 코드가 없고 02를 폐업으로 쓴다", () => {
  assert.deepEqual(statusCodesFor(modelRestaurant), { active: "01", suspended: "", closed: "02" });
  assert.equal(statusCodeFor(modelRestaurant, "active"), "01");
  assert.equal(statusCodeFor(modelRestaurant, "suspended"), "");
  assert.equal(statusCodeFor(modelRestaurant, "closed"), "02");
});

test("모범음식점 02는 폐업으로 분류된다", () => {
  const closed = { SALS_STTS_CD: "02", SALS_STTS_NM: "폐업" };
  assert.equal(licenseStatusKind(closed, modelRestaurant), "closed");
  assert.equal(isClosedLicense(closed, modelRestaurant), true);
  assert.equal(isSuspendedLicense(closed, modelRestaurant), false);

  const active = { SALS_STTS_CD: "01", SALS_STTS_NM: "영업" };
  assert.equal(licenseStatusKind(active, modelRestaurant), "active");
  assert.equal(isActiveLicense(active, modelRestaurant), true);
});

test("표준 원천의 상태코드는 그대로다", () => {
  assert.deepEqual(statusCodesFor(generalRestaurant), { active: "01", suspended: "02", closed: "03" });
  assert.equal(licenseStatusKind({ SALS_STTS_CD: "02", SALS_STTS_NM: "휴업" }, generalRestaurant), "suspended");
  assert.equal(licenseStatusKind({ SALS_STTS_CD: "03", SALS_STTS_NM: "폐업" }, generalRestaurant), "closed");
  assert.equal(licenseStatusKind({ SALS_STTS_CD: "03", SALS_STTS_NM: "폐업" }), "closed");
});

test("모범음식점 필드 이름을 접어 담는다", () => {
  const license = compactLicense({
    MNG_NO: "5805000-101-2008-00088",
    BSNSSP_NM: "제주삼다갈치",
    ROAD_NM_ADDR: "전남광주통합특별시 동구 구성로204번길 28 (대인동,(1층))",
    LCTN_ADDR: "전남광주통합특별시 동구 대인동 154 (1층)",
    APLY_YMD: "2008-06-18",
    DSGN_YMD: "2010-06-30",
    RE_DSGN_YMD: "2029-12-22",
    DSGN_RTRCN_YMD: "",
    DSGN_RTRCN_RSN: "",
    PRINC_FD_KND: "조림",
    SALS_STTS_CD: "01",
    SALS_STTS_NM: "영업",
    CLSBIZ_YMD: "",
    DAT_UPDT_PNT: "2026-05-22 03:03:03"
  }, modelRestaurant);

  assert.equal(license.name, "제주삼다갈치");
  assert.equal(license.smallName, "모범음식점");
  assert.equal(license.licenseType, "모범음식점");
  assert.equal(license.lotAddress, "전남광주통합특별시 동구 대인동 154 (1층)");
  assert.equal(license.licenseDate, "2008-06-18");
  assert.equal(license.designatedAt, "2010-06-30");
  assert.equal(license.reDesignatedAt, "2029-12-22");
  assert.equal(license.principalFoodKind, "조림");
  assert.equal(license.longitude, null);
  assert.equal(license.latitude, null);
});

test("표준 원천은 지정 연혁 필드를 만들지 않는다", () => {
  const license = compactLicense({
    MNG_NO: "5805000-101-2007-00139",
    BPLC_NM: "뜰안채",
    ROAD_NM_ADDR: "전남광주통합특별시 동구 문화전당로26번길 10-4, 2층 (남동)",
    LOTNO_ADDR: "전남광주통합특별시 동구 남동 30-2 2층",
    LCPMT_YMD: "2007-06-24",
    SALS_STTS_CD: "01",
    SALS_STTS_NM: "영업"
  }, generalRestaurant);

  assert.equal(license.name, "뜰안채");
  assert.equal(license.licenseDate, "2007-06-24");
  assert.equal("designatedAt" in license, false);
});
