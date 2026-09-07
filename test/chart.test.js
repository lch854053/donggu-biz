import test from "node:test";
import assert from "node:assert/strict";
import { axisTicks, barBands, barCornerRadius, barWidth, linePath, linePoints, niceStep } from "../lib/chart.js";

test("rounds an axis step up to a readable number", () => {
  assert.equal(niceStep(1), 1);
  assert.equal(niceStep(1.4), 2);
  assert.equal(niceStep(2.2), 2.5);
  assert.equal(niceStep(180), 200);
  assert.equal(niceStep(218), 250);
  assert.equal(niceStep(0), 1);
});

test("builds axis ticks that start at zero and cover the maximum", () => {
  const { max, ticks } = axisTicks(872);
  assert.equal(max, 1000);
  assert.deepEqual(ticks, [0, 250, 500, 750, 1000]);
  assert.ok(ticks.at(-1) >= 872);
  assert.deepEqual(axisTicks(0), { max: 1, ticks: [0, 1] });
  assert.deepEqual(axisTicks(NaN).ticks, [0, 1]);
});

test("spreads line points across the plot and inverts the value axis", () => {
  const points = linePoints([0, 5, 10], { width: 200, height: 100, max: 10 });
  assert.deepEqual(points.map(({ x }) => x), [0, 100, 200]);
  assert.deepEqual(points.map(({ y }) => y), [100, 50, 0]);
});

test("centres a lone line point instead of pinning it to the left edge", () => {
  const [only] = linePoints([7], { width: 200, height: 100, max: 10 });
  assert.equal(only.x, 100);
  assert.deepEqual(linePoints([], { width: 200, height: 100, max: 10 }), []);
});

test("writes a move-then-line path", () => {
  assert.equal(linePath(linePoints([0, 10], { width: 100, height: 50, max: 10 })), "M0.00 50.00 L100.00 0.00");
  assert.equal(linePath([]), "");
});

test("caps bar thickness and leaves the rest of the band as air", () => {
  const wide = barBands(2, { height: 200 });
  assert.equal(wide[0].height, 24);
  assert.equal(wide[0].y, 38);
  assert.equal(wide[1].y, 138);
  const tight = barBands(10, { height: 100 });
  assert.equal(tight[0].height, 8);
  assert.deepEqual(barBands(0, { height: 100 }), []);
});

test("scales bar width against the axis maximum", () => {
  assert.equal(barWidth(50, { width: 200, max: 100 }), 100);
  assert.equal(barWidth(-5, { width: 200, max: 100 }), 0);
  assert.equal(barWidth(500, { width: 200, max: 100 }), 200);
  assert.equal(barWidth(1, { width: 200, max: 0 }), 200);
});

test("shrinks the rounded end so a tiny bar keeps its shape", () => {
  assert.equal(barCornerRadius(100, 24), 4);
  assert.equal(barCornerRadius(2, 24), 2);
  assert.equal(barCornerRadius(100, 6), 3);
  assert.equal(barCornerRadius(0, 24), 0);
});

test("the statistics tab ships the four charts with a table twin each", async () => {
  const { readFile } = await import("node:fs/promises");
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  const app = await readFile(new URL("../app.js", import.meta.url), "utf8");
  assert.deepEqual(
    [...html.matchAll(/data-panel="([^"]+)"/g)].map(([, panel]) => panel),
    ["business", "market", "stats"]
  );
  assert.match(html, /id="panel-stats"[^>]*hidden/);
  for (const id of ["statsTrendChart", "statsDongRateChart", "statsIndustryRateChart", "statsDongLifespanChart", "statsIndustryLifespanChart"]) {
    assert.match(html, new RegExp(`id="${id}"`), id);
  }
  // 그래프는 값을 읽는 유일한 통로가 아니다. 카드마다 표가 함께 있어야 한다.
  assert.equal([...html.matchAll(/class="chart-table"/g)].length, 5);
  assert.equal([...html.matchAll(/<summary>표로 보기<\/summary>/g)].length, 5);
  // 조건은 그래프마다가 아니라 위쪽 한 줄에만 둔다.
  assert.equal([...html.matchAll(/id="statsRunBtn"/g)].length, 1);
  assert.doesNotMatch(html, /market-view-closure|폐업 분석/);
  assert.match(app, /if \(panelName === "stats"\) initializeStats\(\)/);
  assert.doesNotMatch(app, /initializeClosureView/);
});
