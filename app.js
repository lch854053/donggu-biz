import {
  buildLocationFilter,
  buildLocationSelection,
  countBy,
  filterStores
} from "./lib/market.js";
import { filterVworldZones, mergeZoneFeatures } from "./lib/zone-update.js";
import {
  INDUSTRY_SECTIONS,
  displayAddress,
  hasIndustryDetail,
  hydrateSnapshotWorkplace,
  matchesWorkplaceCriteria,
  sortWorkplaces,
  ymdYear
} from "./lib/nps.js";

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

let validationBusy = false;

function validationFormValues() {
  const bNo = $("validationBizNo").value.replace(/[^0-9]/g, "");
  const owner = $("validationOwner").value.trim();
  const startDate = $("validationStartDate").value.replace(/[^0-9]/g, "");

  if (!bNo) {
    showToast("사업자등록번호를 입력해 주세요.");
    $("validationBizNo").focus();
    return null;
  }
  if (!/^\d{10}$/.test(bNo)) {
    showToast("사업자등록번호는 10자리 숫자로 입력해 주세요.");
    $("validationBizNo").focus();
    return null;
  }
  if (!owner) {
    showToast("대표자명을 입력해 주세요.");
    $("validationOwner").focus();
    return null;
  }
  if (startDate.length !== 8) {
    showToast("개업일자를 입력해 주세요.");
    $("validationStartDate").focus();
    return null;
  }

  return {
    b_no: bNo,
    start_dt: startDate,
    p_nm: owner
  };
}

async function callBusinessValidation(business) {
  const response = await fetch("/api/lookup", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "validate", businesses: [business] })
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error.error || `HTTP ${response.status}`);
  }
  return response.json();
}

function renderValidationResult(item, statusRow, statusError) {
  const result = $("validationResult");
  const code = String(item?.valid ?? "");
  const state = code === "01" ? "is-valid" : code === "02" ? "is-invalid" : "is-error";
  const title = code === "01" ? "일치" : code === "02" ? "불일치" : "확인 불가";
  const message = item?.valid_msg ? `<p>${escapeHtml(item.valid_msg)}</p>` : "";
  const statusDetails = code === "01" ? `<dl class="verification-status">
    <div><dt>과세 유형</dt><dd>${badge("tax", statusRow?.tax_type, statusRow?.tax_type_cd)}</dd></div>
    <div><dt>사업자 상태</dt><dd>${badge("status", statusRow?.b_stt, statusRow?.b_stt_cd)}</dd></div>
  </dl>${statusError ? `<p class="verification-note">사업자 상태를 불러오지 못했습니다.</p>` : ""}` : "";
  result.className = `verification-result ${state}`;
  result.innerHTML = `<strong>${title}</strong>${message}${statusDetails}`;
}

function renderValidationError(message) {
  const result = $("validationResult");
  result.className = "verification-result is-error";
  result.innerHTML = `<strong>진위확인을 완료하지 못했습니다.</strong><p>${escapeHtml(message)}</p>`;
}

async function runBusinessValidation() {
  if (validationBusy) return;
  const business = validationFormValues();
  if (!business) return;

  validationBusy = true;
  $("validationRunBtn").disabled = true;
  $("validationClearBtn").disabled = true;
  $("validationResultSection").hidden = false;
  $("validationResultSection").setAttribute("aria-busy", "true");
  $("validationResult").className = "verification-result is-pending";
  $("validationResult").innerHTML = "<p>국세청 등록정보와 대조하는 중입니다.</p>";

  try {
    const payload = await callBusinessValidation(business);
    const result = payload?.data?.[0];
    if (!result) throw new Error("진위확인 결과를 받지 못했습니다.");
    let statusRow;
    let statusError = "";
    if (String(result.valid) === "01") {
      try {
        statusRow = (await callBusinessProxy([business.b_no]))[0];
        if (!statusRow) statusError = "상태조회 결과가 없습니다.";
      } catch (error) {
        statusError = error.message;
      }
    }
    renderValidationResult(result, statusRow, statusError);
    showToast(statusError
      ? "진위확인은 완료했지만 사업자 상태를 불러오지 못했습니다."
      : "사업자등록정보 진위확인이 완료되었습니다.");
  } catch (error) {
    renderValidationError(error.message);
    showToast(error.message);
  } finally {
    validationBusy = false;
    $("validationRunBtn").disabled = false;
    $("validationClearBtn").disabled = false;
    $("validationResultSection").removeAttribute("aria-busy");
  }
}

$("validationRunBtn").addEventListener("click", runBusinessValidation);
$("validationClearBtn").addEventListener("click", () => {
  $("validationBizNo").value = "";
  $("validationOwner").value = "";
  $("validationStartDate").value = "";
  $("validationResultSection").hidden = true;
  $("validationResult").replaceChildren();
});
[
  $("validationBizNo"),
  $("validationOwner"),
  $("validationStartDate")
].forEach((input) => input.addEventListener("keydown", (event) => {
  if (event.key === "Enter") runBusinessValidation();
}));

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
// 이 서비스는 광주 동구만 다룬다. 조회도 스냅샷도 같은 지역 하나를 본다.

const NPS_PAGE_SIZE = 100;

/**
 * 등록일 슬라이더의 기본 범위. 국민연금 사업장 당연적용은 1988년 10인 이상 사업장에서
 * 시작해 1992년 5인 이상, 1999년 전 사업장으로 넓어졌으므로 그 전으로 등록된 사업장은
 * 없다. 동구 자료가 더 이른 해를 담고 있으면 그만큼 아래로 넓힌다.
 */
const NPS_YEAR_FLOOR = 1988;
// 가입자 수 슬라이더의 상한은 자료에서 정하되 이보다 좁히지 않는다. 동구에는 (주)광주은행
// 처럼 1,500명이 넘는 사업장이 있다.
const NPS_PEOPLE_CEILING_MIN = 2000;
const NPS_HISTORY_MAX_POINTS = 24;

let npsRows = [];
let npsSnapshot = null;
let npsPageNo = 1;
let npsBusy = false;
let npsStyleCode = "";
let npsDetail = { seq: "", html: "" };
let npsAppliedCriteria = null;
let npsCriteriaDirty = false;
let npsSort = "";

// 업종 대분류 선택기에서 "업종 미상"을 가리키는 값. 분류표의 대분류 코드와 겹치지 않게 둔다.
const NPS_UNKNOWN_SECTION_VALUE = "unknown";

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

/**
 * 값 두 개를 잡는 슬라이더. 두 손잡이를 겹쳐 놓고 서로를 넘어가지 못하게 잡아 준다.
 * 양 끝에 그대로 있으면 "전체"로 보고 조건을 걸지 않는다 — 아직 상세를 받지 못해
 * 값이 비어 있는 사업장이 슬라이더를 건드리지도 않았는데 사라지면 안 되기 때문이다.
 */
function createRangeControl({ wrapId, fromId, toId, minLabelId, maxLabelId, readoutId, format, onChange }) {
  const wrap = $(wrapId);
  const fill = wrap.querySelector(".range-fill");
  const from = $(fromId);
  const to = $(toId);
  let bounds = { min: 0, max: 1 };
  let touched = false;

  function paint() {
    const span = bounds.max - bounds.min || 1;
    const left = (Number(from.value) - bounds.min) / span * 100;
    const right = (Number(to.value) - bounds.min) / span * 100;
    fill.style.left = `${left}%`;
    fill.style.width = `${Math.max(0, right - left)}%`;
    $(readoutId).textContent = isFull() ? "전체" : `${format(Number(from.value))} ~ ${format(Number(to.value))}`;
  }

  function isFull() {
    return Number(from.value) <= bounds.min && Number(to.value) >= bounds.max;
  }

  function handle(event) {
    touched = true;
    // 두 손잡이가 서로를 지나치면 값이 뒤집힌다. 밀어붙인 쪽을 상대편에서 멈춘다.
    if (event.target === from && Number(from.value) > Number(to.value)) from.value = to.value;
    if (event.target === to && Number(to.value) < Number(from.value)) to.value = from.value;
    paint();
    onChange();
  }

  from.addEventListener("input", handle);
  to.addEventListener("input", handle);

  return {
    /** 조회 결과에 맞춰 범위를 다시 잡는다. 사용자가 손대지 않았으면 양 끝으로 벌린다. */
    setBounds(min, max) {
      bounds = { min, max: Math.max(max, min + 1) };
      for (const input of [from, to]) {
        input.min = String(bounds.min);
        input.max = String(bounds.max);
        input.step = "1";
      }
      if (touched) {
        from.value = String(Math.min(Math.max(Number(from.value), bounds.min), bounds.max));
        to.value = String(Math.min(Math.max(Number(to.value), bounds.min), bounds.max));
      } else {
        from.value = String(bounds.min);
        to.value = String(bounds.max);
      }
      $(minLabelId).textContent = format(bounds.min);
      $(maxLabelId).textContent = format(bounds.max);
      paint();
    },
    value() {
      return { from: Number(from.value), to: Number(to.value), full: isFull() };
    },
    reset() {
      touched = false;
      from.value = String(bounds.min);
      to.value = String(bounds.max);
      paint();
    }
  };
}

const npsYearRange = createRangeControl({
  wrapId: "npsYearRange",
  fromId: "npsYearFrom",
  toId: "npsYearTo",
  minLabelId: "npsYearMinLabel",
  maxLabelId: "npsYearMaxLabel",
  readoutId: "npsYearReadout",
  format: (year) => `${year}년`,
  onChange: markNpsCriteriaDirty
});

const npsPeopleRange = createRangeControl({
  wrapId: "npsPeopleRange",
  fromId: "npsPeopleFrom",
  toId: "npsPeopleTo",
  minLabelId: "npsPeopleMinLabel",
  maxLabelId: "npsPeopleMaxLabel",
  readoutId: "npsPeopleReadout",
  format: (people) => `${people.toLocaleString("ko-KR")}명`,
  onChange: markNpsCriteriaDirty
});

/** 입력 중인 조건을 조회 실행 시점에 결과에 적용한다. */
function npsCriteria() {
  const section = $("npsSectionSelect").value;
  const years = npsYearRange.value();
  const people = npsPeopleRange.value();
  return {
    name: $("npsNameInput").value.trim(),
    includeWithdrawn: $("npsIncludeWithdrawn").checked,
    styleCode: npsStyleCode,
    sectionCode: section === NPS_UNKNOWN_SECTION_VALUE ? "" : section,
    unknownIndustryOnly: section === NPS_UNKNOWN_SECTION_VALUE,
    registeredFromYear: years.full ? null : years.from,
    registeredToYear: years.full ? null : years.to,
    subscriberMin: people.full ? null : people.from,
    subscriberMax: people.full ? null : people.to
  };
}

function filteredNpsRows() {
  const criteria = npsAppliedCriteria || {};
  return npsRows.filter((row) => matchesWorkplaceCriteria(row, criteria));
}

function sortedNpsRows() {
  return sortWorkplaces(filteredNpsRows(), npsSort);
}

function npsPageRows() {
  const rows = sortedNpsRows();
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
  const body = $("npsResultBody");
  if (!rows.length) {
    body.innerHTML = '<tr class="empty-row"><td colspan="10">해당 조건의 결과가 없습니다.</td></tr>';
    return;
  }
  const offset = (npsPageNo - 1) * NPS_PAGE_SIZE;
  body.innerHTML = rows.map((row, index) => {
    const opened = Boolean(row.seq) && npsDetail.seq === row.seq;
    // 상세 카드는 표 맨 아래가 아니라 누른 행 바로 아래에 한 줄을 끼워 펼친다.
    const card = opened
      ? `<tr class="detail-row"><td colspan="10"><div class="detail-card">${npsDetail.html}</div></td></tr>`
      : "";
    return `<tr${opened ? ' class="is-open"' : ""}>
    <td class="seq">${offset + index + 1}</td>
    <td>${escapeHtml(row.name)}</td>
    <td class="mono">${escapeHtml(row.bizNoPrefix ? `${row.bizNoPrefix}-****` : "-")}</td>
    <td>${escapeHtml(displayAddress(row.address) || "-")}</td>
    <td>${escapeHtml(hasIndustryDetail(row) ? row.sectionName : "")}</td>
    <td>${escapeHtml(row.styleName)}</td>
    <td class="mono">${escapeHtml(row.registeredDate ? formatYmd(row.registeredDate) : "-")}</td>
    <td class="mono">${typeof row.subscriberCount === "number" ? `${row.subscriberCount.toLocaleString("ko-KR")}명` : "-"}</td>
    <td>${npsStatusBadge(row)}</td>
    <td class="detail-cell"><button class="button button-quiet detail-btn" type="button" data-seq="${escapeHtml(row.seq)}" aria-expanded="${opened}">상세</button></td>
  </tr>${card}`;
  }).join("");
}

function renderNpsStats() {
  const rows = filteredNpsRows();
  const registered = rows.filter((row) => row.statusCode === "1").length;
  const withdrawn = rows.filter((row) => row.statusCode === "2").length;
  $("npsStatsRow").innerHTML = `
    <span class="stat-item">사업장<strong>${rows.length.toLocaleString("ko-KR")}</strong></span>
    <span class="stat-item">등록<strong>${registered.toLocaleString("ko-KR")}</strong></span>
    <span class="stat-item">탈퇴<strong>${withdrawn.toLocaleString("ko-KR")}</strong></span>`;
}

function renderNpsPager() {
  const lastPage = Math.max(1, Math.ceil(filteredNpsRows().length / NPS_PAGE_SIZE));
  $("npsPager").hidden = lastPage <= 1;
  $("npsPageLabel").textContent = `${npsPageNo} / ${lastPage}`;
  $("npsPrevBtn").disabled = npsPageNo <= 1 || npsBusy;
  $("npsNextBtn").disabled = npsPageNo >= lastPage || npsBusy;
}

function renderNps() {
  const shown = filteredNpsRows().length;
  $("npsCountBadge").textContent = `${shown.toLocaleString("ko-KR")}개 사업장`;
  $("npsDownloadBtn").disabled = !shown;
  renderNpsTable();
  renderNpsStats();
  renderNpsPager();
}

/** 조회 결과는 마지막 실행 조건을 유지하고, 새 조건은 다음 조회 때 적용한다. */
function markNpsCriteriaDirty() {
  npsCriteriaDirty = true;
  renderNpsCriteriaState();
}

function renderNpsCriteriaState() {
  const pending = Boolean(npsAppliedCriteria && npsCriteriaDirty);
  $("npsCriteriaNote").hidden = !pending;
}

function showNpsPage(pageNo) {
  const lastPage = Math.max(1, Math.ceil(filteredNpsRows().length / NPS_PAGE_SIZE));
  npsPageNo = Math.min(Math.max(pageNo, 1), lastPage);
  renderNpsTable();
  renderNpsPager();
}

/**
 * 업종 대분류 목록. 분류표의 대분류에 "업종 미상"을 한 항목으로 덧붙인다. 업종을 담고
 * 있지 않은 자리표시 코드(000000·999999)를 가진 사업장이 갈 곳이 필요하기 때문이다.
 */
function fillNpsSectionOptions() {
  $("npsSectionSelect").innerHTML = ['<option value="">전체</option>',
    ...INDUSTRY_SECTIONS.map(({ code, name }) => `<option value="${code}">${escapeHtml(name)}</option>`),
    `<option value="${NPS_UNKNOWN_SECTION_VALUE}">업종 미상</option>`].join("");
}

/** 자료가 담고 있는 등록 연도와 가입자 수에 맞춰 슬라이더 범위를 잡는다. */
function fitNpsRanges() {
  const thisYear = new Date().getFullYear();
  const years = npsRows.map((row) => ymdYear(row.registeredDate)).filter((year) => year != null);
  npsYearRange.setBounds(Math.min(NPS_YEAR_FLOOR, ...years), Math.max(thisYear, ...years));

  const counts = npsRows.map((row) => row.subscriberCount).filter((value) => typeof value === "number");
  const ceiling = Math.max(NPS_PEOPLE_CEILING_MIN, ...counts);
  npsPeopleRange.setBounds(0, ceiling);
}

/**
 * 조회는 미리 받아둔 동구 스냅샷 하나로 끝낸다. 목록 API는 자료생성년월마다 사업장을
 * 한 건씩 쌓아 돌려주어 동구 전체가 1만 3천 건이 넘고, 업종·등록일·가입자 수는 목록에
 * 없어 사업장마다 상세조회를 한 번씩 더 불러야 한다. 조건검색이 그 값들을 쓰는 이상
 * 화면에서 실시간으로 감당할 양이 아니다. 스냅샷은 그 일을 월 1회 배치로 끝내 둔 것이다.
 * 국민연금 API는 상세 카드와 월별 추이에만 쓴다.
 */
const NPS_SNAPSHOT_URL = "data/nps_donggu.json";

async function loadNpsSnapshot() {
  if (npsSnapshot) return npsSnapshot;
  const response = await fetch(NPS_SNAPSHOT_URL, { cache: "no-cache" });
  if (!response.ok) throw new Error(`사업장 자료를 불러오지 못했습니다. (HTTP ${response.status})`);
  const payload = await response.json();
  npsSnapshot = {
    collectedAt: String(payload.collectedAt ?? ""),
    dataCreatedMonth: String(payload.dataCreatedMonth ?? ""),
    items: (payload.items ?? []).map(hydrateSnapshotWorkplace).filter((workplace) => workplace.name)
  };
  return npsSnapshot;
}

/** 자료가 언제 것인지 보조로 적는다. 실시간 조회가 아니므로 기준을 밝혀야 읽는 쪽이 판단할 수 있다. */
function renderNpsBasis(snapshot) {
  const month = snapshot.dataCreatedMonth ? monthLabel(snapshot.dataCreatedMonth) : "";
  const collected = formatIsoDate(snapshot.collectedAt);
  const parts = [month && `${month} 자료`, collected && `${collected} 갱신`].filter(Boolean);
  $("npsBasis").textContent = parts.length ? `조회 기준 : ${parts.join(" · ")}` : "";
}

/** ISO 시각을 yyyy.mm.dd로 줄인다. 값이 없으면 빈 문자열. */
function formatIsoDate(value) {
  const time = Date.parse(String(value ?? ""));
  if (!Number.isFinite(time)) return "";
  const date = new Date(time);
  const pad = (number) => String(number).padStart(2, "0");
  return `${date.getFullYear()}.${pad(date.getMonth() + 1)}.${pad(date.getDate())}`;
}

async function runNpsLookup() {
  if (npsBusy) return;
  npsBusy = true;
  npsDetail = { seq: "", html: "" };
  $("npsRunBtn").disabled = true;
  $("npsProgressWrap").hidden = false;
  $("npsProgressFill").style.width = "35%";
  $("npsProgressText").textContent = "동구 사업장 자료를 읽는 중입니다.";
  renderNpsPager();

  try {
    const snapshot = await loadNpsSnapshot();
    npsRows = snapshot.items;
    npsPageNo = 1;
    renderNpsBasis(snapshot);
    fitNpsRanges();
    npsAppliedCriteria = npsCriteria();
    npsCriteriaDirty = false;
    $("npsResultSection").hidden = false;
    renderNps();
    renderNpsCriteriaState();
    $("npsProgressFill").style.width = "100%";
    $("npsProgressText").textContent = `사업장 ${filteredNpsRows().length.toLocaleString("ko-KR")}개를 조회했습니다.`;
    showToast(`사업장 ${filteredNpsRows().length.toLocaleString("ko-KR")}개를 조회했습니다.`);
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

/**
 * 상세 카드. 누른 행 바로 아래 한 줄을 끼워 펼치고, 같은 행을 다시 누르면 접는다.
 * 표는 상세를 채우는 동안에도 다시 그려지므로 카드 내용은 상태로 들고 있는다.
 */
async function showNpsDetail(seq) {
  if (npsDetail.seq === seq) {
    npsDetail = { seq: "", html: "" };
    renderNpsTable();
    return;
  }
  const listRow = npsRows.find((row) => row.seq === seq);
  npsDetail = { seq, html: "<p>사업장 상세 정보를 불러오는 중입니다.</p>" };
  renderNpsTable();

  let base;
  try {
    const payload = await fetchNps({ action: "detail", seq });
    const detail = payload.items?.[0];
    if (!detail) throw new Error("사업장 상세 정보를 찾을 수 없습니다.");
    const row = (label, value) => (value == null ? "" : `<div><dt>${label}</dt><dd>${value}</dd></div>`);
    const people = (value) => (value == null ? null : `${value.toLocaleString("ko-KR")}명`);
    base = `<p class="selection-name">${escapeHtml(detail.name)}</p>
      <dl>
        ${row("사업자등록번호", escapeHtml(detail.bizNoPrefix ? `${detail.bizNoPrefix}-****` : "-"))}
        ${row("소재지", escapeHtml(displayAddress(detail.address) || "-"))}
        ${row("업종 대분류", escapeHtml(detail.sectionName))}
        ${row("사업장 형태", escapeHtml(detail.styleName))}
        ${row("가입 상태", escapeHtml(detail.statusName))}
        ${row("사업장 등록일", escapeHtml(formatYmd(detail.registeredDate)))}
        ${row("사업장 탈퇴일", detail.withdrawnDate ? escapeHtml(formatYmd(detail.withdrawnDate)) : null)}
        ${row("가입자 수", people(detail.subscriberCount))}
        ${row("월별 신규 취득자", people(detail.newSubscriberCount))}
        ${row("월별 상실 가입자", people(detail.lostSubscriberCount))}
        ${row("당월 고지금액", `${detail.monthlyNoticeAmount.toLocaleString("ko-KR")}원`)}
      </dl>`;
  } catch (error) {
    if (npsDetail.seq !== seq) return;
    npsDetail = { seq, html: `<p class="summary-empty">${escapeHtml(error.message)}</p>` };
    renderNpsTable();
    return;
  }
  if (npsDetail.seq !== seq) return;

  const historyRows = (listRow?.historyRows ?? []).filter((row) => row.seq && row.month);
  const pending = historyRows.length >= 2 ? '<p class="summary-empty">월별 추이를 불러오는 중입니다.</p>' : "";
  npsDetail = { seq, html: base + pending };
  renderNpsTable();
  document.querySelector("#npsResultBody .detail-row")?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  if (!pending) return;

  const charts = await npsHistoryHtml(historyRows);
  if (npsDetail.seq !== seq) return;
  npsDetail = { seq, html: base + charts };
  renderNpsTable();
}

/** 접어 둔 월별 이력을 불러 상세 카드 아래에 붙일 추이 그래프 마크업을 만든다. */
async function npsHistoryHtml(historyRows) {
  try {
    const seqs = historyRows.slice(0, NPS_HISTORY_MAX_POINTS).map((row) => `${row.seq}:${row.month}`).join(",");
    const { series } = await fetchNps({ action: "history", seqs });
    const points = (series || []).filter((point) => point.month).sort((a, b) => a.month.localeCompare(b.month));
    if (points.length < 2) return "";
    return `<h3 class="chart-heading">월별 추이 <span class="chart-note">${points.length}개월</span></h3>
      <div class="chart-grid">
        ${trendChart("가입자 수", points, [{ key: "subscriberCount", label: "가입자 수", color: "#3987e5" }], "line", (value) => `${value.toLocaleString("ko-KR")}명`)}
        ${trendChart("당월 고지금액", points, [{ key: "monthlyNoticeAmount", label: "당월 고지금액", color: "#3987e5" }], "line", (value) => `${Math.round(value / 10000).toLocaleString("ko-KR")}만원`)}
        ${trendChart("월별 취득·상실 가입자", points, [
          { key: "newSubscriberCount", label: "신규 취득", color: "#199e70" },
          { key: "lostSubscriberCount", label: "상실", color: "#d95926" }
        ], "bar", (value) => `${value.toLocaleString("ko-KR")}명`)}
      </div>`;
  } catch (error) {
    return `<p class="summary-empty">월별 추이를 불러오지 못했습니다. ${escapeHtml(error.message)}</p>`;
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

function downloadXlsx(headers, rows, fileName) {
  const xlsx = window.XLSX;
  if (!xlsx) {
    showToast("XLSX 다운로드 기능을 불러오지 못했습니다. 페이지를 새로고침해 주세요.");
    return;
  }
  const workbook = xlsx.utils.book_new();
  const worksheet = xlsx.utils.aoa_to_sheet([headers, ...rows]);
  xlsx.utils.book_append_sheet(workbook, worksheet, "사업장");
  xlsx.writeFile(workbook, fileName);
  showToast("XLSX 파일을 내려받았습니다.");
}

$("npsRunBtn").addEventListener("click", () => runNpsLookup());
$("npsClearBtn").addEventListener("click", () => {
  $("npsNameInput").value = "";
  $("npsSectionSelect").value = "";
  $("npsIncludeWithdrawn").checked = false;
  npsStyleCode = "";
  setNpsStyleChip("");
  npsPageNo = 1;
  npsDetail = { seq: "", html: "" };
  npsYearRange.reset();
  npsPeopleRange.reset();
  if (npsAppliedCriteria) markNpsCriteriaDirty();
});
$("npsPrevBtn").addEventListener("click", () => showNpsPage(npsPageNo - 1));
$("npsNextBtn").addEventListener("click", () => showNpsPage(npsPageNo + 1));
$("npsNameInput").addEventListener("input", markNpsCriteriaDirty);
$("npsNameInput").addEventListener("keydown", (event) => { if (event.key === "Enter") runNpsLookup(); });
$("npsSectionSelect").addEventListener("change", markNpsCriteriaDirty);
$("npsIncludeWithdrawn").addEventListener("change", markNpsCriteriaDirty);
$("npsStyleTabs").addEventListener("click", (event) => {
  const button = event.target.closest("[data-style]");
  if (!button) return;
  npsStyleCode = button.dataset.style;
  setNpsStyleChip(npsStyleCode);
  markNpsCriteriaDirty();
});

$("npsSortSelect").addEventListener("change", (event) => {
  npsSort = event.target.value;
  npsPageNo = 1;
  npsDetail = { seq: "", html: "" };
  if (npsRows.length) renderNps();
});

/** 사업장 형태 칩의 선택 표시를 맞춘다. */
function setNpsStyleChip(styleCode) {
  document.querySelectorAll("#npsStyleTabs .filter-chip").forEach((chip) => {
    const active = chip.dataset.style === styleCode;
    chip.classList.toggle("is-active", active);
    chip.setAttribute("aria-pressed", String(active));
  });
}

$("npsResultBody").addEventListener("click", (event) => {
  const button = event.target.closest(".detail-btn");
  if (button) showNpsDetail(button.dataset.seq);
});
$("npsDownloadBtn").addEventListener("click", () => {
  const rows = sortedNpsRows();
  if (!rows.length) return;
  downloadXlsx(
    ["순번", "사업장명", "사업자등록번호(앞6자리)", "소재지(도로명)", "업종대분류", "사업장형태", "사업장등록일", "가입자수", "가입상태", "자료기준월", "이력개월수"],
    rows.map((row, index) => [
      index + 1,
      row.name, row.bizNoPrefix, displayAddress(row.address),
      hasIndustryDetail(row) ? row.sectionName : "",
      row.styleName, row.registeredDate ? formatYmd(row.registeredDate) : "",
      typeof row.subscriberCount === "number" ? row.subscriberCount : "",
      row.statusName, row.dataCreatedMonth, row.historyCount || 1
    ]),
    `국민연금사업장_${new Date().toISOString().slice(0, 10)}.xlsx`
  );
});

fillNpsSectionOptions();
fitNpsRanges();

updateInputCount();
