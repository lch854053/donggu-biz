import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { enrichStoreAddresses } from "../lib/kakao-local.js";

const apiKey = process.env.KAKAO_REST_API_KEY;
if (!apiKey) throw new Error("KAKAO_REST_API_KEY 환경변수가 필요합니다.");

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outputPath = resolve(root, "data/stores_donggu.json");
const tempPath = resolve(root, "data/.stores-donggu-enriched.tmp");
const payload = JSON.parse(await readFile(outputPath, "utf8"));

const result = await enrichStoreAddresses(payload.stores, {
  apiKey,
  onError(error, store) {
    console.warn(`[kakao] ${store.id} ${store.name}: ${error.message}`);
  }
});

const previous = payload.meta?.kakaoAddressEnrichment || {};
const alreadyEnriched = payload.stores.filter((store) => store.addressSource).length;
const totalStats = {
  candidateCount: Math.max(Number(previous.candidateCount) || 0, alreadyEnriched + result.stats.candidateCount),
  uniqueCoordinateCount: Math.max(Number(previous.uniqueCoordinateCount) || 0, result.stats.uniqueCoordinateCount),
  requestCount: (Number(previous.requestCount) || 0) + result.stats.requestCount,
  keywordRequestCount: (Number(previous.keywordRequestCount) || 0) + result.stats.keywordRequestCount,
  keywordFallbackCount: (Number(previous.keywordFallbackCount) || 0) + result.stats.keywordFallbackCount,
  enrichedCount: alreadyEnriched + result.stats.enrichedCount,
  failedCount: (Number(previous.failedCount) || 0) + result.stats.failedCount,
  unresolvedCount: result.stats.unresolvedCount,
  skippedCount: result.stats.skippedCount
};
payload.stores = result.stores;
payload.meta = {
  ...payload.meta,
  kakaoAddressEnrichment: {
    source: "Kakao Local 좌표로 주소 변환",
    generatedAt: new Date().toISOString(),
    ...totalStats
  }
};
payload.quality = {
  ...payload.quality,
  kakaoAddressEnriched: totalStats.enrichedCount,
  kakaoAddressEnrichmentFailed: totalStats.failedCount,
  kakaoAddressEnrichmentUnresolved: totalStats.unresolvedCount
};

await mkdir(dirname(outputPath), { recursive: true });
await writeFile(tempPath, `${JSON.stringify(payload)}\n`, "utf8");
await rename(tempPath, outputPath);
console.log(`[kakao] enriched ${result.stats.enrichedCount}/${result.stats.candidateCount} stores with ${result.stats.requestCount} coordinate requests and ${result.stats.keywordRequestCount} keyword fallbacks (${result.stats.unresolvedCount} unresolved)`);
