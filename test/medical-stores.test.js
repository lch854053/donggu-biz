import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const snapshot = JSON.parse(await readFile(new URL("../data/medical_stores_donggu.json", import.meta.url), "utf8"));

test("medical store snapshot contains a validated Dong-gu dataset", () => {
  assert.equal(snapshot.meta.source, "소상공인시장진흥공단_상가(상권)정보_의료기관");
  assert.match(snapshot.meta.sourceUpdatedAt, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(snapshot.meta.totalCount, snapshot.stores.length);
  assert.ok(snapshot.stores.length > 0);
  assert.equal(new Set(snapshot.stores.map((store) => store.id)).size, snapshot.stores.length);
  assert.ok(snapshot.stores.every((store) => store.adminDong && store.largeName === "의료"));
  assert.ok(snapshot.stores.every((store) => Number.isFinite(store.longitude) && Number.isFinite(store.latitude)));
});
