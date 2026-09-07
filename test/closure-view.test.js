import test from "node:test";
import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import {
  closureLifespanMedianDays,
  closureRateTable,
  closureRateTableWithLifespan,
  closureYearCounts,
  filterClosureRows,
  UNKNOWN_ADMIN_DONG
} from "../lib/closure-view.js";

function closed(overrides = {}) {
  return {
    statusKind: "closed",
    adminDong: "충장동",
    largeName: "음식",
    licenseDate: "20150301",
    closedDate: "20200115",
    ...overrides
  };
}

const rows = [
  closed(),
  closed({ closedDate: "20210620", adminDong: "동명동", largeName: "소매" }),
  closed({ closedDate: "20210101", licenseDate: "20200101" }),
  closed({ statusKind: "suspended", closedDate: "" }),
  closed({ closedDate: "99991231", adminDong: "" })
];

test("filters by status, admin dong, category and closure year", () => {
  assert.equal(filterClosureRows(rows, {}).length, 4);
  assert.equal(filterClosureRows(rows, { statusKind: "suspended" }).length, 1);
  assert.equal(filterClosureRows(rows, { adminDong: "동명동" }).length, 1);
  assert.equal(filterClosureRows(rows, { largeName: "소매" }).length, 1);
  assert.equal(filterClosureRows(rows, { fromYear: 2021 }).length, 2);
  assert.equal(filterClosureRows(rows, { fromYear: 2020, toYear: 2020 }).length, 1);
});

test("drops undated rows once a year range is set, keeps them otherwise", () => {
  const undated = filterClosureRows([closed({ closedDate: "99991231" })], {});
  assert.equal(undated.length, 1);
  assert.equal(filterClosureRows(undated, { fromYear: 2016 }).length, 0);
});

test("counts closures by year in ascending order", () => {
  assert.deepEqual(closureYearCounts(rows), [{ year: 2020, count: 1 }, { year: 2021, count: 2 }]);
  assert.deepEqual(closureYearCounts([]), []);
});

test("takes the median business lifespan of dated rows only", () => {
  assert.equal(closureLifespanMedianDays([closed(), closed({ licenseDate: "20200101", closedDate: "20210101" })]), 1074);
  assert.equal(closureLifespanMedianDays([closed({ closedDate: "" })]), null);
});

test("keeps the unresolved admin dong out of the rate table and counts it apart", () => {
  const active = [{ adminDong: "충장동" }, { adminDong: "충장동" }, { adminDong: "동명동" }];
  const closedRows = [closed(), closed({ adminDong: "" }), closed({ adminDong: "" })];
  const table = closureRateTable(active, closedRows, (row) => row.adminDong);
  assert.deepEqual(table.rows.map(({ name }) => name), ["충장동", "동명동"]);
  assert.equal(table.unknownClosedCount, 2);
  assert.equal(table.rows.find(({ name }) => name === "충장동").closureRate, 0.3333);
  assert.ok(!table.rows.some(({ name }) => name === UNKNOWN_ADMIN_DONG));
});

test("adds each group's median lifespan to the rate table", () => {
  const table = closureRateTableWithLifespan(
    [{ largeName: "음식" }],
    [closed(), closed({ licenseDate: "20200101", closedDate: "20210101" })],
    (row) => row.largeName
  );
  assert.equal(table.rows[0].name, "음식");
  assert.equal(table.rows[0].closedCount, 2);
  assert.equal(table.rows[0].medianLifespanDays, 1074);
});

test("the committed closure snapshot supports the analysis view", async () => {
  const path = "data/closed_licenses_donggu.json";
  try {
    await access(path);
  } catch {
    return;
  }
  const payload = JSON.parse(await readFile(path, "utf8"));
  const licenses = payload.licenses || [];
  assert.ok(licenses.length > 1000, "폐업 스냅샷이 비어 있습니다");
  const table = closureRateTableWithLifespan(
    [],
    filterClosureRows(licenses, {}),
    (row) => row.adminDong
  );
  assert.ok(table.rows.every((row) => row.name !== UNKNOWN_ADMIN_DONG));
  assert.ok(table.rows.every((row) => row.closureRate === null || (row.closureRate >= 0 && row.closureRate <= 1)));
});
