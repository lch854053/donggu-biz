import test from "node:test";
import assert from "node:assert/strict";
import handler from "../api/nps.js";
import {
  addressArea,
  compactWorkplace,
  compactWorkplaceDetail,
  ksicSection,
  parseNpsBody,
  parseNpsResponse,
  parseNpsXml,
  summarizeWorkplaces,
  toBizNoPrefix
} from "../lib/nps.js";

function responseRecorder() {
  return {
    statusCode: 200,
    headers: {},
    body: undefined,
    setHeader(name, value) { this.headers[name] = value; },
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
    end() { return this; }
  };
}

function npsEnvelope(items, totalCount = items.length) {
  return {
    response: {
      header: { resultCode: "00", resultMsg: "NORMAL SERVICE." },
      body: { items: { item: items }, numOfRows: 10, pageNo: 1, totalCount }
    }
  };
}

const sampleItem = {
  seq: "20240101",
  dataCrtYm: "202607",
  wkplNm: "광주동구청",
  bzowrRgstNo: "408815",
  wkplRoadNmDtlAddr: "광주광역시 동구 서남로",
  wkplJnngStcd: "1",
  wkplStylDvcd: "1",
  wkplIntpCd: "84111",
  ldongAddrMgplDgCd: "29",
  ldongAddrMgplSgguCd: "110",
  ldongAddrMgplSgguEmdCd: "101"
};

test("사업자등록번호는 앞 6자리로만 잘라낸다", () => {
  assert.equal(toBizNoPrefix("408-81-52345"), "408815");
  assert.equal(toBizNoPrefix("4088152345"), "408815");
  assert.equal(toBizNoPrefix(""), "");
});

test("업종코드를 표준산업분류 대분류로 옮긴다", () => {
  assert.equal(ksicSection("84111").code, "O");
  assert.equal(ksicSection("56111").name, "숙박 및 음식점업");
  assert.equal(ksicSection("10120").code, "C");
  assert.equal(ksicSection("").name, "업종 미상");
  assert.equal(ksicSection("44000").name, "업종 미상");
});

test("건물번호 없는 주소에서 시군구와 도로명을 집계 단위로 뽑는다", () => {
  assert.equal(addressArea("광주광역시 동구 서남로"), "동구 서남로");
  assert.equal(addressArea("  "), "주소 미상");
  assert.equal(addressArea("제봉로"), "제봉로");
});

test("사업장 항목을 화면과 통계가 함께 쓰는 형태로 정규화한다", () => {
  const workplace = compactWorkplace(sampleItem);
  assert.equal(workplace.name, "광주동구청");
  assert.equal(workplace.bizNoPrefix, "408815");
  assert.equal(workplace.statusName, "등록");
  assert.equal(workplace.styleName, "법인사업장");
  assert.equal(workplace.sectionCode, "O");
  assert.equal(workplace.area, "동구 서남로");
});

test("알 수 없는 상태·형태 코드는 원본 코드를 남긴다", () => {
  const workplace = compactWorkplace({ ...sampleItem, wkplJnngStcd: "9", wkplStylDvcd: "" });
  assert.equal(workplace.statusName, "상태 미상(9)");
  assert.equal(workplace.styleName, "형태 미상");
});

test("상세 항목은 가입자 수와 고지금액을 함께 담는다", () => {
  const detail = compactWorkplaceDetail({ ...sampleItem, jnngpCnt: "1,024", crrmmNtcAmt: "83210000", nwAcqzrCnt: "7", lssJnngpCnt: "3" });
  assert.equal(detail.subscriberCount, 1024);
  assert.equal(detail.monthlyNoticeAmount, 83210000);
  assert.equal(detail.newSubscriberCount, 7);
  assert.equal(detail.lostSubscriberCount, 3);
});

test("항목이 하나뿐인 응답도 배열로 해석한다", () => {
  const parsed = parseNpsResponse(npsEnvelope(sampleItem, 1));
  assert.equal(parsed.items.length, 1);
  assert.equal(parsed.totalCount, 1);
});

test("정상이 아닌 결과코드는 사유를 담아 오류로 올린다", () => {
  const payload = { response: { header: { resultCode: "30", resultMsg: "SERVICE KEY IS NOT REGISTERED ERROR." }, body: {} } };
  assert.throws(() => parseNpsResponse(payload), /30/);
});

test("사업장 통계는 상태·형태·업종·도로명을 함께 집계한다", () => {
  const summary = summarizeWorkplaces([
    compactWorkplace(sampleItem),
    compactWorkplace({ ...sampleItem, wkplJnngStcd: "2", wkplStylDvcd: "2", wkplIntpCd: "56111" }),
    compactWorkplace({ ...sampleItem, wkplIntpCd: "56112", wkplRoadNmDtlAddr: "광주광역시 동구 제봉로" })
  ]);
  assert.equal(summary.total, 3);
  assert.equal(summary.registered, 2);
  assert.equal(summary.withdrawn, 1);
  assert.equal(summary.corporate, 2);
  assert.equal(summary.individual, 1);
  assert.equal(summary.sections[0].name, "숙박 및 음식점업");
  assert.equal(summary.sections[0].count, 2);
  assert.equal(summary.areas[0].name, "동구 서남로");
  assert.equal(summary.areas[0].count, 2);
});

const sampleXml = `<?xml version="1.0" encoding="UTF-8"?>
<response>
  <header><resultCode>00</resultCode><resultMsg>NORMAL SERVICE.</resultMsg></header>
  <body>
    <items>
      <item>
        <seq>20240101</seq>
        <wkplNm><![CDATA[광주동구청 &amp; 부속기관]]></wkplNm>
        <bzowrRgstNo>408815</bzowrRgstNo>
        <wkplRoadNmDtlAddr>광주광역시 동구 서남로</wkplRoadNmDtlAddr>
        <wkplJnngStcd>1</wkplJnngStcd>
        <wkplStylDvcd>1</wkplStylDvcd>
        <wkplIntpCd>84111</wkplIntpCd>
        <dataCrtYm>202607</dataCrtYm>
      </item>
      <item>
        <seq>20240102</seq>
        <wkplNm>동구식당</wkplNm>
        <bzowrRgstNo>408816</bzowrRgstNo>
        <wkplRoadNmDtlAddr>광주광역시 동구 제봉로</wkplRoadNmDtlAddr>
        <wkplJnngStcd>2</wkplJnngStcd>
        <wkplStylDvcd>2</wkplStylDvcd>
        <wkplIntpCd>56111</wkplIntpCd>
        <dataCrtYm>202607</dataCrtYm>
      </item>
    </items>
    <numOfRows>10</numOfRows><pageNo>1</pageNo><totalCount>1234</totalCount>
  </body>
</response>`;

test("XML 응답에서 항목과 전체 건수를 읽는다", () => {
  const parsed = parseNpsXml(sampleXml);
  assert.equal(parsed.items.length, 2);
  assert.equal(parsed.totalCount, 1234);
  assert.equal(parsed.items[0].wkplNm, "광주동구청 & 부속기관");
  assert.equal(parsed.items[1].wkplIntpCd, "56111");
});

test("XML 인증 오류 문서는 사유를 담아 오류로 올린다", () => {
  const xml = `<OpenAPI_ServiceResponse><cmmMsgHeader>
    <returnAuthMsg>SERVICE_KEY_IS_NOT_REGISTERED_ERROR</returnAuthMsg>
    <returnReasonCode>30</returnReasonCode></cmmMsgHeader></OpenAPI_ServiceResponse>`;
  assert.throws(() => parseNpsXml(xml), /30.*SERVICE_KEY_IS_NOT_REGISTERED_ERROR/);
});

test("XML 결과코드가 정상이 아니면 사유를 담아 오류로 올린다", () => {
  const xml = "<response><header><resultCode>12</resultCode><resultMsg>NO OPENAPI SERVICE ERROR.</resultMsg></header></response>";
  assert.throws(() => parseNpsXml(xml), /12: NO OPENAPI SERVICE ERROR/);
});

test("본문 파서는 JSON과 XML을 같은 형태로 돌려준다", () => {
  assert.equal(parseNpsBody(sampleXml).totalCount, 1234);
  assert.equal(parseNpsBody(JSON.stringify(npsEnvelope([sampleItem], 7))).totalCount, 7);
  assert.throws(() => parseNpsBody("<html><body>Bad Gateway</body></html>"), /해석할 수 없습니다/);
  assert.throws(() => parseNpsBody("그냥 문자열"), /해석할 수 없습니다/);
});

test("nps 프록시는 조건 없는 전국 검색을 upstream 전에 막는다", async () => {
  const originalKey = process.env.NPS_SERVICE_KEY;
  process.env.NPS_SERVICE_KEY = "test-key";
  try {
    const res = responseRecorder();
    await handler({ method: "GET", headers: { host: "localhost:3000" }, query: {} }, res);
    assert.equal(res.statusCode, 400);
    assert.match(res.body.error, /조건이 필요합니다/);
  } finally {
    if (originalKey === undefined) delete process.env.NPS_SERVICE_KEY;
    else process.env.NPS_SERVICE_KEY = originalKey;
  }
});

test("nps 프록시는 낯선 origin에 CORS를 열지 않는다", async () => {
  const res = responseRecorder();
  await handler({ method: "OPTIONS", headers: { host: "donggu-biz.vercel.app", origin: "https://example.com" }, query: {} }, res);
  assert.equal(res.headers["Access-Control-Allow-Origin"], undefined);
});

test("nps 프록시는 지역 조건을 upstream 파라미터로 옮기고 결과를 정규화한다", async () => {
  const originalFetch = global.fetch;
  const originalKey = process.env.NPS_SERVICE_KEY;
  let requestedUrl = "";
  global.fetch = async (url) => {
    requestedUrl = String(url);
    return new Response(JSON.stringify(npsEnvelope([sampleItem], 42)), { status: 200 });
  };
  process.env.NPS_SERVICE_KEY = "test-key";

  try {
    const res = responseRecorder();
    await handler({
      method: "GET",
      headers: { host: "localhost:3000" },
      query: { action: "search", sido: "29", sggu: "110", bzowrRgstNo: "408-81-52345", numOfRows: "5000" }
    }, res);
    assert.match(requestedUrl, /getBassInfoSearchV2/);
    assert.match(requestedUrl, /ldong_addr_mgpl_dg_cd=29/);
    assert.match(requestedUrl, /ldong_addr_mgpl_sggu_cd=110/);
    assert.match(requestedUrl, /bzowr_rgst_no=408815/);
    assert.match(requestedUrl, /numOfRows=1000/); // 상한으로 눌린다
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.totalCount, 42);
    assert.equal(res.body.items[0].sectionCode, "O");
  } finally {
    global.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.NPS_SERVICE_KEY;
    else process.env.NPS_SERVICE_KEY = originalKey;
  }
});

test("nps 프록시는 XML 인증 오류 문서를 읽을 수 있는 메시지로 바꾼다", async () => {
  const originalFetch = global.fetch;
  const originalKey = process.env.NPS_SERVICE_KEY;
  global.fetch = async () => new Response(
    "<OpenAPI_ServiceResponse><returnAuthMsg>SERVICE_KEY_IS_NOT_REGISTERED_ERROR</returnAuthMsg></OpenAPI_ServiceResponse>",
    { status: 200 }
  );
  process.env.NPS_SERVICE_KEY = "test-key";

  try {
    const res = responseRecorder();
    await handler({ method: "GET", headers: { host: "localhost:3000" }, query: { action: "search", sido: "29" } }, res);
    assert.equal(res.statusCode, 502);
    assert.match(res.body.error, /SERVICE_KEY_IS_NOT_REGISTERED_ERROR/);
  } finally {
    global.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.NPS_SERVICE_KEY;
    else process.env.NPS_SERVICE_KEY = originalKey;
  }
});

test("nps 프록시는 상세조회에 seq와 기준월을 넘긴다", async () => {
  const originalFetch = global.fetch;
  const originalKey = process.env.NPS_SERVICE_KEY;
  let requestedUrl = "";
  global.fetch = async (url) => {
    requestedUrl = String(url);
    return new Response(JSON.stringify(npsEnvelope([{ ...sampleItem, jnngpCnt: "12" }], 1)), { status: 200 });
  };
  process.env.NPS_SERVICE_KEY = "test-key";

  try {
    const res = responseRecorder();
    await handler({ method: "GET", headers: { host: "localhost:3000" }, query: { action: "detail", seq: "20240101", dataCrtYm: "202607" } }, res);
    assert.match(requestedUrl, /getDetailInfoSearchV2/);
    assert.match(requestedUrl, /seq=20240101/);
    assert.match(requestedUrl, /data_crt_ym=202607/);
    assert.equal(res.body.items[0].subscriberCount, 12);
  } finally {
    global.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.NPS_SERVICE_KEY;
    else process.env.NPS_SERVICE_KEY = originalKey;
  }
});
