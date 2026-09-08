// 축 눈금과 좌표만 계산한다. 그리기는 화면 코드가 맡는다.

const NICE_STEPS = [1, 2, 2.5, 5, 10];

// 눈금은 1·2·2.5·5의 10의 거듭제곱 배수로만 올려, 축에 3,247 같은 값이 서지 않게 한다.
export function niceStep(rawStep) {
  if (!Number.isFinite(rawStep) || rawStep <= 0) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(rawStep));
  const normalized = rawStep / magnitude;
  const step = NICE_STEPS.find((candidate) => normalized <= candidate) ?? 10;
  return step * magnitude;
}

export function axisTicks(maxValue, tickCount = 4) {
  const max = Number(maxValue);
  if (!Number.isFinite(max) || max <= 0) return { max: 1, ticks: [0, 1] };
  const step = niceStep(max / Math.max(1, tickCount));
  const top = Math.ceil(max / step) * step;
  const ticks = [];
  for (let value = 0; value <= top + step / 2; value += step) {
    ticks.push(Number(value.toFixed(10)));
  }
  return { max: top, ticks };
}

// 값이 하나뿐이면 가로 위치를 나눌 수 없어 가운데에 둔다.
export function linePoints(values, { width, height, max }) {
  const rows = values || [];
  if (!rows.length) return [];
  const top = max > 0 ? max : 1;
  const step = rows.length > 1 ? width / (rows.length - 1) : 0;
  return rows.map((value, index) => ({
    value,
    x: rows.length > 1 ? index * step : width / 2,
    y: height - Math.min(Math.max(value, 0), top) / top * height
  }));
}

export function linePath(points) {
  return (points || [])
    .map(({ x, y }, index) => `${index ? "L" : "M"}${x.toFixed(2)} ${y.toFixed(2)}`)
    .join(" ");
}

// 막대는 24px을 넘지 않고, 남는 자리는 여백으로 둔다.
export function barBands(count, { height, thickness = 24, gap = 2 }) {
  if (!count) return [];
  const band = height / count;
  const barHeight = Math.max(4, Math.min(thickness, band - gap));
  return Array.from({ length: count }, (unused, index) => ({
    y: index * band + (band - barHeight) / 2,
    height: barHeight
  }));
}

// 세로 막대. 가로 막대와 같은 규칙을 축만 바꿔 쓴다.
export function columnBands(count, { width, thickness = 24, gap = 2 }) {
  if (!count) return [];
  const band = width / count;
  const barWidthPx = Math.max(2, Math.min(thickness, band - gap));
  return Array.from({ length: count }, (unused, index) => ({
    center: index * band + band / 2,
    x: index * band + (band - barWidthPx) / 2,
    width: barWidthPx
  }));
}

export function barWidth(value, { width, max }) {
  const top = max > 0 ? max : 1;
  return Math.max(0, Math.min(Number(value) || 0, top)) / top * width;
}

// 값이 0에 가까우면 둥근 끝이 막대보다 커져 도형이 뭉개진다.
export function barCornerRadius(renderedWidth, height, radius = 4) {
  return Math.max(0, Math.min(radius, renderedWidth, height / 2));
}
