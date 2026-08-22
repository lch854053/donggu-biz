import test from "node:test";
import assert from "node:assert/strict";
import handler, { resetVariantPreference } from "../api/nps.js";
import {
  addressArea,
  displayAddress,
  hydrateSnapshotWorkplace,
  matchesWorkplaceCriteria,
  ymdYear,
  compactWorkplace,
  compactWorkplaceDetail,
  industrySection,
  isPlaceholderIndustry,
  mergeWorkplaceHistory,
  parseNpsBody,
  parseNpsResponse,
  parseNpsXml,
  sortWorkplaces,
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
  wkplIntpCd: "751100",
  ldongAddrMgplDgCd: "29",
  ldongAddrMgplSgguCd: "110",
  ldongAddrMgplSgguEmdCd: "101"
};

test("사업자등록번호는 앞 6자리로만 잘라낸다", () => {
  assert.equal(toBizNoPrefix("408-81-52345"), "408815");
  assert.equal(toBizNoPrefix("4088152345"), "408815");
  assert.equal(toBizNoPrefix(""), "");
});

test("업종코드를 API가 쓰는 옛 분류 기준 대분류로 옮긴다", () => {
  assert.equal(industrySection("751100").code, "N"); // 일반 행정
  assert.equal(industrySection("552101").name, "숙박 및 음식점업");
  assert.equal(industrySection("452125").name, "건설업"); // 일반 전기 공사업
  assert.equal(industrySection("513421").name, "도매 및 소매업"); // 서적, 잡지 도매업
  assert.equal(industrySection("292902").code, "D"); // 인쇄 및 제책용 기계 제조업
  assert.equal(industrySection("").name, "업종 미상");
  assert.equal(industrySection("440000").name, "업종 미상");
});

test("업종이 비어 있다는 뜻의 자리표시 코드는 국제기관이 아니라 미상으로 둔다", () => {
  // 어린이집처럼 사업자등록번호가 잡히지 않는 사업장은 999999로 내려온다.
  assert.equal(industrySection("999999").name, "업종 미상");
  assert.equal(industrySection("000000").name, "업종 미상");
  assert.ok(isPlaceholderIndustry("999999"));
  assert.ok(!isPlaceholderIndustry("991100"));

  const daycare = compactWorkplaceDetail({
    ...sampleItem,
    wkplNm: "광주은행어린이집",
    wkplIntpCd: "999999",
    vldtVlKrnNm: "BIZ_NO미존재사업장"
  });
  assert.equal(daycare.sectionName, "업종 미상");
  assert.equal(daycare.sectionCode, "");
  assert.equal(daycare.industryName, "");
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
  assert.equal(workplace.styleName, "법인");
  assert.equal(workplace.sectionCode, "N");
  assert.equal(workplace.area, "동구 서남로");
});

test("스냅샷 항목은 상태·형태 이름과 업종 대분류를 코드에서 다시 판정해 편다", () => {
  const workplace = hydrateSnapshotWorkplace({
    seq: "20240101", dataCreatedMonth: "202606", name: "광주동구청", bizNoPrefix: "408815",
    address: "광주광역시 동구 서남로", statusCode: "1", styleCode: "1",
    industryCode: "751100", industryName: "일반 행정", registeredDate: "19980401",
    subscriberCount: 320, historyCount: 12, historyRows: [{ seq: "1", month: "202606" }]
  });
  assert.equal(workplace.statusName, "등록");
  assert.equal(workplace.styleName, "법인");
  assert.equal(workplace.sectionCode, "N");
  assert.equal(workplace.area, "동구 서남로");
  assert.equal(workplace.subscriberCount, 320);
  assert.equal(workplace.historyRows.length, 1);
  // 스냅샷은 상세조회까지 마친 자료라 업종 조건을 걸어도 빠지지 않아야 한다.
  assert.equal(workplace.detailLoaded, true);
  assert.equal(matchesWorkplaceCriteria(workplace, { sectionCode: "N" }), true);
});

test("스냅샷의 자리표시 업종코드는 업종명을 비우고 미상으로 남긴다", () => {
  const workplace = hydrateSnapshotWorkplace({ name: "광주은행어린이집", industryCode: "999999", industryName: "BIZ_NO미존재사업장" });
  assert.equal(workplace.industryName, "");
  assert.equal(workplace.sectionName, "업종 미상");
  assert.equal(matchesWorkplaceCriteria(workplace, { unknownIndustryOnly: true, includeWithdrawn: true }), true);
});

test("소재지에서 시 이름을 덜어낸다", () => {
  assert.equal(displayAddress("광주광역시 동구 서남로"), "동구 서남로");
  assert.equal(displayAddress("동구 제봉로"), "동구 제봉로");
  assert.equal(displayAddress(""), "");
});

test("등록일에서 연도만 꺼낸다", () => {
  assert.equal(ymdYear("19990401"), 1999);
  assert.equal(ymdYear("2007-05-01"), 2007);
  assert.equal(ymdYear(""), null);
});

const registered = compactWorkplaceDetail({ ...sampleItem, adptDt: "20050301", jnngpCnt: "12", vldtVlKrnNm: "일반 행정" });

test("기본 조건은 가입 상태가 등록인 사업장만 남긴다", () => {
  assert.equal(matchesWorkplaceCriteria(registered, {}), true);
  assert.equal(matchesWorkplaceCriteria({ ...registered, statusCode: "2" }, {}), false);
  assert.equal(matchesWorkplaceCriteria({ ...registered, statusCode: "2" }, { includeWithdrawn: true }), true);
});

test("사업장 형태·사업장명·업종 대분류로 좁힌다", () => {
  assert.equal(matchesWorkplaceCriteria(registered, { styleCode: "1" }), true);
  assert.equal(matchesWorkplaceCriteria(registered, { styleCode: "2" }), false);
  assert.equal(matchesWorkplaceCriteria(registered, { name: "동구청" }), true);
  assert.equal(matchesWorkplaceCriteria(registered, { name: "광주은행" }), false);
  assert.equal(matchesWorkplaceCriteria(registered, { sectionCode: "N" }), true);
  assert.equal(matchesWorkplaceCriteria(registered, { sectionCode: "D" }), false);
});

test("업종 미상만 조회는 자리표시 업종코드를 가진 사업장만 남긴다", () => {
  const unknown = compactWorkplaceDetail({ ...sampleItem, wkplIntpCd: "999999" });
  assert.equal(matchesWorkplaceCriteria(unknown, { unknownIndustryOnly: true }), true);
  assert.equal(matchesWorkplaceCriteria(registered, { unknownIndustryOnly: true }), false);
});

test("상세를 아직 못 받은 사업장은 업종·등록일·가입자 수 조건을 걸었을 때만 빠진다", () => {
  const listOnly = compactWorkplace({ ...sampleItem, wkplIntpCd: "" });
  assert.equal(matchesWorkplaceCriteria(listOnly, {}), true);
  assert.equal(matchesWorkplaceCriteria(listOnly, { sectionCode: "N" }), false);
  assert.equal(matchesWorkplaceCriteria(listOnly, { unknownIndustryOnly: true }), false);
  assert.equal(matchesWorkplaceCriteria(listOnly, { registeredFromYear: 1988 }), false);
  assert.equal(matchesWorkplaceCriteria(listOnly, { subscriberMin: 0 }), false);
});

test("등록일 연도와 가입자 수 범위로 좁힌다", () => {
  assert.equal(matchesWorkplaceCriteria(registered, { registeredFromYear: 2000, registeredToYear: 2010 }), true);
  assert.equal(matchesWorkplaceCriteria(registered, { registeredFromYear: 2006 }), false);
  assert.equal(matchesWorkplaceCriteria(registered, { registeredToYear: 2004 }), false);
  assert.equal(matchesWorkplaceCriteria(registered, { subscriberMin: 10, subscriberMax: 20 }), true);
  assert.equal(matchesWorkplaceCriteria(registered, { subscriberMin: 13 }), false);
  assert.equal(matchesWorkplaceCriteria(registered, { subscriberMax: 11 }), false);
});

test("조회 결과를 상세분류·등록일·가입자 수로 오름차순과 내림차순 정렬한다", () => {
  const rows = [
    { name: "가", industryName: "카페", registeredDate: "20200301", subscriberCount: 5 },
    { name: "나", industryName: "식당", registeredDate: "20210101", subscriberCount: 20 },
    { name: "다", industryName: "", registeredDate: "20190101", subscriberCount: null }
  ];
  const names = (sort) => sortWorkplaces(rows, sort).map((row) => row.name);

  assert.deepEqual(names("detail-asc"), ["나", "가", "다"]);
  assert.deepEqual(names("detail-desc"), ["가", "나", "다"]);
  assert.deepEqual(names("registered-asc"), ["다", "가", "나"]);
  assert.deepEqual(names("registered-desc"), ["나", "가", "다"]);
  assert.deepEqual(names("subscriber-asc"), ["가", "나", "다"]);
  assert.deepEqual(names("subscriber-desc"), ["나", "가", "다"]);
  assert.deepEqual(rows.map((row) => row.name), ["가", "나", "다"]);
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
        <wkplIntpCd>751100</wkplIntpCd>
        <dataCrtYm>202607</dataCrtYm>
      </item>
      <item>
        <seq>20240102</seq>
        <wkplNm>동구식당</wkplNm>
        <bzowrRgstNo>408816</bzowrRgstNo>
        <wkplRoadNmDtlAddr>광주광역시 동구 제봉로</wkplRoadNmDtlAddr>
        <wkplJnngStcd>2</wkplJnngStcd>
        <wkplStylDvcd>2</wkplStylDvcd>
        <wkplIntpCd>552101</wkplIntpCd>
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
  assert.equal(parsed.items[1].wkplIntpCd, "552101");
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
    assert.match(requestedUrl, /ldongAddrMgplDgCd=29/);
    assert.match(requestedUrl, /ldongAddrMgplSgguCd=110/); // 화면이 넘긴 코드를 그대로 먼저 쓴다
    assert.match(requestedUrl, /bzowrRgstNo=408815/);
    assert.match(requestedUrl, /numOfRows=100/); // 상한으로 눌린다
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.totalCount, 42);
    assert.equal(res.body.items[0].sectionCode, "N");
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

test("nps 프록시는 상세조회에 seq만 넘기고 기간별 현황을 합친다", async () => {
  const originalFetch = global.fetch;
  const originalKey = process.env.NPS_SERVICE_KEY;
  const requestedUrls = [];
  global.fetch = async (url) => {
    requestedUrls.push(String(url));
    const detail = requestedUrls.length === 1;
    return new Response(JSON.stringify(npsEnvelope(
      [detail ? { ...sampleItem, jnngpCnt: "12", vldtVlKrnNm: "일반 행정", adptDt: "19880101" } : { nwAcqzrCnt: "7", lssJnngpCnt: "3" }],
      1
    )), { status: 200 });
  };
  process.env.NPS_SERVICE_KEY = "test-key";

  try {
    const res = responseRecorder();
    await handler({ method: "GET", headers: { host: "localhost:3000" }, query: { action: "detail", seq: "20240101", dataCrtYm: "202607" } }, res);
    assert.match(requestedUrls[0], /getDetailInfoSearchV2/);
    assert.match(requestedUrls[0], /seq=20240101/);
    assert.doesNotMatch(requestedUrls[0], /crt_ym|dataCrtYm/); // 상세조회는 기준월을 받지 않는다
    assert.match(requestedUrls[1], /getPdAcctoSttusInfoSearchV2/);
    assert.equal(res.body.items[0].subscriberCount, 12);
    assert.equal(res.body.items[0].industryName, "일반 행정");
    assert.equal(res.body.items[0].registeredDate, "19880101");
    assert.equal(res.body.items[0].newSubscriberCount, 7);
    assert.equal(res.body.items[0].lostSubscriberCount, 3);
  } finally {
    global.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.NPS_SERVICE_KEY;
    else process.env.NPS_SERVICE_KEY = originalKey;
  }
});

test("nps 프록시는 파라미터 오류를 만나면 다른 표기법으로 한 번 더 부른다", async () => {
  const originalFetch = global.fetch;
  const originalKey = process.env.NPS_SERVICE_KEY;
  const requestedUrls = [];
  global.fetch = async (url) => {
    requestedUrls.push(String(url));
    if (requestedUrls.length === 1) {
      return new Response(
        "<OpenAPI_ServiceResponse><cmmMsgHeader><returnAuthMsg>CLIENT_ERROR</returnAuthMsg><returnReasonCode>97</returnReasonCode></cmmMsgHeader></OpenAPI_ServiceResponse>",
        { status: 200 }
      );
    }
    return new Response(JSON.stringify(npsEnvelope([sampleItem], 3)), { status: 200 });
  };
  process.env.NPS_SERVICE_KEY = "test-key";

  try {
    const res = responseRecorder();
    await handler({ method: "GET", headers: { host: "localhost:3000" }, query: { action: "search", sido: "29" } }, res);
    assert.equal(requestedUrls.length, 2);
    assert.match(requestedUrls[0], /ldongAddrMgplDgCd=29/);
    assert.match(requestedUrls[1], /ldong_addr_mgpl_dg_cd=29/);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.totalCount, 3);
  } finally {
    resetVariantPreference();
    global.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.NPS_SERVICE_KEY;
    else process.env.NPS_SERVICE_KEY = originalKey;
  }
});

test("nps 프록시는 서비스키 오류에는 표기법을 바꿔 다시 부르지 않고 안내를 덧붙인다", async () => {
  const originalFetch = global.fetch;
  const originalKey = process.env.NPS_SERVICE_KEY;
  let calls = 0;
  global.fetch = async () => {
    calls += 1;
    return new Response(
      "<OpenAPI_ServiceResponse><cmmMsgHeader><returnAuthMsg>SERVICE_KEY_IS_NOT_REGISTERED_ERROR</returnAuthMsg><returnReasonCode>30</returnReasonCode></cmmMsgHeader></OpenAPI_ServiceResponse>",
      { status: 200 }
    );
  };
  process.env.NPS_SERVICE_KEY = "test-key";

  try {
    const res = responseRecorder();
    await handler({ method: "GET", headers: { host: "localhost:3000" }, query: { action: "search", sido: "29" } }, res);
    assert.equal(calls, 1);
    assert.equal(res.statusCode, 502);
    assert.match(res.body.error, /디코딩 키/);
  } finally {
    global.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.NPS_SERVICE_KEY;
    else process.env.NPS_SERVICE_KEY = originalKey;
  }
});

test("nps 프록시는 인코딩된 서비스키를 한 번 풀어서 보낸다", async () => {
  const originalFetch = global.fetch;
  const originalKey = process.env.NPS_SERVICE_KEY;
  let requestedUrl = "";
  global.fetch = async (url) => {
    requestedUrl = String(url);
    return new Response(JSON.stringify(npsEnvelope([sampleItem], 1)), { status: 200 });
  };
  process.env.NPS_SERVICE_KEY = "abc%2Bdef%3D";

  try {
    const res = responseRecorder();
    await handler({ method: "GET", headers: { host: "localhost:3000" }, query: { action: "search", sido: "29" } }, res);
    assert.match(requestedUrl, /serviceKey=abc%2Bdef%3D(&|$)/);
    assert.equal(res.statusCode, 200);
  } finally {
    global.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.NPS_SERVICE_KEY;
    else process.env.NPS_SERVICE_KEY = originalKey;
  }
});

test("nps 프록시는 첫 페이지가 0건이면 다른 코드 형식으로 다시 물어본다", async () => {
  const originalFetch = global.fetch;
  const originalKey = process.env.NPS_SERVICE_KEY;
  const requestedUrls = [];
  global.fetch = async (url) => {
    requestedUrls.push(String(url));
    const empty = requestedUrls.length === 1;
    return new Response(JSON.stringify(npsEnvelope(empty ? [] : [sampleItem], empty ? 0 : 5)), { status: 200 });
  };
  process.env.NPS_SERVICE_KEY = "test-key";

  try {
    const res = responseRecorder();
    await handler({
      method: "GET",
      headers: { host: "localhost:3000" },
      query: { action: "search", sido: "29", sggu: "110" }
    }, res);
    assert.equal(requestedUrls.length, 2);
    assert.match(requestedUrls[0], /ldongAddrMgplSgguCd=110(&|$)/);
    assert.match(requestedUrls[1], /ldongAddrMgplSgguCd=29110(&|$)/);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.items.length, 1);
    assert.equal(res.body.meta.regionForm, "prefixed");
  } finally {
    resetVariantPreference();
    global.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.NPS_SERVICE_KEY;
    else process.env.NPS_SERVICE_KEY = originalKey;
  }
});

test("nps 프록시는 모든 조합이 0건이면 빈 결과와 시도 내역을 돌려준다", async () => {
  const originalFetch = global.fetch;
  const originalKey = process.env.NPS_SERVICE_KEY;
  let calls = 0;
  global.fetch = async () => {
    calls += 1;
    return new Response(JSON.stringify(npsEnvelope([], 0)), { status: 200 });
  };
  process.env.NPS_SERVICE_KEY = "test-key";

  try {
    const res = responseRecorder();
    await handler({
      method: "GET",
      headers: { host: "localhost:3000" },
      query: { action: "search", sido: "29", sggu: "110" }
    }, res);
    assert.equal(calls, 4);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.items.length, 0);
    assert.equal(res.body.meta.attempts.length, 4);
    assert.doesNotMatch(JSON.stringify(res.body.meta), /test-key/); // 서비스키는 가린다
  } finally {
    resetVariantPreference();
    global.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.NPS_SERVICE_KEY;
    else process.env.NPS_SERVICE_KEY = originalKey;
  }
});

test("nps 프록시는 2페이지 이후에는 0건이어도 다시 묻지 않는다", async () => {
  const originalFetch = global.fetch;
  const originalKey = process.env.NPS_SERVICE_KEY;
  let calls = 0;
  global.fetch = async () => {
    calls += 1;
    return new Response(JSON.stringify(npsEnvelope([], 0)), { status: 200 });
  };
  process.env.NPS_SERVICE_KEY = "test-key";

  try {
    const res = responseRecorder();
    await handler({
      method: "GET",
      headers: { host: "localhost:3000" },
      query: { action: "search", sido: "29", pageNo: "3" }
    }, res);
    assert.equal(calls, 1);
    assert.equal(res.statusCode, 200);
  } finally {
    resetVariantPreference();
    global.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.NPS_SERVICE_KEY;
    else process.env.NPS_SERVICE_KEY = originalKey;
  }
});

test("상세 항목은 제공되지 않은 취득·상실자 수를 0으로 꾸미지 않는다", () => {
  const detail = compactWorkplaceDetail({ ...sampleItem, jnngpCnt: "12" });
  assert.equal(detail.subscriberCount, 12);
  assert.equal(detail.newSubscriberCount, null);
  assert.equal(detail.lostSubscriberCount, null);
});

test("같은 사업장의 월별 이력은 최근 기준월 한 건으로 접는다", () => {
  const merged = mergeWorkplaceHistory([
    compactWorkplace({ ...sampleItem, seq: "1", dataCrtYm: "202605", wkplNm: "(주)광주은행" }),
    compactWorkplace({ ...sampleItem, seq: "2", dataCrtYm: "202607", wkplNm: "(주)광주은행", jnngpCnt: "10" }),
    compactWorkplace({ ...sampleItem, seq: "3", dataCrtYm: "202606", wkplNm: "( 주 ) 광주은행" })
  ]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].dataCreatedMonth, "202607");
  assert.equal(merged[0].seq, "2");
  assert.equal(merged[0].historyCount, 3);
  assert.deepEqual(merged[0].historyMonths, ["202607", "202606", "202605"]);
});

test("주소가 다른 지점은 합치지 않는다", () => {
  const merged = mergeWorkplaceHistory([
    compactWorkplace({ ...sampleItem, wkplNm: "(주)광주은행", wkplRoadNmDtlAddr: "광주광역시 동구 제봉로" }),
    compactWorkplace({ ...sampleItem, wkplNm: "(주)광주은행", wkplRoadNmDtlAddr: "광주광역시 동구 서남로" })
  ]);
  assert.equal(merged.length, 2);
  assert.equal(merged[0].historyCount, 1);
});

test("합친 목록으로 집계하면 사업장 수가 개월 수만큼 부풀지 않는다", () => {
  const rows = ["202605", "202606", "202607"].map((month) =>
    compactWorkplace({ ...sampleItem, dataCrtYm: month })
  );
  assert.equal(rows.length, 3);
  assert.equal(mergeWorkplaceHistory(rows).length, 1);
});

test("이미 접힌 목록을 다시 접어도 이력 개월 수가 남는다", () => {
  const once = mergeWorkplaceHistory([
    compactWorkplace({ ...sampleItem, dataCrtYm: "202605" }),
    compactWorkplace({ ...sampleItem, dataCrtYm: "202607" })
  ]);
  const twice = mergeWorkplaceHistory(once);
  assert.equal(twice.length, 1);
  assert.equal(twice[0].historyCount, 2);
  assert.equal(twice[0].dataCreatedMonth, "202607");
});

test("접힌 사업장은 달마다의 seq를 함께 남긴다", () => {
  const merged = mergeWorkplaceHistory([
    compactWorkplace({ ...sampleItem, seq: "11", dataCrtYm: "202605" }),
    compactWorkplace({ ...sampleItem, seq: "12", dataCrtYm: "202607" })
  ]);
  assert.deepEqual(merged[0].historyRows, [
    { seq: "12", month: "202607" },
    { seq: "11", month: "202605" }
  ]);
});

test("nps 프록시는 월별 추이를 달마다 상세·기간별 현황으로 모은다", async () => {
  const originalFetch = global.fetch;
  const originalKey = process.env.NPS_SERVICE_KEY;
  const requestedUrls = [];
  global.fetch = async (url) => {
    const text = String(url);
    requestedUrls.push(text);
    const seq = new URL(text).searchParams.get("seq");
    if (text.includes("getPdAcctoSttusInfoSearchV2")) {
      return new Response(JSON.stringify(npsEnvelope([{ nwAcqzrCnt: seq === "11" ? "4" : "9" }], 1)), { status: 200 });
    }
    return new Response(JSON.stringify(npsEnvelope([{ ...sampleItem, jnngpCnt: seq === "11" ? "100" : "120" }], 1)), { status: 200 });
  };
  process.env.NPS_SERVICE_KEY = "test-key";

  try {
    const res = responseRecorder();
    await handler({
      method: "GET",
      headers: { host: "localhost:3000" },
      query: { action: "history", seqs: "12:202607,11:202605" }
    }, res);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body.series.map((point) => point.month), ["202605", "202607"]); // 오래된 달부터
    assert.equal(res.body.series[0].subscriberCount, 100);
    assert.equal(res.body.series[0].newSubscriberCount, 4);
    assert.equal(res.body.series[1].subscriberCount, 120);
    assert.equal(requestedUrls.length, 4); // 달마다 상세 + 기간별 현황
  } finally {
    global.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.NPS_SERVICE_KEY;
    else process.env.NPS_SERVICE_KEY = originalKey;
  }
});

test("nps 프록시는 seq 없는 추이 요청을 upstream 전에 막는다", async () => {
  const originalKey = process.env.NPS_SERVICE_KEY;
  process.env.NPS_SERVICE_KEY = "test-key";
  try {
    const res = responseRecorder();
    await handler({ method: "GET", headers: { host: "localhost:3000" }, query: { action: "history", seqs: "" } }, res);
    assert.equal(res.statusCode, 400);
  } finally {
    if (originalKey === undefined) delete process.env.NPS_SERVICE_KEY;
    else process.env.NPS_SERVICE_KEY = originalKey;
  }
});
