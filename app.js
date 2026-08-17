import {
  buildLocationFilter,
  buildLocationSelection,
  countBy,
  filterStores
} from "./lib/market.js";
import { filterVworldZones, mergeZoneFeatures } from "./lib/zone-update.js";
import { summarizeWorkplaces, toBizNoPrefix } from "./lib/nps.js";

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
const NPS_REGIONS = {
  donggu: { label: "광주광역시 동구", sido: "29", sggu: "110" },
  gwangju: { label: "광주광역시", sido: "29" },
  "": { label: "전국" }
};
const NPS_PAGE_SIZE = 100;
const STATS_PAGE_SIZE = 1000;
const STATS_MAX_PAGES = 40;

let npsResults = [];
let npsTotalCount = 0;
let npsPageNo = 1;
let npsFilter = "all";
let npsBusy = false;

function regionParams(key) {
  const region = NPS_REGIONS[key] || NPS_REGIONS[""];
  const params = {};
  if (region.sido) params.sido = region.sido;
  if (region.sggu) params.sggu = region.sggu;
  return params;
}

async function fetchNps(params) {
  const search = new URLSearchParams(Object.entries(params).filter(([, value]) => value !== "" && value != null));
  const response = await fetch(`/api/nps?${search}`);
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    if (error.detail) console.error("[nps]", error.error, error.detail);
    throw new Error(error.error || `HTTP ${response.status}`);
  }
  return response.json();
}

function filteredNpsResults() {
  if (npsFilter === "registered") return npsResults.filter((row) => row.statusCode === "1");
  if (npsFilter === "withdrawn") return npsResults.filter((row) => row.statusCode === "2");
  return npsResults;
}

function npsStatusBadge(row) {
  if (row.statusCode === "1") return '<span class="badge badge-green">등록</span>';
  if (row.statusCode === "2") return '<span class="badge badge-gray">탈퇴</span>';
  return `<span class="badge badge-gray">${escapeHtml(row.statusName)}</span>`;
}

function renderNpsTable() {
  const rows = filteredNpsResults();
  if (!rows.length) {
    $("npsResultBody").innerHTML = '<tr class="empty-row"><td colspan="8">해당 조건의 결과가 없습니다.</td></tr>';
    return;
  }
  const offset = (npsPageNo - 1) * NPS_PAGE_SIZE;
  $("npsResultBody").innerHTML = rows.map((row, index) => `<tr>
    <td class="seq">${offset + index + 1}</td>
    <td>${escapeHtml(row.name)}</td>
    <td class="mono">${escapeHtml(row.bizNoPrefix ? `${row.bizNoPrefix}-****` : "-")}</td>
    <td>${escapeHtml(row.address || "-")}</td>
    <td>${escapeHtml(row.sectionName)}</td>
    <td>${escapeHtml(row.styleName)}</td>
    <td>${npsStatusBadge(row)}</td>
    <td><button class="button button-quiet detail-btn" type="button" data-seq="${escapeHtml(row.seq)}" data-month="${escapeHtml(row.dataCreatedMonth)}">상세</button></td>
  </tr>`).join("");
}

function renderNpsStats() {
  const registered = npsResults.filter((row) => row.statusCode === "1").length;
  const withdrawn = npsResults.filter((row) => row.statusCode === "2").length;
  $("npsStatsRow").innerHTML = `
    <span class="stat-item">전체 검색<strong>${npsTotalCount.toLocaleString("ko-KR")}</strong></span>
    <span class="stat-item">현재 페이지<strong>${npsResults.length}</strong></span>
    <span class="stat-item">등록<strong>${registered}</strong></span>
    <span class="stat-item">탈퇴<strong>${withdrawn}</strong></span>`;
}

function renderNpsPager() {
  const lastPage = Math.max(1, Math.ceil(npsTotalCount / NPS_PAGE_SIZE));
  $("npsPager").hidden = lastPage <= 1;
  $("npsPageLabel").textContent = `${npsPageNo} / ${lastPage}`;
  $("npsPrevBtn").disabled = npsPageNo <= 1 || npsBusy;
  $("npsNextBtn").disabled = npsPageNo >= lastPage || npsBusy;
}

async function runNpsLookup(pageNo = 1) {
  if (npsBusy || pageNo < 1) return;
  const name = $("npsNameInput").value.trim();
  const rawBizNo = $("npsBizNoInput").value.trim();
  const bizNo = toBizNoPrefix(rawBizNo);
  const regionKey = $("npsRegionSelect").value;
  if (!name && !bizNo && !NPS_REGIONS[regionKey]?.sido) {
    showToast("전국 조회는 사업장명 또는 사업자등록번호가 필요합니다.");
    return;
  }
  if (rawBizNo && bizNo.length < 6) {
    showToast("사업자등록번호는 앞 6자리 이상 입력해 주세요.");
    return;
  }

  npsBusy = true;
  $("npsRunBtn").disabled = true;
  $("npsProgressWrap").hidden = false;
  $("npsProgressFill").style.width = "35%";
  $("npsProgressText").textContent = "국민연금 사업장 내역을 조회하는 중입니다.";
  $("npsDetailCard").hidden = true;
  renderNpsPager();

  try {
    const payload = await fetchNps({
      action: "search", wkplNm: name, bzowrRgstNo: bizNo, ...regionParams(regionKey),
      pageNo, numOfRows: NPS_PAGE_SIZE
    });
    npsResults = payload.items || [];
    npsTotalCount = payload.totalCount || npsResults.length;
    npsPageNo = pageNo;
    $("npsResultSection").hidden = false;
    $("npsCountBadge").textContent = `${npsTotalCount.toLocaleString("ko-KR")}건 조회`;
    $("npsDownloadBtn").disabled = !npsResults.length;
    $("npsProgressFill").style.width = "100%";
    $("npsProgressText").textContent = `${npsTotalCount.toLocaleString("ko-KR")}건 중 ${npsResults.length.toLocaleString("ko-KR")}건 표시`;
    renderNpsTable();
    renderNpsStats();
    showToast(npsTotalCount ? "국민연금 사업장 조회가 완료되었습니다." : "조건에 맞는 사업장이 없습니다.");
  } catch (error) {
    $("npsProgressFill").style.width = "0%";
    $("npsProgressText").textContent = error.message;
    showToast(error.message);
  } finally {
    npsBusy = false;
    $("npsRunBtn").disabled = false;
    renderNpsPager();
  }
}

async function showNpsDetail(seq, dataCrtYm) {
  const card = $("npsDetailCard");
  card.hidden = false;
  card.innerHTML = "<p>사업장 상세 정보를 불러오는 중입니다.</p>";
  try {
    const payload = await fetchNps({ action: "detail", seq, dataCrtYm });
    const detail = payload.items?.[0];
    if (!detail) throw new Error("사업장 상세 정보를 찾을 수 없습니다.");
    const month = detail.dataCreatedMonth?.replace(/^(\d{4})(\d{2})$/, "$1.$2") || "미확인";
    card.innerHTML = `<p class="selection-name">${escapeHtml(detail.name)}</p>
      <dl>
        <div><dt>자료 기준월</dt><dd>${escapeHtml(month)}</dd></div>
        <div><dt>사업자등록번호</dt><dd>${escapeHtml(detail.bizNoPrefix ? `${detail.bizNoPrefix}-****` : "-")}</dd></div>
        <div><dt>소재지</dt><dd>${escapeHtml(detail.address || "-")}</dd></div>
        <div><dt>업종</dt><dd>${escapeHtml(detail.sectionName)} (${escapeHtml(detail.industryCode || "-")})</dd></div>
        <div><dt>사업장 형태</dt><dd>${escapeHtml(detail.styleName)}</dd></div>
        <div><dt>가입 상태</dt><dd>${escapeHtml(detail.statusName)}</dd></div>
        <div><dt>가입자 수</dt><dd>${detail.subscriberCount.toLocaleString("ko-KR")}명</dd></div>
        <div><dt>당월 신규 취득자</dt><dd>${detail.newSubscriberCount.toLocaleString("ko-KR")}명</dd></div>
        <div><dt>당월 상실 가입자</dt><dd>${detail.lostSubscriberCount.toLocaleString("ko-KR")}명</dd></div>
        <div><dt>당월 고지금액</dt><dd>${detail.monthlyNoticeAmount.toLocaleString("ko-KR")}원</dd></div>
      </dl>`;
  } catch (error) {
    card.innerHTML = `<p class="summary-empty">${escapeHtml(error.message)}</p>`;
  }
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

$("npsRunBtn").addEventListener("click", () => runNpsLookup(1));
$("npsClearBtn").addEventListener("click", () => {
  $("npsNameInput").value = "";
  $("npsBizNoInput").value = "";
  npsResults = [];
  npsTotalCount = 0;
  npsPageNo = 1;
  $("npsResultSection").hidden = true;
  $("npsProgressWrap").hidden = true;
  $("npsCountBadge").textContent = "0건 조회";
  $("npsDownloadBtn").disabled = true;
});
$("npsPrevBtn").addEventListener("click", () => runNpsLookup(npsPageNo - 1));
$("npsNextBtn").addEventListener("click", () => runNpsLookup(npsPageNo + 1));
[$("npsNameInput"), $("npsBizNoInput")].forEach((input) => {
  input.addEventListener("keydown", (event) => { if (event.key === "Enter") runNpsLookup(1); });
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
  renderNpsTable();
});
$("npsResultBody").addEventListener("click", (event) => {
  const button = event.target.closest(".detail-btn");
  if (button) showNpsDetail(button.dataset.seq, button.dataset.month);
});
$("npsDownloadBtn").addEventListener("click", () => {
  if (!npsResults.length) return;
  downloadCsv(
    ["순번", "사업장명", "사업자등록번호(앞6자리)", "소재지(도로명)", "업종코드", "업종대분류", "사업장형태", "가입상태", "자료기준월"],
    npsResults.map((row, index) => [
      (npsPageNo - 1) * NPS_PAGE_SIZE + index + 1,
      row.name, row.bizNoPrefix, row.address, row.industryCode, row.sectionName, row.styleName, row.statusName, row.dataCreatedMonth
    ]),
    `국민연금사업장_${new Date().toISOString().slice(0, 10)}.csv`
  );
});

// National Pension workplace statistics
let statsWorkplaces = [];
let statsSummary = null;
let statsBusy = false;

function statsBars(counts, limit) {
  if (!counts.length) return '<p class="summary-empty">집계할 자료가 없습니다.</p>';
  const total = counts.reduce((sum, item) => sum + item.count, 0);
  const max = counts[0].count || 1;
  return counts.slice(0, limit).map(({ name, count }) => `<div class="summary-row">
    <div class="summary-label"><span>${escapeHtml(name)}</span><strong>${count.toLocaleString("ko-KR")}</strong></div>
    <div class="summary-track" title="전체의 ${total ? Math.round(count / total * 100) : 0}%"><span style="width:${Math.round(count / max * 100)}%"></span></div>
  </div>`).join("");
}

function renderStats(regionLabel) {
  const summary = statsSummary;
  const month = summary.months[0]?.name?.replace(/^(\d{4})(\d{2})$/, "$1.$2") || "미확인";
  $("statTiles").innerHTML = [
    ["가입 사업장", `${summary.total.toLocaleString("ko-KR")}개`],
    ["등록 사업장", `${summary.registered.toLocaleString("ko-KR")}개 (${Math.round(summary.registeredRatio * 100)}%)`],
    ["탈퇴 사업장", `${summary.withdrawn.toLocaleString("ko-KR")}개`],
    ["법인 사업장", `${summary.corporate.toLocaleString("ko-KR")}개 (${Math.round(summary.corporateRatio * 100)}%)`],
    ["개인 사업장", `${summary.individual.toLocaleString("ko-KR")}개`],
    ["업종 대분류", `${summary.sections.length}개`]
  ].map(([label, value]) => `<div class="stat-tile"><dt>${label}</dt><dd>${escapeHtml(value)}</dd></div>`).join("");
  $("statsSections").innerHTML = statsBars(summary.sections, 21);
  $("statsAreas").innerHTML = statsBars(summary.areas, 12);
  $("statsStyles").innerHTML = statsBars(summary.styles, 5);
  $("statsStatuses").innerHTML = statsBars(summary.statuses, 5);
  $("statsMeta").textContent = `국민연금공단 가입 사업장 내역 · ${regionLabel} · 자료 기준월 ${month} · 사업장 ${summary.total.toLocaleString("ko-KR")}개 집계`;
  $("statsDownloadBtn").disabled = !summary.total;
}

async function runStats() {
  if (statsBusy) return;
  const regionKey = $("statsRegionSelect").value;
  const region = NPS_REGIONS[regionKey] || NPS_REGIONS.donggu;
  statsBusy = true;
  statsWorkplaces = [];
  $("statsRunBtn").disabled = true;
  $("statsWorkspace").hidden = true;
  $("statsState").hidden = false;
  $("statsState").classList.remove("is-error");
  $("statsState").textContent = "사업장 내역을 수집하는 중입니다.";
  $("statsProgressWrap").hidden = false;
  $("statsProgressFill").style.width = "0%";

  try {
    let total = Infinity;
    for (let pageNo = 1; pageNo <= STATS_MAX_PAGES && statsWorkplaces.length < total; pageNo += 1) {
      const payload = await fetchNps({
        action: "search", pageNo, numOfRows: STATS_PAGE_SIZE, ...regionParams(regionKey)
      });
      const items = payload.items || [];
      total = payload.totalCount || items.length;
      statsWorkplaces.push(...items);
      if (!items.length) break;
      const percent = total ? Math.min(100, Math.round(statsWorkplaces.length / total * 100)) : 100;
      $("statsProgressFill").style.width = `${percent}%`;
      $("statsProgressText").textContent = `${statsWorkplaces.length.toLocaleString("ko-KR")} / ${total.toLocaleString("ko-KR")}개 사업장 수집 (${percent}%)`;
    }
    if (!statsWorkplaces.length) throw new Error("집계할 사업장 내역이 없습니다.");
    statsSummary = summarizeWorkplaces(statsWorkplaces);
    renderStats(region.label);
    $("statsState").hidden = true;
    $("statsWorkspace").hidden = false;
    $("statsProgressFill").style.width = "100%";
    showToast("국민연금 사업장 통계 집계가 완료되었습니다.");
  } catch (error) {
    $("statsState").classList.add("is-error");
    $("statsState").textContent = error.message;
    $("statsProgressText").textContent = "집계를 완료하지 못했습니다.";
    showToast(error.message);
  } finally {
    statsBusy = false;
    $("statsRunBtn").disabled = false;
  }
}

$("statsRunBtn").addEventListener("click", runStats);
$("statsDownloadBtn").addEventListener("click", () => {
  if (!statsSummary) return;
  const group = (title, counts) => counts.map((item) => [title, item.name, item.count]);
  downloadCsv(
    ["구분", "항목", "사업장 수"],
    [
      ...group("업종 대분류", statsSummary.sections),
      ...group("도로명", statsSummary.areas),
      ...group("사업장 형태", statsSummary.styles),
      ...group("가입 상태", statsSummary.statuses)
    ],
    `국민연금사업장통계_${new Date().toISOString().slice(0, 10)}.csv`
  );
});

updateInputCount();
