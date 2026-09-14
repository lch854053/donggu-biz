import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// 한국여성경제인협회 광주지회 여성기업명부(gjwbiz.or.kr)는 로그인 없이 표로
// 내려오고 사업자등록번호가 있어 4대보험 사업장과 정확히 맞춘다. 명부는
// 15행씩 끊겨 있어 끝까지 넘기면서 읽는다. 사업자번호를 공개하는 명부라
// 대표자 이름은 원본 그대로 마스킹되어 온다.
//
//   npm run update-women-enterprises

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const listUrl = "https://gjwbiz.or.kr/sub/company.php";
const outputPath = resolve(root, "data/women_enterprises_gwangju.json");
const tempPath = resolve(root, "data/.women-enterprises-gwangju.tmp");
const PAGE_SIZE = 40;
const REQUEST_PAUSE_MS = 60;

function cellText(rowMarkup) {
  return rowMarkup.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

function parseRow(rowMarkup) {
  // 업체명 사업자등록번호 대표자 업종 주생산품목 전화번호 주소 유효기간만료일 형태
  const cells = [...rowMarkup.matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/g)].map((match) => cellText(match[1]));
  const joined = cells.join(" ");
  if (cells.length < 9 || !/\d{3}-\d{2}-\d{5}/.test(joined)) return null;
  const address = cells[6];
  return {
    name: cells[0],
    businessNumber: cells[1],
    representative: cells[2],
    industry: cells[3],
    product: cells[4],
    phone: cells[5] === "-" ? "" : cells[5],
    address,
    gu: address.startsWith("광주광역시 ") ? address.split(" ")[1] || "" : "",
    validTo: cells[7],
    form: cells[8]
  };
}

async function fetchRows(page) {
  const response = await fetch(`${listUrl}?&s_limit=${PAGE_SIZE}&page=${page}`, {
    headers: { "User-Agent": "Mozilla/5.0" }
  });
  if (!response.ok) throw new Error(`여성기업명부 ${page}쪽을 못 읽습니다: HTTP ${response.status}`);
  const html = await response.text();
  return [...html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)]
    .map((match) => parseRow(match[1]))
    .filter(Boolean);
}

const seen = new Set();
const all = [];
for (let page = 1; ; page += 1) {
  const rows = await fetchRows(page);
  if (!rows.length) break;
  let fresh = 0;
  for (const row of rows) {
    if (seen.has(row.businessNumber)) continue;
    seen.add(row.businessNumber);
    all.push(row);
    fresh += 1;
  }
  if (page % 20 === 0) console.log(`[women-enterprises] ${page}쪽, 누적 ${all.length}건`);
  if (!fresh) break;
  await new Promise((resolvePause) => setTimeout(resolvePause, REQUEST_PAUSE_MS));
}

const gwangju = all.filter((row) => row.address.startsWith("광주광역시"));
if (gwangju.length < 1000) {
  throw new Error(`광주 여성기업이 비정상적으로 적습니다(${gwangju.length}곳). 명부를 확인하세요.`);
}
const dongguCount = gwangju.filter((row) => row.gu === "동구").length;
if (!dongguCount) throw new Error("동구 여성기업이 한 건도 없습니다. 주소 열을 확인하세요.");

const payload = {
  meta: {
    generatedAt: new Date().toISOString(),
    source: "한국여성경제인협회 광주지회 여성기업명부 (https://gjwbiz.or.kr/sub/company.php)",
    region: "광주광역시",
    totalCount: gwangju.length,
    dongguCount
  },
  enterprises: gwangju
};

await mkdir(dirname(outputPath), { recursive: true });
await writeFile(tempPath, `${JSON.stringify(payload, null, 1)}\n`, "utf8");
await rename(tempPath, outputPath);
console.log(`[women-enterprises] 광주 ${gwangju.length}곳(동구 ${dongguCount}곳)을 ${outputPath}에 기록했습니다`);
