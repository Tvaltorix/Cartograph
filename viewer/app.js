const svg = document.getElementById("graph");
const details = document.getElementById("details");
const summary = document.getElementById("summary");
const empty = document.getElementById("empty");
const statusFilter = document.getElementById("status-filter");
const gapsOnly = document.getElementById("gaps-only");
const plagueOnly = document.getElementById("plague-only");
const fileInput = document.getElementById("file-input");
const exportButton = document.getElementById("export-button");
const newProjectButton = document.getElementById("new-project-button");
const projectSelect = document.getElementById("project-select");
const refreshButton = document.getElementById("refresh-button");
const onboardingDialog = document.getElementById("onboarding-dialog");
const onboardingForm = document.getElementById("onboarding-form");
const cancelOnboarding = document.getElementById("cancel-onboarding");
const projectPrivacy = document.getElementById("project-privacy");
const privacyDescription = document.getElementById("privacy-description");
const onboardingError = document.getElementById("onboarding-error");
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

function setGraph(value) {
  graph = value;
  selectedId = null;
  render();
}

async function requestJson(url, options = {}) {
  const response = await fetch(url, options);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
  return payload;
}

async function loadProjects(preferred = graph?.project) {
  try {
    const payload = await requestJson("/api/projects");
    projectSelect.replaceChildren(new Option("Reference export", ""));
    payload.projects.forEach(project => {
      const freshness = project.scanned_at ? "" : project.graph_digest ? " · scan time unknown" : " · not scanned";
      projectSelect.add(new Option(`${project.project} · ${project.privacy}${freshness}`, project.project));
    });
    projectSelect.disabled = false;
    const match = payload.projects.find(project => project.project.toLowerCase() === String(preferred || "").toLowerCase());
    projectSelect.value = match?.project || "";
    refreshButton.disabled = !projectSelect.value;
  } catch {
    projectSelect.disabled = true;
    refreshButton.disabled = true;
  }
}

async function loadStoredProject(project) {
  setGraph(await requestJson(`/api/projects/${encodeURIComponent(project)}/graph`));
  projectSelect.value = project;
  refreshButton.disabled = false;
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
    details.innerHTML = '<p class="eyebrow">Selection</p><h2>Filtered out</h2><p>Change the filters to restore the selected node.</p>';
  } else if (selectedId) {
    renderDetails(graph.nodes.find(node => node.id === selectedId));
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
    setGraph(await response.json());
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
  setGraph(JSON.parse(await file.text()));
  projectSelect.value = "";
  refreshButton.disabled = true;
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
projectSelect.addEventListener("change", async () => {
  if (projectSelect.value) await loadStoredProject(projectSelect.value);
  else await loadDefault();
});
refreshButton.addEventListener("click", async () => {
  if (!projectSelect.value) return;
  refreshButton.disabled = true;
  try {
    await requestJson(`/api/projects/${encodeURIComponent(projectSelect.value)}/scan`, {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body: "{}",
    });
    await loadStoredProject(projectSelect.value);
    await loadProjects(projectSelect.value);
  } finally {
    refreshButton.disabled = false;
  }
});
newProjectButton.addEventListener("click", () => {
  onboardingError.textContent = "";
  onboardingDialog.showModal();
});
cancelOnboarding.addEventListener("click", () => onboardingDialog.close());
projectPrivacy.addEventListener("change", () => {
  privacyDescription.textContent = {
    "shared": "Whisper indexes semantic project documents and enables persistent Codex/Claude handoffs. Source code remains local to Cartograph.",
    "map-only": "Cartograph maps the code locally. Whisper receives no project documents or checkpoints.",
    "private": "Cartograph maps the code locally and Whisper explicitly refuses project context, search, and checkpoints.",
  }[projectPrivacy.value];
});
onboardingForm.addEventListener("submit", async event => {
  event.preventDefault();
  onboardingError.textContent = "";
  const submit = onboardingForm.querySelector('button[type="submit"]');
  submit.disabled = true;
  const form = new FormData(onboardingForm);
  try {
    const result = await requestJson("/api/onboard", {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify({path: form.get("path"), name: form.get("name") || null, privacy: form.get("privacy")}),
    });
    onboardingDialog.close();
    onboardingForm.reset();
    projectPrivacy.dispatchEvent(new Event("change"));
    await loadProjects(result.project);
    await loadStoredProject(result.project);
  } catch (error) {
    onboardingError.textContent = error.message;
  } finally {
    submit.disabled = false;
  }
});
(async () => {
  await loadDefault();
  await loadProjects();
})();
