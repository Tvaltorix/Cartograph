const svg = document.getElementById("graph");
const details = document.getElementById("details");
const summary = document.getElementById("summary");
const empty = document.getElementById("empty");
const statusFilter = document.getElementById("status-filter");
const gapsOnly = document.getElementById("gaps-only");
const plagueOnly = document.getElementById("plague-only");
const fileInput = document.getElementById("file-input");
const exportButton = document.getElementById("export-button");
let graph = null;
let selectedId = null;

const ns = "http://www.w3.org/2000/svg";
const makeSvg = (name, attributes = {}) => {
  const element = document.createElementNS(ns, name);
  Object.entries(attributes).forEach(([key, value]) => element.setAttribute(key, value));
  return element;
};
const short = (value, max = 24) => value.length > max ? `${value.slice(0, max - 1)}…` : value;
const visible = node => (statusFilter.value === "all" || node.status === statusFilter.value)
  && (!gapsOnly.checked || node.gap)
  && (!plagueOnly.checked || node.plague);

function renderDetails(node) {
  if (!node) return;
  const evidence = graph.evidence.filter(item => item.node_id === node.id);
  const relationships = graph.edges.filter(edge => edge.source === node.id || edge.target === node.id).length;
  details.innerHTML = `
    <p class="eyebrow">${node.kind.replaceAll("_", " ")}</p>
    <h2>${escapeHtml(node.label)}</h2>
    <dl>
      <dt>Status</dt><dd class="status-word">${node.status}</dd>
      <dt>Reason</dt><dd>${escapeHtml(node.status_reason)}</dd>
      <dt>Path</dt><dd>${escapeHtml(node.path || "—")}</dd>
      <dt>Evidence</dt><dd>${evidence.length ? evidence.map(item => escapeHtml(item.check_id)).join(", ") : "none"}</dd>
      <dt>Links</dt><dd>${relationships}</dd>
      <dt>Gap</dt><dd>${node.gap ? "yes" : "no"}</dd>
      <dt>Plague</dt><dd>${node.plague ? escapeHtml(node.plague_reasons.join(", ")) : "no"}</dd>
    </dl>`;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>'"]/g, char => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;"})[char]);
}

function render() {
  if (!graph) return;
  exportButton.disabled = false;
  svg.replaceChildren(svg.querySelector("title"), svg.querySelector("desc"));
  const nodes = graph.nodes.filter(visible);
  const ids = new Set(nodes.map(node => node.id));
  const edges = graph.edges.filter(edge => ids.has(edge.source) && ids.has(edge.target));
  empty.hidden = nodes.length > 0;
  const maxX = Math.max(900, ...nodes.map(node => node.x + 200));
  const maxY = Math.max(600, ...nodes.map(node => node.y + 90));
  svg.setAttribute("viewBox", `0 0 ${maxX} ${maxY}`);
  svg.setAttribute("width", maxX);
  svg.setAttribute("height", maxY);
  const nodeById = new Map(nodes.map(node => [node.id, node]));
  const lanes = [...nodes.reduce((map, node) => map.set(node.kind, Math.min(map.get(node.kind) ?? Infinity, node.x)), new Map()).entries()]
    .map(([kind, x]) => [x, kind]).sort((a, b) => a[0] - b[0]);
  lanes.forEach(([x, kind]) => {
    const label = makeSvg("text", {x, y: 30, class: "lane-label"});
    label.textContent = kind.replaceAll("_", " ");
    svg.append(label);
  });
  edges.forEach(edge => {
    const source = nodeById.get(edge.source);
    const target = nodeById.get(edge.target);
    const path = makeSvg("path", {
      d: `M ${source.x + 170} ${source.y + 26} C ${source.x + 205} ${source.y + 26}, ${target.x - 35} ${target.y + 26}, ${target.x} ${target.y + 26}`,
      class: `edge ${edge.provenance === "declared" ? "declared" : ""} ${edge.plague ? "plague" : ""}`,
    });
    svg.append(path);
  });
  nodes.forEach(node => {
    const group = makeSvg("g", {class: `node ${node.id === selectedId ? "selected" : ""}`, role: "button", "aria-label": `${node.label}, ${node.status}`});
    group.addEventListener("click", () => select(node.id));
    group.addEventListener("keydown", event => {
      if (event.key === "Enter" || event.key === " ") { event.preventDefault(); select(node.id); }
    });
    group.setAttribute("tabindex", "0");
    group.setAttribute("transform", `translate(${node.x}, ${node.y})`);
    if (node.plague) group.append(makeSvg("rect", {x: -5, y: -5, width: 180, height: 62, rx: 11, class: "plague-halo"}));
    group.append(makeSvg("rect", {width: 170, height: 52, class: `node-${node.status}`}));
    const label = makeSvg("text", {x: 12, y: 23, class: "node-label"});
    label.textContent = short(node.label);
    const kind = makeSvg("text", {x: 12, y: 40, class: "node-kind"});
    kind.textContent = `${node.kind.replaceAll("_", " ")}${node.gap ? " · GAP" : ""}`;
    group.append(label, kind);
    svg.append(group);
  });
  summary.value = `${graph.project} · ${nodes.length}/${graph.nodes.length} nodes · ${edges.length} links`;
  summary.textContent = summary.value;
  if (selectedId && !ids.has(selectedId)) {
    selectedId = null;
    details.innerHTML = '<p class="eyebrow">Selection</p><h2>Filtered out</h2><p>Change the filters to restore the selected node.</p>';
  }
}

function select(id) {
  selectedId = id;
  render();
  renderDetails(graph.nodes.find(node => node.id === id));
}

async function loadDefault() {
  const params = new URLSearchParams(location.search);
  const source = params.get("graph") || "../examples/whisper-mcp.graph.json";
  try {
    const response = await fetch(source);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    graph = await response.json();
    render();
  } catch (error) {
    summary.textContent = "Open a Cartograph JSON export to begin";
    empty.hidden = false;
    empty.textContent = `Default graph unavailable: ${error.message}`;
  }
}

[statusFilter, gapsOnly, plagueOnly].forEach(control => control.addEventListener("change", render));
fileInput.addEventListener("change", async () => {
  const [file] = fileInput.files;
  if (!file) return;
  graph = JSON.parse(await file.text());
  selectedId = null;
  render();
});
exportButton.addEventListener("click", () => {
  if (!graph) return;
  const project = String(graph.project || "cartograph").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const digest = String(graph.graph_digest || "export").slice(0, 8);
  const blob = new Blob([`${JSON.stringify(graph, null, 2)}\n`], {type: "application/json"});
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = `${project || "cartograph"}-${digest}.graph.json`;
  link.click();
  URL.revokeObjectURL(link.href);
});
loadDefault();
