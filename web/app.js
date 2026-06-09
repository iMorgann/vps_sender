// ── VPS Sender Frontend Application ──────────────────────────────────────────

document.addEventListener("DOMContentLoaded", () => {
  // Application State
  const state = {
    activeTab: "dashboard",
    files: [],
    attachments: [],
    selectedFile: null,
    campaignRunning: false,
    campaignStats: { total: 0, sent: 0, failed: 0, greylisted: 0, reachable: 0, dropped: 0 }
  };

  // ── API Token + Fetch Helper ────────────────────────────────────────────────
  // Persist token across page reloads so the app remains usable after token setup
  let apiToken = localStorage.getItem("vps-sender-token") || "";

  function apiFetch(url, method = "GET", body = null) {
    const opts = { method, headers: { "Content-Type": "application/json" } };
    if (apiToken) opts.headers["X-API-Token"] = apiToken;
    if (body !== null) opts.body = JSON.stringify(body);
    return fetch(url, opts);
  }

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
  function buildSseUrl() {
    return "/api/stream" + (apiToken ? `?token=${encodeURIComponent(apiToken)}` : "");
  }
  let eventSource = new EventSource(buildSseUrl());
  const connectionIndicator = document.querySelector(".connection-status .status-indicator");
  const connectionText = document.querySelector(".connection-status");
  const engineStatus = document.getElementById("engine-status");
  const engineStatusText = document.getElementById("engine-status-text");

  // Remove static text nodes from HTML so JS owns the connection label exclusively
  [...connectionText.childNodes].forEach(n => { if (n.nodeType === Node.TEXT_NODE) n.remove(); });
  const connectionTextNode = document.createTextNode(" SSE Connected");
  connectionText.appendChild(connectionTextNode);

  // Attach handlers to an EventSource instance — called on init and after token change
  function attachSseHandlers(es) {
    es.onopen = () => {
      connectionIndicator.className = "status-indicator connected";
      connectionTextNode.textContent = " SSE Connected";
    };
    es.onerror = () => {
      connectionIndicator.className = "status-indicator disconnected";
      connectionTextNode.textContent = " SSE Offline";
    };
    es.onmessage = (event) => {
      let data;
      try { data = JSON.parse(event.data); } catch { return; }
      if (data.type === "state")             updateEngineStatus(data.status);
      if (data.type === "log")               appendLog(data.text, data.logClass);
      if (data.type === "scan_progress")     updateScanProgress(data);
      if (data.type === "campaign_progress") updateCampaignProgress(data);
    };
  }
  attachSseHandlers(eventSource);

  function updateEngineStatus(status) {
    engineStatus.className = `engine-status-badge ${status}`;
    engineStatusText.textContent = `Engine: ${status.charAt(0).toUpperCase() + status.slice(1)}`;

    const isSending = status === "sending" || status === "paused";
    state.campaignRunning = status === "sending";

    document.getElementById("btn-start").disabled = status === "sending" || status === "paused" || status === "scanning";
    document.getElementById("btn-pause").disabled = status !== "sending" && status !== "paused";
    document.getElementById("btn-pause").textContent = status === "paused" ? "Resume" : "Pause";
    document.getElementById("btn-stop").disabled = !isSending;
    // Scan button: disabled while scanning; re-enabled on idle/sending/paused so a failed scan doesn't lock it
    const scanBtn = document.getElementById("btn-trigger-scan");
    if (scanBtn) scanBtn.disabled = (status === "scanning");
  }

  // ── Logging Console ─────────────────────────────────────────────────────────
  const logTerminal = document.getElementById("log-terminal");
  const btnClearLogs = document.getElementById("btn-clear-logs");

  function appendLog(text, logClass = "system") {
    const line = document.createElement("div");
    line.className = `terminal-line ${logClass}`;
    line.textContent = `[${new Date().toLocaleTimeString()}] ${text}`;
    logTerminal.appendChild(line);
    // Cap at 500 lines to prevent DOM bloat on long campaigns
    while (logTerminal.children.length > 500) logTerminal.removeChild(logTerminal.firstChild);
    logTerminal.scrollTop = logTerminal.scrollHeight;
  }

  btnClearLogs.addEventListener("click", () => {
    logTerminal.innerHTML = '<div class="terminal-line system">=== Console cleared ===</div>';
  });

  // ── Campaign Wizard ──────────────────────────────────────────────────────────
  const wizardForm = document.getElementById("campaign-form");

  function populateWizardFromData(data) {
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

      // text files
      (data.files || []).forEach(f => {
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
      });

      // binary attachments from the new API field
      (data.attachments || []).forEach(a => {
        attachmentsContainer.appendChild(makeCheckbox("attachments", a.name, false));
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
  }

  async function loadWizardOptions() {
    try {
      const res  = await apiFetch("/api/files");
      if (!res.ok) { appendLog(`Wizard load failed (HTTP ${res.status})`, "fail"); return; }
      const data = await res.json();
      populateWizardFromData(data);
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
      const res = await apiFetch("/api/campaign/setup", "POST", payload);
      const data = await res.json();
      if (data.success) {
        appendLog("Campaign configuration saved. Starting campaign...", "system");
        
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
      const res = await apiFetch(endpoint, "POST");
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
      const res = await apiFetch("/api/campaign/stop", "POST");
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
      const res = await apiFetch("/api/campaign/start", "POST");
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
    if (!stats) return;
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
  const fileListUl       = document.getElementById("file-list-ul");
  const fileEditor       = document.getElementById("file-editor");
  const editingFileName  = document.getElementById("editing-file-name");
  const btnSaveFile      = document.getElementById("btn-save-file");
  const btnNewFile       = document.getElementById("btn-new-file");
  const btnUploadFile    = document.getElementById("btn-upload-file");
  const btnDownloadFile  = document.getElementById("btn-download-file");
  const btnDeleteFile    = document.getElementById("btn-delete-file");
  const btnPasteClipboard= document.getElementById("btn-paste-clipboard");
  const fileUploadInput  = document.getElementById("file-upload-input");
  const editorDropZone   = document.getElementById("editor-drop-zone");
  const dropOverlay      = document.getElementById("drop-overlay");
  const attachmentListUl = document.getElementById("attachment-list-ul");
  const attachmentEmptyMsg = document.getElementById("attachment-empty-msg");
  const btnUploadAttachment = document.getElementById("btn-upload-attachment");
  const attachmentUploadInput = document.getElementById("attachment-upload-input");

  const TEXT_EXTS_FE = new Set([".txt",".csv",".html",".htm"]);

  function extOf(name) { return name.slice(name.lastIndexOf(".")).toLowerCase(); }

  function updateToolbarState() {
    const hasFile = !!state.selectedFile;
    btnDownloadFile.disabled  = !hasFile;
    btnDeleteFile.disabled    = !hasFile;
    btnPasteClipboard.disabled= !hasFile || !TEXT_EXTS_FE.has(extOf(state.selectedFile || ""));
  }

  async function loadWorkspaceFiles() {
    try {
      const res  = await apiFetch("/api/files");
      if (!res.ok) { appendLog(`File list load failed (HTTP ${res.status})`, "fail"); return; }
      const data = await res.json();
      state.files       = data.files       || [];
      state.attachments = data.attachments || [];

      fileListUl.innerHTML = "";
      state.files.forEach(f => {
        const icon = (f.endsWith(".html") || f.endsWith(".htm")) ? "📄" : "📁";
        const li   = document.createElement("li");
        li.className = "file-list-item";
        const iconSpan = document.createElement("span");
        iconSpan.textContent = icon;
        li.appendChild(iconSpan);
        li.appendChild(document.createTextNode(" " + f));
        if (state.selectedFile === f) li.classList.add("active");
        li.addEventListener("click", () => {
          document.querySelectorAll(".file-list-item").forEach(i => i.classList.remove("active"));
          li.classList.add("active");
          selectFileForEditing(f);
        });
        fileListUl.appendChild(li);
      });

      // Attachment list
      attachmentListUl.innerHTML = "";
      if (state.attachments.length === 0) {
        attachmentListUl.innerHTML = '<li class="text-dim" id="attachment-empty-msg">No attachment files in workspace.</li>';
      } else {
        state.attachments.forEach(a => {
          const li = document.createElement("li");
          li.className = "attachment-list-item";
          const size = a.size < 1024 ? `${a.size} B` : a.size < 1048576 ? `${(a.size/1024).toFixed(1)} KB` : `${(a.size/1048576).toFixed(1)} MB`;
          const nameSpan = document.createElement("span");
          nameSpan.className = "attachment-name";
          nameSpan.textContent = "📎 " + a.name;
          const sizeSpan = document.createElement("span");
          sizeSpan.className = "attachment-size text-dim";
          sizeSpan.textContent = size;
          li.appendChild(nameSpan);
          li.appendChild(sizeSpan);
          const dlBtn = document.createElement("button");
          dlBtn.className = "btn btn-sm btn-secondary";
          dlBtn.textContent = "↓";
          dlBtn.title = "Download";
          dlBtn.addEventListener("click", () => downloadFile(a.name));
          const delBtn = document.createElement("button");
          delBtn.className = "btn btn-sm btn-danger-sm";
          delBtn.textContent = "🗑";
          delBtn.title = "Delete";
          delBtn.addEventListener("click", () => deleteWorkspaceFile(a.name));
          li.appendChild(dlBtn);
          li.appendChild(delBtn);
          attachmentListUl.appendChild(li);
        });
      }

      updateToolbarState();
      // Populate wizard dropdowns from the same data — avoids a second /api/files fetch
      populateWizardFromData(data);
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
    updateToolbarState();

    try {
      const res  = await apiFetch(`/api/files/read?name=${encodeURIComponent(filename)}`);
      const data = await res.json();
      if (state.selectedFile !== filename) return; // user navigated away before fetch completed
      fileEditor.value = data.content ?? "";
    } catch (e) {
      if (state.selectedFile !== filename) return;
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
      const res  = await apiFetch("/api/files/save", "POST", { name: state.selectedFile, content: fileEditor.value });
      const data = await res.json();
      if (data.success) {
        appendLog(`Saved: ${state.selectedFile}`, "sent");
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

  // New File
  btnNewFile.addEventListener("click", () => {
    const name = prompt("New file name (e.g. list2.txt, template2.html):");
    if (!name || !name.trim()) return;
    const trimmed = name.trim();
    // Create empty file via save
    apiFetch("/api/files/save", "POST", { name: trimmed, content: "" })
      .then(r => r.json())
      .then(d => {
        if (d.success) {
          appendLog(`Created: ${trimmed}`, "sent");
          loadWorkspaceFiles().then(() => selectFileForEditing(trimmed));
        } else {
          alert("Could not create file: " + d.error);
        }
      })
      .catch(() => alert("Error creating file"));
  });

  // Upload (text + binary)
  btnUploadFile.addEventListener("click", () => fileUploadInput.click());
  fileUploadInput.addEventListener("change", (e) => {
    handleFileInputUpload(e.target.files);
    fileUploadInput.value = ""; // reset so the same file can be re-uploaded
  });

  async function handleFileInputUpload(fileList) {
    for (const file of fileList) {
      await uploadFile(file);
    }
    await loadWorkspaceFiles();
  }

  async function uploadFile(file) {
    try {
      const isText = TEXT_EXTS_FE.has(extOf(file.name));
      let data, encoding;
      if (isText) {
        data     = await file.text();
        encoding = "utf8";
      } else {
        const buf   = await file.arrayBuffer();
        const bytes = new Uint8Array(buf);
        let binary  = "";
        const CHUNK = 0x8000; // 32 KB — avoids O(n²) concat and stack overflow from huge spreads
        for (let i = 0; i < bytes.length; i += CHUNK) {
          binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
        }
        data     = btoa(binary);
        encoding = "base64";
      }
      const res = await apiFetch("/api/files/upload", "POST", { name: file.name, data, encoding });
      const json = await res.json();
      if (json.success) {
        appendLog(`Uploaded: ${file.name}`, "sent");
      } else {
        appendLog(`Upload failed: ${file.name} — ${json.error}`, "fail");
      }
    } catch (e) {
      appendLog(`Upload error: ${file.name}`, "fail");
    }
  }

  // Download
  btnDownloadFile.addEventListener("click", () => {
    if (state.selectedFile) downloadFile(state.selectedFile);
  });

  function downloadFile(name) {
    const tokenParam = apiToken ? `&token=${encodeURIComponent(apiToken)}` : "";
    const a = document.createElement("a");
    a.href = `/api/files/download?name=${encodeURIComponent(name)}${tokenParam}`;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  // Delete
  btnDeleteFile.addEventListener("click", () => {
    if (state.selectedFile) deleteWorkspaceFile(state.selectedFile);
  });

  async function deleteWorkspaceFile(name) {
    if (!confirm(`Delete "${name}"? This cannot be undone.`)) return;
    try {
      const res  = await apiFetch("/api/files/delete", "POST", { name });
      const data = await res.json();
      if (data.success) {
        appendLog(`Deleted: ${name}`, "warn");
        if (state.selectedFile === name) {
          state.selectedFile = null;
          editingFileName.textContent = "Select a file to edit";
          fileEditor.value = "";
          fileEditor.disabled = true;
          btnSaveFile.disabled = true;
        }
        loadWorkspaceFiles();
      } else {
        alert("Could not delete: " + data.error);
      }
    } catch (e) {
      alert("Error deleting file");
    }
  }

  // Paste from clipboard
  btnPasteClipboard.addEventListener("click", async () => {
    try {
      const text = await navigator.clipboard.readText();
      fileEditor.value = text;
      fileEditor.dispatchEvent(new Event("input"));
      appendLog("Clipboard content pasted into editor.", "system");
    } catch (e) {
      alert("Clipboard access denied. Use Ctrl+V to paste manually.");
    }
  });

  // Attachment upload button
  btnUploadAttachment.addEventListener("click", () => attachmentUploadInput.click());
  attachmentUploadInput.addEventListener("change", (e) => {
    handleFileInputUpload(e.target.files);
    attachmentUploadInput.value = ""; // reset so the same file can be re-uploaded
  });

  // Drag-and-drop on editor panel
  editorDropZone.addEventListener("dragover", (e) => {
    e.preventDefault();
    dropOverlay.style.display = "flex";
  });
  editorDropZone.addEventListener("dragleave", (e) => {
    if (!editorDropZone.contains(e.relatedTarget)) dropOverlay.style.display = "none";
  });
  editorDropZone.addEventListener("drop", async (e) => {
    e.preventDefault();
    dropOverlay.style.display = "none";
    const files = e.dataTransfer.files;
    if (!files.length) return;
    await handleFileInputUpload(files);
    // If single text file dropped, open it for editing
    if (files.length === 1 && TEXT_EXTS_FE.has(extOf(files[0].name))) {
      selectFileForEditing(files[0].name);
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
      const res = await apiFetch("/api/scan", "POST", { file, includeWeak, output });
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
            `${score >= 3 ? "GOOD" : score >= 1 ? "WEAK" : "POOR"} (${score}/4)`
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
      const res = await apiFetch(`/api/files/read?name=${encodeURIComponent(htmlFile)}`);
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

    // Revoke any previous blob URL before creating a new one to avoid leaks
    if (previewIframe._prevBlobUrl) {
      URL.revokeObjectURL(previewIframe._prevBlobUrl);
      previewIframe._prevBlobUrl = null;
    }
    const blob = new Blob([renderedBody], { type: "text/html" });
    const blobUrl = URL.createObjectURL(blob);
    previewIframe._prevBlobUrl = blobUrl;
    previewIframe.onload = () => { URL.revokeObjectURL(blobUrl); previewIframe._prevBlobUrl = null; };
    previewIframe.src = blobUrl;

    btnRefreshPreview.textContent = "Render Template";
    btnRefreshPreview.disabled = false;
  });

  // ── System Settings ─────────────────────────────────────────────────────────
  const settingsForm    = document.getElementById("settings-form");
  const btnTestProxy    = document.getElementById("btn-test-proxy");
  const proxyTestStatus = document.getElementById("proxy-test-status");
  const bindHostSelect  = document.getElementById("settings-bind-host");
  const apiTokenInput   = document.getElementById("settings-api-token");
  const publicWarning   = document.getElementById("public-no-token-warning");
  const publicUrlGroup  = document.getElementById("public-url-group");
  const publicUrlText   = document.getElementById("public-url-text");
  const btnCopyUrl      = document.getElementById("btn-copy-url");

  function updatePublicUrlDisplay() {
    const bind   = bindHostSelect.value;
    const domain = document.getElementById("settings-domain").value.trim();
    const port   = document.getElementById("settings-port").value || "3000";
    const isPublic = bind === "0.0.0.0";
    // Token field is intentionally blank on load (never pre-filled for security).
    // Use serverTokenIsSet to know if a token is already configured on the server.
    const hasToken = serverTokenIsSet || !!apiTokenInput.value.trim();
    publicWarning.style.display = (isPublic && !hasToken) ? "block" : "none";

    // Public URL
    if (isPublic) {
      const host = domain || window.location.hostname;
      publicUrlText.textContent = `http://${host}:${port}`;
      publicUrlGroup.style.display = "block";
    } else {
      publicUrlGroup.style.display = "none";
    }
  }

  bindHostSelect.addEventListener("change", updatePublicUrlDisplay);
  apiTokenInput.addEventListener("input", updatePublicUrlDisplay);
  document.getElementById("settings-domain").addEventListener("input", updatePublicUrlDisplay);
  document.getElementById("settings-port").addEventListener("input", updatePublicUrlDisplay);

  btnCopyUrl.addEventListener("click", () => {
    navigator.clipboard.writeText(publicUrlText.textContent).then(() => {
      btnCopyUrl.textContent = "Copied!";
      setTimeout(() => { btnCopyUrl.textContent = "Copy"; }, 2000);
    });
  });

  // ── Transport toggle ────────────────────────────────────────────────────────
  function toggleRelayFields(show) {
    document.getElementById("relay-fields").classList.toggle("hidden", !show);
  }

  document.getElementById("settings-transport").addEventListener("change", e => {
    toggleRelayFields(e.target.value === "relay");
  });

  // ── DKIM generate ────────────────────────────────────────────────────────────
  document.getElementById("btn-generate-dkim").addEventListener("click", async () => {
    const domain   = document.getElementById("settings-dkim-domain").value.trim();
    const selector = document.getElementById("settings-dkim-selector").value.trim() || "mail";
    if (!domain) { alert("Enter a domain first."); return; }

    const btn = document.getElementById("btn-generate-dkim");
    btn.disabled = true;
    btn.textContent = "Generating…";

    try {
      const res  = await apiFetch("/api/dkim/generate", "POST", { domain, selector });
      const data = await res.json();
      if (!data.success) { alert("DKIM generation failed: " + (data.error || "unknown error")); return; }

      document.getElementById("dns-spf-name").textContent  = data.dns.spf.name  + "   (TXT)";
      document.getElementById("dns-spf-value").textContent = data.dns.spf.value;
      document.getElementById("dns-dkim-name").textContent = data.dns.dkim.name + "   (TXT)";
      document.getElementById("dns-dkim-value").textContent= data.dns.dkim.value;
      document.getElementById("dns-dmarc-name").textContent= data.dns.dmarc.name + "   (TXT)";
      document.getElementById("dns-dmarc-value").textContent = data.dns.dmarc.value;

      const mtaEl = document.getElementById("dkim-mta-instructions");
      mtaEl.textContent = "";
      const p = document.createElement("p");
      p.className = "form-hint";
      if (data.os === "win32") {
        p.textContent = `Windows (hMailServer): In hMailServer Admin, go to Domains → ${domain} → DKIM Signing, enable it, set selector to "${selector}", and paste the private key from dkim/${domain}.pem.`;
      } else {
        p.textContent = `Linux/Mac (Postfix): The private key was saved to dkim/${domain}.pem. Add the DKIM record to DNS, then reload Postfix: sudo postfix reload`;
      }
      mtaEl.appendChild(p);

      document.getElementById("dkim-result").style.display = "block";
      appendLog(`DKIM keys generated for ${domain} (selector: ${selector})`, "sent");
      // Refresh DKIM config textarea
      loadSettings();
    } catch (e) {
      alert("Error generating DKIM keys: " + e.message);
    } finally {
      btn.disabled = false;
      btn.textContent = "Generate DKIM Keys";
    }
  });

  async function loadSettings() {
    try {
      const res  = await apiFetch("/api/config");
      if (!res.ok) {
        appendLog(`Settings load failed (HTTP ${res.status}) — check your API token`, "fail");
        return;
      }
      const data = await res.json();

      document.getElementById("settings-proxy").value        = data.proxyUrl           || "";
      document.getElementById("settings-delay").value        = data.sendDelay          ?? 1500;
      document.getElementById("settings-greylist").value     = data.greylistWait       ?? 60000;
      document.getElementById("settings-results-file").value = data.resultsFile        || "results.csv";
      document.getElementById("settings-helo-host").value    = data.heloHost           || "";
      document.getElementById("settings-concurrency").value  = data.concurrency        ?? 2;
      document.getElementById("settings-unsubscribe").value  = data.unsubscribeBaseUrl || "";
      document.getElementById("settings-tls-reject").checked = data.tlsRejectUnauthorized !== false;
      bindHostSelect.value = data.bindHost || "127.0.0.1";
      document.getElementById("settings-port").value   = data.port   || 3000;
      document.getElementById("settings-domain").value = data.domain || "";
      // apiToken: never pre-fill the field; track server-side state separately
      serverTokenIsSet          = data.apiToken === "***";
      tokenFieldDirty           = false;
      relayPassDirty            = false;
      apiTokenInput.value       = "";
      apiTokenInput.placeholder = serverTokenIsSet
        ? "Token is set — type to change, clear to remove"
        : "Leave blank to disable auth";

      // Sending options
      document.getElementById("settings-sending-ip").value       = data.sendingIp || "auto";
      document.getElementById("settings-direct-mx").checked      = data.directToMxOnly !== false;
      document.getElementById("settings-allow-weak").checked     = data.allowWeakDomains !== false;

      // Transport / relay
      document.getElementById("settings-transport").value        = data.transport      || "direct";
      document.getElementById("settings-relay-host").value       = data.relayHost      || "127.0.0.1";
      document.getElementById("settings-relay-port").value       = data.relayPort      ?? 587;
      document.getElementById("settings-relay-user").value       = data.relayUser      || "";
      document.getElementById("settings-relay-pass").value       = "";  // never pre-fill password
      document.getElementById("settings-prescan-relay").checked  = data.preScanRelay   !== false;
      document.getElementById("settings-envelope-domain").value  = data.envelopeDomain || "";
      toggleRelayFields(data.transport === "relay");

      // Warmup
      const warmup = data.warmup || {};
      document.getElementById("settings-warmup-enabled").checked  = !!warmup.enabled;
      document.getElementById("settings-warmup-daily").value      = warmup.dailyLimit ?? 100;
      document.getElementById("settings-warmup-increment").value  = warmup.incrementPerDay ?? 50;

      // JSON fields — pretty-print for editing
      try { document.getElementById("settings-rate-limits").value = JSON.stringify(data.rateLimits || {}, null, 2); } catch {}
      try { document.getElementById("settings-dkim").value        = JSON.stringify(data.dkim       || {}, null, 2); } catch {}

      updatePublicUrlDisplay();
    } catch (e) {
      appendLog("Failed to load settings from server", "fail");
    }
  }

  btnTestProxy.addEventListener("click", async () => {
    const proxyUrl = document.getElementById("settings-proxy").value.trim();
    btnTestProxy.disabled = true;
    proxyTestStatus.style.color = ""; // clear any inline color left from a previous test
    proxyTestStatus.textContent = "Testing proxy connection...";
    proxyTestStatus.className = "form-hint text-dim";

    try {
      const res  = await apiFetch("/api/proxy/test", "POST", { proxyUrl });
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

  // Track whether the user has touched the token / relay-pass fields since last load
  let tokenFieldDirty    = false;
  let relayPassDirty     = false;
  let serverTokenIsSet   = false;
  apiTokenInput.addEventListener("input", () => { tokenFieldDirty = true; });
  document.getElementById("settings-relay-pass").addEventListener("input", () => { relayPassDirty = true; });

  settingsForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const tokenVal = apiTokenInput.value;
    const payload = {
      proxyUrl:              document.getElementById("settings-proxy").value.trim(),
      sendDelay:             parseInt(document.getElementById("settings-delay").value, 10),
      greylistWait:          parseInt(document.getElementById("settings-greylist").value, 10),
      resultsFile:           document.getElementById("settings-results-file").value.trim(),
      heloHost:              document.getElementById("settings-helo-host").value.trim(),
      concurrency:           parseInt(document.getElementById("settings-concurrency").value, 10),
      unsubscribeBaseUrl:    document.getElementById("settings-unsubscribe").value.trim(),
      tlsRejectUnauthorized: document.getElementById("settings-tls-reject").checked,
      bindHost:              bindHostSelect.value,
      port:                  parseInt(document.getElementById("settings-port").value, 10) || 3000,
      domain:                document.getElementById("settings-domain").value.trim(),
      apiToken:              tokenFieldDirty ? tokenVal : "***", // not touched → keep existing
      sendingIp:             document.getElementById("settings-sending-ip").value.trim() || "auto",
      directToMxOnly:        document.getElementById("settings-direct-mx").checked,
      allowWeakDomains:      document.getElementById("settings-allow-weak").checked,
      transport:             document.getElementById("settings-transport").value,
      relayHost:             document.getElementById("settings-relay-host").value.trim() || "127.0.0.1",
      relayPort:             parseInt(document.getElementById("settings-relay-port").value, 10) || 587,
      relayUser:             document.getElementById("settings-relay-user").value.trim(),
      relayPass:             relayPassDirty ? document.getElementById("settings-relay-pass").value : "***",
      preScanRelay:          document.getElementById("settings-prescan-relay").checked,
      envelopeDomain:        document.getElementById("settings-envelope-domain").value.trim(),
      warmup: {
        enabled:         document.getElementById("settings-warmup-enabled").checked,
        dailyLimit:      parseInt(document.getElementById("settings-warmup-daily").value, 10)     || 100,
        incrementPerDay: parseInt(document.getElementById("settings-warmup-increment").value, 10) || 50,
      },
    };
    // JSON textarea fields — skip on parse error rather than blocking save
    try { payload.rateLimits = JSON.parse(document.getElementById("settings-rate-limits").value || "{}"); } catch {}
    try { payload.dkim       = JSON.parse(document.getElementById("settings-dkim").value       || "{}"); } catch {}

    try {
      const res  = await apiFetch("/api/config", "POST", payload);
      const data = await res.json();
      if (data.success) {
        // Reconnect SSE only after server has the new token — avoids 401 on reconnect
        if (tokenFieldDirty) {
          apiToken = tokenVal;
          // Persist so the app stays functional after page reload
          if (tokenVal) {
            localStorage.setItem("vps-sender-token", tokenVal);
          } else {
            localStorage.removeItem("vps-sender-token");
          }
          eventSource.close();
          eventSource = new EventSource(buildSseUrl());
          attachSseHandlers(eventSource);
        }
        tokenFieldDirty = false;
        relayPassDirty  = false;
        appendLog("Configuration saved. Restart the server to apply bind/port changes.", "sent");
        alert("Configuration saved. Restart the server for bind address / port changes to take effect.");
        loadSettings();
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
  drawChart(0, 0, 0);
});
