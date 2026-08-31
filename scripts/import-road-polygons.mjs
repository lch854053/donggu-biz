import { readFile, rename, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import proj4 from "proj4";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const defaultSource = "D:/Downloads/(도로명주소)실폭도로_전남광주통합특별시/TL_SPRD_RW_12_202608";
const defaultOutput = resolve(root, "data/road-polygons-donggu.geojson");
const DONGGU_CODE = "12210";
const SOURCE_CRS = "+proj=tmerc +lat_0=38 +lon_0=127.5 +k=0.9996 +x_0=1000000 +y_0=2000000 +ellps=GRS80 +units=m +no_defs";
const WGS84 = "EPSG:4326";
const COORDINATE_DECIMALS = 6;

function option(name, fallback) {
  const prefix = `${name}=`;
  const argument = process.argv.find((value) => value.startsWith(prefix));
  return argument ? argument.slice(prefix.length) : fallback;
}

function roundCoordinate(value) {
  return Number(value.toFixed(COORDINATE_DECIMALS));
}

function dbfFields(buffer) {
  const headerLength = buffer.readUInt16LE(8);
  const fields = [];
  let offset = 32;
  let recordOffset = 1;
  while (offset + 32 <= headerLength && buffer[offset] !== 0x0d) {
    const rawName = buffer.subarray(offset, offset + 11);
    const nameEnd = rawName.indexOf(0);
    const name = rawName.subarray(0, nameEnd < 0 ? rawName.length : nameEnd).toString("ascii").trim();
    const length = buffer[offset + 16];
    fields.push({ name, length, recordOffset });
    recordOffset += length;
    offset += 32;
  }
  return fields;
}

function dbfValue(buffer, rowOffset, field) {
  return buffer.subarray(rowOffset + field.recordOffset, rowOffset + field.recordOffset + field.length)
    .toString("ascii")
    .replace(/\0/g, "")
    .trim();
}

function ringArea(ring) {
  let area = 0;
  for (let index = 0, previous = ring.length - 1; index < ring.length; previous = index, index += 1) {
    area += ring[previous][0] * ring[index][1] - ring[index][0] * ring[previous][1];
  }
  return area / 2;
}

function pointInRing(point, ring) {
  let inside = false;
  for (let index = 0, previous = ring.length - 1; index < ring.length; previous = index, index += 1) {
    const [x1, y1] = ring[index];
    const [x2, y2] = ring[previous];
    if ((y1 > point[1]) !== (y2 > point[1])
      && point[0] < ((x2 - x1) * (point[1] - y1)) / (y2 - y1) + x1) inside = !inside;
  }
  return inside;
}

function ringsToGeometry(rings) {
  const groups = rings
    .map((ring) => ({ ring, area: ringArea(ring), holes: [] }))
    .filter(({ area }) => Math.abs(area) > 0);
  const outers = groups.filter(({ area }) => area < 0);
  const holes = groups.filter(({ area }) => area > 0);
  const polygons = outers.length ? outers : groups
    .sort((left, right) => Math.abs(right.area) - Math.abs(left.area))
    .slice(0, 1);

  for (const hole of holes) {
    const owner = polygons.find(({ ring }) => pointInRing(hole.ring[0], ring));
    if (owner) owner.holes.push(hole.ring);
    else polygons.push(hole);
  }

  const coordinates = polygons.map(({ ring, holes: innerRings }) => [ring, ...innerRings]);
  return coordinates.length === 1
    ? { type: "Polygon", coordinates: coordinates[0] }
    : { type: "MultiPolygon", coordinates };
}

function geometryBounds(geometry) {
  const bounds = [Infinity, Infinity, -Infinity, -Infinity];
  const walk = (value) => {
    if (Array.isArray(value) && typeof value[0] === "number" && typeof value[1] === "number") {
      bounds[0] = Math.min(bounds[0], value[0]);
      bounds[1] = Math.min(bounds[1], value[1]);
      bounds[2] = Math.max(bounds[2], value[0]);
      bounds[3] = Math.max(bounds[3], value[1]);
      return;
    }
    if (Array.isArray(value)) value.forEach(walk);
  };
  walk(geometry.coordinates);
  return bounds;
}

function parsePolygonRecord(buffer, offset) {
  const shapeType = buffer.readInt32LE(offset + 8);
  if (shapeType === 0) return null;
  if (shapeType !== 5) throw new Error(`지원하지 않는 실폭도로 도형입니다: ${shapeType}`);

  const partCount = buffer.readUInt32LE(offset + 44);
  const pointCount = buffer.readUInt32LE(offset + 48);
  const partsOffset = offset + 52;
  const pointsOffset = partsOffset + partCount * 4;
  const rings = [];
  for (let part = 0; part < partCount; part += 1) {
    const start = buffer.readUInt32LE(partsOffset + part * 4);
    const end = part + 1 < partCount ? buffer.readUInt32LE(partsOffset + (part + 1) * 4) : pointCount;
    const ring = [];
    for (let point = start; point < end; point += 1) {
      const pointOffset = pointsOffset + point * 16;
      const [longitude, latitude] = proj4(SOURCE_CRS, WGS84, [
        buffer.readDoubleLE(pointOffset),
        buffer.readDoubleLE(pointOffset + 8)
      ]);
      ring.push([roundCoordinate(longitude), roundCoordinate(latitude)]);
    }
    if (ring.length >= 3 && (ring[0][0] !== ring.at(-1)[0] || ring[0][1] !== ring.at(-1)[1])) ring.push(ring[0]);
    if (ring.length >= 4) rings.push(ring);
  }
  return rings.length ? ringsToGeometry(rings) : null;
}

async function main() {
  const source = option("--source", defaultSource).replace(/\/$/, "");
  const output = resolve(option("--output", defaultOutput));
  const [shp, dbf] = await Promise.all([
    readFile(`${source}.shp`),
    readFile(`${source}.dbf`)
  ]);
  if (shp.readInt32BE(0) !== 9994 || shp.readInt32LE(28) !== 1000 || shp.readInt32LE(32) !== 5) {
    throw new Error("실폭도로 SHP 헤더가 Polygon 형식이 아닙니다.");
  }

  const fields = dbfFields(dbf);
  const fieldByName = new Map(fields.map((field) => [field.name, field]));
  const sigunguField = fieldByName.get("SIG_CD");
  const roadSerialField = fieldByName.get("RW_SN");
  const operatedAtField = fieldByName.get("OPERT_DE");
  if (!sigunguField) throw new Error("DBF에 SIG_CD 필드가 없습니다.");

  const recordCount = dbf.readUInt32LE(4);
  const dbfHeaderLength = dbf.readUInt16LE(8);
  const dbfRecordLength = dbf.readUInt16LE(10);
  const features = [];
  let shapeOffset = 100;
  let shapeRecordCount = 0;
  while (shapeOffset < shp.length) {
    const contentLength = shp.readInt32BE(shapeOffset + 4) * 2;
    const geometry = parsePolygonRecord(shp, shapeOffset);
    const rowOffset = dbfHeaderLength + shapeRecordCount * dbfRecordLength;
    const sigunguCode = dbfValue(dbf, rowOffset, sigunguField);
    if (geometry && sigunguCode === DONGGU_CODE) {
      const properties = {};
      const roadSerial = roadSerialField ? dbfValue(dbf, rowOffset, roadSerialField) : "";
      const operatedAt = operatedAtField ? dbfValue(dbf, rowOffset, operatedAtField) : "";
      if (roadSerial) properties.rwSn = roadSerial;
      if (operatedAt) properties.operationDate = operatedAt;
      features.push({
        type: "Feature",
        id: `road-${shapeRecordCount + 1}`,
        bbox: geometryBounds(geometry),
        properties,
        geometry
      });
    }
    shapeOffset += 8 + contentLength;
    shapeRecordCount += 1;
  }
  if (shapeRecordCount !== recordCount) throw new Error(`SHP/DBF 레코드 수가 다릅니다: ${shapeRecordCount}/${recordCount}`);

  const payload = {
    type: "FeatureCollection",
    meta: {
      generatedAt: new Date().toISOString(),
      source: "도로명주소 실폭도로",
      sourceFile: basename(source),
      sourceCrs: "EPSG:5179",
      crs: "EPSG:4326",
      sigunguCode: DONGGU_CODE,
      inputFeatureCount: recordCount,
      featureCount: features.length
    },
    features
  };
  const temporary = `${output}.tmp`;
  await writeFile(temporary, JSON.stringify(payload));
  await rename(temporary, output);
  console.log(JSON.stringify({ output, inputFeatureCount: recordCount, featureCount: features.length }));
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
