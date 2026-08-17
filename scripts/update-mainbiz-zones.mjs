import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
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
const MAX_RETRIES = 3;
const key = process.env.VWORLD_KEY;
const domain = process.env.VWORLD_DOMAIN || "https://biz-lookup.vercel.app";

if (!key) throw new Error("VWORLD_KEY 환경변수가 필요합니다.");

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const storesPath = resolve(root, "data/stores_donggu.json");
const outputPath = resolve(root, "data/mainbiz_zones_donggu.geojson");
const tempPath = resolve(root, "data/.mainbiz-zones-donggu.tmp");
const sleep = (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms));

async function fetchTile(bounds) {
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
      const response = await fetch(url, { signal: AbortSignal.timeout(15000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      const result = data?.response;
      if (result?.status === "NOT_FOUND") return [];
      if (result?.status !== "OK") throw new Error(`${result?.error?.code}: ${result?.error?.text}`);
      return result?.result?.featureCollection?.features || [];
    } catch (error) {
      if (attempt === MAX_RETRIES) throw error;
      await sleep(attempt * 800);
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

const storesPayload = JSON.parse(await readFile(storesPath, "utf8"));
if (!Array.isArray(storesPayload.stores) || !storesPayload.stores.length) {
  throw new Error("점포 데이터가 없어 주요상권 수집을 진행할 수 없습니다.");
}
const tiles = makeTiles();
const byNumber = new Map();

for (let index = 0; index < tiles.length; index += 1) {
  const features = await fetchTile(tiles[index]);
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

const features = filterVworldZones([...byNumber.values()])
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
