import test from "node:test";
import assert from "node:assert/strict";
import {
  fetchAddressCoordinate,
  GWANGJU_DONGGU_LD_CODE,
  normalizeBrokerOffice,
  parseBrokerOffices
} from "../lib/broker-offices.js";

const sampleOffice = {
  jurirno: "나92200000-51",
  brkrNm: "강정식",
  ldCode: "11110",
  ldCodeNm: "서울특별시 종로구",
  registDe: "1984-06-01",
  sttusSeCode: "1",
  sttusSeCodeNm: "영업중",
  rdnmadrcode: "11110310001300026600000",
  mnnmadr: "서울특별시 종로구 종로6가 262-1",
  rdnmadr: "서울특별시 종로구 종로 266",
  estbsBeginDe: "2026-03-06",
  lastUpdtDt: "2026-09-10",
  bsnmCmpnm: "신흥사부동산중개인사무소",
  emplym_co: "3"
};

test("광주 동구의 행정통합 뒤 시군구 코드는 12210이다", () => {
  assert.equal(GWANGJU_DONGGU_LD_CODE, "12210");
});

test("부동산중개 사무소를 인허가 행과 같은 모양으로 접는다", () => {
  const license = normalizeBrokerOffice(sampleOffice, { adminDong: "종로동" });
  assert.equal(license.id, "license:vworld_broker_offices:나92200000-51");
  assert.equal(license.sourceSlug, "vworld_broker_offices");
  assert.equal(license.source, "국토교통부 부동산중개업정보");
  assert.equal(license.licenseId, "나92200000-51");
  assert.equal(license.name, "신흥사부동산중개인사무소");
  assert.equal(license.largeName, "부동산");
  assert.equal(license.smallName, "부동산중개");
  assert.equal(license.licenseType, "부동산중개");
  assert.equal(license.adminDong, "종로동");
  assert.equal(license.address, "서울특별시 종로구 종로 266");
  assert.equal(license.lotAddress, "서울특별시 종로구 종로6가 262-1");
  assert.equal(license.statusCode, "1");
  assert.equal(license.statusName, "영업중");
  assert.equal(license.licenseDate, "1984-06-01");
  assert.equal(license.lastModifiedAt, "2026-09-10");
  assert.equal(license.brokerName, "강정식");
  assert.equal(license.employmentCount, 3);
  assert.equal(license.longitude, null);
  assert.equal(license.latitude, null);
  assert.equal("designatedAt" in license, false);
});

test("등록번호가 없으면 이름과 주소로 식별자를 만든다", () => {
  const license = normalizeBrokerOffice({ bsnmCmpnm: "가나부동산", rdnmadr: "전남광주통합특별시 동구 어딘가로 1" });
  assert.equal(license.id, "license:vworld_broker_offices:가나부동산:전남광주통합특별시 동구 어딘가로 1");
  assert.equal(license.licenseId, "");
  assert.equal(license.employmentCount, null);
});

test("EDOffices 응답을 파싱한다", () => {
  const parsed = parseBrokerOffices({
    EDOffices: {
      totalCount: "2",
      field: [sampleOffice, { ...sampleOffice, jurirno: "나92200000-52" }]
    }
  });
  assert.equal(parsed.totalCount, 2);
  assert.equal(parsed.offices.length, 2);

  const zero = parseBrokerOffices({ response: { totalCount: "0" } });
  assert.equal(zero.totalCount, 0);
  assert.deepEqual(zero.offices, []);
});

test("카카오 주소 검색으로 좌표를 찾는다", async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(String(url));
    return {
      ok: true,
      text: async () => "",
      json: async () => ({
        documents: [{ road_address: { x: "126.9196", y: "35.1526" }, address: { x: "126.9", y: "35.1" } }]
      })
    };
  };
  const coordinate = await fetchAddressCoordinate("전남광주통합특별시 동구 동계천로 39", "kakao-key", { fetchImpl });
  assert.deepEqual(coordinate, { longitude: 126.9196, latitude: 35.1526 });
  assert.equal(calls.length, 1);
  assert.match(calls[0], /dapi\.kakao\.com\/v2\/local\/search\/address\.json/);
  assert.match(calls[0], /query=/);
});

test("검색 결과가 없으면 null을 돌려 수집이 막히지 않게 한다", async () => {
  const fetchImpl = async () => ({ ok: true, text: async () => "", json: async () => ({ documents: [] }) });
  const coordinate = await fetchAddressCoordinate("없는 주소", "kakao-key", { fetchImpl });
  assert.equal(coordinate, null);
});

test("주소나 키가 비었으면 호출하지 않는다", async () => {
  let called = 0;
  const fetchImpl = async () => { called += 1; };
  assert.equal(await fetchAddressCoordinate("", "kakao-key", { fetchImpl }), null);
  assert.equal(await fetchAddressCoordinate("주소", "", { fetchImpl }), null);
  assert.equal(called, 0);
});
