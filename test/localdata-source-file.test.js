import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  insertLocaldataSources,
  localdataSourceSlugs,
  renderLocaldataSource
} from "../lib/localdata-source-file.js";
import { pickDatasetMatch } from "../lib/localdata-portal.js";
import { LOCALDATA_SOURCES } from "../lib/store-license.js";

const entry = {
  // 실제 원천으로 승격될 수 있는 슬러그를 쓰면, 그 원천이 도입되는 날 이 테스트가 깨진다.
  slug: "zzz_test_only_source",
  datasetId: "15150000",
  title: "행정안전부_문화_시험용 조회서비스",
  endpoint: "https://apis.data.go.kr/1741000/zzz_test_only_source/info",
  largeCode: "N1",
  largeName: "사업시설관리",
  middleCode: "N105",
  middleName: "여행사·보조"
};

test("renders a source entry in the shape the file already uses", () => {
  assert.equal(renderLocaldataSource(entry), `  {
    slug: "zzz_test_only_source",
    datasetId: "15150000",
    title: "행정안전부_문화_시험용 조회서비스",
    endpoint: "https://apis.data.go.kr/1741000/zzz_test_only_source/info",
    largeCode: "N1",
    largeName: "사업시설관리",
    middleCode: "N105",
    middleName: "여행사·보조"
  }`);
});

test("reads back every slug the source file declares", async () => {
  const text = await readFile(new URL("../lib/store-license.js", import.meta.url), "utf8");
  assert.deepEqual(localdataSourceSlugs(text), LOCALDATA_SOURCES.map(({ slug }) => slug));
});

test("appends new sources just before the array closes and stays parseable", async () => {
  const text = await readFile(new URL("../lib/store-license.js", import.meta.url), "utf8");
  const { text: next, added } = insertLocaldataSources(text, [entry]);
  assert.deepEqual(added.map(({ slug }) => slug), [entry.slug]);
  assert.deepEqual(localdataSourceSlugs(next), [...LOCALDATA_SOURCES.map(({ slug }) => slug), entry.slug]);
  // 붙인 결과가 실제로 읽히는 자바스크립트인지, 배열 리터럴을 그대로 평가해 확인한다.
  const open = "LOCALDATA_SOURCES = Object.freeze(";
  const literal = next.slice(next.indexOf(open) + open.length);
  const parsed = new Function(`return ${literal.slice(0, literal.indexOf("\n]);") + 2)}`)();
  assert.equal(parsed.length, LOCALDATA_SOURCES.length + 1);
  assert.deepEqual(parsed.at(-1), entry);
});

test("never adds a slug that is already configured", async () => {
  const text = await readFile(new URL("../lib/store-license.js", import.meta.url), "utf8");
  const existing = { ...entry, slug: LOCALDATA_SOURCES[0].slug };
  const { text: next, added, skipped } = insertLocaldataSources(text, [existing, { slug: "", endpoint: "" }]);
  assert.equal(added.length, 0);
  assert.equal(next, text);
  assert.deepEqual(skipped.map(({ slug }) => slug), [LOCALDATA_SOURCES[0].slug, "(슬러그 없음)"]);
});

test("takes the dataset whose title matches, and refuses to guess between two", () => {
  const title = "행정안전부_문화_국내여행업 조회서비스";
  const rows = [
    { datasetId: "1", title: "행정안전부_문화_국내여행업_20251127" },
    { datasetId: "2", title: "행정안전부_문화_국내여행업 조회서비스" }
  ];
  assert.equal(pickDatasetMatch(rows, title).datasetId, "2");
  assert.equal(pickDatasetMatch(rows, title).confidence, "exact");
  // 띄어쓰기만 다른 제목도 같은 것으로 본다.
  assert.equal(pickDatasetMatch([{ datasetId: "3", title: "행정안전부_문화_국내여행업  조회서비스" }], title).datasetId, "3");
  // 업종명만 걸리는 후보가 하나뿐일 때만 인정한다.
  assert.equal(pickDatasetMatch([{ datasetId: "4", title: "행정안전부_국내여행업 조회서비스 (신규)" }], title).confidence, "keyword");
  assert.equal(pickDatasetMatch([
    { datasetId: "5", title: "행정안전부_국내여행업 조회서비스 A" },
    { datasetId: "6", title: "행정안전부_국내여행업 조회서비스 B" }
  ], title), null);
  assert.equal(pickDatasetMatch([], title), null);
});

test("the staged candidates carry everything promotion needs", async () => {
  const payload = JSON.parse(await readFile(new URL("../data/localdata_source_candidates.json", import.meta.url), "utf8"));
  const candidates = payload.newCandidates || [];
  assert.ok(candidates.length > 0);
  const configured = new Set(LOCALDATA_SOURCES.map(({ slug }) => slug));
  const seen = new Set();
  for (const candidate of candidates) {
    assert.ok(!configured.has(candidate.slug), `${candidate.slug}는 이미 설정된 원천입니다`);
    assert.ok(!seen.has(candidate.slug), `${candidate.slug}가 후보에 두 번 있습니다`);
    seen.add(candidate.slug);
    assert.match(candidate.endpoint, /^https:\/\/apis\.data\.go\.kr\/1741000\/[a-z_]+\/info$/);
    assert.ok(candidate.endpoint.includes(`/${candidate.slug}/`), `${candidate.slug}의 요청주소가 슬러그와 다릅니다`);
    assert.match(candidate.title, /^행정안전부_.+ 조회서비스$/);
    assert.ok(candidate.largeCode && candidate.largeName, `${candidate.slug}에 업종 매핑이 없습니다`);
    assert.ok([1, 2, 3, 4].includes(candidate.priority));
  }
});
