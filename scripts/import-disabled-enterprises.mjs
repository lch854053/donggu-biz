import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { inflateRawSync } from "node:zlib";

// (재)장애인기업종합지원센터 자료실에는 공공구매종합정보망(SMPP) 기준 장애인기업
// 리스트 엑셀이 주기적으로 올라온다. 로그인 없이 받을 수 있고, 대장에는 지역이
// 전남·광주 통합 행정구역 기준으로 "전남" 하나만 적힌다(광주 062 사업장 포함).
//
//   npm run update-disabled-enterprises
//   npm run update-disabled-enterprises -- --file data/장애인기업관리대장.xlsx

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const boardUrl = "https://www.debc.or.kr/bbs/board.php?bo_table=s2_3";
const outputPath = resolve(root, "data/disabled_enterprises_jeonnam_gwangju.json");
const tempPath = resolve(root, "data/.disabled-enterprises-jeonnam-gwangju.tmp");

const fileArgumentIndex = process.argv.indexOf("--file");
const manualFilePath = fileArgumentIndex >= 0 ? process.argv[fileArgumentIndex + 1] : "";

async function findLatestListFileUrl() {
  const board = await fetch(boardUrl, { headers: { "User-Agent": "Mozilla/5.0" } }).then((r) => {
    if (!r.ok) throw new Error(`자료실 게시판을 못 읽습니다: HTTP ${r.status}`);
    return r.text();
  });
  // 게시판은 최신글이 먼저다. 제목에 기준일이 붙는 "장애인기업 리스트" 글을 찾는다.
  const posts = [...board.matchAll(/href="([^"]*bo_table=s2_3&(?:amp;)?wr_id=\d+)"[^>]*>([^<]*)<\/a>/g)]
    .map((match) => ({ url: match[1].replaceAll("&amp;", "&"), title: match[2].trim() }))
    .filter(({ title }) => /장애인기업.*(리스트|현황)/.test(title));
  if (!posts.length) throw new Error("자료실에서 장애인기업 리스트 글을 찾지 못했습니다. https://www.debc.or.kr/bbs/board.php?bo_table=s2_3 을 확인하세요.");
  const post = await fetch(posts[0].url, { headers: { "User-Agent": "Mozilla/5.0" } }).then((r) => r.text());
  const fileUrl = [...post.matchAll(/href="([^"]*\/bbs\/download\.php[^"]*)"/g)]
    .map((match) => match[1].replaceAll("&amp;", "&"))[0];
  if (!fileUrl) throw new Error(`리스트 글(${posts[0].title})에 첨부 파일이 없습니다.`);
  return { fileUrl, title: posts[0].title };
}

// xlsx는 zip이다. 의존성을 더하지 않고 중앙 디렉터리에서 항목을 찾아 푼다.
function readZipEntries(buffer) {
  if (buffer.readUInt32LE(0) !== 0x04034b50) throw new Error("xlsx 파일이 아니거나 깨졌습니다(zip 시그니처 없음).");
  let position = buffer.length - 22;
  while (position >= 0 && buffer.readUInt32LE(position) !== 0x06054b50) position -= 1;
  if (position < 0) throw new Error("zip 중앙 디렉터리를 찾지 못했습니다.");
  const entryCount = buffer.readUInt16LE(position + 10);
  let offset = buffer.readUInt32LE(position + 16);
  const entries = {};
  for (let index = 0; index < entryCount; index += 1) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) break;
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.slice(offset + 46, offset + 46 + nameLength).toString();
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const raw = buffer.slice(dataStart, dataStart + compressedSize);
    entries[name] = method === 8 ? inflateRawSync(raw) : raw;
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

function cellValue(cellMarkup, sharedStrings) {
  const type = (cellMarkup.match(/t="([^"]+)"/) || [])[1];
  const value = (cellMarkup.match(/<v>([\s\S]*?)<\/v>/) || [])[1];
  if (value === undefined) return "";
  const decoded = value
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'").replace(/&amp;/g, "&");
  return type === "s" ? (sharedStrings[Number(value)] ?? "") : decoded;
}

function readSheetRows(buffer) {
  const entries = readZipEntries(buffer);
  const sharedXml = entries["xl/sharedStrings.xml"]?.toString("utf8") || "";
  const sharedStrings = sharedXml.split("<si>").slice(1)
    .map((block) => block.replace(/<[^>]+>/g, "").trim());
  const sheetXml = entries["xl/worksheets/sheet1.xml"]?.toString("utf8");
  if (!sheetXml) throw new Error("sheet1을 찾지 못했습니다. 엑셀 양식을 확인하세요.");
  return sheetXml.split("</row>").map((rowMarkup) =>
    [...rowMarkup.matchAll(/<c [^>]*?(?:\/>|>([\s\S]*?)<\/c>)/g)]
      .map((match) => cellValue(match[0], sharedStrings))
  ).filter((cells) => cells.some((cell) => cell !== ""));
}

function normalizeDate(raw) {
  const digits = String(raw).replace(/[^0-9]/g, "");
  if (!/^\d{8}$/.test(digits)) return "";
  return `${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6, 8)}`;
}

let fileBuffer;
let listTitle;
if (manualFilePath) {
  fileBuffer = await import("node:fs/promises").then((fs) => fs.readFile(resolve(root, manualFilePath)));
  listTitle = `수동 지정 파일(${manualFilePath})`;
} else {
  const found = await findLatestListFileUrl();
  listTitle = found.title;
  const response = await fetch(found.fileUrl, { headers: { "User-Agent": "Mozilla/5.0" } });
  if (!response.ok) throw new Error(`첨부 파일 내려받기 실패: HTTP ${response.status}`);
  fileBuffer = Buffer.from(await response.arrayBuffer());
}

const rows = readSheetRows(fileBuffer);
const header = rows[0];
if (header.slice(0, 2).join("|") !== "구분|업체명") {
  throw new Error(`열 구성이 바뀌었습니다. 대장 양식 변화를 확인하세요.\n실제: ${header.join(", ")}`);
}

// 지역 열은 전남·광주 통합 행정구역 기준으로 "전남"만 남는다. 광주 062 사업장이 포함된다.
const jeonnam = rows.slice(1)
  .map((row) => ({
    name: String(row[1] ?? "").trim(),
    phone: String(row[2] ?? "").trim(),
    validFrom: normalizeDate(row[3]),
    validTo: normalizeDate(row[4]),
    region: String(row[5] ?? "").trim()
  }))
  .filter((enterprise) => enterprise.name && enterprise.region === "전남");

if (jeonnam.length < 300) {
  throw new Error(`전남 장애인기업이 비정상적으로 적습니다(${jeonnam.length}곳). 대장을 확인하세요.`);
}

const payload = {
  meta: {
    generatedAt: new Date().toISOString(),
    source: "(재)장애인기업종합지원센터 자료실 SMPP 등록 장애인기업 리스트 (https://www.debc.or.kr/bbs/board.php?bo_table=s2_3)",
    listTitle,
    region: "전남광주통합특별시(대장 지역 구분상 전남, 광주 포함)",
    totalCount: jeonnam.length
  },
  enterprises: jeonnam
};

await mkdir(dirname(outputPath), { recursive: true });
await writeFile(tempPath, `${JSON.stringify(payload, null, 1)}\n`, "utf8");
await rename(tempPath, outputPath);
console.log(`[disabled-enterprises] "${listTitle}"에서 전남(광주 포함) ${jeonnam.length}곳을 ${outputPath}에 기록했습니다`);
