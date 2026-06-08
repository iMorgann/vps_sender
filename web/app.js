// ── VPS Sender Frontend Application ──────────────────────────────────────────

document.addEventListener("DOMContentLoaded", () => {
  // Application State
  const state = {
    activeTab: "dashboard",
    files: [],
    selectedFile: null,
    campaignRunning: false,
    campaignStats: { total: 0, sent: 0, failed: 0, greylisted: 0, reachable: 0, dropped: 0 }
  };

  // ── Tab Navigation ──────────────────────────────────────────────────────────
  const navItems = document.querySelectorAll(".nav-item");
  const tabContents = document.querySelectorAll(".tab-content");
  const currentTabTitle = document.getElementById("current-tab-title");

  navItems.forEach(item => {
    item.addEventListener("click", (e) => {
      e.preventDefault();
      const tabId = item.getAttribute("data-tab");
      
      navItems.forEach(i => i.classList.remove("active"));
      tabContents.forEach(c => c.classList.remove("active"));

      item.classList.add("active");
      const targetTab = document.getElementById(`tab-${tabId}`);
      if (targetTab) targetTab.classList.add("active");

      state.activeTab = tabId;
      currentTabTitle.textContent = item.textContent.trim();

      // Hook tab-specific load actions
      if (tabId === "file-manager") loadWorkspaceFiles();
      if (tabId === "campaign-wizard" || tabId === "smtp-scanner") loadWizardOptions();
    });
  });

  // ── Server-Sent Events (SSE) Stream ─────────────────────────────────────────
  const eventSource = new EventSource("/api/stream");
  const connectionIndicator = document.querySelector(".connection-status .status-indicator");
  const connectionText = document.querySelector(".connection-status");
  const engineStatus = document.getElementById("engine-status");
  const engineStatusText = document.getElementById("engine-status-text");

  // Remove static text nodes from HTML so JS owns the connection label exclusively
  [...connectionText.childNodes].forEach(n => { if (n.nodeType === Node.TEXT_NODE) n.remove(); });
  const connectionTextNode = document.createTextNode(" SSE Connected");
  connectionText.appendChild(connectionTextNode);

  eventSource.onopen = () => {
    connectionIndicator.className = "status-indicator connected";
    connectionTextNode.textContent = " SSE Connected";
  };

  eventSource.onerror = () => {
    connectionIndicator.className = "status-indicator disconnected";
    connectionTextNode.textContent = " SSE Offline";
  };

  eventSource.onmessage = (event) => {
    const data = JSON.parse(event.data);
    
    if (data.type === "state") {
      updateEngineStatus(data.status);
    }
    
    if (data.type === "log") {
      appendLog(data.text, data.logClass);
    }

    if (data.type === "scan_progress") {
      updateScanProgress(data);
    }

    if (data.type === "campaign_progress") {
      updateCampaignProgress(data);
    }
  };

  function updateEngineStatus(status) {
    engineStatus.className = `engine-status-badge ${status}`;
    engineStatusText.textContent = `Engine: ${status.charAt(0).toUpperCase() + status.slice(1)}`;
    
    const isSending = status === "sending" || status === "paused";
    state.campaignRunning = status === "sending";
    
    document.getElementById("btn-start").disabled = status === "sending" || status === "paused" || status === "scanning";
    document.getElementById("btn-pause").disabled = status !== "sending" && status !== "paused";
    document.getElementById("btn-pause").textContent = status === "paused" ? "Resume" : "Pause";
    document.getElementById("btn-stop").disabled = !isSending;
  }

  // ── Logging Console ─────────────────────────────────────────────────────────
  const logTerminal = document.getElementById("log-terminal");
  const btnClearLogs = document.getElementById("btn-clear-logs");

  function appendLog(text, logClass = "system") {
    const line = document.createElement("div");
    line.className = `terminal-line ${logClass}`;
    line.textContent = `[${new Date().toLocaleTimeString()}] ${text}`;
    logTerminal.appendChild(line);
    logTerminal.scrollTop = logTerminal.scrollHeight;
  }

  btnClearLogs.addEventListener("click", () => {
    logTerminal.innerHTML = '<div class="terminal-line system">=== Console cleared ===</div>';
  });

  function escHtml(s) {
    return String(s).replace(/&/g,"&amp;").replace(/"/g,"&quot;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
  }

  // ── Campaign Wizard ──────────────────────────────────────────────────────────
  const wizardForm = document.getElementById("campaign-form");

  async function loadWizardOptions() {
    try {
      const res = await fetch("/api/files");
      const data = await res.json();
      
      const recSelect = document.getElementById("wizard-recipient-file");
      const nameSelect = document.getElementById("wizard-names-file");
      const subjSelect = document.getElementById("wizard-subjects-file");
      const smtpSelect = document.getElementById("wizard-smtp-file");
      const scanSrcSelect = document.getElementById("scan-source-file");
      
      const bodiesContainer = document.getElementById("wizard-bodies-container");
      const attachmentsContainer = document.getElementById("wizard-attachments-container");

      // Clear
      recSelect.innerHTML = "";
      nameSelect.innerHTML = '<option value="">(None - use plain display names)</option>';
      subjSelect.innerHTML = "";
      smtpSelect.innerHTML = '<option value="direct">Direct-to-MX (Resolves MX directly, default)</option>';
      scanSrcSelect.innerHTML = "";
      bodiesContainer.innerHTML = "";
      attachmentsContainer.innerHTML = "";

      let htmlCount = 0;
      let attachCount = 0;

      function makeOption(value) {
        const opt = document.createElement("option");
        opt.value = value;
        opt.textContent = value;
        return opt;
      }

      function makeCheckbox(name, value, checked) {
        const label = document.createElement("label");
        label.className = "checkbox-wrapper";
        const input = document.createElement("input");
        input.type = "checkbox";
        input.name = name;
        input.value = value;
        input.checked = !!checked;
        const span = document.createElement("span");
        span.className = "checkbox-label";
        span.textContent = value;
        label.appendChild(input);
        label.appendChild(span);
        return label;
      }

      data.files.forEach(f => {
        if (f.endsWith(".txt") || f.endsWith(".csv")) {
          recSelect.appendChild(makeOption(f));
          scanSrcSelect.appendChild(makeOption(f));
          subjSelect.appendChild(makeOption(f));
          nameSelect.appendChild(makeOption(f));
          if (f.includes("smtp")) smtpSelect.appendChild(makeOption(f));
        }

        if (f.endsWith(".html") || f.endsWith(".htm")) {
          htmlCount++;
          bodiesContainer.appendChild(makeCheckbox("htmlBodies", f, htmlCount === 1));
        }

        if (f.endsWith(".pdf") || f.endsWith(".zip") || f.endsWith(".docx") || f.endsWith(".xlsx") || f.endsWith(".png") || f.endsWith(".jpg")) {
          attachCount++;
          attachmentsContainer.appendChild(makeCheckbox("attachments", f, false));
        }
      });

      // Select defaults
      selectDefaultOption(recSelect, "recipients.txt");
      selectDefaultOption(nameSelect, "names.txt");
      selectDefaultOption(subjSelect, "subjects.txt");
      selectDefaultOption(smtpSelect, "smtp.txt");
      selectDefaultOption(scanSrcSelect, "mxemails.txt");

      if (bodiesContainer.children.length === 0) {
        bodiesContainer.innerHTML = `<span class="text-dim text-center">No HTML templates found. Copy templates into workspace.</span>`;
      }
      if (attachmentsContainer.children.length === 0) {
        attachmentsContainer.innerHTML = `<span class="text-dim text-center">No attachments found in directory.</span>`;
      }

    } catch (e) {
      appendLog("Failed to load campaign wizard source files", "fail");
    }
  }

  function selectDefaultOption(select, value) {
    for (let opt of select.options) {
      if (opt.value === value) {
        select.value = value;
        return;
      }
    }
  }

  wizardForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const checkedBodies = Array.from(document.querySelectorAll('input[name="htmlBodies"]:checked')).map(el => el.value);
    const checkedAttachments = Array.from(document.querySelectorAll('input[name="attachments"]:checked')).map(el => el.value);

    const payload = {
      recipientsFile: document.getElementById("wizard-recipient-file").value,
      namesFile: document.getElementById("wizard-names-file").value,
      subjectsFile: document.getElementById("wizard-subjects-file").value,
      htmlFiles: checkedBodies,
      attachmentFiles: checkedAttachments,
      smtpFile: document.getElementById("wizard-smtp-file").value,
      rotEvery: parseInt(document.getElementById("wizard-rot-every").value, 10) || 2,
      resume: document.getElementById("wizard-resume").checked
    };

    try {
      const res = await fetch("/api/campaign/setup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
      const data = await res.json();
      if (data.success) {
        appendLog("Campaign configuration saved successfully. Starting scan...", "system");
        
        // Go to dashboard tab
        document.querySelector('[data-tab="dashboard"]').click();
        
        // Trigger campaign start
        startCampaign();
      } else {
        alert("Failed to apply configuration: " + data.error);
      }
    } catch (err) {
      alert("Error saving campaign configuration");
    }
  });

  // ── Campaign Controls ───────────────────────────────────────────────────────
  const btnStart = document.getElementById("btn-start");
  const btnPause = document.getElementById("btn-pause");
  const btnStop = document.getElementById("btn-stop");

  btnStart.addEventListener("click", () => {
    startCampaign();
  });

  btnPause.addEventListener("click", async () => {
    const isPaused = btnPause.textContent === "Resume";
    try {
      const endpoint = isPaused ? "/api/campaign/resume" : "/api/campaign/pause";
      const res = await fetch(endpoint, { method: "POST" });
      const data = await res.json();
      if (data.success) {
        appendLog(isPaused ? "Campaign resumed." : "Campaign paused.", "warn");
      }
    } catch (e) {
      appendLog("Failed to toggle pause state", "fail");
    }
  });

  btnStop.addEventListener("click", async () => {
    if (!confirm("Are you sure you want to stop the current campaign?")) return;
    try {
      const res = await fetch("/api/campaign/stop", { method: "POST" });
      const data = await res.json();
      if (data.success) {
        appendLog("Campaign stopped by user.", "fail");
      }
    } catch (e) {
      appendLog("Failed to stop campaign", "fail");
    }
  });

  async function startCampaign() {
    try {
      const res = await fetch("/api/campaign/start", { method: "POST" });
      const data = await res.json().catch(() => ({ success: false, error: `HTTP ${res.status}` }));
      if (!data.success) {
        alert("Could not start campaign: " + data.error);
      } else {
        appendLog("Outbound campaign began successfully.", "system");
      }
    } catch (e) {
      appendLog("Error launching campaign", "fail");
    }
  }

  function updateCampaignProgress(data) {
    const stats = data.stats;
    state.campaignStats = stats;

    document.getElementById("stats-total").textContent = stats.total;
    document.getElementById("stats-total-desc").textContent = `Reachable: ${stats.reachable} | Dropped: ${stats.dropped}`;
    document.getElementById("stats-sent").textContent = stats.sent;
    document.getElementById("stats-failed").textContent = stats.failed;
    document.getElementById("stats-greylisted").textContent = stats.greylisted;

    const totalToSend = stats.reachable || stats.total || 0;
    const completed = stats.sent + stats.failed;
    const progressPct = totalToSend ? Math.round((completed / totalToSend) * 100) : 0;
    
    document.getElementById("progress-bar").style.width = `${progressPct}%`;
    document.getElementById("btn-clear-logs").textContent = `Clear Logs (${progressPct}%)`;

    // Success percentages
    const sentPct = completed ? Math.round((stats.sent / completed) * 100) : 0;
    const failPct = completed ? Math.round((stats.failed / completed) * 100) : 0;
    document.getElementById("stats-sent-pct").textContent = `${sentPct}% Success rate`;
    document.getElementById("stats-failed-pct").textContent = `${failPct}% Failed`;

    // Meta details
    document.getElementById("meta-speed").textContent = `${(data.speed ?? 0).toFixed(1)} emails/s`;
    document.getElementById("meta-elapsed").textContent = formatDuration(data.elapsed ?? 0);
    document.getElementById("meta-eta").textContent = (data.eta > 0) ? `${data.eta}s` : "--";

    // Current output
    if (data.current) {
      document.getElementById("current-recipient").textContent = data.current.recipient || "--";
      document.getElementById("current-smtp").textContent = data.current.smtpLabel || "--";
      document.getElementById("current-sender").textContent = data.current.sender || "--";
      document.getElementById("current-subject").textContent = data.current.subject || "--";
    }

    drawChart(stats.sent, stats.failed, stats.greylisted);

    if (data.done) {
      updateEngineStatus("idle");
      document.getElementById("btn-clear-logs").textContent = "Clear Logs";
    }
  }

  function formatDuration(seconds) {
    if (seconds < 60) return `${seconds}s`;
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}m ${secs}s`;
  }

  // ── Workspace Files Editor ──────────────────────────────────────────────────
  const fileListUl = document.getElementById("file-list-ul");
  const fileEditor = document.getElementById("file-editor");
  const editingFileName = document.getElementById("editing-file-name");
  const btnSaveFile = document.getElementById("btn-save-file");

  async function loadWorkspaceFiles() {
    try {
      const res = await fetch("/api/files");
      const data = await res.json();
      state.files = data.files;
      
      fileListUl.innerHTML = "";
      state.files.forEach(f => {
        const ext = f.split(".").pop();
        const icon = (ext === "html" || ext === "htm") ? "📄" : "📁";
        const li = document.createElement("li");
        li.className = "file-list-item";
        const iconSpan = document.createElement("span");
        iconSpan.textContent = icon;
        li.appendChild(iconSpan);
        li.appendChild(document.createTextNode(" " + f));
        if (state.selectedFile === f) li.classList.add("active");
        
        li.addEventListener("click", () => {
          document.querySelectorAll(".file-list-item").forEach(item => item.classList.remove("active"));
          li.classList.add("active");
          selectFileForEditing(f);
        });

        fileListUl.appendChild(li);
      });
    } catch (e) {
      appendLog("Failed to list directory files", "fail");
    }
  }

  async function selectFileForEditing(filename) {
    state.selectedFile = filename;
    editingFileName.textContent = filename;
    fileEditor.disabled = false;
    btnSaveFile.disabled = false;
    fileEditor.value = "Loading content...";

    try {
      const res = await fetch(`/api/files/read?name=${encodeURIComponent(filename)}`);
      const data = await res.json();
      fileEditor.value = data.content;
    } catch (e) {
      fileEditor.value = "Error reading file content.";
      fileEditor.disabled = true;
      btnSaveFile.disabled = true;
    }
  }

  btnSaveFile.addEventListener("click", async () => {
    if (!state.selectedFile) return;
    btnSaveFile.disabled = true;
    btnSaveFile.textContent = "Saving...";

    try {
      const res = await fetch("/api/files/save", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: state.selectedFile, content: fileEditor.value })
      });
      const data = await res.json();
      if (data.success) {
        appendLog(`Successfully saved workspace file: ${state.selectedFile}`, "sent");
      } else {
        alert("Failed to save file: " + data.error);
      }
    } catch (err) {
      alert("Error writing file changes to disk.");
    } finally {
      btnSaveFile.disabled = false;
      btnSaveFile.textContent = "Save Changes";
    }
  });

  // ── SMTP / Domain Scanner ───────────────────────────────────────────────────
  const btnTriggerScan = document.getElementById("btn-trigger-scan");
  const scanResultsTbody = document.getElementById("scan-results-tbody");
  const scanCounterStatus = document.getElementById("scan-counter-status");

  btnTriggerScan.addEventListener("click", async () => {
    const file = document.getElementById("scan-source-file").value;
    const includeWeak = document.getElementById("scan-include-weak").checked;
    const output = document.getElementById("scan-output-file").value;

    btnTriggerScan.disabled = true;
    scanCounterStatus.className = "badge warning";
    scanCounterStatus.textContent = "Scanning...";
    scanResultsTbody.innerHTML = '<tr><td colspan="6" class="text-center text-dim">Resolving MX records and probing port 25...</td></tr>';
    
    appendLog(`Domain scanner initiated on ${file}...`, "system");

    try {
      const res = await fetch("/api/scan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ file, includeWeak, output })
      });
      const data = await res.json();
      if (!data.success) {
        alert("Scan could not start: " + data.error);
        btnTriggerScan.disabled = false;
        scanCounterStatus.className = "badge error";
        scanCounterStatus.textContent = "Failed";
      }
    } catch (e) {
      alert("Error triggering MX pre-scan");
      btnTriggerScan.disabled = false;
    }
  });

  function makeBadge(cls, text) {
    const s = document.createElement("span");
    s.className = `badge ${cls}`;
    s.textContent = text;
    return s;
  }

  function updateScanProgress(data) {
    if (data.results) {
      scanResultsTbody.replaceChildren();
      if (data.results.length === 0) {
        const emptyTr = document.createElement("tr");
        const emptyTd = document.createElement("td");
        emptyTd.colSpan = 6;
        emptyTd.className = "text-center text-dim";
        emptyTd.textContent = "No domains found in file.";
        emptyTr.appendChild(emptyTd);
        scanResultsTbody.appendChild(emptyTr);
      } else {
        data.results.forEach(d => {
          const tr = document.createElement("tr");

          // Domain cell
          const tdDomain = document.createElement("td");
          const strong = document.createElement("strong");
          strong.textContent = d.domain || "";
          tdDomain.appendChild(strong);
          tr.appendChild(tdDomain);

          // MX cell
          const tdMx = document.createElement("td");
          if (d.mx) { tdMx.textContent = d.mx; }
          else { tdMx.appendChild(makeBadge("text-dim", "none")); }
          tr.appendChild(tdMx);

          // Port 25
          const tdPort = document.createElement("td");
          tdPort.appendChild(d.port25Open ? makeBadge("success","OPEN") : makeBadge("error","BLOCKED"));
          tr.appendChild(tdPort);

          // SPF
          const tdSpf = document.createElement("td");
          tdSpf.appendChild(
            d.spfStrength === "hard" ? makeBadge("success","HARD") :
            d.spfStrength === "soft" ? makeBadge("warning","SOFT") :
            makeBadge("error","NONE")
          );
          tr.appendChild(tdSpf);

          // DMARC
          const tdDmarc = document.createElement("td");
          tdDmarc.appendChild(
            d.dmarcPolicy === "reject"      ? makeBadge("success","REJECT") :
            d.dmarcPolicy === "quarantine"  ? makeBadge("warning","QUARANTINE") :
            makeBadge("error","NONE")
          );
          tr.appendChild(tdDmarc);

          // Score
          const score = (d.port25Open ? 2 : 0)
            + (d.spfStrength !== "none" ? 1 : 0)
            + (d.dmarcPolicy !== "none" ? 1 : 0);
          const tdScore = document.createElement("td");
          tdScore.appendChild(makeBadge(
            score >= 3 ? "success" : score >= 1 ? "warning" : "error",
            `${score >= 3 ? "GOOD" : score >= 1 ? "WEAK" : "POOR"} (${score}/3)`
          ));
          tr.appendChild(tdScore);

          scanResultsTbody.appendChild(tr);
        });
      }
    }

    if (data.done) {
      btnTriggerScan.disabled = false;
      scanCounterStatus.className = "badge success";
      scanCounterStatus.textContent = "Done";
      appendLog(`Domain scanner finished. Generated ${data.entriesSaved} usable SMTP rotating entries.`, "sent");
      loadWizardOptions();
    }
  }

  // ── Template Previewer ──────────────────────────────────────────────────────
  const btnRefreshPreview = document.getElementById("btn-refresh-preview");
  const renderFromMeta = document.getElementById("render-from-meta");
  const renderToMeta = document.getElementById("render-to-meta");
  const renderSubjectMeta = document.getElementById("render-subject-meta");
  const previewIframe = document.getElementById("rendered-body-iframe");

  btnRefreshPreview.addEventListener("click", async () => {
    // Collect active input parameters
    const email = document.getElementById("preview-email").value;
    const name = document.getElementById("preview-name").value;
    const sender = document.getElementById("preview-sender").value;
    const subjectTmpl = document.getElementById("preview-subject-template").value;

    let bodyHTML = "<p>Draft HTML templates in Workspace Files tab to select here.</p>";
    
    // Read the active selected HTML file in workspace if it exists, or look for body.html
    let htmlFile = "body.html";
    const checked = document.querySelector('input[name="htmlBodies"]:checked');
    if (checked) htmlFile = checked.value;

    btnRefreshPreview.textContent = "Rendering...";
    btnRefreshPreview.disabled = true;

    try {
      const res = await fetch(`/api/files/read?name=${encodeURIComponent(htmlFile)}`);
      const fileData = await res.json();
      if (fileData.content) {
        bodyHTML = fileData.content;
      }
    } catch (e) {
      // Fallback
    }

    // Interpolate variables
    const domain = email.split("@")[1] || "domain.com";
    const variables = { email, domain, name };
    
    function interpolate(str, vars) {
      return str.replace(/\{\{(\w+)\}\}/g, (_, k) => vars[k] ?? "");
    }

    const renderedSubject = interpolate(subjectTmpl, variables);
    const renderedBody = interpolate(bodyHTML, variables);

    renderFromMeta.textContent = name ? `"${name}" <${sender}>` : sender;
    renderToMeta.textContent = email;
    renderSubjectMeta.textContent = renderedSubject;

    const blob = new Blob([renderedBody], { type: "text/html" });
    const blobUrl = URL.createObjectURL(blob);
    previewIframe.onload = () => URL.revokeObjectURL(blobUrl);
    previewIframe.src = blobUrl;

    btnRefreshPreview.textContent = "Render Template";
    btnRefreshPreview.disabled = false;
  });

  // ── System Settings ─────────────────────────────────────────────────────────
  const settingsForm = document.getElementById("settings-form");
  const btnTestProxy = document.getElementById("btn-test-proxy");
  const proxyTestStatus = document.getElementById("proxy-test-status");

  async function loadSettings() {
    try {
      const res = await fetch("/api/config");
      const data = await res.json();
      
      document.getElementById("settings-proxy").value       = data.proxyUrl        || "";
      document.getElementById("settings-delay").value       = data.sendDelay       ?? 1200;
      document.getElementById("settings-greylist").value    = data.greylistWait    ?? 60000;
      document.getElementById("settings-results-file").value= data.resultsFile     || "results.csv";
      document.getElementById("settings-helo-host").value   = data.heloHost        || "";
      document.getElementById("settings-concurrency").value = data.concurrency      ?? 2;
      document.getElementById("settings-unsubscribe").value = data.unsubscribeBaseUrl || "";
      document.getElementById("settings-tls-reject").checked = data.tlsRejectUnauthorized !== false;
    } catch (e) {
      appendLog("Failed to load settings from server", "fail");
    }
  }

  btnTestProxy.addEventListener("click", async () => {
    const proxyUrl = document.getElementById("settings-proxy").value.trim();
    btnTestProxy.disabled = true;
    proxyTestStatus.textContent = "Testing proxy connection...";
    proxyTestStatus.className = "form-hint text-dim";

    try {
      const res = await fetch("/api/proxy/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ proxyUrl })
      });
      const data = await res.json();
      if (data.success) {
        proxyTestStatus.textContent = `✓ Proxy Online: ${data.message}`;
        proxyTestStatus.className = "form-hint";
        proxyTestStatus.style.color = "var(--success)";
      } else {
        proxyTestStatus.textContent = `✗ Proxy Failed: ${data.error}`;
        proxyTestStatus.className = "form-hint";
        proxyTestStatus.style.color = "var(--error)";
      }
    } catch (e) {
      proxyTestStatus.textContent = "✗ Proxy connection error.";
      proxyTestStatus.style.color = "var(--error)";
    } finally {
      btnTestProxy.disabled = false;
    }
  });

  settingsForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const payload = {
      proxyUrl:              document.getElementById("settings-proxy").value.trim(),
      sendDelay:             parseInt(document.getElementById("settings-delay").value, 10),
      greylistWait:          parseInt(document.getElementById("settings-greylist").value, 10),
      resultsFile:           document.getElementById("settings-results-file").value.trim(),
      heloHost:              document.getElementById("settings-helo-host").value.trim(),
      concurrency:           parseInt(document.getElementById("settings-concurrency").value, 10),
      unsubscribeBaseUrl:    document.getElementById("settings-unsubscribe").value.trim(),
      tlsRejectUnauthorized: document.getElementById("settings-tls-reject").checked,
    };

    try {
      const res = await fetch("/api/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
      const data = await res.json();
      if (data.success) {
        appendLog("System configuration updated and saved.", "sent");
        alert("Configuration saved successfully.");
      } else {
        alert("Failed to save: " + data.error);
      }
    } catch (err) {
      alert("Error saving settings");
    }
  });

  // ── Canvas Statistics Chart ─────────────────────────────────────────────────
  const chartCanvas = document.getElementById("stats-chart");
  
  function drawChart(sent = 0, failed = 0, greylisted = 0) {
    const ctx = chartCanvas.getContext("2d");
    ctx.clearRect(0, 0, chartCanvas.width, chartCanvas.height);

    const total = sent + failed + greylisted;
    if (total === 0) {
      // Draw empty placeholder
      ctx.beginPath();
      ctx.arc(110, 60, 45, 0, 2 * Math.PI);
      ctx.strokeStyle = "rgba(255,255,255,0.05)";
      ctx.lineWidth = 12;
      ctx.stroke();
      
      ctx.fillStyle = "var(--text-dim)";
      ctx.font = "12px Outfit";
      ctx.textAlign = "center";
      ctx.fillText("No sending data yet", 110, 64);
      return;
    }

    const segments = [
      { val: sent, color: "#10b981", label: "Sent" },
      { val: failed, color: "#f43f5e", label: "Failed" },
      { val: greylisted, color: "#f59e0b", label: "Greylist" }
    ].filter(s => s.val > 0);

    let startAngle = -0.5 * Math.PI;
    const cx = 70;
    const cy = 75;
    const radius = 45;

    segments.forEach(seg => {
      const sliceAngle = (seg.val / total) * 2 * Math.PI;
      ctx.beginPath();
      ctx.arc(cx, cy, radius, startAngle, startAngle + sliceAngle);
      ctx.strokeStyle = seg.color;
      ctx.lineWidth = 14;
      ctx.lineCap = "round";
      ctx.stroke();
      startAngle += sliceAngle;
    });

    // Render legend
    let ly = 40;
    ctx.textAlign = "left";
    ctx.font = "12px Outfit";
    
    segments.forEach(seg => {
      // Colored circle
      ctx.beginPath();
      ctx.arc(140, ly - 4, 4, 0, 2 * Math.PI);
      ctx.fillStyle = seg.color;
      ctx.fill();

      // Label
      ctx.fillStyle = "var(--text-main)";
      ctx.fillText(`${seg.label}: ${seg.val}`, 152, ly);
      ly += 22;
    });
  }

  // ── Initial Load ────────────────────────────────────────────────────────────
  loadSettings();
  loadWizardOptions();
  drawChart(0, 0, 0); // Initial placeholder
});
