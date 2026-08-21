import assert from "node:assert/strict";
import test from "node:test";
import {
  SB_REGIONS,
  formatMonth,
  formatRatio,
  isRetryableStatus,
  isSameSnapshotData,
  leadingNumber,
  normalizeProfile,
  parseSbResponse,
  summarizeByMonth,
  summarizeProfiles,
  tenureBucket
} from "../lib/sbprofile.js";

// 실제 응답에서 확인한 한 행
const sampleItem = {
  basYm: "202506",
  rprSexNm: "남성",
  rprAggrNm: "50대",
  estbYr: "2002",
  bizAreaNm: "광주광역시 동구",
  bizBzcCd: "47",
  bizBzcCdNm: "소매업; 자동차 제외",
  empeCntNm: "1명 이상 5명 미만"
};

const rowOf = (overrides = {}) => normalizeProfile({ ...sampleItem, ...overrides });

test("응답 한 행을 화면에서 쓰는 형태로 정규화한다", () => {
  const row = rowOf();
  assert.equal(row.basYm, "202506");
  assert.equal(row.sexName, "남성");
  assert.equal(row.ageName, "50대");
  assert.equal(row.establishedYear, 2002);
  assert.equal(row.industryCode, "47");
  assert.equal(row.industryName, "소매업; 자동차 제외");
  assert.equal(row.employeeName, "1명 이상 5명 미만");
});

test("빈 값은 미상으로 두고 설립년도는 숫자가 아니면 버린다", () => {
  const row = rowOf({ rprSexNm: "  ", rprAggrNm: "", estbYr: "미상" });
  assert.equal(row.sexName, "미상");
  assert.equal(row.ageName, "미상");
  assert.equal(row.establishedYear, null);
});

test("구간 이름은 앞머리 숫자로 크기를 잡고 숫자가 없으면 뒤로 보낸다", () => {
  assert.equal(leadingNumber("20대 이하"), 20);
  assert.equal(leadingNumber("1명 이상 5명 미만"), 1);
  assert.equal(leadingNumber("0명"), 0);
  assert.equal(leadingNumber("미상"), Number.POSITIVE_INFINITY);
});

test("업력은 기준년월의 연도에서 설립년도를 뺀 구간이다", () => {
  assert.equal(tenureBucket(2025, "202506"), "1년 미만");
  assert.equal(tenureBucket(2022, "202506"), "1~4년");
  assert.equal(tenureBucket(2018, "202506"), "5~9년");
  assert.equal(tenureBucket(2010, "202506"), "10~19년");
  assert.equal(tenureBucket(2002, "202506"), "20년 이상");
  assert.equal(tenureBucket(null, "202506"), "미상");
  assert.equal(tenureBucket(2030, "202506"), "미상");
});

test("연령대와 종업원 구간은 건수가 아니라 구간 순서로 정렬한다", () => {
  const summary = summarizeProfiles([
    rowOf({ rprAggrNm: "50대", empeCntNm: "1명 이상 5명 미만" }),
    rowOf({ rprAggrNm: "50대", empeCntNm: "1명 이상 5명 미만" }),
    rowOf({ rprAggrNm: "50대", empeCntNm: "1명 이상 5명 미만" }),
    rowOf({ rprAggrNm: "30대", empeCntNm: "0명" }),
    rowOf({ rprAggrNm: "미상", empeCntNm: "미상" })
  ]);
  assert.deepEqual(summary.ages.map((item) => item.name), ["30대", "50대", "미상"]);
  assert.deepEqual(summary.employees.map((item) => item.name), ["0명", "1명 이상 5명 미만", "미상"]);
});

test("업종은 건수가 많은 순으로 세운다", () => {
  const summary = summarizeProfiles([
    rowOf({ bizBzcCdNm: "소매업; 자동차 제외" }),
    rowOf({ bizBzcCdNm: "음식점 및 주점업" }),
    rowOf({ bizBzcCdNm: "음식점 및 주점업" })
  ]);
  assert.deepEqual(summary.industries, [
    { name: "음식점 및 주점업", count: 2 },
    { name: "소매업; 자동차 제외", count: 1 }
  ]);
});

test("지표는 건수와 비중을 함께 낸다", () => {
  const summary = summarizeProfiles([
    rowOf({ rprSexNm: "여성", rprAggrNm: "30대", estbYr: "2024", empeCntNm: "0명" }),
    rowOf({ rprSexNm: "남성", rprAggrNm: "60대", estbYr: "2002", empeCntNm: "1명 이상 5명 미만" }),
    rowOf({ rprSexNm: "남성", rprAggrNm: "70대 이상", estbYr: "2010", empeCntNm: "0명" }),
    rowOf({ rprSexNm: "여성", rprAggrNm: "미상", estbYr: "2024", empeCntNm: "미상" })
  ]);
  assert.equal(summary.total, 4);
  assert.equal(summary.indicators.female.count, 2);
  assert.equal(summary.indicators.female.ratio, 0.5);
  assert.equal(summary.indicators.under40.count, 1);
  assert.equal(summary.indicators.over60.count, 2);
  assert.equal(summary.indicators.solo.count, 2);
  assert.equal(summary.indicators.veteran.count, 2);
});

test("연령 미상은 40대 미만에도 60대 이상에도 들어가지 않는다", () => {
  const summary = summarizeProfiles([rowOf({ rprAggrNm: "미상" })]);
  assert.equal(summary.indicators.under40.count, 0);
  assert.equal(summary.indicators.over60.count, 0);
});

test("성별은 남성 여성 순으로 두고 그 밖의 값은 뒤에 붙인다", () => {
  const summary = summarizeProfiles([
    rowOf({ rprSexNm: "미상" }),
    rowOf({ rprSexNm: "여성" }),
    rowOf({ rprSexNm: "남성" })
  ]);
  assert.deepEqual(summary.sexes.map((item) => item.name), ["남성", "여성", "미상"]);
});

test("기준년월마다 따로 집계해 사업자 수가 개월 수만큼 부풀지 않는다", () => {
  const rows = ["202208", "202406", "202506"].map((basYm) => rowOf({ basYm }));
  const grouped = summarizeByMonth(rows);
  assert.deepEqual(grouped.months, ["202506", "202406", "202208"]);
  assert.equal(grouped.byMonth["202506"].total, 1);
  assert.equal(summarizeProfiles(rows).total, 3);
});

test("표준 응답 껍질을 벗기고 한 건짜리 items도 배열로 맞춘다", () => {
  const many = parseSbResponse({
    response: { header: { resultCode: "00" }, body: { totalCount: 2, items: { item: [sampleItem, sampleItem] } } }
  });
  assert.equal(many.totalCount, 2);
  assert.equal(many.items.length, 2);

  const one = parseSbResponse({
    response: { header: { resultCode: "00" }, body: { totalCount: 1, items: { item: sampleItem } } }
  });
  assert.equal(one.items.length, 1);
});

test("정상이 아닌 결과코드는 사유를 담아 오류로 올린다", () => {
  assert.throws(
    () => parseSbResponse({ response: { header: { resultCode: "30", resultMsg: "SERVICE KEY IS NOT REGISTERED ERROR." }, body: {} } }),
    /30/
  );
});

test("동구는 광주광역시 조회에도 함께 잡히므로 지역명 접두어로 걸러 낼 수 있다", () => {
  const [donggu, gwangju] = SB_REGIONS;
  assert.equal(donggu.bizAreaNm, "광주광역시 동구");
  assert.equal(gwangju.bizAreaNm, "광주광역시");
  assert.ok(donggu.bizAreaNm.startsWith(gwangju.bizAreaNm));
  // 부분 일치라 "동구"나 "광주"로 조회하면 일산동구·경기도 광주시가 섞인다.
  assert.ok(!"경기도 광주시".startsWith(gwangju.bizAreaNm));
  assert.ok(!"경기도 고양시 일산동구".startsWith(donggu.bizAreaNm));
});

test("기준년월과 비중 표기", () => {
  assert.equal(formatMonth("202506"), "2025.06");
  assert.equal(formatMonth(""), "미상");
  assert.equal(formatRatio(0.1234), "12.3%");
  assert.equal(formatRatio(0), "0%");
});

test("위쪽만 막힌 구간은 같은 숫자로 시작하는 구간보다 앞에 온다", () => {
  assert.equal(leadingNumber("30세 미만"), 29.5);
  assert.equal(leadingNumber("30대"), 30);
  assert.equal(leadingNumber("1명 이상 5명 미만"), 1);

  const summary = summarizeProfiles([
    rowOf({ rprAggrNm: "30대" }),
    rowOf({ rprAggrNm: "30세 미만" }),
    rowOf({ rprAggrNm: "80대 이상" }),
    rowOf({ rprAggrNm: "70대" }),
    rowOf({ rprAggrNm: "미상" })
  ]);
  assert.deepEqual(summary.ages.map((item) => item.name), ["30세 미만", "30대", "70대", "80대 이상", "미상"]);
  // 30세 미만은 40대 미만에 들어가고 60대 이상에는 들어가지 않는다.
  assert.equal(summary.indicators.under40.count, 2);
  assert.equal(summary.indicators.over60.count, 2);
});

test("업종명에 겹친 공백은 하나로 줄인다", () => {
  assert.equal(rowOf({ bizBzcCdNm: "기타 전문  과학 및 기술 서비스업" }).industryName, "기타 전문 과학 및 기술 서비스업");
});

test("5xx와 혼잡 응답만 재시도하고 4xx는 바로 실패시킨다", () => {
  assert.equal(isRetryableStatus(504), true);
  assert.equal(isRetryableStatus(500), true);
  assert.equal(isRetryableStatus(429), true);
  assert.equal(isRetryableStatus(408), true);
  assert.equal(isRetryableStatus(401), false);
  assert.equal(isRetryableStatus(404), false);
});

test("집계가 같으면 수집 시각이 달라도 같은 스냅샷으로 본다", () => {
  const regions = { donggu: { label: "광주 동구", byMonth: { 202506: { total: 1 } } } };
  const meta = { months: ["202506"] };
  assert.equal(
    isSameSnapshotData(
      { meta: { ...meta, collectedAt: "2026-01-01T00:00:00.000Z" }, regions },
      { meta: { ...meta, collectedAt: "2026-08-21T00:00:00.000Z" }, regions }
    ),
    true
  );
});

test("기준월이 늘거나 집계가 달라지면 다른 스냅샷으로 본다", () => {
  const regions = { donggu: { label: "광주 동구", byMonth: { 202506: { total: 1 } } } };
  assert.equal(isSameSnapshotData(
    { meta: { months: ["202506"] }, regions },
    { meta: { months: ["202606", "202506"] }, regions }
  ), false);
  assert.equal(isSameSnapshotData(
    { meta: { months: ["202506"] }, regions },
    { meta: { months: ["202506"] }, regions: { donggu: { label: "광주 동구", byMonth: { 202506: { total: 2 } } } } }
  ), false);
  // 파일이 없던 첫 수집
  assert.equal(isSameSnapshotData(null, { meta: { months: ["202506"] }, regions }), false);
});
