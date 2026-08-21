import {
  buildLocationFilter,
  buildLocationSelection,
  countBy,
  filterStores
} from "./lib/market.js";
import { filterVworldZones, mergeZoneFeatures } from "./lib/zone-update.js";
import {
  industrySection,
  isPlaceholderIndustry,
  mergeWorkplaceHistory,
  toBizNoPrefix,
  workplaceIdentity
} from "./lib/nps.js";
import { SB_REGIONS, formatMonth, formatRatio } from "./lib/sbprofile.js";

const $ = (id) => document.getElementById(id);
const escapeHtml = (value) => String(value ?? "").replace(/[&<>'"]/g, (char) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;"
})[char]);

let toastTimer;
function showToast(message) {
  const toast = $("toast");
  toast.textContent = message;
  toast.classList.add("is-visible");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("is-visible"), 2600);
}

// Service navigation
const tabs = [...document.querySelectorAll(".primary-tab")];
tabs.forEach((tab, index) => {
  tab.addEventListener("click", () => activateService(tab.dataset.panel));
  tab.addEventListener("keydown", (event) => {
    if (!["ArrowLeft", "ArrowRight"].includes(event.key)) return;
    event.preventDefault();
    const direction = event.key === "ArrowRight" ? 1 : -1;
    const next = tabs[(index + direction + tabs.length) % tabs.length];
    next.focus();
    activateService(next.dataset.panel);
  });
});

function activateService(panelName) {
  tabs.forEach((tab) => {
    const active = tab.dataset.panel === panelName;
    tab.classList.toggle("is-active", active);
    tab.setAttribute("aria-selected", String(active));
    $(`panel-${tab.dataset.panel}`).hidden = !active;
  });
  if (panelName === "market") initializeMarket();
  if (panelName === "stats") initializeStats();
}

// Business lookup sub-navigation
const subTabs = [...document.querySelectorAll(".sub-tab")];
subTabs.forEach((tab, index) => {
  tab.addEventListener("click", () => activateBusinessLookup(tab.dataset.subpanel));
  tab.addEventListener("keydown", (event) => {
    if (!["ArrowLeft", "ArrowRight"].includes(event.key)) return;
    event.preventDefault();
    const direction = event.key === "ArrowRight" ? 1 : -1;
    const next = subTabs[(index + direction + subTabs.length) % subTabs.length];
    next.focus();
    activateBusinessLookup(next.dataset.subpanel);
  });
});

function activateBusinessLookup(subpanelName) {
  subTabs.forEach((tab) => {
    const active = tab.dataset.subpanel === subpanelName;
    tab.classList.toggle("is-active", active);
    tab.setAttribute("aria-selected", String(active));
    $(`subpanel-${tab.dataset.subpanel}`).hidden = !active;
  });
}

// Business status lookup
let allResults = [];
let currentBusinessFilter = "all";
let shouldStop = false;

function parseNumbers(raw) {
  return raw.split(/[\n,\t]+/)
    .map((value) => value.replace(/[^0-9]/g, "").trim())
    .filter(Boolean);
}

function validateBizNo(number) {
  if (number.length !== 10) return false;
  const weights = [1, 3, 7, 1, 3, 7, 1, 3, 5];
  let sum = 0;
  for (let index = 0; index < 9; index += 1) sum += Number(number[index]) * weights[index];
  sum += Math.floor((Number(number[8]) * 5) / 10);
  return (10 - (sum % 10)) % 10 === Number(number[9]);
}

function formatBizNo(number) {
  return `${number.slice(0, 3)}-${number.slice(3, 5)}-${number.slice(5)}`;
}

function chunk(items, size) {
  const groups = [];
  for (let index = 0; index < items.length; index += size) groups.push(items.slice(index, index + size));
  return groups;
}

function updateInputCount() {
  const count = parseNumbers($("inputArea").value).length;
  $("countBadge").textContent = `${count.toLocaleString("ko-KR")}건 입력`;
}

function badge(type, value, code) {
  if (type === "result") {
    if (value === "format") return '<span class="badge badge-red">형식 오류</span>';
    if (value === "api") return '<span class="badge badge-yellow">API 오류</span>';
    if (!value) return '<span class="badge badge-gray">미등록</span>';
    return '<span class="badge badge-green">조회 성공</span>';
  }
  if (type === "tax") {
    if (!value) return '<span class="badge badge-gray">-</span>';
    const label = escapeHtml(value.replace("부가가치세 ", "").replace("과세자", "").trim());
    if (code === "01") return `<span class="badge badge-green">${label}</span>`;
    if (code === "02") return `<span class="badge badge-yellow">${label}</span>`;
    return `<span class="badge badge-gray">${label}</span>`;
  }
  if (!value) return '<span class="badge badge-gray">-</span>';
  if (code === "01") return '<span class="badge badge-green">계속사업자</span>';
  if (code === "02") return '<span class="badge badge-yellow">휴업</span>';
  if (code === "03") return '<span class="badge badge-red">폐업</span>';
  return `<span class="badge badge-gray">${escapeHtml(value)}</span>`;
}

function filteredBusinessResults() {
  if (currentBusinessFilter === "active") return allResults.filter((row) => row.b_stt_cd === "01");
  if (currentBusinessFilter === "closed") return allResults.filter((row) => ["02", "03"].includes(row.b_stt_cd));
  if (currentBusinessFilter === "error") {
    return allResults.filter((row) => row.formatError || row.apiError || (!row.b_stt && !row.pending));
  }
  return allResults;
}

function renderBusinessTable() {
  const rows = filteredBusinessResults();
  if (!rows.length) {
    $("resultBody").innerHTML = '<tr class="empty-row"><td colspan="6">해당 조건의 결과가 없습니다.</td></tr>';
    return;
  }
  $("resultBody").innerHTML = rows.map((row, index) => {
    const rowClass = row.formatError || row.apiError ? "row-error" : row.pending ? "row-pending" : "";
    const resultKey = row.formatError ? "format" : row.apiError ? "api" : row.b_stt;
    const closeDate = row.end_dt?.replace(/(\d{4})(\d{2})(\d{2})/, "$1.$2.$3") || "-";
    return `<tr class="${rowClass}">
      <td class="seq">${index + 1}</td>
      <td class="mono">${escapeHtml(formatBizNo(row.b_no))}</td>
      <td>${badge("result", resultKey)}</td>
      <td>${badge("tax", row.tax_type, row.tax_type_cd)}</td>
      <td>${badge("status", row.b_stt, row.b_stt_cd)}</td>
      <td class="mono">${escapeHtml(closeDate)}</td>
    </tr>`;
  }).join("");
}

function renderBusinessStats() {
  const active = allResults.filter((row) => row.b_stt_cd === "01").length;
  const closed = allResults.filter((row) => ["02", "03"].includes(row.b_stt_cd)).length;
  const errors = allResults.filter((row) => row.formatError || row.apiError || (!row.b_stt && !row.pending)).length;
  $("statsRow").innerHTML = `
    <span class="stat-item">전체<strong>${allResults.length}</strong></span>
    <span class="stat-item">계속사업자<strong>${active}</strong></span>
    <span class="stat-item">휴·폐업<strong>${closed}</strong></span>
    <span class="stat-item">오류·미등록<strong>${errors}</strong></span>`;
}

async function callBusinessProxy(numbers) {
  const response = await fetch("/api/lookup", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ b_no: numbers })
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error.error || `HTTP ${response.status}`);
  }
  const json = await response.json();
  return json.data || [];
}

async function runBusinessLookup() {
  const numbers = parseNumbers($("inputArea").value);
  if (!numbers.length) {
    showToast("조회할 사업자등록번호를 입력해 주세요.");
    return;
  }

  shouldStop = false;
  $("runBtn").disabled = true;
  $("stopBtn").hidden = false;
  $("progressWrap").hidden = false;
  $("resultSection").hidden = false;
  $("progressFill").style.width = "0%";

  allResults = numbers.map((number) => ({
    b_no: number,
    formatError: !validateBizNo(number),
    b_stt: null,
    b_stt_cd: null,
    tax_type: null,
    tax_type_cd: null,
    end_dt: null,
    apiError: false,
    pending: validateBizNo(number)
  }));
  renderBusinessTable();
  renderBusinessStats();

  const validRows = allResults.filter((row) => !row.formatError);
  let done = 0;
  for (const group of chunk(validRows, 100)) {
    if (shouldStop) break;
    try {
      const responseRows = await callBusinessProxy(group.map((row) => row.b_no));
      const byNumber = new Map(responseRows.map((row) => [row.b_no, row]));
      group.forEach((row) => {
        const data = byNumber.get(row.b_no);
        if (data) Object.assign(row, {
          b_stt: data.b_stt || null,
          b_stt_cd: data.b_stt_cd || null,
          tax_type: data.tax_type || null,
          tax_type_cd: data.tax_type_cd || null,
          end_dt: data.end_dt || null
        });
        row.pending = false;
      });
    } catch (error) {
      group.forEach((row) => { row.apiError = true; row.pending = false; });
      showToast(error.message);
    }
    done += group.length;
    const percent = validRows.length ? Math.round(done / validRows.length * 100) : 100;
    $("progressFill").style.width = `${percent}%`;
    $("progressText").textContent = `${done.toLocaleString("ko-KR")} / ${validRows.length.toLocaleString("ko-KR")}건 처리 (${percent}%)`;
    renderBusinessTable();
    renderBusinessStats();
    await new Promise((resolve) => setTimeout(resolve, 150));
  }

  $("runBtn").disabled = false;
  $("stopBtn").hidden = true;
  $("progressFill").style.width = "100%";
  $("progressText").textContent = shouldStop ? "사용자가 조회를 중단했습니다." : `완료: 총 ${numbers.length.toLocaleString("ko-KR")}건`;
  renderBusinessTable();
  renderBusinessStats();
  showToast(shouldStop ? "조회가 중단되었습니다." : "사업자 상태 조회가 완료되었습니다.");
}

function downloadBusinessCsv() {
  if (!allResults.length) return;
  const headers = ["순번", "사업자등록번호", "형식오류", "사업자상태", "상태코드", "과세유형", "과세유형코드", "폐업일"];
  const rows = allResults.map((row, index) => [
    index + 1,
    formatBizNo(row.b_no),
    row.formatError ? "형식오류" : "",
    row.b_stt || (row.apiError ? "API오류" : "미등록"),
    row.b_stt_cd || "",
    row.tax_type || "",
    row.tax_type_cd || "",
    row.end_dt?.replace(/(\d{4})(\d{2})(\d{2})/, "$1.$2.$3") || ""
  ]);
  const csv = `\uFEFF${[headers, ...rows].map((row) => row.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(",")).join("\n")}`;
  const link = document.createElement("a");
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  link.href = url;
  link.download = `사업자조회_${new Date().toISOString().slice(0, 10)}.csv`;
  link.click();
  URL.revokeObjectURL(url);
  showToast("CSV 파일을 내려받았습니다.");
}

$("inputArea").addEventListener("input", updateInputCount);
$("runBtn").addEventListener("click", runBusinessLookup);
$("stopBtn").addEventListener("click", () => { shouldStop = true; $("stopBtn").hidden = true; });
$("sampleBtn").addEventListener("click", () => {
  $("inputArea").value = "1234567890\n2208808965\n1068617609\n2148788166\n1138600998";
  updateInputCount();
});
$("clearBtn").addEventListener("click", () => { $("inputArea").value = ""; updateInputCount(); });
$("downloadBtn").addEventListener("click", downloadBusinessCsv);
$("businessFilterTabs").addEventListener("click", (event) => {
  const button = event.target.closest("[data-filter]");
  if (!button) return;
  currentBusinessFilter = button.dataset.filter;
  document.querySelectorAll("#businessFilterTabs .filter-chip").forEach((chip) => {
    const active = chip === button;
    chip.classList.toggle("is-active", active);
    chip.setAttribute("aria-pressed", String(active));
  });
  renderBusinessTable();
});

// Commercial district analysis
const DONGGU_CENTER = [35.1467, 126.9231];
let marketInitialized = false;
let allStores = [];
let visibleStores = [];
let marketMeta = null;
let marketMap;
let markerCluster;
let storeMarkers = [];
let mainBizZones = [];
let zoneLayer;
let selectedZoneNo = "";
const zoneLeafletByNo = new Map();

async function initializeMarket() {
  if (marketInitialized) {
    setTimeout(() => marketMap?.invalidateSize(), 0);
    return;
  }
  marketInitialized = true;
  try {
    const [response, zoneResponse, manualZoneResponse] = await Promise.all([
      fetch("data/stores_donggu.json"),
      fetch("data/mainbiz_zones_donggu.geojson").catch(() => null),
      fetch("data/manual_mainbiz_zones_donggu.geojson").catch(() => null)
    ]);
    if (!response.ok) throw new Error(`상가정보 파일을 불러오지 못했습니다. HTTP ${response.status}`);
    const payload = await response.json();
    let zonePayload = { features: [], meta: {} };
    if (zoneResponse?.ok) {
      try {
        zonePayload = await zoneResponse.json();
      } catch (error) {
        console.error("[mainbiz-zones] invalid JSON", error);
      }
    }
    let manualZonePayload = { features: [] };
    if (manualZoneResponse?.ok) {
      try {
        manualZonePayload = await manualZoneResponse.json();
      } catch (error) {
        console.error("[manual-mainbiz-zones] invalid JSON", error);
      }
    }
    allStores = Array.isArray(payload.stores) ? payload.stores : [];
    marketMeta = payload.meta || {};
    const visibleVworldPayload = { features: filterVworldZones(zonePayload.features) };
    mainBizZones = mergeZoneFeatures(visibleVworldPayload, manualZonePayload);
    if (!allStores.length) throw new Error("상가정보 파일에 표시할 업소가 없습니다.");
    initializeMap();
    populateMarketFilters();
    try {
      buildZoneLayer();
    } catch (error) {
      console.error("[mainbiz-zones] layer unavailable", error);
      mainBizZones = [];
      zoneLayer = null;
      populateMarketFilters();
    }
    buildStoreMarkers();
    applyMarketFilters();
    renderMarketMeta();
    $("marketState").hidden = true;
    $("marketWorkspace").hidden = false;
    setTimeout(() => marketMap.invalidateSize(), 0);
  } catch (error) {
    $("marketState").classList.add("is-error");
    $("marketState").textContent = `${error.message} 데이터 갱신 스크립트를 먼저 실행해 주세요.`;
  }
}

function renderMarketMeta() {
  const month = String(marketMeta.standardMonth || "").replace(/^(\d{4})(\d{2})$/, "$1.$2");
  const generated = marketMeta.generatedAt
    ? new Intl.DateTimeFormat("ko-KR", { dateStyle: "medium", timeZone: "Asia/Seoul" }).format(new Date(marketMeta.generatedAt))
    : "미확인";
  $("marketMeta").textContent = `${marketMeta.source || "상가정보 API"} · 기준월 ${month || "미확인"} · 갱신일 ${generated} · 사업자 상태와 별도 데이터`;
}

function initializeMap() {
  marketMap = L.map("marketMap", { zoomControl: true, preferCanvas: true }).setView(DONGGU_CENTER, 14);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
  }).addTo(marketMap);
  markerCluster = L.markerClusterGroup({
    chunkedLoading: true,
    chunkInterval: 100,
    chunkDelay: 30,
    maxClusterRadius: 46,
    showCoverageOnHover: false
  }).addTo(marketMap);
}

function selectedZone() {
  return mainBizZones.find((feature) => feature.properties.no === selectedZoneNo) || null;
}

function zoneStyle(feature) {
  const selected = feature.properties.no === selectedZoneNo;
  return {
    color: selected ? "#83b3ff" : "#f2ce68",
    weight: selected ? 3 : 2,
    opacity: selected ? 1 : .82,
    fillColor: selected ? "#5b98ff" : "#f2ce68",
    fillOpacity: selected ? .18 : .06
  };
}

function buildZoneLayer() {
  zoneLayer = L.geoJSON({ type: "FeatureCollection", features: mainBizZones }, {
    style: zoneStyle,
    onEachFeature(feature, layer) {
      const properties = feature.properties;
      zoneLeafletByNo.set(properties.no, layer);
      layer.bindTooltip(properties.name, { sticky: true, direction: "top" });
      layer.on({
        click(event) {
          L.DomEvent.stopPropagation(event.originalEvent);
          selectZone(properties.no, true);
        },
        mouseover() { if (properties.no !== selectedZoneNo) layer.setStyle({ weight: 3, fillOpacity: .12 }); },
        mouseout() { zoneLayer.resetStyle(layer); }
      });
    }
  }).addTo(marketMap);
}

function syncZoneTooltips() {
  zoneLeafletByNo.forEach((layer) => {
    if (selectedZoneNo) {
      layer.unbindTooltip();
    } else if (!layer.getTooltip()) {
      layer.bindTooltip(layer.feature.properties.name, { sticky: true, direction: "top" });
    }
  });
}

function createOption(value, label) {
  return new Option(label, value);
}

function replaceOptions(select, items, placeholder) {
  const current = select.value;
  select.replaceChildren(createOption("", placeholder), ...items.map((item) => createOption(item.value, item.label)));
  if (items.some((item) => item.value === current)) select.value = current;
}

function populateMarketFilters() {
  replaceOptions($("dongFilter"), [...new Set(allStores.map((store) => store.adminDong).filter(Boolean))]
    .sort((a, b) => a.localeCompare(b, "ko")).map((name) => ({ value: name, label: name })), "전체 행정동");
  replaceOptions($("zoneFilter"), mainBizZones.map((feature) => ({
    value: feature.properties.no,
    label: feature.properties.name
  })), "전체 지역");
  $("zoneFilter").disabled = !mainBizZones.length;
}

function currentMarketFilters() {
  const zone = selectedZone();
  return buildLocationFilter($("dongFilter").value, zone?.geometry || null);
}

function buildStoreMarkers() {
  const icon = L.divIcon({ className: "store-dot", iconSize: [12, 12] });
  storeMarkers = allStores.map((store) => {
    const marker = L.marker([store.latitude, store.longitude], { icon, title: store.name });
    marker.store = store;
    marker.bindPopup(`<div class="store-popup"><strong>${escapeHtml(store.name)}${store.branch ? ` ${escapeHtml(store.branch)}` : ""}</strong><span>${escapeHtml(store.smallName || store.largeName)}</span><span>${escapeHtml(store.address)}</span></div>`);
    marker.on({
      mouseover() { if (selectedZoneNo) marker.openPopup(); },
      mouseout() { if (selectedZoneNo) marker.closePopup(); }
    });
    return marker;
  });
}

function applyMarketFilters() {
  visibleStores = filterStores(allStores, currentMarketFilters());
  markerCluster.clearLayers();
  if ($("dongFilter").value || selectedZoneNo) {
    const visibleIds = new Set(visibleStores.map((store) => store.id));
    markerCluster.addLayers(storeMarkers.filter((marker) => visibleIds.has(marker.store.id)));
  }
  renderSelectionOverview();
}

function summaryRows(counts, total, limit = 6) {
  if (!counts.length) return '<p class="summary-empty">조건에 맞는 업소가 없습니다.</p>';
  const max = counts[0].count || 1;
  return counts.slice(0, limit).map(({ name, count }) => `<div class="summary-row">
    <div class="summary-label"><span>${escapeHtml(name)}</span><strong>${count.toLocaleString("ko-KR")}</strong></div>
    <div class="summary-track" title="전체의 ${total ? Math.round(count / total * 100) : 0}%"><span style="width:${Math.round(count / max * 100)}%"></span></div>
  </div>`).join("");
}

function renderSelectionOverview() {
  const zone = selectedZone();
  const adminDong = $("dongFilter").value;
  if (!zone && !adminDong) {
    $("selectionOverview").innerHTML = "<p>행정동 또는 주요상권을 선택하면 점포 수와 상위 업종 소분류를 확인할 수 있습니다.</p>";
    return;
  }
  const name = zone?.properties?.name || adminDong;
  const area = zone ? Number(zone.properties.areaSqm || 0) / 1e6 : null;
  $("selectionOverview").innerHTML = `<p class="selection-name">${escapeHtml(name)}</p>
    <dl>
      ${area === null ? "" : `<div><dt>경계 면적</dt><dd>${area.toFixed(3)}㎢</dd></div>`}
      <div><dt>점포 수</dt><dd>${visibleStores.length.toLocaleString("ko-KR")}개</dd></div>
    </dl>
    <p class="selection-category-title">상위 업종 소분류 10개</p>
    <div class="selection-categories">${summaryRows(countBy(visibleStores, "smallName"), visibleStores.length, 10)}</div>`;
}

function selectZone(number, fitBounds) {
  const selection = buildLocationSelection("zone", number);
  selectedZoneNo = selection.zoneNo;
  $("zoneFilter").value = selectedZoneNo;
  $("dongFilter").value = selection.adminDong;
  syncZoneTooltips();
  zoneLayer?.setStyle(zoneStyle);
  applyMarketFilters();
  const layer = zoneLeafletByNo.get(selectedZoneNo);
  if (fitBounds && layer) marketMap.fitBounds(layer.getBounds(), { padding: [32, 32], maxZoom: 16 });
}

$("dongFilter").addEventListener("change", (event) => {
  const selection = buildLocationSelection("dong", event.target.value);
  selectedZoneNo = selection.zoneNo;
  $("zoneFilter").value = selection.zoneNo;
  syncZoneTooltips();
  zoneLayer?.setStyle(zoneStyle);
  applyMarketFilters();
  if (event.target.value && visibleStores.length) {
    const bounds = L.latLngBounds(visibleStores.map((store) => [store.latitude, store.longitude]));
    marketMap.fitBounds(bounds, { padding: [32, 32], maxZoom: 15 });
  } else if (!event.target.value) {
    marketMap.setView(DONGGU_CENTER, 14);
  }
});
$("zoneFilter").addEventListener("change", (event) => selectZone(event.target.value, Boolean(event.target.value)));
$("resetMarketBtn").addEventListener("click", () => {
  $("dongFilter").value = "";
  selectZone("", false);
  marketMap?.setView(DONGGU_CENTER, 14);
});

// National Pension workplace lookup
// 이 서비스는 광주 동구만 다룬다. 조회·통계·스냅샷이 모두 같은 지역 코드를 쓴다.
const NPS_REGION = { label: "광주광역시 동구", sido: "29", sggu: "110" };

const NPS_PAGE_SIZE = 100;
// 중복을 걷어낸 건수를 보여주려면 이력을 다 받아야 한다. 지역 전체처럼 큰 조회는 여기서 멈춘다.
const NPS_MAX_COLLECT_PAGES = 30;
const NPS_DETAIL_CONCURRENCY = 4;
const NPS_HISTORY_MAX_POINTS = 24;

let npsRows = [];
let npsHistoryRowCount = 0;
let npsTruncated = false;
let npsPageNo = 1;
let npsFilter = "all";
let npsBusy = false;
let npsSnapshotIndex = null;

async function fetchNps(params) {
  const search = new URLSearchParams(Object.entries(params).filter(([, value]) => value !== "" && value != null));
  const response = await fetch(`/api/nps?${search}`);
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    if (error.detail) console.error("[nps]", error.error, error.detail);
    throw new Error(error.error || `HTTP ${response.status}`);
  }
  const payload = await response.json();
  // 0건일 때 어떤 파라미터 조합으로 물었는지 콘솔에 남긴다. 원인 확인용이다.
  if (payload.meta && !(payload.items || []).length) console.info("[nps] 조회 결과 없음", payload.meta);
  return payload;
}

function filteredNpsRows() {
  if (npsFilter === "registered") return npsRows.filter((row) => row.statusCode === "1");
  if (npsFilter === "withdrawn") return npsRows.filter((row) => row.statusCode === "2");
  return npsRows;
}

function npsPageRows() {
  const rows = filteredNpsRows();
  const offset = (npsPageNo - 1) * NPS_PAGE_SIZE;
  return rows.slice(offset, offset + NPS_PAGE_SIZE);
}

function npsStatusBadge(row) {
  if (row.statusCode === "1") return '<span class="badge badge-green">등록</span>';
  if (row.statusCode === "2") return '<span class="badge badge-gray">탈퇴</span>';
  return `<span class="badge badge-gray">${escapeHtml(row.statusName)}</span>`;
}

function renderNpsTable() {
  const rows = npsPageRows();
  if (!rows.length) {
    $("npsResultBody").innerHTML = '<tr class="empty-row"><td colspan="11">해당 조건의 결과가 없습니다.</td></tr>';
    return;
  }
  const offset = (npsPageNo - 1) * NPS_PAGE_SIZE;
  $("npsResultBody").innerHTML = rows.map((row, index) => `<tr>
    <td class="seq">${offset + index + 1}</td>
    <td>${escapeHtml(row.name)}</td>
    <td class="mono">${escapeHtml(row.bizNoPrefix ? `${row.bizNoPrefix}-****` : "-")}</td>
    <td>${escapeHtml(row.address || "-")}</td>
    <td>${escapeHtml(row.sectionName)}</td>
    <td>${escapeHtml(npsIndustryDetailLabel(row))}</td>
    <td>${escapeHtml(row.styleName)}</td>
    <td class="mono">${escapeHtml(row.registeredDate ? formatYmd(row.registeredDate) : "-")}</td>
    <td class="mono">${typeof row.subscriberCount === "number" ? `${row.subscriberCount.toLocaleString("ko-KR")}명` : "-"}</td>
    <td>${npsStatusBadge(row)}</td>
    <td><button class="button button-quiet detail-btn" type="button" data-seq="${escapeHtml(row.seq)}">상세</button></td>
  </tr>`).join("");
}

/** 상세분류 열에 쓸 업종명. 상세조회를 아직 못 받았으면 비워 둔다. */
function npsIndustryDetailLabel(row) {
  if (row.industryName) return row.industryCode ? `${row.industryName} (${row.industryCode})` : row.industryName;
  return row.detailLoaded ? "-" : "";
}

function renderNpsStats() {
  const rows = filteredNpsRows();
  const registered = rows.filter((row) => row.statusCode === "1").length;
  const withdrawn = rows.filter((row) => row.statusCode === "2").length;
  $("npsStatsRow").innerHTML = `
    <span class="stat-item">사업장<strong>${npsRows.length.toLocaleString("ko-KR")}</strong></span>
    <span class="stat-item">수집한 월별 이력<strong>${npsHistoryRowCount.toLocaleString("ko-KR")}</strong></span>
    <span class="stat-item">등록<strong>${registered.toLocaleString("ko-KR")}</strong></span>
    <span class="stat-item">탈퇴<strong>${withdrawn.toLocaleString("ko-KR")}</strong></span>
    ${npsTruncated ? '<span class="stat-item">수집 상한에 걸려 일부만 집계<strong>조건을 좁혀 주세요</strong></span>' : ""}`;
}

function renderNpsPager() {
  const lastPage = Math.max(1, Math.ceil(filteredNpsRows().length / NPS_PAGE_SIZE));
  $("npsPager").hidden = lastPage <= 1;
  $("npsPageLabel").textContent = `${npsPageNo} / ${lastPage}`;
  $("npsPrevBtn").disabled = npsPageNo <= 1 || npsBusy;
  $("npsNextBtn").disabled = npsPageNo >= lastPage || npsBusy;
}

function showNpsPage(pageNo) {
  const lastPage = Math.max(1, Math.ceil(filteredNpsRows().length / NPS_PAGE_SIZE));
  npsPageNo = Math.min(Math.max(pageNo, 1), lastPage);
  renderNpsTable();
  renderNpsPager();
  fillMissingIndustries();
}

/**
 * 중복을 제거한 건수를 보여주려면 이력을 다 받아야 한다. 100건씩 끝까지 모으되,
 * 지역 전체처럼 너무 큰 조회는 상한에서 멈추고 그 사실을 화면에 알린다.
 */
async function collectNpsRows(params) {
  const rows = [];
  let total = Infinity;
  for (let pageNo = 1; pageNo <= NPS_MAX_COLLECT_PAGES && rows.length < total; pageNo += 1) {
    const payload = await fetchNps({ ...params, pageNo, numOfRows: NPS_PAGE_SIZE });
    const items = payload.items || [];
    total = payload.totalCount || items.length;
    rows.push(...items);
    if (!items.length) break;
    const percent = total ? Math.min(100, Math.round(rows.length / total * 100)) : 100;
    $("npsProgressFill").style.width = `${percent}%`;
    $("npsProgressText").textContent = `${rows.length.toLocaleString("ko-KR")} / ${total.toLocaleString("ko-KR")}건 수집 (${percent}%)`;
  }
  return { rows, total: Number.isFinite(total) ? total : rows.length, truncated: rows.length < total };
}

/**
 * 목록 API에는 업종코드가 없다. 미리 받아둔 동구 스냅샷에서 먼저 찾고, 거기에도 없는
 * 사업장만 상세조회로 채운다. 지금 보고 있는 페이지의 사업장만 대상으로 한다.
 */
async function npsIndustryIndexFromSnapshot() {
  if (npsSnapshotIndex) return npsSnapshotIndex;
  npsSnapshotIndex = new Map();
  try {
    const response = await fetch("data/nps_donggu.json", { cache: "no-cache" });
    if (response.ok) {
      const snapshot = await response.json();
      for (const workplace of snapshot.items || []) {
        if (workplace.industryCode) npsSnapshotIndex.set(workplaceIdentity(workplace), workplace);
      }
    }
  } catch {
    // 스냅샷이 없으면 상세조회로만 채운다.
  }
  return npsSnapshotIndex;
}

// 대분류는 스냅샷에 적힌 값을 믿지 않고 업종코드에서 다시 판정한다. 분류 표를 고쳐도
// 지난달에 만들어 둔 스냅샷은 그대로이므로, 읽는 쪽에서 맞춰야 옛 판정이 남지 않는다.
// 등록일과 가입자 수도 목록 API에는 없어 여기서 함께 채운다.
function applyDetail(row, source) {
  const section = industrySection(source.industryCode);
  row.industryCode = source.industryCode;
  row.industryName = isPlaceholderIndustry(source.industryCode) ? "" : (source.industryName ?? row.industryName ?? "");
  row.sectionCode = section.code;
  row.sectionName = section.name;
  row.registeredDate = source.registeredDate ?? row.registeredDate ?? "";
  if (typeof source.subscriberCount === "number") row.subscriberCount = source.subscriberCount;
  row.detailLoaded = true;
}

async function fillMissingIndustries() {
  const rows = npsPageRows().filter((row) => !row.detailLoaded && row.seq);
  if (!rows.length) return;

  const index = await npsIndustryIndexFromSnapshot();
  const remaining = [];
  for (const row of rows) {
    const hit = index.get(workplaceIdentity(row));
    if (hit) applyDetail(row, hit);
    else remaining.push(row);
  }
  renderNpsTable();

  for (let offset = 0; offset < remaining.length; offset += NPS_DETAIL_CONCURRENCY) {
    if (npsBusy) return;
    const batch = remaining.slice(offset, offset + NPS_DETAIL_CONCURRENCY);
    await Promise.all(batch.map(async (row) => {
      try {
        const detail = (await fetchNps({ action: "detail", seq: row.seq })).items?.[0];
        if (detail) applyDetail(row, detail);
      } catch {
        // 한 건 실패는 업종 미상으로 남긴다.
      }
    }));
    renderNpsTable();
  }
}

async function runNpsLookup() {
  if (npsBusy) return;
  const name = $("npsNameInput").value.trim();
  const rawBizNo = $("npsBizNoInput").value.trim();
  const bizNo = toBizNoPrefix(rawBizNo);
  if (rawBizNo && bizNo.length < 6) {
    showToast("사업자등록번호는 앞 6자리 이상 입력해 주세요.");
    return;
  }

  npsBusy = true;
  $("npsRunBtn").disabled = true;
  $("npsProgressWrap").hidden = false;
  $("npsProgressFill").style.width = "10%";
  $("npsProgressText").textContent = "국민연금 사업장 내역을 조회하는 중입니다.";
  $("npsDetailCard").hidden = true;
  renderNpsPager();

  try {
    const { rows, truncated } = await collectNpsRows({
      action: "search", wkplNm: name, bzowrRgstNo: bizNo, sido: NPS_REGION.sido, sggu: NPS_REGION.sggu
    });
    // 같은 사업장이 자료생성년월마다 한 건씩 오므로 합쳐서 사업장 단위로 보여준다.
    npsRows = mergeWorkplaceHistory(rows);
    npsHistoryRowCount = rows.length;
    npsTruncated = truncated;
    npsPageNo = 1;
    $("npsResultSection").hidden = false;
    $("npsCountBadge").textContent = `${npsRows.length.toLocaleString("ko-KR")}개 사업장`;
    $("npsDownloadBtn").disabled = !npsRows.length;
    $("npsProgressFill").style.width = "100%";
    $("npsProgressText").textContent = truncated
      ? `월별 이력 ${npsHistoryRowCount.toLocaleString("ko-KR")}건까지만 수집했습니다. 조건을 좁혀 주세요.`
      : `월별 이력 ${npsHistoryRowCount.toLocaleString("ko-KR")}건을 사업장 ${npsRows.length.toLocaleString("ko-KR")}개로 정리했습니다.`;
    renderNpsTable();
    renderNpsStats();
    showToast(npsRows.length ? "국민연금 사업장 조회가 완료되었습니다." : "조건에 맞는 사업장이 없습니다.");
  } catch (error) {
    $("npsProgressFill").style.width = "0%";
    $("npsProgressText").textContent = error.message;
    showToast(error.message);
  } finally {
    npsBusy = false;
    $("npsRunBtn").disabled = false;
    renderNpsPager();
  }
  fillMissingIndustries();
}

async function showNpsDetail(seq) {
  const card = $("npsDetailCard");
  const listRow = npsRows.find((row) => row.seq === seq);
  card.hidden = false;
  card.innerHTML = "<p>사업장 상세 정보를 불러오는 중입니다.</p>";
  try {
    const payload = await fetchNps({ action: "detail", seq });
    const detail = payload.items?.[0];
    if (!detail) throw new Error("사업장 상세 정보를 찾을 수 없습니다.");
    const industryCode = isPlaceholderIndustry(detail.industryCode) ? "" : detail.industryCode;
    const industry = [detail.industryName, industryCode && `(${industryCode})`].filter(Boolean).join(" ") || detail.sectionName;
    const row = (label, value) => (value == null ? "" : `<div><dt>${label}</dt><dd>${value}</dd></div>`);
    const people = (value) => (value == null ? null : `${value.toLocaleString("ko-KR")}명`);
    card.innerHTML = `<p class="selection-name">${escapeHtml(detail.name)}</p>
      <dl>
        ${row("사업자등록번호", escapeHtml(detail.bizNoPrefix ? `${detail.bizNoPrefix}-****` : "-"))}
        ${row("소재지", escapeHtml(detail.address || "-"))}
        ${row("업종", escapeHtml(industry))}
        ${row("사업장 형태", escapeHtml(detail.styleName))}
        ${row("가입 상태", escapeHtml(detail.statusName))}
        ${row("사업장 등록일", escapeHtml(formatYmd(detail.registeredDate)))}
        ${row("사업장 탈퇴일", detail.withdrawnDate ? escapeHtml(formatYmd(detail.withdrawnDate)) : null)}
        ${row("가입자 수", people(detail.subscriberCount))}
        ${row("월별 신규 취득자", people(detail.newSubscriberCount))}
        ${row("월별 상실 가입자", people(detail.lostSubscriberCount))}
        ${row("당월 고지금액", `${detail.monthlyNoticeAmount.toLocaleString("ko-KR")}원`)}
      </dl>
      <div id="npsHistoryCharts"></div>`;
    renderNpsHistory(listRow);
  } catch (error) {
    card.innerHTML = `<p class="summary-empty">${escapeHtml(error.message)}</p>`;
  }
  // 카드가 결과 표 아래에 있어 목록이 길면 화면 밖에 그려진다. 눌렀을 때 보이도록 옮겨준다.
  card.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

/** 접어 둔 월별 이력을 불러 상세 카드 아래에 추이 그래프로 그린다. */
async function renderNpsHistory(listRow) {
  const target = $("npsHistoryCharts");
  const historyRows = (listRow?.historyRows ?? []).filter((row) => row.seq && row.month);
  if (!target || historyRows.length < 2) return;

  target.innerHTML = '<p class="summary-empty">월별 추이를 불러오는 중입니다.</p>';
  try {
    const seqs = historyRows.slice(0, NPS_HISTORY_MAX_POINTS).map((row) => `${row.seq}:${row.month}`).join(",");
    const { series } = await fetchNps({ action: "history", seqs });
    const points = (series || []).filter((point) => point.month).sort((a, b) => a.month.localeCompare(b.month));
    if (points.length < 2) {
      target.innerHTML = "";
      return;
    }
    target.innerHTML = `<h3 class="chart-heading">월별 추이 <span class="chart-note">${points.length}개월</span></h3>
      <div class="chart-grid">
        ${trendChart("가입자 수", points, [{ key: "subscriberCount", label: "가입자 수", color: "#3987e5" }], "line", (value) => `${value.toLocaleString("ko-KR")}명`)}
        ${trendChart("당월 고지금액", points, [{ key: "monthlyNoticeAmount", label: "당월 고지금액", color: "#3987e5" }], "line", (value) => `${Math.round(value / 10000).toLocaleString("ko-KR")}만원`)}
        ${trendChart("월별 취득·상실 가입자", points, [
          { key: "newSubscriberCount", label: "신규 취득", color: "#199e70" },
          { key: "lostSubscriberCount", label: "상실", color: "#d95926" }
        ], "bar", (value) => `${value.toLocaleString("ko-KR")}명`)}
      </div>`;
  } catch (error) {
    target.innerHTML = `<p class="summary-empty">월별 추이를 불러오지 못했습니다. ${escapeHtml(error.message)}</p>`;
  }
}

/** yyyymm을 안내창에 쓸 "yyyy년 m월"로 편다. */
function monthLabel(month) {
  const digits = String(month ?? "").replace(/[^0-9]/g, "");
  if (digits.length !== 6) return shortMonth(month);
  return `${digits.slice(0, 4)}년 ${Number(digits.slice(4))}월`;
}

/** yyyymm을 그래프 축에 쓸 yy.mm으로 줄인다. */
function shortMonth(month) {
  return String(month ?? "").replace(/^\d{2}(\d{2})(\d{2})$/, "$1.$2");
}

const CHART_WIDTH = 320;
const CHART_HEIGHT = 136;
const CHART_PAD_X = 30;
const CHART_PAD_TOP = 22;
const CHART_BASELINE = CHART_HEIGHT - 26;

/**
 * 월별 추이 그래프. 지표마다 단위가 달라 축을 겹치지 않고 그래프를 따로 그린다.
 * 값과 월 라벨은 서로 겹치지 않을 만큼만 남기고, 마지막 달은 항상 남긴다.
 */
function trendChart(title, points, series, shape, format) {
  const active = series.filter(({ key }) => points.some((point) => typeof point[key] === "number"));
  if (!active.length) {
    return `<figure class="chart"><figcaption><span>${escapeHtml(title)}</span></figcaption>
      <p class="summary-empty">제공되지 않는 항목입니다.</p></figure>`;
  }

  const values = active.flatMap(({ key }) => points.map((point) => point[key]).filter((value) => typeof value === "number"));
  const max = Math.max(...values);
  // 막대는 0에서 시작해야 길이가 값이 된다. 선그래프는 변화를 보려는 것이라 실제 범위에 맞춘다.
  const low = shape === "bar" ? 0 : Math.min(...values);
  const high = max > low ? max : low + 1;
  const step = points.length > 1 ? (CHART_WIDTH - CHART_PAD_X * 2) / (points.length - 1) : 0;
  const x = (index) => CHART_PAD_X + index * step;
  const y = (value) => CHART_BASELINE - ((value - low) / (high - low)) * (CHART_BASELINE - CHART_PAD_TOP);

  const labelStep = Math.max(1, Math.ceil(30 * active.length / Math.max(step, 1)));
  const tickStep = Math.max(1, Math.ceil(30 / Math.max(step, 1)));
  const keepFromEnd = (index, every) => (points.length - 1 - index) % every === 0;

  let marks = "";
  if (shape === "line") {
    marks = active.map(({ key, color }) => {
      const drawn = points.map((point, index) => ({ value: point[key], index })).filter((point) => typeof point.value === "number");
      const path = drawn.map((point, order) => `${order ? "L" : "M"}${x(point.index).toFixed(1)} ${y(point.value).toFixed(1)}`).join(" ");
      const dots = drawn.map((point) => `<circle cx="${x(point.index).toFixed(1)}" cy="${y(point.value).toFixed(1)}" r="3.5" fill="${color}" stroke="var(--surface)" stroke-width="2"></circle>`).join("");
      const labels = drawn.filter((point) => keepFromEnd(point.index, labelStep))
        .map((point) => `<text x="${x(point.index).toFixed(1)}" y="${(y(point.value) - 8).toFixed(1)}" text-anchor="middle" class="chart-value">${escapeHtml(format(point.value))}</text>`).join("");
      return `<path d="${path}" fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"></path>${dots}${labels}`;
    }).join("");
  } else {
    const slot = Math.max(4, Math.min(12, (step || CHART_WIDTH / 3) / active.length - 2));
    marks = points.map((point, index) => active.map(({ key, color }, order) => {
      const value = point[key];
      if (typeof value !== "number") return "";
      // 같은 달의 막대는 계열 수만큼 나란히 놓고 사이에 틈을 둔다.
      const left = x(index) - (slot * active.length + 2 * (active.length - 1)) / 2 + order * (slot + 2);
      const top = y(value);
      // 두 계열의 막대가 붙어 있어 값 라벨은 막대 색을 그대로 입혀 어느 쪽 값인지 알 수 있게 한다.
      const label = keepFromEnd(index, labelStep)
        ? `<text x="${(left + slot / 2).toFixed(1)}" y="${(top - 5).toFixed(1)}" text-anchor="middle" class="chart-value" style="fill:${color}">${escapeHtml(format(value))}</text>`
        : "";
      return `<rect x="${left.toFixed(1)}" y="${top.toFixed(1)}" width="${slot.toFixed(1)}" height="${Math.max(1, CHART_BASELINE - top).toFixed(1)}" rx="2" fill="${color}"></rect>${label}`;
    }).join("")).join("");
  }

  // 막대·꼭짓점 위에 뜨는 안내창의 내용. 막대는 좁아서 열 전체를 덮는 투명한 판으로 받는다.
  const hits = points.map((point, index) => {
    const tip = {
      month: monthLabel(point.month),
      rows: active.map(({ key, label, color }) => ({
        label,
        color,
        value: typeof point[key] === "number" ? format(point[key]) : "자료 없음"
      }))
    };
    return `<rect x="${(x(index) - Math.max(step, 8) / 2).toFixed(1)}" y="0" width="${Math.max(step, 8).toFixed(1)}" height="${CHART_BASELINE}" fill="transparent" class="chart-hit" data-tip="${escapeHtml(JSON.stringify(tip))}"></rect>`;
  }).join("");

  const ticks = points.map((point, index) => (keepFromEnd(index, tickStep)
    ? `<text x="${x(index).toFixed(1)}" y="${CHART_HEIGHT - 8}" text-anchor="middle" class="chart-axis">${escapeHtml(shortMonth(point.month))}</text>`
    : "")).join("");

  const legend = active.length > 1
    ? `<span class="chart-legend">${active.map(({ label, color }) => `<span><i style="background:${color}"></i>${escapeHtml(label)}</span>`).join("")}</span>`
    : "";

  return `<figure class="chart">
    <figcaption><span>${escapeHtml(title)}</span>${legend}</figcaption>
    <svg viewBox="0 0 ${CHART_WIDTH} ${CHART_HEIGHT}" role="img" aria-label="${escapeHtml(title)} 월별 추이">
      <line x1="${CHART_PAD_X - 6}" y1="${CHART_BASELINE}" x2="${CHART_WIDTH - CHART_PAD_X + 6}" y2="${CHART_BASELINE}" stroke="var(--line)" stroke-width="1"></line>
      ${marks}
      ${hits}
      ${ticks}
    </svg>
  </figure>`;
}

/**
 * 그래프 위에 뜨는 미니 안내창. 상세 카드가 다시 그려져도 살아 있도록 문서에 한 번만 걸고,
 * 커서를 따라다니되 화면 밖으로 밀려나지 않게 가장자리에서 붙잡는다.
 */
let chartTipEl = null;
function chartTipNode() {
  if (!chartTipEl) {
    chartTipEl = document.createElement("div");
    chartTipEl.className = "chart-tip";
    chartTipEl.hidden = true;
    document.body.appendChild(chartTipEl);
  }
  return chartTipEl;
}

function hideChartTip() {
  if (chartTipEl) chartTipEl.hidden = true;
}

function showChartTip(hit, clientX, clientY) {
  let tip;
  try {
    tip = JSON.parse(hit.dataset.tip);
  } catch {
    return;
  }
  const node = chartTipNode();
  node.innerHTML = `<strong>${escapeHtml(tip.month)}</strong>${tip.rows.map(({ label, color, value }) =>
    `<span><i style="background:${escapeHtml(color)}"></i>${escapeHtml(label)}<b>${escapeHtml(value)}</b></span>`).join("")}`;
  node.hidden = false;
  const box = node.getBoundingClientRect();
  const left = Math.min(Math.max(8, clientX - box.width / 2), window.innerWidth - box.width - 8);
  const top = clientY - box.height - 12;
  node.style.left = `${left}px`;
  node.style.top = `${(top < 8 ? clientY + 16 : top)}px`;
}

document.addEventListener("mousemove", (event) => {
  const hit = event.target.closest?.(".chart-hit");
  if (hit) showChartTip(hit, event.clientX, event.clientY);
  else hideChartTip();
});
document.addEventListener("scroll", hideChartTip, true);

/** yyyymmdd 또는 yyyy-mm-dd 문자열을 yyyy.mm.dd로 보여준다. 값이 없으면 하이픈. */
function formatYmd(value) {
  const digits = String(value ?? "").replace(/[^0-9]/g, "");
  if (digits.length !== 8) return value || "-";
  return `${digits.slice(0, 4)}.${digits.slice(4, 6)}.${digits.slice(6)}`;
}

function downloadCsv(headers, rows, fileName) {
  const csv = `﻿${[headers, ...rows].map((row) => row.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(",")).join("\n")}`;
  const link = document.createElement("a");
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  link.href = url;
  link.download = fileName;
  link.click();
  URL.revokeObjectURL(url);
  showToast("CSV 파일을 내려받았습니다.");
}

$("npsRunBtn").addEventListener("click", () => runNpsLookup());
$("npsClearBtn").addEventListener("click", () => {
  $("npsNameInput").value = "";
  $("npsBizNoInput").value = "";
  npsRows = [];
  npsHistoryRowCount = 0;
  npsTruncated = false;
  npsPageNo = 1;
  $("npsResultSection").hidden = true;
  $("npsProgressWrap").hidden = true;
  $("npsCountBadge").textContent = "0개 사업장";
  $("npsDownloadBtn").disabled = true;
});
$("npsPrevBtn").addEventListener("click", () => showNpsPage(npsPageNo - 1));
$("npsNextBtn").addEventListener("click", () => showNpsPage(npsPageNo + 1));
[$("npsNameInput"), $("npsBizNoInput")].forEach((input) => {
  input.addEventListener("keydown", (event) => { if (event.key === "Enter") runNpsLookup(); });
});
$("npsFilterTabs").addEventListener("click", (event) => {
  const button = event.target.closest("[data-filter]");
  if (!button) return;
  npsFilter = button.dataset.filter;
  document.querySelectorAll("#npsFilterTabs .filter-chip").forEach((chip) => {
    const active = chip === button;
    chip.classList.toggle("is-active", active);
    chip.setAttribute("aria-pressed", String(active));
  });
  npsPageNo = 1;
  renderNpsTable();
  renderNpsStats();
  renderNpsPager();
});
$("npsResultBody").addEventListener("click", (event) => {
  const button = event.target.closest(".detail-btn");
  if (button) showNpsDetail(button.dataset.seq);
});
$("npsDownloadBtn").addEventListener("click", () => {
  if (!npsRows.length) return;
  downloadCsv(
    ["순번", "사업장명", "사업자등록번호(앞6자리)", "소재지(도로명)", "업종코드", "업종대분류", "사업장형태", "가입상태", "자료기준월", "이력개월수"],
    filteredNpsRows().map((row, index) => [
      index + 1,
      row.name, row.bizNoPrefix, row.address, isPlaceholderIndustry(row.industryCode) ? "" : row.industryCode,
      row.sectionName, row.styleName, row.statusName, row.dataCreatedMonth,
      row.historyCount || 1
    ]),
    `국민연금사업장_${new Date().toISOString().slice(0, 10)}.csv`
  );
});

// 개인사업자 통계 (금융위원회 개인사업자기본정보)
//
// 자료는 연 1회 갱신이라 실시간 수집을 두지 않고 배치로 받아둔 스냅샷만 읽는다.
// 인증키가 브라우저로 나가지 않도록 프록시도 두지 않는다.
let sbSnapshot = null;
let sbLoaded = false;

const SB_INDICATORS = [
  ["여성 대표", "female"],
  ["40대 미만 대표", "under40"],
  ["60대 이상 대표", "over60"],
  ["종업원 0명", "solo"],
  ["업력 10년 이상", "veteran"]
];

function summaryBars(counts, limit) {
  if (!counts?.length) return '<p class="summary-empty">집계할 자료가 없습니다.</p>';
  const total = counts.reduce((sum, item) => sum + item.count, 0);
  // 연령대·업력은 건수 순서가 아니라 구간 순서로 정렬되므로 첫 항목을 최대값으로 볼 수 없다.
  const max = Math.max(...counts.map((item) => item.count)) || 1;
  return counts.slice(0, limit).map(({ name, count }) => `<div class="summary-row">
    <div class="summary-label"><span>${escapeHtml(name)}</span><strong>${count.toLocaleString("ko-KR")}명</strong></div>
    <div class="summary-track" title="전체의 ${total ? Math.round(count / total * 100) : 0}%"><span style="width:${Math.round(count / max * 100)}%"></span></div>
  </div>`).join("");
}

function fillSelect(select, options) {
  select.innerHTML = options
    .map(({ value, label }) => `<option value="${escapeHtml(value)}">${escapeHtml(label)}</option>`)
    .join("");
}

function sbSummaryOf(regionId, month) {
  return sbSnapshot?.regions?.[regionId]?.byMonth?.[month] || null;
}

function showStatsMessage(message, isError) {
  $("statsWorkspace").hidden = true;
  $("statsState").hidden = false;
  $("statsState").classList.toggle("is-error", Boolean(isError));
  $("statsState").textContent = message;
  $("statsDownloadBtn").disabled = true;
}

/** 두 지역을 같은 기준년월로 나란히 놓는다. 동구만으로는 높고 낮음을 판단할 기준이 없다. */
function renderSbCompare(month) {
  const columns = SB_REGIONS
    .filter((region) => sbSnapshot?.regions?.[region.id])
    .map((region) => ({ label: sbSnapshot.regions[region.id].label || region.label, summary: sbSummaryOf(region.id, month) }));
  const cell = (item) => `<td class="mono">${item ? `${item.count.toLocaleString("ko-KR")}명 (${formatRatio(item.ratio)})` : "-"}</td>`;
  const rows = SB_INDICATORS
    .map(([label, key]) => `<tr><th scope="row">${label}</th>${columns.map(({ summary }) => cell(summary?.indicators?.[key])).join("")}</tr>`)
    .join("");
  $("statsCompare").innerHTML = `<table>
    <thead><tr><th scope="col">지표</th>${columns.map(({ label }) => `<th scope="col">${escapeHtml(label)}</th>`).join("")}</tr></thead>
    <tbody>
      <tr><th scope="row">개인사업자 수</th>${columns.map(({ summary }) => `<td class="mono">${summary ? `${summary.total.toLocaleString("ko-KR")}명` : "-"}</td>`).join("")}</tr>
      ${rows}
    </tbody>
  </table>`;
}

function renderSbStats() {
  const month = $("statsMonth").value;
  const regionId = $("statsRegion").value;
  const region = sbSnapshot?.regions?.[regionId];
  const summary = sbSummaryOf(regionId, month);
  if (!summary?.total) {
    showStatsMessage(`${region?.label || "선택한 지역"}의 ${formatMonth(month)} 자료가 없습니다.`, false);
    return;
  }

  const collected = sbSnapshot?.meta?.collectedAt
    ? `${new Date(sbSnapshot.meta.collectedAt).toLocaleDateString("ko-KR")} 수집 자료`
    : "";
  $("statsMeta").textContent = [
    "금융위원회 개인사업자기본정보",
    region.label,
    `기준년월 ${formatMonth(month)}`,
    `개인사업자 ${summary.total.toLocaleString("ko-KR")}명`,
    collected
  ].filter(Boolean).join(" · ");

  const tile = (label, item) => [label, `${item.count.toLocaleString("ko-KR")}명 (${formatRatio(item.ratio)})`];
  $("statTiles").innerHTML = [
    ["개인사업자", `${summary.total.toLocaleString("ko-KR")}명`],
    ...SB_INDICATORS.map(([label, key]) => tile(label, summary.indicators[key]))
  ].map(([label, value]) => `<div class="stat-tile"><dt>${label}</dt><dd>${escapeHtml(value)}</dd></div>`).join("");

  $("statsAges").innerHTML = summaryBars(summary.ages, 12);
  $("statsTenures").innerHTML = summaryBars(summary.tenures, 8);
  $("statsIndustries").innerHTML = summaryBars(summary.industries, 12);
  $("statsEmployees").innerHTML = summaryBars(summary.employees, 8);
  $("statsSexes").innerHTML = summaryBars(summary.sexes, 4);
  renderSbCompare(month);

  $("statsState").hidden = true;
  $("statsState").classList.remove("is-error");
  $("statsWorkspace").hidden = false;
  $("statsDownloadBtn").disabled = false;
}

async function initializeStats() {
  if (sbLoaded) return;
  try {
    const response = await fetch("data/sbprofile_gwangju.json", { cache: "no-cache" });
    if (!response.ok) throw new Error("개인사업자 자료 파일을 찾지 못했습니다.");
    sbSnapshot = await response.json();
    const months = sbSnapshot?.meta?.months || [];
    const regions = SB_REGIONS.filter((region) => sbSnapshot?.regions?.[region.id]);
    if (!months.length || !regions.length) throw new Error("개인사업자 자료가 비어 있습니다.");
    fillSelect($("statsRegion"), regions.map((region) => ({
      value: region.id, label: sbSnapshot.regions[region.id].label || region.label
    })));
    fillSelect($("statsMonth"), months.map((month) => ({ value: month, label: formatMonth(month) })));
    sbLoaded = true;
    renderSbStats();
  } catch (error) {
    // 다음에 탭을 다시 열면 재시도한다.
    showStatsMessage(`${error.message} npm run update-sbprofile로 자료를 먼저 만들어야 합니다.`, true);
  }
}

$("statsRegion").addEventListener("change", renderSbStats);
$("statsMonth").addEventListener("change", renderSbStats);
$("statsDownloadBtn").addEventListener("click", () => {
  const month = $("statsMonth").value;
  const region = sbSnapshot?.regions?.[$("statsRegion").value];
  const summary = sbSummaryOf($("statsRegion").value, month);
  if (!summary) return;
  const group = (title, counts) => counts.map((item) => [
    region.label, formatMonth(month), title, item.name, item.count,
    formatRatio(summary.total ? item.count / summary.total : 0)
  ]);
  downloadCsv(
    ["지역", "기준년월", "구분", "항목", "사업자 수", "비중"],
    [
      ...group("대표자 연령대", summary.ages),
      ...group("대표자 성별", summary.sexes),
      ...group("업력", summary.tenures),
      ...group("업종 중분류", summary.industries),
      ...group("종업원 규모", summary.employees)
    ],
    `개인사업자통계_${new Date().toISOString().slice(0, 10)}.csv`
  );
});

updateInputCount();
