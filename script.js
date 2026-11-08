const API = "https://parx-am.vercel.app/api";
const RETRIES = 3;
const TIMEOUT = 20000;

const $ = (id) => document.getElementById(id);
const logList = $("log-list");

function addLog(message, type = "info") {
  const empty = logList.querySelector(".log-empty");
  if (empty) empty.remove();
  const row = document.createElement("div");
  row.className = `log-entry ${type}`;
  const time = document.createElement("span");
  time.className = "log-time";
  time.textContent = new Date().toLocaleTimeString("id-ID");
  const msg = document.createElement("span");
  msg.className = "log-message";
  msg.textContent = message;
  row.append(time, msg);
  logList.prepend(row);
}

function setBusy(button, busy, label) {
  button.disabled = busy;
  button.dataset.original = button.dataset.original || button.innerHTML;
  button.innerHTML = busy ? "Processing..." : (label || button.dataset.original);
}

async function apiRequest(path, options = {}) {
  let lastError;
  for (let attempt = 0; attempt <= RETRIES; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT);
    try {
      const response = await fetch(`${API}${path}`, {
        method: options.method || "GET",
        headers: { "Content-Type": "application/json", "Accept": "application/json" },
        body: options.body ? JSON.stringify(options.body) : undefined,
        signal: controller.signal
      });
      const raw = await response.text();
      let data;
      try { data = JSON.parse(raw); }
      catch { throw new Error(`Respons bukan JSON (HTTP ${response.status})`); }

      addLog(`${response.status} ${options.method || "GET"} ${path}`);
      if (!response.ok || data.success === false) {
        const error = new Error(data.error || data.message || `HTTP ${response.status}`);
        if ([408, 425, 429, 500, 502, 503, 504].includes(response.status) && attempt < RETRIES) {
          const retryAfter = Number(response.headers.get("retry-after"));
          await new Promise(resolve => setTimeout(resolve, retryAfter > 0 ? retryAfter * 1000 : 1000 * (2 ** attempt)));
          lastError = error;
          continue;
        }
        throw error;
      }
      return data;
    } catch (error) {
      lastError = error;
      const retryable = error.name === "AbortError" || error instanceof TypeError;
      if (!retryable || attempt === RETRIES) throw error;
      await new Promise(resolve => setTimeout(resolve, 800 * (2 ** attempt)));
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError || new Error("Request gagal.");
}

function normalizeMagicLink(raw) {
  let url;
  try { url = new URL(String(raw || "").trim().replace(/^["']|["']$/g, "")); }
  catch { throw new Error("Magic link bukan URL yang valid."); }

  for (let i = 0; i < 3 && !url.searchParams.get("oobCode"); i++) {
    const inner = url.searchParams.get("link") || url.searchParams.get("deep_link_id");
    if (!inner) break;
    try { url = new URL(inner); } catch { break; }
  }

  const oobCode = url.searchParams.get("oobCode");
  if (!oobCode) throw new Error("Magic link tidak valid: oobCode tidak ditemukan.");
  const params = new URLSearchParams({
    mode: url.searchParams.get("mode") || "signIn",
    oobCode
  });
  const apiKey = url.searchParams.get("apiKey");
  if (apiKey) params.set("apiKey", apiKey);
  return `https://alight-creative.firebaseapp.com/__/auth/action?${params}`;
}

function validEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email);
}

function showResult(data, kind) {
  const content = $("result-content");
  const indicator = $("result-indicator");
  indicator.className = `result-indicator ${kind}`;
  content.className = "result-data";
  content.replaceChildren();

  const fields = kind === "success"
    ? [
        ["Status", "Success"],
        ["Email", data.data?.email || data.email || "-"],
        ["UID", data.data?.uid || data.uid || "-"],
        ["Order ID", data.data?.orderId || data.orderId || "-"]
      ]
    : [["Status", "Failed"], ["Message", data.error || data.message || "Request gagal."]];

  for (const [label, value] of fields) {
    const row = document.createElement("div");
    row.className = "result-row";
    const left = document.createElement("span");
    left.textContent = label;
    const right = document.createElement("strong");
    right.textContent = String(value);
    row.append(left, right);
    content.append(row);
  }
}

async function refreshStats() {
  $("service-stat").textContent = "Checking";
  try {
    const data = await apiRequest("/stats");
    $("total-stat").textContent = data.total ?? "--";
    $("today-stat").textContent = data.today ?? "--";
    $("service-stat").textContent = "Online";
    $("connection-label").textContent = "Connected";
    addLog("Statistics berhasil diperbarui.", "success");
  } catch (error) {
    $("service-stat").textContent = "Offline";
    $("connection-label").textContent = "Unavailable";
    addLog(`Stats: ${error.message}`, "error");
  }
}

$("send-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const email = $("send-email").value.trim();
  const button = $("send-button");
  if (!validEmail(email)) return addLog("Format email tidak valid.", "error");
  setBusy(button, true);
  addLog(`Meminta magic link untuk ${email}...`);
  try {
    const data = await apiRequest("/send-link", { method: "POST", body: { email } });
    showResult(data, "success");
    addLog(data.message || "Permintaan magic link berhasil.", "success");
    $("verify-email").value = email;
  } catch (error) {
    showResult({ error: error.message }, "error");
    addLog(error.message, "error");
  } finally { setBusy(button, false, 'Send link <span>↗</span>'); }
});

$("verify-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const email = $("verify-email").value.trim();
  const rawLink = $("magic-link").value.trim();
  const button = $("verify-button");
  if (!validEmail(email)) return addLog("Format email tidak valid.", "error");
  let magicLink;
  try { magicLink = normalizeMagicLink(rawLink); }
  catch (error) { return addLog(error.message, "error"); }

  setBusy(button, true);
  addLog(`Mengirim proses verifikasi untuk ${email}...`);
  try {
    const data = await apiRequest("/verify-link", {
      method: "POST",
      body: { email, magicLink }
    });
    showResult(data, "success");
    addLog("Verifikasi berhasil.", "success");
    $("magic-link").value = "";
    refreshStats();
  } catch (error) {
    showResult({ error: error.message }, "error");
    addLog(error.message, "error");
  } finally { setBusy(button, false, 'Verify link <span>↗</span>'); }
});

$("refresh-stats").addEventListener("click", refreshStats);
$("clear-log").addEventListener("click", () => {
  logList.innerHTML = '<div class="log-empty">Waiting for activity...</div>';
});
refreshStats();
