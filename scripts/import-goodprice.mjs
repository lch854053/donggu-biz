import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// 동구청 홈페이지의 착한가격업소 현황은 Open API가 없다. 게시글에 첨부된 PDF를
// 받아 두고, poppler류로는 한글 글리프가 풀리지 않는(ToUnicode 맵 부재) 자료라
// 브라우저의 pdf.js(CMap 내장)로 표를 읽어 정규화 JSON으로 남긴다.
//
//   npm run update-goodprice                        # data/goodprice_donggu.pdf
//   npm run update-goodprice -- --pdf <경로> --basis 2026-05-26

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outputPath = resolve(root, "data/goodprice_donggu.json");
const tempPath = resolve(root, "data/.goodprice-donggu.tmp");

const argumentValue = (name) => {
  const withEquals = process.argv.find((value) => value.startsWith(`--${name}=`));
  if (withEquals) return withEquals.slice(name.length + 3);
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : "";
};

const pdfPath = resolve(root, argumentValue("pdf") || "data/goodprice_donggu.pdf");
const basisDate = argumentValue("basis") || "";
if (basisDate && !/^\d{4}-\d{2}-\d{2}$/.test(basisDate)) {
  throw new Error("--basis는 YYYY-MM-DD로 적습니다.");
}

// poppler(pdftotext)가 한글을 못 읽는 자료라 pdf.js로 좌표와 함께 읽어 표를 재조립한다.
const PAGE_HTML = `<!doctype html><html><head><meta charset="utf-8"></head><body>
<script src="https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js"></script>
<script>
  window.pdfjsLib.GlobalWorkerOptions.workerSrc =
    "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
</script>
</body></html>`;

const { chromium } = await import("playwright");

let browser;
try {
  browser = await chromium.launch({ channel: "msedge", headless: true });
} catch {
  browser = await chromium.launch({ headless: true });
}

const rows = await (async () => {
  const page = await browser.newPage();
  await page.setContent(PAGE_HTML);
  // about:blank 문서에서 file:// PDF를 못 읽으므로 base64로 통째로 넘긴다.
  const pdfBase64 = Buffer.from(await readFile(pdfPath)).toString("base64");
  return page.evaluate(async (base64) => {
    const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
    const pdf = await pdfjsLib.getDocument({
      data: bytes,
      cMapUrl: "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/cmaps/",
      cMapPacked: true
    }).promise;
    const lines = [];
    for (let pageNo = 1; pageNo <= pdf.numPages; pageNo += 1) {
      const content = await (await pdf.getPage(pageNo)).getTextContent();
      // 같은 줄의 글자 조각을 y좌표로 묶고 x좌표 순으로 세운다.
      const buckets = new Map();
      for (const item of content.items) {
        if (!item.str.trim()) continue;
        const y = Math.round(item.transform[5] / 3) * 3;
        if (!buckets.has(y)) buckets.set(y, []);
        buckets.get(y).push({ x: item.transform[4], width: item.width || item.str.length * 5, str: item.str });
      }
      for (const bucket of [...buckets.values()]) {
        bucket.sort((left, right) => left.x - right.x);
        // pdf.js가 알려 준 글자 폭으로 끝점을 계산해, 간격이 넓으면 새 칸으로 본다.
        const cells = [];
        let cell = bucket[0].str;
        let end = bucket[0].x + bucket[0].width;
        for (let i = 1; i < bucket.length; i += 1) {
          if (bucket[i].x - end > 4) {
            cells.push(cell.trim());
            cell = bucket[i].str;
          } else {
            cell += bucket[i].str;
          }
          end = Math.max(end, bucket[i].x + bucket[i].width);
        }
        cells.push(cell.trim());
        const kept = cells.filter((value) => value !== "");
        if (kept.length) lines.push(kept);
      }
    }
    return lines;
  }, pdfBase64);
})().finally(() => browser?.close());

// 줄 하나가 "순번 업종 업소명 광주광역시 동구 (주소) 전화번호 대표품목 가격 주차·금연" 형태다.
// 칸 경계를 그대로 믿기보다 정규식으로 해부하는 게 양식 변화에 덜 깨진다.
const digits = (value) => String(value ?? "").replace(/[^0-9]/g, "");
const PHONE_PATTERN = /0\d{1,2}-\d{3,4}-\d{4}/;

const dataRows = rows
  .map((cells) => cells.join(" ").replace(/\s+/g, " ").trim())
  .filter((line) => PHONE_PATTERN.test(line) && line.includes("광주광역시 동구"));
if (dataRows.length < 20) {
  throw new Error(`착한가격업소 행이 비정상적으로 적습니다(${dataRows.length}행). PDF 양식이 바뀌었는지 확인하세요.`);
}

const enterprises = [];
let unparsed = 0;
for (const line of dataRows) {
  const phone = line.match(PHONE_PATTERN)?.[0] ?? "";
  const phoneIndex = phone ? line.indexOf(phone) : -1;
  if (phoneIndex < 0) {
    unparsed += 1;
    continue;
  }
  // 표 머리글 셀이 행 앞에 붙는 경우가 있어 주소(마지막 "광주광역시 동구")를 기준으로 자른다.
  const addressRegion = line.slice(0, phoneIndex);
  const addressStart = addressRegion.lastIndexOf("광주광역시 동구");
  if (addressStart < 0) {
    unparsed += 1;
    continue;
  }
  const address = addressRegion.slice(addressStart).trim();
  const head = addressRegion.slice(0, addressStart).replace(/광주광역시\s*동구/g, " ").replace(/^\s*\d+\s*/, "").trim();
  const [industry = "", ...nameParts] = head.split(" ");
  const name = nameParts.join(" ").trim();
  const tail = line.slice(phoneIndex + phone.length).trim();
  // 꼬리는 대표품목 + 가격 + 주차·금연 표시(O/X) 순서다. 가격은 마지막 수 토큰이다.
  const tailTokens = tail.split(" ").filter(Boolean);
  const flagTokens = tailTokens.filter((token) => /^[OX]$/.test(token));
  const priceToken = [...tailTokens].reverse().find((token) => /^[\d,]+$/.test(token) && digits(token).length >= 3);
  const priceIndex = priceToken ? tailTokens.lastIndexOf(priceToken) : -1;
  const item = tailTokens.slice(0, priceIndex).join(" ").trim();
  if (!name || !phone || !address || priceIndex < 0) {
    unparsed += 1;
    continue;
  }
  enterprises.push({
    name,
    industry: industry || "",
    address,
    phone,
    item,
    price: Number(digits(priceToken)),
    parking: flagTokens[0] || "",
    noSmoking: flagTokens[1] || ""
  });
}

if (unparsed) console.warn(`[goodprice] 해석 못한 행 ${unparsed}개를 뺐습니다.`);
if (enterprises.length < 20) {
  throw new Error(`해석된 행이 너무 적습니다(${enterprises.length}행). PDF 양식이 바뀌었는지 확인하세요.`);
}

const payload = {
  meta: {
    generatedAt: new Date().toISOString(),
    source: "광주 동구 착한가격업소 현황 (동구청 홈페이지 게시 자료)",
    basisDate: basisDate || null,
    pdfPath: "data/goodprice_donggu.pdf",
    unparsedRows: unparsed,
    totalCount: enterprises.length
  },
  enterprises
};

await mkdir(dirname(outputPath), { recursive: true });
await writeFile(tempPath, `${JSON.stringify(payload, null, 1)}\n`, "utf8");
await rename(tempPath, outputPath);
console.log(`[goodprice] 착한가격업소 ${enterprises.length}곳을 ${outputPath}에 기록했습니다. 예시: ${JSON.stringify(enterprises[0])}`);
