import test from "node:test";
import assert from "node:assert/strict";
import {
  datasetDetailUrl,
  datasetSearchUrl,
  extractApiEndpoints,
  extractDatasetLinks,
  readApplicationState
} from "../lib/localdata-portal.js";

test("folds a dataset page's operation URLs into one service endpoint", () => {
  const text = `
    요청주소 https://apis.data.go.kr/1741000/tele_sales/info
    요청주소 https://apis.data.go.kr/1741000/tele_sales/count
    요청주소 https://apis.data.go.kr/B553077/api/open/sdsc2/storeListInDong
  `;
  assert.deepEqual(extractApiEndpoints(text), [
    { slug: "tele_sales", endpoint: "https://apis.data.go.kr/1741000/tele_sales/info" }
  ]);
});

test("keeps every distinct license service on a page", () => {
  const endpoints = extractApiEndpoints(`
    https://apis.data.go.kr/1741000/museums_galleries/info
    https://apis.data.go.kr/1741000/animal_transport/info
  `);
  assert.deepEqual(endpoints.map(({ slug }) => slug), ["museums_galleries", "animal_transport"]);
});

test("returns nothing when a page carries no license API address", () => {
  assert.deepEqual(extractApiEndpoints("요청주소가 없는 페이지"), []);
  assert.deepEqual(extractApiEndpoints(null), []);
});

test("reads dataset ids and titles out of a search result page", () => {
  const html = `
    <ul>
      <li><a href="/data/15155146/openapi.do">행정안전부_문화_<b>박물관</b> 및 미술관 조회서비스</a></li>
      <li><a href="/data/15155018/openapi.do?recommendDataYn=Y">행정안전부_생활_등록체육시설업 조회서비스</a></li>
      <li><a href="/data/15155146/openapi.do">중복 링크</a></li>
      <li><a href="/data/15083033/fileData.do">파일데이터는 제외</a></li>
    </ul>
  `;
  assert.deepEqual(extractDatasetLinks(html), [
    { datasetId: "15155146", title: "행정안전부_문화_ 박물관 및 미술관 조회서비스" },
    { datasetId: "15155018", title: "행정안전부_생활_등록체육시설업 조회서비스" }
  ]);
});

test("tells an unapplied dataset page from an approved one", () => {
  assert.equal(readApplicationState("활용신청 바로가기"), "not-applied");
  assert.equal(readApplicationState("일반 인증키 발급 완료"), "approved-or-applied");
  assert.equal(readApplicationState("활용신청 상세기능정보"), "approved-or-applied");
  assert.equal(readApplicationState(""), "unknown");
});

test("builds portal URLs the script navigates to", () => {
  assert.equal(datasetDetailUrl("15155146"), "https://www.data.go.kr/data/15155146/openapi.do");
  const search = new URL(datasetSearchUrl("통신판매업"));
  assert.equal(search.searchParams.get("keyword"), "통신판매업");
  assert.equal(search.searchParams.get("dType"), "API");
});
