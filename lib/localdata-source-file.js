// 승인이 확인된 후보를 lib/store-license.js의 LOCALDATA_SOURCES 끝에 붙인다.
// 원천이 쉰 개를 넘어가면서 손으로 옮기다 오타를 내기 쉬워, 붙이는 일만 따로 떼어 냈다.

const ARRAY_CLOSE = "\n]);";
const FIELD_ORDER = ["slug", "datasetId", "title", "endpoint", "largeCode", "largeName", "middleCode", "middleName"];

function quote(value) {
  return JSON.stringify(String(value ?? ""));
}

export function renderLocaldataSource(entry) {
  const body = FIELD_ORDER.map((field) => `    ${field}: ${quote(entry[field])}`).join(",\n");
  return `  {\n${body}\n  }`;
}

export function localdataSourceSlugs(fileText) {
  return [...String(fileText ?? "").matchAll(/^\s{4}slug: "([A-Za-z0-9_-]+)",$/gm)].map(([, slug]) => slug);
}

// 이미 들어 있는 슬러그는 건너뛴다. 같은 원천이 두 번 들어가면 수집이 그대로 두 배가 된다.
export function insertLocaldataSources(fileText, entries) {
  const text = String(fileText ?? "");
  const closeIndex = text.lastIndexOf(ARRAY_CLOSE);
  if (closeIndex < 0) throw new Error("LOCALDATA_SOURCES 배열의 끝을 찾지 못했습니다.");

  const existing = new Set(localdataSourceSlugs(text));
  const added = [];
  const skipped = [];
  for (const entry of entries || []) {
    if (!entry.slug || !entry.endpoint) {
      skipped.push({ slug: entry.slug || "(슬러그 없음)", reason: "슬러그 또는 요청주소가 비어 있습니다." });
      continue;
    }
    if (existing.has(entry.slug)) {
      skipped.push({ slug: entry.slug, reason: "이미 LOCALDATA_SOURCES에 있습니다." });
      continue;
    }
    existing.add(entry.slug);
    added.push(entry);
  }
  if (!added.length) return { text, added, skipped };

  const block = added.map((entry) => `,\n${renderLocaldataSource(entry)}`).join("");
  return {
    text: `${text.slice(0, closeIndex)}${block}${text.slice(closeIndex)}`,
    added,
    skipped
  };
}
