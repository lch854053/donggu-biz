import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { setDefaultResultOrder } from "node:dns";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { geometryAreaSqm } from "../lib/market.js";
import { assertZoneSnapshotHealthy, filterVworldZones } from "../lib/zone-update.js";

const API_URL = "https://api.vworld.kr/req/data";
const LAYER = "LT_C_DGMAINBIZ";
const TILE_WIDTH = 0.014;
const TILE_HEIGHT = 0.012;
// Dong-gu legal-dong bounds with a small margin; independent of current store density.
const DONGGU_BOUNDS = [126.9, 35.065, 127.012, 35.172];
const MAX_RETRIES = 6;
const MAX_RETRY_WAIT_MS = 30000;
const REQUEST_TIMEOUT_MS = 20000;
const key = process.env.VWORLD_KEY;
const domain = process.env.VWORLD_DOMAIN || "https://biz-lookup.vercel.app";

if (!key) throw new Error("VWORLD_KEY 환경변수가 필요합니다.");

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const storesPath = resolve(root, "data/stores_donggu.json");
const outputPath = resolve(root, "data/mainbiz_zones_donggu.geojson");
const tempPath = resolve(root, "data/.mainbiz-zones-donggu.tmp");
const sleep = (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms));

setDefaultResultOrder("ipv4first");

const TRANSIENT_ERROR_CODES = new Set([
  "ECONNRESET",
  "ETIMEDOUT",
  "EAI_AGAIN",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_SOCKET"
]);

function retryWait(attempt) {
  return Math.min(MAX_RETRY_WAIT_MS, 1000 * 2 ** attempt);
}

function isTransientNetworkError(error) {
  const seen = new Set();
  let current = error;
  while (current && !seen.has(current)) {
    if (current.retryable || current.name === "AbortError" || current.name === "TimeoutError"
      || TRANSIENT_ERROR_CODES.has(current.code)) return true;
    seen.add(current);
    current = current.cause;
  }
  return false;
}

async function fetchTile(bounds, tileNo, tileCount) {
  const url = new URL(API_URL);
  url.search = new URLSearchParams({
    service: "data",
    request: "GetFeature",
    data: LAYER,
    key,
    domain,
    format: "json",
    size: "1000",
    page: "1",
    geometry: "true",
    attribute: "true",
    crs: "EPSG:4326",
    geomFilter: `BOX(${bounds.join(",")})`
  }).toString();

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt += 1) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      if (!response.ok) {
        const error = new Error(`HTTP ${response.status}`);
        error.retryable = response.status === 429 || response.status >= 500;
        throw error;
      }
      const data = await response.json();
      const result = data?.response;
      if (result?.status === "NOT_FOUND") return [];
      if (result?.status !== "OK") throw new Error(`${result?.error?.code}: ${result?.error?.text}`);
      return result?.result?.featureCollection?.features || [];
    } catch (error) {
      if (attempt === MAX_RETRIES) {
        throw new Error(`[mainbiz] ${tileNo}/${tileCount} 타일 요청 실패: ${error.message}`, { cause: error });
      }
      const wait = retryWait(attempt);
      console.warn(`[mainbiz] ${tileNo}/${tileCount} 타일 요청 실패 ${attempt}/${MAX_RETRIES} (${error.message}), ${wait / 1000}초 뒤 다시 시도합니다.`);
      await sleep(wait);
    }
  }
}

function makeTiles() {
  const [minLongitude, minLatitude, maxLongitude, maxLatitude] = DONGGU_BOUNDS;
  const tiles = [];
  for (let minX = minLongitude; minX < maxLongitude; minX += TILE_WIDTH) {
    for (let minY = minLatitude; minY < maxLatitude; minY += TILE_HEIGHT) {
      tiles.push([minX, minY, Math.min(minX + TILE_WIDTH, maxLongitude), Math.min(minY + TILE_HEIGHT, maxLatitude)]
        .map((value) => Number(value.toFixed(7))));
    }
  }
  return tiles;
}

async function collectFeatures(tiles) {
  const byNumber = new Map();
  for (let index = 0; index < tiles.length; index += 1) {
    const features = await fetchTile(tiles[index], index + 1, tiles.length);
    features.filter((feature) => feature?.properties?.sigg === "동구").forEach((feature) => {
      const properties = feature.properties || {};
      byNumber.set(String(properties.no), {
        type: "Feature",
        id: `${LAYER}.${properties.no}`,
        properties: {
          no: String(properties.no || ""),
          name: String(properties.nm || properties.fullnm || "").trim(),
          fullName: String(properties.fullnm || properties.nm || "").trim(),
          sido: String(properties.sido || "").trim(),
          sigg: String(properties.sigg || "").trim(),
          areaSqm: Math.round(geometryAreaSqm(feature.geometry))
        },
        geometry: feature.geometry
      });
    });
    console.log(`[mainbiz] ${index + 1}/${tiles.length} tiles, ${byNumber.size} unique Dong-gu zones`);
    await sleep(80);
  }
  return [...byNumber.values()];
}

async function preservePreviousSnapshot(error) {
  let previous;
  try {
    previous = JSON.parse(await readFile(outputPath, "utf8"));
  } catch (readError) {
    if (readError?.code === "ENOENT") return false;
    throw new Error(`기존 주요상권 파일을 읽을 수 없습니다: ${readError.message}`, { cause: readError });
  }

  const features = filterVworldZones(previous?.features);
  assertZoneSnapshotHealthy({ features, minimumCount: 2 });
  console.warn(`[mainbiz] VWorld 일시 오류로 기존 경계 ${features.length}개를 유지합니다: ${error.message}`);
  return true;
}

const storesPayload = JSON.parse(await readFile(storesPath, "utf8"));
if (!Array.isArray(storesPayload.stores) || !storesPayload.stores.length) {
  throw new Error("점포 데이터가 없어 주요상권 수집을 진행할 수 없습니다.");
}
const tiles = makeTiles();
let fetchedFeatures;
try {
  fetchedFeatures = await collectFeatures(tiles);
} catch (error) {
  if (!isTransientNetworkError(error) || !await preservePreviousSnapshot(error)) throw error;
  process.exit(0);
}

const features = filterVworldZones(fetchedFeatures)
  .sort((a, b) => a.properties.no.localeCompare(b.properties.no));
let previousCount = null;
try {
  const previous = JSON.parse(await readFile(outputPath, "utf8"));
  previousCount = filterVworldZones(previous?.features).length;
} catch (error) {
  if (error?.code !== "ENOENT") throw new Error(`기존 주요상권 파일을 읽을 수 없습니다: ${error.message}`);
}
assertZoneSnapshotHealthy({ features, previousCount, minimumCount: 2 });

const payload = {
  type: "FeatureCollection",
  meta: {
    generatedAt: new Date().toISOString(),
    source: "VWorld 주요상권",
    layer: LAYER,
    sourceRegionName: "광주광역시 동구",
    zoneCount: features.length,
    tileCount: tiles.length
  },
  features
};

await mkdir(dirname(outputPath), { recursive: true });
await writeFile(tempPath, `${JSON.stringify(payload)}\n`, "utf8");
await rename(tempPath, outputPath);
console.log(`[mainbiz] wrote ${features.length} zones to ${outputPath}`);
