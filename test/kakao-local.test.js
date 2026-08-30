import test from "node:test";
import assert from "node:assert/strict";
import {
  buildCoordinateAddressUrl,
  enrichStoreAddresses,
  fetchCoordinateAddress,
  isMaskedAddress,
  parseCoordinateAddressResponse,
  parseKeywordSearchResponse
} from "../lib/kakao-local.js";

test("detects masked address fields", () => {
  assert.equal(isMaskedAddress("전남광주통합특별시 동구 독립로***번길 **"), true);
  assert.equal(isMaskedAddress("전남광주통합특별시 동구 독립로264번길 25"), false);
});

test("parses Kakao coordinate-to-address results", () => {
  assert.deepEqual(parseCoordinateAddressResponse({
    documents: [{
      road_address: {
        address_name: "전남광주통합특별시 동구 독립로264번길 25",
        building_name: "반도빌딩",
        zone_no: "61470"
      },
      address: { address_name: "전남광주통합특별시 동구 대인동 27" }
    }]
  }), {
    address: "전남광주통합특별시 동구 독립로264번길 25",
    lotAddress: "전남광주통합특별시 동구 대인동 27",
    buildingName: "반도빌딩",
    postalCode: "61470"
  });
  assert.equal(parseCoordinateAddressResponse({ documents: [] }), null);
});

test("requests Kakao addresses with WGS84 coordinates", async () => {
  const calls = [];
  const address = await fetchCoordinateAddress(126.9, 35.15, "test-key", {
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), options });
      return {
        ok: true,
        status: 200,
        json: async () => ({ documents: [{ address: { address_name: "지번주소" } }] })
      };
    }
  });

  assert.equal(address.address, "지번주소");
  assert.match(calls[0].url, /input_coord=WGS84/);
  assert.equal(calls[0].options.headers.Authorization, "KakaoAK test-key");
  assert.equal(buildCoordinateAddressUrl(126.9, 35.15).searchParams.get("x"), "126.9");
});

test("accepts a nearby exact-name Kakao place when reverse geocoding has no result", () => {
  assert.deepEqual(parseKeywordSearchResponse({
    documents: [{
      place_name: "스페이스뷰티 광주충장점",
      road_address_name: "전남광주통합특별시 동구 백서로125번길 47",
      address_name: "전남광주통합특별시 동구 광산동 92",
      x: "126.916646225122",
      y: "35.1457207376137",
      distance: "13",
      id: "place-1"
    }]
  }, "스페이스뷰티 광주충장점", 126.91660438355876, 35.1458326165556), {
    address: "전남광주통합특별시 동구 백서로125번길 47",
    lotAddress: "전남광주통합특별시 동구 광산동 92",
    buildingName: "",
    postalCode: "",
    source: "Kakao Local 장소 검색",
    distanceMeters: 13,
    placeId: "place-1"
  });
});

test("falls back to an exact nearby Kakao place for an unresolved coordinate", async () => {
  let requestCount = 0;
  const result = await enrichStoreAddresses([{
    id: "unresolved",
    name: "스페이스뷰티 광주충장점",
    address: "전남광주통합특별시 동구 백서로***번길 **",
    lotAddress: "전남광주통합특별시 동구 광산동 **",
    longitude: 126.91660438355876,
    latitude: 35.1458326165556
  }], {
    apiKey: "test-key",
    pauseMs: 0,
    fetchImpl: async (url) => {
      requestCount += 1;
      if (String(url).includes("coord2address")) {
        return { ok: true, status: 200, json: async () => ({ documents: [] }) };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ documents: [{
          place_name: "스페이스뷰티 광주충장점",
          road_address_name: "전남광주통합특별시 동구 백서로125번길 47",
          address_name: "전남광주통합특별시 동구 광산동 92",
          x: "126.916646225122",
          y: "35.1457207376137",
          distance: "13",
          id: "place-1"
        }] })
      };
    }
  });

  assert.equal(requestCount, 2);
  assert.equal(result.stats.keywordFallbackCount, 1);
  assert.equal(result.stats.unresolvedCount, 0);
  assert.equal(result.stores[0].address, "전남광주통합특별시 동구 백서로125번길 47");
  assert.equal(result.stores[0].addressSource, "Kakao Local 장소 검색");
});

test("enriches masked stores once per unique coordinate and preserves source values", async () => {
  let requestCount = 0;
  const stores = [
    {
      id: "first",
      name: "강남전자",
      address: "전남광주통합특별시 동구 독립로***번길 **, 반도빌딩 *층 ***호 (대인동)",
      lotAddress: "전남광주통합특별시 동구 대인동 ** 반도빌딩",
      buildingName: "",
      longitude: 126.9136312972709,
      latitude: 35.15357080616101
    },
    {
      id: "second",
      name: "다른 업소",
      address: "전남광주통합특별시 동구 독립로***번길 **",
      lotAddress: "전남광주통합특별시 동구 대인동 **",
      buildingName: "",
      longitude: 126.9136312972709,
      latitude: 35.15357080616101
    }
  ];
  const result = await enrichStoreAddresses(stores, {
    apiKey: "test-key",
    pauseMs: 0,
    fetchImpl: async () => {
      requestCount += 1;
      return {
        ok: true,
        status: 200,
        json: async () => ({ documents: [{
          road_address: {
            address_name: "전남광주통합특별시 동구 독립로264번길 25",
            building_name: "반도빌딩",
            zone_no: "61470"
          },
          address: { address_name: "전남광주통합특별시 동구 대인동 27" }
        }] })
      };
    }
  });

  assert.equal(requestCount, 1);
  assert.deepEqual(result.stats, {
    candidateCount: 2,
    uniqueCoordinateCount: 1,
    requestCount: 1,
    keywordRequestCount: 0,
    keywordFallbackCount: 0,
    enrichedCount: 2,
    failedCount: 0,
    unresolvedCount: 0,
    skippedCount: 0
  });
  assert.equal(result.stores[0].address, "전남광주통합특별시 동구 독립로264번길 25");
  assert.equal(result.stores[0].lotAddress, "전남광주통합특별시 동구 대인동 27");
  assert.equal(result.stores[0].buildingName, "반도빌딩");
  assert.equal(result.stores[0].sourceAddress, stores[0].address);
  assert.equal(result.stores[0].sourceLotAddress, stores[0].lotAddress);
  assert.equal(result.stores[0].addressSource, "Kakao Local 좌표→주소");
});
