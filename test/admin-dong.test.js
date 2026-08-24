import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  adminDongForAddress,
  createAdminDongLookup,
  normalizeAddressLookupKey,
  normalizeAdminDongName
} from "../lib/admin-dong.js";

const snapshot = JSON.parse(await readFile(new URL("../data/insurance_admin_dongs.json", import.meta.url), "utf8"));

test("normalizes old and new Gwangju address prefixes to one lookup key", () => {
  assert.equal(
    normalizeAddressLookupKey("전남광주통합특별시 동구 필문대로171번길 1-17 (산수동)"),
    normalizeAddressLookupKey("광주광역시 동구  필문대로171번길 1-17")
  );
});

test("accepts only Dong-gu administrative dong names", () => {
  assert.equal(normalizeAdminDongName("전남광주통합특별시 동구 산수1동"), "산수1동");
  assert.equal(normalizeAdminDongName("광주광역시 북구 중앙동"), "");
});

test("resolves an address from the committed administrative dong lookup", () => {
  const lookup = createAdminDongLookup({
    items: [{ address: "동구 서남로 1", adminDong: "서남동" }]
  });
  assert.equal(adminDongForAddress("광주광역시 동구 서남로 1", lookup), "서남동");
  assert.equal(adminDongForAddress("광주광역시 동구 서남로 2", lookup), "");
});

test("committed address lookup keeps matched and unresolved addresses explicit", () => {
  assert.equal(snapshot.meta.addressCount, snapshot.items.length);
  assert.equal(snapshot.meta.matchedCount, snapshot.items.filter((item) => item.adminDong).length);
  assert.equal(snapshot.meta.unmatchedCount, snapshot.items.filter((item) => !item.adminDong).length);
  assert.ok(snapshot.meta.matchedCount > 3000);
  assert.equal(new Set(snapshot.items.map((item) => normalizeAddressLookupKey(item.address))).size, snapshot.items.length);
});
