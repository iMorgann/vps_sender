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

  // ── Mobile sidebar ──────────────────────────────────────────────────────────
  const sidebarEl      = document.querySelector(".sidebar");
  const sidebarOverlay = document.getElementById("sidebar-overlay");
  const hamburgerBtn   = document.getElementById("hamburger-btn");

  function openSidebar()  { sidebarEl.classList.add("sidebar-open");    sidebarOverlay.classList.add("visible"); }
  function closeSidebar() { sidebarEl.classList.remove("sidebar-open"); sidebarOverlay.classList.remove("visible"); }

  hamburgerBtn.addEventListener("click", () =>
    sidebarEl.classList.contains("sidebar-open") ? closeSidebar() : openSidebar()
  );
  sidebarOverlay.addEventListener("click", closeSidebar);

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

      // Close sidebar on mobile after nav
      if (window.innerWidth <= 768) closeSidebar();

      // Hook tab-specific load actions
      if (tabId === "file-manager")    loadWorkspaceFiles();
      if (tabId === "campaign-wizard" || tabId === "smtp-scanner") loadWizardOptions();
      if (tabId === "relay-manager")   loadRelayHealth();
      if (tabId === "sending-domains") loadSendingDomains();
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

    // Reset stats display when a new campaign starts so stale numbers don't persist
    if (status === "sending") {
      state.campaignStats = { total: 0, sent: 0, failed: 0, greylisted: 0, reachable: 0, dropped: 0 };
      document.getElementById("stats-total").textContent = "0";
      document.getElementById("stats-sent").textContent  = "0";
      document.getElementById("stats-failed").textContent = "0";
      document.getElementById("stats-greylisted").textContent = "0";
      document.getElementById("stats-total-desc").textContent = "Reachable: 0 | Dropped: 0";
      document.getElementById("stats-sent-pct").textContent = "0% Success rate";
      document.getElementById("stats-failed-pct").textContent = "0% Failed";
      document.getElementById("progress-bar").style.width = "0%";
      document.getElementById("meta-speed").textContent = "0.0 emails/s";
      document.getElementById("meta-elapsed").textContent = "0s";
      document.getElementById("meta-eta").textContent = "--";
      drawChart(0, 0, 0);
    }

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

  // Toggle dynamic-from domain input based on from-mode radio
  document.querySelectorAll('input[name="from-mode"]').forEach(radio => {
    radio.addEventListener("change", () => {
      const isDynamic = document.getElementById("from-mode-dynamic").checked;
      document.getElementById("dynamic-from-domain-group").style.display = isDynamic ? "block" : "none";
    });
  });

  wizardForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const checkedBodies = Array.from(document.querySelectorAll('input[name="htmlBodies"]:checked')).map(el => el.value);
    const checkedAttachments = Array.from(document.querySelectorAll('input[name="attachments"]:checked')).map(el => el.value);

    const isDynamicFrom = document.querySelector('input[name="from-mode"]:checked')?.value === "dynamic";
    const isDomainRot   = document.getElementById("wizard-domain-rotation").checked;
    if (isDynamicFrom && isDomainRot) {
      appendLog("Warning: Dynamic From Domain overrides Domain Rotation — domain rotation will be ignored.", "warn");
    }

    const payload = {
      recipientsFile: document.getElementById("wizard-recipient-file").value,
      namesFile: document.getElementById("wizard-names-file").value,
      subjectsFile: document.getElementById("wizard-subjects-file").value,
      htmlFiles: checkedBodies,
      attachmentFiles: checkedAttachments,
      smtpFile: document.getElementById("wizard-smtp-file").value,
      rotEvery:          parseInt(document.getElementById("wizard-rot-every").value, 10) || 2,
      resume:            document.getElementById("wizard-resume").checked,
      domainRotation:    isDomainRot,
      dynamicFromDomain: isDynamicFrom
        ? (document.getElementById("wizard-dynamic-from-domain").value.trim() || "")
        : "",
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
    const bind        = bindHostSelect.value;
    const panelDomain = document.getElementById("settings-panel-domain").value.trim();
    const smtpDomain  = document.getElementById("settings-domain").value.trim();
    const port        = document.getElementById("settings-port").value || "3000";
    const isPublic    = bind === "0.0.0.0";
    const hasToken    = serverTokenIsSet || !!apiTokenInput.value.trim();
    publicWarning.style.display = (isPublic && !hasToken) ? "block" : "none";

    if (isPublic) {
      const proto = window.location.protocol; // inherit http: or https: from current connection
      const url = panelDomain
        ? `${proto}//${panelDomain}`
        : `${proto}//${smtpDomain || window.location.hostname}:${port}`;
      publicUrlText.textContent = url;
      publicUrlGroup.style.display = "block";
    } else {
      publicUrlGroup.style.display = "none";
    }
  }

  bindHostSelect.addEventListener("change", updatePublicUrlDisplay);
  apiTokenInput.addEventListener("input", updatePublicUrlDisplay);
  document.getElementById("settings-domain").addEventListener("input", updatePublicUrlDisplay);
  document.getElementById("settings-panel-domain").addEventListener("input", updatePublicUrlDisplay);
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

  // Advisory: when relay host is non-loopback and TLS is off, show a warning
  function updateRelayTlsAdvisory() {
    const host = document.getElementById("settings-relay-host").value.trim();
    const tlsOff = !document.getElementById("settings-relay-tls-reject").checked;
    const isLoopback = /^(127\.|::1$|localhost$)/i.test(host);
    let advisory = document.getElementById("relay-tls-advisory");
    if (!advisory) {
      advisory = document.createElement("small");
      advisory.id = "relay-tls-advisory";
      advisory.className = "form-hint";
      advisory.style.color = "var(--warning)";
      document.getElementById("settings-relay-tls-reject").closest(".form-group").appendChild(advisory);
    }
    advisory.textContent = (!isLoopback && tlsOff)
      ? "⚠ External relay host with TLS verification off — ensure you trust this server."
      : "";
  }
  document.getElementById("settings-relay-host").addEventListener("input", updateRelayTlsAdvisory);
  document.getElementById("settings-relay-tls-reject").addEventListener("change", updateRelayTlsAdvisory);

  // ── Settings sub-tabs ───────────────────────────────────────────────────────
  document.querySelectorAll(".settings-subtab-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      const stab = btn.getAttribute("data-stab");
      document.querySelectorAll(".settings-subtab-btn").forEach(b => b.classList.remove("active"));
      document.querySelectorAll(".settings-tab-panel").forEach(p => p.classList.remove("active"));
      btn.classList.add("active");
      const panel = document.querySelector(`.settings-tab-panel[data-stab="${stab}"]`);
      if (panel) panel.classList.add("active");
    });
  });

  // ── Sending Domains ──────────────────────────────────────────────────────────
  const addDomainForm   = document.getElementById("add-domain-form");
  const domainListEl    = document.getElementById("domain-list");
  const domainListEmpty = document.getElementById("domain-list-empty");

  document.getElementById("btn-add-domain-toggle").addEventListener("click", () => {
    const visible = addDomainForm.style.display !== "none";
    addDomainForm.style.display = visible ? "none" : "block";
    document.getElementById("add-domain-error").style.display = "none";
    if (!visible) document.getElementById("new-domain-name").focus();
  });

  document.getElementById("btn-cancel-add-domain").addEventListener("click", () => {
    addDomainForm.style.display = "none";
    document.getElementById("new-domain-name").value     = "";
    document.getElementById("new-domain-selector").value = "mail";
  });

  document.getElementById("btn-refresh-domains").addEventListener("click", loadSendingDomains);

  document.getElementById("btn-generate-domain-keys").addEventListener("click", async () => {
    const domain   = document.getElementById("new-domain-name").value.trim();
    const selector = document.getElementById("new-domain-selector").value.trim() || "mail";
    const errEl    = document.getElementById("add-domain-error");
    errEl.style.display = "none";
    if (!domain) { errEl.textContent = "Enter a domain name."; errEl.style.display = "block"; return; }

    const btn = document.getElementById("btn-generate-domain-keys");
    btn.disabled = true;
    btn.textContent = "Generating…";
    try {
      const res  = await apiFetch("/api/dkim/generate", "POST", { domain, selector });
      const data = await res.json();
      if (!data.success) { errEl.textContent = "Failed: " + (data.error || "unknown error"); errEl.style.display = "block"; return; }
      appendLog(`DKIM keys generated for ${domain} (selector: ${selector})`, "sent");
      addDomainForm.style.display = "none";
      document.getElementById("new-domain-name").value     = "";
      document.getElementById("new-domain-selector").value = "mail";
      await loadSendingDomains();
      // Auto-expand the DNS panel for the newly created domain
      const row = domainListEl.querySelector(`[data-domain="${CSS.escape(domain)}"]`);
      if (row) row.querySelector(".btn-domain-dns")?.click();
    } catch (e) {
      errEl.textContent = "Error: " + e.message;
      errEl.style.display = "block";
    } finally {
      btn.disabled = false;
      btn.textContent = "Generate Keys";
    }
  });

  async function loadSendingDomains() {
    try {
      const res  = await apiFetch("/api/domains");
      const list = await res.json();
      renderDomainList(list);
    } catch {
      domainListEmpty.textContent = "Failed to load domains.";
      domainListEmpty.style.display = "block";
    }
  }

  function renderDomainList(list) {
    // Remove all existing domain rows (keep the empty placeholder)
    domainListEl.querySelectorAll(".domain-row").forEach(el => el.remove());
    if (!list.length) {
      domainListEmpty.style.display = "block";
      return;
    }
    domainListEmpty.style.display = "none";
    list.forEach(item => {
      const row = buildDomainRow(item);
      domainListEl.appendChild(row);
    });
  }

  function buildDomainRow(item) {
    const row = document.createElement("div");
    row.className = "domain-row";
    row.setAttribute("data-domain", item.domain);

    const keyBadge = document.createElement("span");
    keyBadge.className = "domain-key-badge " + (item.hasKey ? "badge-ok" : "badge-warn");
    keyBadge.textContent = item.hasKey ? "🔑 Key ✓" : "🔑 Key ✗";

    const info = document.createElement("div");
    info.className = "domain-row-info";
    const nameEl = document.createElement("span");
    nameEl.className = "domain-name";
    nameEl.textContent = item.domain;
    const selEl = document.createElement("span");
    selEl.className = "domain-selector-badge";
    selEl.textContent = "sel: " + item.selector;
    info.appendChild(nameEl);
    info.appendChild(selEl);
    info.appendChild(keyBadge);

    const actions = document.createElement("div");
    actions.className = "domain-row-actions";

    if (item.hasKey) {
      const dnsBtn = document.createElement("button");
      dnsBtn.type = "button";
      dnsBtn.className = "btn btn-sm btn-secondary btn-domain-dns";
      dnsBtn.textContent = "DNS Records";
      dnsBtn.addEventListener("click", () => toggleDomainDetail(row, item, "dns"));
      actions.appendChild(dnsBtn);
    }

    const verifyBtn = document.createElement("button");
    verifyBtn.type = "button";
    verifyBtn.className = "btn btn-sm btn-secondary btn-domain-verify";
    verifyBtn.textContent = "Verify DNS";
    verifyBtn.addEventListener("click", () => toggleDomainDetail(row, item, "verify"));
    actions.appendChild(verifyBtn);

    const delBtn = document.createElement("button");
    delBtn.type = "button";
    delBtn.className = "btn btn-sm btn-danger btn-domain-delete";
    delBtn.textContent = "Delete";
    delBtn.addEventListener("click", () => deleteDomain(item.domain, item.hasKey));
    actions.appendChild(delBtn);

    const detail = document.createElement("div");
    detail.className = "domain-detail-panel";
    detail.style.display = "none";

    row.appendChild(info);
    row.appendChild(actions);
    row.appendChild(detail);
    return row;
  }

  async function runHealthCheck(detail, item, row) {
    detail.textContent = "";
    const loading = document.createElement("p");
    loading.className = "form-hint";
    loading.textContent = "Running DNS health check…";
    detail.appendChild(loading);
    try {
      const res  = await apiFetch("/api/sender-health", "POST", { domain: item.domain, selector: item.selector });
      const data = await res.json();
      detail.textContent = "";
      renderHealthResult(detail, data, item, row);
    } catch (e) {
      loading.textContent = "Error: " + e.message;
    }
  }

  async function toggleDomainDetail(row, item, mode) {
    const detail = row.querySelector(".domain-detail-panel");
    const sameMode = detail.getAttribute("data-mode") === mode && detail.style.display !== "none";
    if (sameMode) { detail.style.display = "none"; detail.removeAttribute("data-mode"); return; }

    detail.setAttribute("data-mode", mode);
    detail.style.display = "block";

    if (mode === "dns") {
      detail.textContent = "";
      const loading = document.createElement("p");
      loading.className = "form-hint";
      loading.textContent = "Loading DNS records…";
      detail.appendChild(loading);
      try {
        const res  = await apiFetch(`/api/domains/${encodeURIComponent(item.domain)}/dns`);
        const data = await res.json();
        if (data.error) { loading.textContent = "Error: " + data.error; return; }
        detail.textContent = "";
        renderDnsRecords(detail, data.dns);
      } catch (e) {
        loading.textContent = "Error: " + e.message;
      }
    } else {
      await runHealthCheck(detail, item, row);
    }
  }

  function renderDnsRecords(container, dns) {
    const title = document.createElement("p");
    title.className = "form-hint dns-records-title";
    title.textContent = "Add all 6 of these records in your domain registrar (DNS settings):";
    container.appendChild(title);

    const records = [
      { label: "A",     desc: "Points your domain root to your server — needed for HELO resolution and reputation",  rec: dns.a_root },
      { label: "A",     desc: "Points mail.yourdomain to your server — used as the EHLO hostname",                   rec: dns.a_mail },
      { label: "MX",    desc: "Tells other servers where to send bounces and replies for your domain",                rec: dns.mx    },
      { label: "SPF",   desc: "Authorizes your server IP to send email for this domain (prevents spoofing)",         rec: dns.spf   },
      { label: "DKIM",  desc: "Cryptographic signature so receivers can verify emails came from you",                 rec: dns.dkim  },
      { label: "DMARC", desc: "Policy for what to do with mail that fails SPF/DKIM — protects your domain name",     rec: dns.dmarc },
    ].filter(r => r.rec); // skip any records not present (e.g. old cached responses)

    records.forEach(({ label, desc, rec }) => {
      const block = document.createElement("div");
      block.className = "dns-copy-row";

      const header = document.createElement("div");
      header.className = "dns-copy-header";
      const lbl = document.createElement("span");
      lbl.className = "dns-copy-label";
      lbl.textContent = label;
      const descEl = document.createElement("span");
      descEl.className = "dns-copy-desc";
      descEl.textContent = desc;
      header.appendChild(lbl);
      header.appendChild(descEl);

      const nameRow = document.createElement("div");
      nameRow.className = "dns-copy-field-row";
      const nameLbl = document.createElement("span");
      nameLbl.className = "dns-field-label";
      nameLbl.textContent = "Name / Host:";
      const nameVal = document.createElement("code");
      nameVal.className = "dns-copy-val";
      nameVal.textContent = rec.name;
      const nameCopy = makeCopyBtn(rec.name);
      nameRow.appendChild(nameLbl);
      nameRow.appendChild(nameVal);
      nameRow.appendChild(nameCopy);

      const typeRow = document.createElement("div");
      typeRow.className = "dns-copy-field-row";
      const typeLbl = document.createElement("span");
      typeLbl.className = "dns-field-label";
      typeLbl.textContent = "Type:";
      const typeVal = document.createElement("code");
      typeVal.className = "dns-copy-val";
      typeVal.textContent = rec.type;
      typeRow.appendChild(typeLbl);
      typeRow.appendChild(typeVal);

      const valRow = document.createElement("div");
      valRow.className = "dns-copy-field-row";
      const valLbl = document.createElement("span");
      valLbl.className = "dns-field-label";
      valLbl.textContent = "Value:";
      const valEl = document.createElement("code");
      valEl.className = "dns-copy-val dns-copy-val-long";
      valEl.textContent = rec.value;
      const valCopy = makeCopyBtn(rec.value);
      valRow.appendChild(valLbl);
      valRow.appendChild(valEl);
      valRow.appendChild(valCopy);

      block.appendChild(header);
      block.appendChild(nameRow);
      block.appendChild(typeRow);
      block.appendChild(valRow);
      container.appendChild(block);
    });

    const ptrNote = document.createElement("div");
    ptrNote.className = "dns-ptr-note";
    ptrNote.textContent = "PTR / rDNS: Cannot be set in your registrar — contact your VPS/hosting provider to set a reverse DNS record for your sending IP.";
    container.appendChild(ptrNote);
  }

  function copyToClipboard(text) {
    if (navigator.clipboard && window.isSecureContext) {
      return navigator.clipboard.writeText(text);
    }
    // HTTP fallback via execCommand
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.cssText = "position:fixed;opacity:0;pointer-events:none";
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    ta.remove();
    return Promise.resolve();
  }

  function appendCheckRow(container, { label, ok, detail, critical = false }) {
    const checkRow = document.createElement("div");
    checkRow.className = "health-check-item " + (ok ? "pass" : critical ? "fail" : "warn");
    const icon = document.createElement("span");
    icon.className = "check-icon";
    icon.textContent = ok ? "✓" : critical ? "✗" : "⚠";
    const labelEl = document.createElement("span");
    labelEl.className = "check-label";
    labelEl.textContent = label + ":";
    const detailEl = document.createElement("span");
    detailEl.className = "check-detail";
    detailEl.textContent = detail;
    checkRow.appendChild(icon);
    checkRow.appendChild(labelEl);
    checkRow.appendChild(detailEl);
    container.appendChild(checkRow);
  }

  function makeCopyBtn(text) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "btn btn-sm btn-secondary dns-copy-btn";
    btn.textContent = "Copy";
    btn.addEventListener("click", () => {
      copyToClipboard(text).then(() => {
        btn.textContent = "Copied!";
        setTimeout(() => { btn.textContent = "Copy"; }, 1500);
      });
    });
    return btn;
  }

  function renderHealthResult(container, data, item, row) {
    if (data.error) {
      const errP = document.createElement("p");
      errP.className = "form-hint";
      errP.style.color = "var(--error)";
      errP.textContent = "Health check failed: " + data.error;
      container.appendChild(errP);
      return;
    }

    // Critical = SPF + DKIM only. Advisory = everything else.
    const spfOk   = data.spf?.strength !== "none";
    const dkimOk  = !!data.dkim?.exists;
    const dnsReady = spfOk && dkimOk;

    // Top-level READY / NOT READY banner
    const banner = document.createElement("div");
    banner.className = "ready-banner " + (dnsReady ? "ready-banner-ok" : "ready-banner-fail");
    const bannerIcon = document.createElement("span");
    bannerIcon.className = "ready-banner-icon";
    bannerIcon.textContent = dnsReady ? "✅" : "❌";
    const bannerText = document.createElement("span");
    bannerText.textContent = dnsReady
      ? "Ready to Send — critical DNS records (SPF + DKIM) are configured"
      : "Not Ready — fix the critical issues below before sending";
    banner.appendChild(bannerIcon);
    banner.appendChild(bannerText);
    container.appendChild(banner);

    // Update the domain row status badge
    if (row) {
      let statusBadge = row.querySelector(".domain-ready-badge");
      if (!statusBadge) {
        statusBadge = document.createElement("span");
        statusBadge.className = "domain-ready-badge";
        const infoEl = row.querySelector(".domain-row-info");
        if (infoEl) infoEl.appendChild(statusBadge);
      }
      statusBadge.className = "domain-ready-badge " + (dnsReady ? "badge-ok" : "badge-warn");
      statusBadge.textContent = dnsReady ? "✅ Ready" : "❌ Not Ready";
    }

    const ip       = data.sendingIp || "";
    const dmarcOk  = !!data.dmarc?.raw;
    const dmarcSrc = data.dmarcSource ? ` (at _dmarc.${data.dmarcSource})` : "";
    const aRootOk  = !!data.aRoot?.hasRecord;
    const aMailOk  = !!data.aMail?.hasRecord;
    const mxOk     = !!data.mx?.hasRecord;
    const ptrOk    = !!data.ptr?.ptr; // advisory: just having a PTR is enough

    // Critical checks first, then advisory
    const criticalChecks = [
      { label: "SPF",  ok: spfOk,  critical: true, detail: data.spf?.raw || `No SPF TXT record — add: v=spf1 ip4:${ip || "<ip>"} ~all` },
      { label: "DKIM", ok: dkimOk, critical: true, detail: dkimOk ? `Found at ${item.selector}._domainkey.${item.domain}` : `No DKIM TXT record at ${item.selector}._domainkey.${item.domain}` },
    ];
    const advisoryChecks = [
      { label: "DMARC",    ok: dmarcOk, detail: dmarcOk ? (data.dmarc.raw + dmarcSrc) : `No DMARC record — add TXT at _dmarc.${item.domain}: v=DMARC1; p=none; rua=mailto:dmarc@${item.domain}` },
      { label: "A (root)", ok: aRootOk, detail: aRootOk ? data.aRoot.addrs.join(", ") : `No A record for ${item.domain}` },
      { label: "A (mail)", ok: aMailOk, detail: aMailOk ? data.aMail.addrs.join(", ") : `No A record for mail.${item.domain}` },
      { label: "MX",       ok: mxOk,    detail: mxOk    ? data.mx.host               : `No MX record for ${item.domain}` },
    ];

    const addSectionLabel = (text) => {
      const lbl = document.createElement("p");
      lbl.className = "form-hint check-section-label";
      lbl.textContent = text;
      container.appendChild(lbl);
    };

    addSectionLabel("Critical (required for sending):");
    criticalChecks.forEach(c => appendCheckRow(container, c));

    addSectionLabel("Advisory (improve deliverability):");
    advisoryChecks.forEach(c => appendCheckRow(container, c));

    // PTR row with expandable provider guide
    const ptrFcrdns  = data.ptr?.matches;
    const ptrDetail  = ptrOk
      ? `${data.ptr.ptr}${ptrFcrdns ? " (forward-confirmed ✓)" : " (FCrDNS unconfirmed — see guide below)"}`
      : `No PTR record for ${ip || "your sending IP"}`;
    appendCheckRow(container, { label: "PTR/rDNS", ok: ptrOk && ptrFcrdns, detail: ptrDetail });

    if (!ptrOk || !ptrFcrdns) {
      const heloHint   = item.domain ? `mail.${item.domain}` : "mail.yourdomain.com";
      const currentVal = ptrOk ? (data.ptr.ptr || "none") : "none";

      // Build with DOM — avoid innerHTML on server-supplied values (ip, currentVal, heloHint)
      const guide = document.createElement("div");
      guide.className = "ptr-guide";

      const title = document.createElement("strong");
      title.textContent = "How to set PTR / rDNS";
      guide.appendChild(title);

      function metaLine(...parts) {
        const d = document.createElement("div");
        d.className = "ptr-guide-meta";
        parts.forEach(p => {
          if (typeof p === "string") { d.appendChild(document.createTextNode(p)); }
          else {
            const c = document.createElement("code");
            c.textContent = p.code;
            d.appendChild(c);
          }
        });
        return d;
      }
      guide.appendChild(metaLine("Current PTR for ", {code: ip || "your IP"}, ": ", {code: currentVal}, " → Required: ", {code: heloHint}));

      const staticSteps = [
        ["Hetzner", "Robot console → Servers → your server → IPs → pencil icon → Reverse DNS"],
        ["DigitalOcean", "Droplet → Networking → Configure PTR records"],
        ["Vultr", "Products → Cloud Compute → your instance → Settings → Reverse DNS"],
        ["Linode / Akamai", "Linodes → your instance → Network → Reverse DNS"],
        ["OVH / SoYouStart", "IP Manager → gear icon → Modify reverse"],
        ["AWS EC2", "Request via the AWS console IP Address form, or use an Elastic IP"],
        ["Generic", "VPS control panel → Networking → Reverse DNS / rDNS"],
      ];
      const ul = document.createElement("ul");
      ul.className = "ptr-guide-steps";
      staticSteps.forEach(([provider, steps]) => {
        const li = document.createElement("li");
        const b = document.createElement("strong");
        b.textContent = provider;
        li.appendChild(b);
        li.appendChild(document.createTextNode(": " + steps));
        ul.appendChild(li);
      });
      guide.appendChild(ul);
      guide.appendChild(metaLine("Set it to: ", {code: heloHint}, " (must match your SMTP HELO hostname)"));
      container.appendChild(guide);
    }

    if (data.tips?.length) {
      const tipsTitle = document.createElement("p");
      tipsTitle.className = "form-hint";
      tipsTitle.style.marginTop = "12px";
      tipsTitle.style.fontWeight = "600";
      tipsTitle.textContent = "How to fix:";
      container.appendChild(tipsTitle);
      data.tips.forEach(tip => {
        const p = document.createElement("p");
        p.className = "form-hint";
        p.style.color = "var(--warning)";
        p.textContent = "→ " + tip;
        container.appendChild(p);
      });
    }

    const btnRow = document.createElement("div");
    btnRow.className = "verify-action-row";

    if (!dnsReady) {
      const reverifyBtn = document.createElement("button");
      reverifyBtn.type = "button";
      reverifyBtn.className = "btn btn-sm btn-primary";
      reverifyBtn.textContent = "Re-verify";
      reverifyBtn.addEventListener("click", async () => {
        reverifyBtn.disabled = true;
        reverifyBtn.textContent = "Checking…";
        await runHealthCheck(container, item, row);
      });
      btnRow.appendChild(reverifyBtn);
    }

    const dnsBtn = document.createElement("button");
    dnsBtn.type = "button";
    dnsBtn.className = "btn btn-sm btn-secondary";
    dnsBtn.textContent = dnsReady ? "View DNS Records" : "Show DNS Records to Add";
    dnsBtn.addEventListener("click", async () => {
      dnsBtn.disabled = true;
      dnsBtn.textContent = "Loading…";
      try {
        const res = await apiFetch(`/api/domains/${encodeURIComponent(item.domain)}/dns`);
        const d   = await res.json();
        if (!d.error) {
          btnRow.remove();
          renderDnsRecords(container, d.dns);
        }
      } catch { dnsBtn.disabled = false; dnsBtn.textContent = "Show DNS Records"; }
    });
    btnRow.appendChild(dnsBtn);

    container.appendChild(btnRow);
  }

  async function deleteDomain(domain, hasKey) {
    const msg = hasKey
      ? `Delete domain "${domain}" and its private key file? This cannot be undone.`
      : `Remove domain "${domain}" from config?`;
    if (!confirm(msg)) return;
    try {
      const res  = await apiFetch("/api/domains/delete", "POST", { domain, deleteKey: hasKey });
      const data = await res.json();
      if (data.success) {
        appendLog(`Domain ${domain} deleted`, "system");
        loadSendingDomains();
      } else {
        alert("Delete failed: " + (data.error || "unknown error"));
      }
    } catch (e) {
      alert("Error: " + e.message);
    }
  }

  // ── Relay Manager ─────────────────────────────────────────────────────────

  // Wires the "Configure in Settings" link inside the relay manager tab
  document.querySelectorAll(".relay-settings-link").forEach(el => {
    el.addEventListener("click", e => {
      e.preventDefault();
      const settingsNav = document.querySelector('.nav-item[data-tab="settings"]');
      if (settingsNav) settingsNav.click();
    });
  });

  // Inline nav links (e.g. in wizard hints)
  document.querySelectorAll(".nav-link-inline[data-tab]").forEach(el => {
    el.addEventListener("click", e => {
      e.preventDefault();
      const nav = document.querySelector(`.nav-item[data-tab="${el.getAttribute("data-tab")}"]`);
      if (nav) nav.click();
    });
  });

  document.getElementById("btn-relay-check").addEventListener("click", loadRelayHealth);

  document.getElementById("btn-guide-toggle").addEventListener("click", () => {
    const body = document.getElementById("guide-body");
    const btn  = document.getElementById("btn-guide-toggle");
    const open = body.style.display !== "none";
    body.style.display = open ? "none" : "block";
    btn.textContent    = open ? "Show guide" : "Hide guide";
  });

  function makeDomEl(tag, cls, text) {
    const el = document.createElement(tag);
    if (cls)  el.className   = cls;
    if (text !== undefined) el.textContent = text;
    return el;
  }

  function renderHealthDetail(container, rows) {
    const table = makeDomEl("div", "health-detail-table");
    for (const [key, val, cls] of rows) {
      const row  = makeDomEl("div", "health-detail-row");
      const k    = makeDomEl("span", "health-detail-key", key);
      const v    = makeDomEl("span", "health-detail-val" + (cls ? ` ${cls}` : ""), val);
      row.appendChild(k);
      row.appendChild(v);
      table.appendChild(row);
    }
    container.appendChild(table);
  }

  function renderCheckItems(container, items, cls) {
    const icon = cls === "pass" ? "✓" : cls === "fail" ? "✗" : "⚠";
    for (const text of items) {
      const row  = makeDomEl("div", `health-check-item ${cls}`);
      const ic   = makeDomEl("span", "check-icon", icon);
      const msg  = makeDomEl("span", "", text);
      row.appendChild(ic);
      row.appendChild(msg);
      container.appendChild(row);
    }
  }

  function buildGuideLinux(container) {
    const sections = [
      {
        title: "Install & configure Postfix",
        steps: [
          ["Install Postfix", "sudo apt-get install -y postfix"],
          ["Restrict to loopback", "sudo postconf -e \"inet_interfaces = loopback-only\""],
          ["Trust loopback relay", "sudo postconf -e \"mynetworks = 127.0.0.0/8\""],
          ["Disable auth for local", "sudo postconf -e \"smtpd_relay_restrictions = permit_mynetworks,reject\""],
          ["Enable & start", "sudo systemctl enable postfix && sudo systemctl restart postfix"],
        ],
      },
      {
        title: "Configure VPS Sender",
        steps: [
          ["In Settings → Transport Mode", "Select: Local MTA Relay"],
          ["Relay Host", "127.0.0.1"],
          ["Relay Port", "25"],
          ["Pre-scan", "Uncheck (relay handles routing)"],
        ],
      },
    ];
    buildGuideHtml(container, sections, "🐧");
  }

  function buildGuideWindows(container) {
    const sections = [
      {
        title: "Install hMailServer",
        steps: [
          ["Download", "hmailserver.com → Download → Windows installer"],
          ["Run installer", "Accept defaults; choose 'Use built-in database engine'"],
          ["Open hMailServer Admin", "Start → hMailServer Administrator"],
          ["Create a domain", "Domains → Add → enter any domain name → Save"],
        ],
      },
      {
        title: "Allow local relay (no auth)",
        steps: [
          ["Go to", "Settings → Advanced → IP Ranges"],
          ["Add range", "Name: Localhost | IP: 127.0.0.1 | Subnet: 255.255.255.255"],
          ["Set permissions", "Require SMTP auth: unchecked | Allow deliveries: checked"],
          ["Save & restart", "File → Exit Admin → Restart hMailServer service"],
        ],
      },
      {
        title: "Configure VPS Sender",
        steps: [
          ["In Settings → Transport Mode", "Select: Local MTA Relay"],
          ["Relay Host", "127.0.0.1"],
          ["Relay Port", "587"],
          ["Leave user/pass blank", "(IP Range rule trusts 127.0.0.1 without auth)"],
        ],
      },
    ];
    buildGuideHtml(container, sections, "🪟");
  }

  function buildGuideMac(container) {
    const sections = [
      {
        title: "Start the built-in Postfix",
        steps: [
          ["Edit main.cf (if needed)", "sudo nano /etc/postfix/main.cf"],
          ["Ensure loopback only", "inet_interfaces = loopback-only"],
          ["Start Postfix", "sudo postfix start"],
          ["Verify listening", "sudo lsof -i :25"],
        ],
      },
      {
        title: "Configure VPS Sender",
        steps: [
          ["Transport Mode", "Local MTA Relay"],
          ["Relay Host", "127.0.0.1"],
          ["Relay Port", "25"],
        ],
      },
    ];
    buildGuideHtml(container, sections, "🍎");
  }

  function buildGuideHtml(container, sections, osIcon) {
    for (const sec of sections) {
      const wrap = makeDomEl("div", "guide-section");
      wrap.appendChild(makeDomEl("h4", "", sec.title));
      for (let i = 0; i < sec.steps.length; i++) {
        const [label, cmd] = sec.steps[i];
        const row = makeDomEl("div", "guide-step");
        row.appendChild(makeDomEl("span", "guide-step-num", String(i + 1)));
        const body = document.createElement("div");
        body.appendChild(makeDomEl("div", "", label));
        const code = makeDomEl("code", "guide-code", cmd);
        body.appendChild(code);
        row.appendChild(body);
        wrap.appendChild(row);
      }
      container.appendChild(wrap);
    }
    document.getElementById("guide-os-icon").textContent = osIcon;
  }

  async function loadRelayHealth() {
    // Reset badges to "Checking…" state
    ["relay-conn-badge", "mta-status-badge"].forEach(id => {
      const el = document.getElementById(id);
      el.className = "health-badge checking";
      el.textContent = "Checking…";
    });
    document.getElementById("relay-check-time").textContent = "";

    let data;
    try {
      const res = await apiFetch("/api/relay/health");
      data = await res.json();
    } catch (e) {
      appendLog("Relay health check failed: " + e.message, "fail");
      return;
    }

    const isRelay  = data.transport === "relay";
    const platform = data.os || "linux";

    // Update mode banner
    const badge = document.getElementById("relay-mode-badge");
    const title = document.getElementById("relay-mode-title");
    const desc  = document.getElementById("relay-mode-desc");
    if (isRelay) {
      badge.textContent = "Relay Mode";
      badge.className   = "relay-mode-badge relay";
      title.textContent = "Local MTA Relay Mode Active";
      desc.textContent  = `Emails are routed through the local MTA at ${data.relayHost}:${data.relayPort}.`;
    } else {
      badge.textContent = "Direct to MX";
      badge.className   = "relay-mode-badge";
      title.textContent = "Direct-to-MX Mode Active";
      desc.textContent  = "Emails resolve MX records and connect directly on port 25. No local MTA required.";
    }

    document.getElementById("relay-direct-note").style.display = isRelay ? "none" : "block";
    document.getElementById("relay-health-grid").style.display  = isRelay ? "grid" : "none";

    if (!isRelay) {
      document.getElementById("relay-check-time").textContent = `Last checked: ${new Date().toLocaleTimeString()}`;
      return;
    }

    // ── Connection card ──────────────────────────────────────────────────────
    const connTarget = document.getElementById("relay-conn-target");
    const connBadge  = document.getElementById("relay-conn-badge");
    const connBody   = document.getElementById("relay-conn-body");
    connTarget.textContent = `${data.relayHost}:${data.relayPort}`;
    connBody.textContent   = "";

    if (data.connection.ok) {
      connBadge.className   = "health-badge ok";
      connBadge.textContent = "✓ Reachable";
      renderHealthDetail(connBody, [
        ["Host", data.relayHost],
        ["Port", String(data.relayPort)],
        ["TCP connect", "success", "ok"],
      ]);
    } else {
      connBadge.className   = "health-badge err";
      connBadge.textContent = "✗ Unreachable";
      renderHealthDetail(connBody, [
        ["Host", data.relayHost],
        ["Port", String(data.relayPort)],
        ["Error", data.connection.error || "connection refused", "err"],
      ]);
      renderCheckItems(connBody, ["Cannot reach relay port — check that the MTA is running and listening."], "fail");
    }

    // ── MTA status card ──────────────────────────────────────────────────────
    const mtaIcon   = document.getElementById("mta-icon");
    const mtaName   = document.getElementById("mta-card-name");
    const mtaTarget = document.getElementById("mta-card-target");
    const mtaBadge  = document.getElementById("mta-status-badge");
    const mtaBody   = document.getElementById("mta-body");
    mtaBody.textContent = "";

    const mta = data.mta;
    const osLabels = { linux: ["🐧 Postfix", "Linux"], darwin: ["🍎 Postfix", "macOS"], win32: ["🪟 hMailServer", "Windows"] };
    const [mtaLabel, osLabel] = osLabels[platform] || ["⚙️ MTA", "Unknown OS"];
    mtaIcon.textContent   = mtaLabel.split(" ")[0];
    mtaName.textContent   = mtaLabel.split(" ").slice(1).join(" ") + " Status";
    mtaTarget.textContent = osLabel;

    if (!mta.detected) {
      mtaBadge.className   = "health-badge err";
      mtaBadge.textContent = "✗ Not Found";
    } else if (!mta.active) {
      mtaBadge.className   = "health-badge err";
      mtaBadge.textContent = "✗ Not Running";
    } else if (mta.warnings.length > 0) {
      mtaBadge.className   = "health-badge warn";
      mtaBadge.textContent = "⚠ Running";
    } else {
      mtaBadge.className   = "health-badge ok";
      mtaBadge.textContent = "✓ Running";
    }

    // Detail rows from mta.details object
    const detailRows = Object.entries(mta.details || {}).map(([k, v]) => [k.replace(/_/g, " "), String(v)]);
    if (detailRows.length) renderHealthDetail(mtaBody, detailRows);

    // Pass checks
    if (mta.active) renderCheckItems(mtaBody, ["MTA service is active and running"], "pass");
    if (platform === "linux" && mta.details.inet_interfaces === "loopback-only")
      renderCheckItems(mtaBody, ["inet_interfaces = loopback-only ✓"], "pass");
    if (platform === "linux" && (mta.details.mynetworks || "").includes("127.0.0.0"))
      renderCheckItems(mtaBody, ["mynetworks includes 127.0.0.0/8 ✓"], "pass");

    // ── Issues & warnings card ───────────────────────────────────────────────
    const allIssues   = [...(mta.issues || [])];
    const allWarnings = [...(mta.warnings || [])];
    if (!data.connection.ok) allIssues.unshift(`TCP connection to ${data.relayHost}:${data.relayPort} failed — ${data.connection.error}`);

    const issuesCard = document.getElementById("card-issues");
    const issuesBody = document.getElementById("issues-body");
    issuesBody.textContent = "";

    if (allIssues.length || allWarnings.length) {
      issuesCard.style.display = "block";
      renderCheckItems(issuesBody, allIssues, "fail");
      renderCheckItems(issuesBody, allWarnings, "warn");
    } else {
      issuesCard.style.display = "none";
      renderCheckItems(mtaBody, ["No issues detected — relay looks healthy"], "pass");
    }

    // ── Setup guide ──────────────────────────────────────────────────────────
    const guideTitle = document.getElementById("guide-title");
    const guideBody  = document.getElementById("guide-body");
    guideBody.textContent = "";
    guideTitle.textContent = platform === "win32" ? "hMailServer Setup Guide (Windows)" :
                             platform === "darwin" ? "Postfix Setup Guide (macOS)" :
                                                     "Postfix Setup Guide (Linux)";
    if (platform === "win32")      buildGuideWindows(guideBody);
    else if (platform === "darwin") buildGuideMac(guideBody);
    else                            buildGuideLinux(guideBody);

    document.getElementById("relay-check-time").textContent = `Last checked: ${new Date().toLocaleTimeString()}`;
  }

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
      document.getElementById("settings-prescan-relay").checked      = data.preScanRelay             !== false;
      document.getElementById("settings-relay-tls-reject").checked  = !!data.relayTlsRejectUnauthorized;
      document.getElementById("settings-relay-from-email").value   = data.relayFromEmail || "";
      document.getElementById("settings-envelope-domain").value     = data.envelopeDomain            || "";
      document.getElementById("settings-panel-domain").value        = data.panelDomain               || "";
      toggleRelayFields(data.transport === "relay");

      // Warmup
      const warmup = data.warmup || {};
      document.getElementById("settings-warmup-enabled").checked  = !!warmup.enabled;
      document.getElementById("settings-warmup-daily").value      = warmup.dailyLimit ?? 100;
      document.getElementById("settings-warmup-increment").value  = warmup.incrementPerDay ?? 50;

      // JSON fields — pretty-print for editing
      try { document.getElementById("settings-rate-limits").value = JSON.stringify(data.rateLimits || {}, null, 2); } catch {}

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
      relayHost:                  document.getElementById("settings-relay-host").value.trim() || "127.0.0.1",
      relayPort:                  parseInt(document.getElementById("settings-relay-port").value, 10) || 587,
      relayUser:                  document.getElementById("settings-relay-user").value.trim(),
      relayPass:                  relayPassDirty ? document.getElementById("settings-relay-pass").value : "***",
      preScanRelay:               document.getElementById("settings-prescan-relay").checked,
      relayTlsRejectUnauthorized: document.getElementById("settings-relay-tls-reject").checked,
      relayFromEmail:             document.getElementById("settings-relay-from-email").value.trim(),
      envelopeDomain:             document.getElementById("settings-envelope-domain").value.trim(),
      panelDomain:                document.getElementById("settings-panel-domain").value.trim(),
      warmup: {
        enabled:         document.getElementById("settings-warmup-enabled").checked,
        dailyLimit:      parseInt(document.getElementById("settings-warmup-daily").value, 10)     || 100,
        incrementPerDay: parseInt(document.getElementById("settings-warmup-increment").value, 10) || 50,
      },
    };
    // JSON textarea fields — skip on parse error rather than blocking save
    try { payload.rateLimits = JSON.parse(document.getElementById("settings-rate-limits").value || "{}"); } catch {}

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

  // ── PM2 Restart ─────────────────────────────────────────────────────────────
  document.getElementById("btn-restart-pm2").addEventListener("click", async () => {
    const btn    = document.getElementById("btn-restart-pm2");
    const status = document.getElementById("pm2-restart-status");
    btn.disabled = true;
    status.textContent = "Restarting…";
    status.className   = "pm2-restart-status pm2-pending";
    try {
      const res  = await apiFetch("/api/server/restart", "POST", {});
      const data = await res.json();
      if (res.ok && data.ok) {
        status.textContent = "✓ " + data.message;
        status.className   = "pm2-restart-status pm2-ok";
        appendLog("PM2 restart requested — the server will come back in a few seconds.", "system");
      } else {
        status.textContent = "✗ " + (data.error || "Restart failed");
        status.className   = "pm2-restart-status pm2-fail";
        btn.disabled       = false;
      }
    } catch {
      status.textContent = "✗ Request failed";
      status.className   = "pm2-restart-status pm2-fail";
      btn.disabled       = false;
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
      
      ctx.fillStyle = "#6b7280";
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
      ctx.fillStyle = "#e5e7eb";
      ctx.fillText(`${seg.label}: ${seg.val}`, 152, ly);
      ly += 22;
    });
  }

  // ── Test Send ───────────────────────────────────────────────────────────────
  const btnTestSend       = document.getElementById("btn-test-send");
  const testSendTo        = document.getElementById("test-send-to");
  const testSendStatus    = document.getElementById("test-send-status");

  if (btnTestSend) {
    btnTestSend.addEventListener("click", async () => {
      const to = testSendTo.value.trim();
      if (!to || !to.includes("@")) {
        testSendStatus.className = "test-send-status fail";
        testSendStatus.textContent = "Enter a valid email address.";
        return;
      }
      btnTestSend.disabled = true;
      testSendStatus.className = "test-send-status pending";
      testSendStatus.textContent = "Sending…";
      try {
        const res  = await apiFetch("/api/test-send", "POST", { to });
        const data = await res.json();
        if (data.ok) {
          testSendStatus.className = "test-send-status ok";
          testSendStatus.textContent = `Delivered${data.tls ? " via TLS" : ""} from ${data.from} → ${data.to}`;
          appendLog(`Test send OK → ${data.to} (${data.tls ? "TLS" : "plain"})`, "sent");
        } else {
          testSendStatus.className = "test-send-status fail";
          testSendStatus.textContent = data.error || "Send failed.";
          appendLog(`Test send failed → ${to}: ${data.error}`, "fail");
        }
      } catch (err) {
        testSendStatus.className = "test-send-status fail";
        testSendStatus.textContent = "Request error: " + err.message;
      } finally {
        btnTestSend.disabled = false;
      }
    });
  }

  // ── Blacklist / RBL Check ───────────────────────────────────────────────────
  const btnBlacklistCheck = document.getElementById("btn-blacklist-check");
  const blacklistResults  = document.getElementById("blacklist-results");

  if (btnBlacklistCheck) {
    btnBlacklistCheck.addEventListener("click", async () => {
      btnBlacklistCheck.disabled = true;
      blacklistResults.replaceChildren();
      const loading = document.createElement("p");
      loading.className = "form-hint";
      loading.textContent = "Checking 8 blocklists…";
      blacklistResults.appendChild(loading);
      try {
        const res  = await apiFetch("/api/blacklist-check", "POST");
        const data = await res.json();
        blacklistResults.replaceChildren();
        renderBlacklistResults(data);
      } catch (err) {
        blacklistResults.textContent = "Error: " + err.message;
      } finally {
        btnBlacklistCheck.disabled = false;
      }
    });
  }

  function renderBlacklistResults(data) {
    const listedCount = data.listed.length;

    // Summary banner
    const banner = document.createElement("div");
    banner.className = `blacklist-banner ${listedCount === 0 ? "clean" : "listed"}`;
    const bannerIcon = document.createElement("span");
    bannerIcon.className = "blacklist-banner-icon";
    bannerIcon.textContent = listedCount === 0 ? "✓" : "✗";
    const bannerText = document.createElement("span");
    bannerText.textContent = listedCount === 0
      ? `IP ${data.ip} is clean on all ${data.clean.length} checked lists`
      : `IP ${data.ip} is listed on ${listedCount} of ${listedCount + data.clean.length} lists`;
    banner.appendChild(bannerIcon);
    banner.appendChild(bannerText);
    blacklistResults.appendChild(banner);

    // Listed rows first — red, with delist link
    data.listed.forEach(entry => {
      const row = document.createElement("div");
      row.className = "blacklist-row listed";
      const ic = document.createElement("span");
      ic.className = "bl-icon bl-icon-fail";
      ic.textContent = "✗";
      const nm = document.createElement("span");
      nm.className = "bl-name";
      nm.textContent = entry.name;
      const lnk = document.createElement("a");
      lnk.href = entry.delist;
      lnk.target = "_blank";
      lnk.rel = "noopener noreferrer";
      lnk.className = "btn btn-sm btn-danger-sm bl-delist-btn";
      lnk.textContent = "Request Delist →";
      row.append(ic, nm, lnk);
      blacklistResults.appendChild(row);
    });

    // Clean rows — dimmed green
    data.clean.forEach(entry => {
      const row = document.createElement("div");
      row.className = "blacklist-row clean";
      const ic = document.createElement("span");
      ic.className = "bl-icon bl-icon-ok";
      ic.textContent = "✓";
      const nm = document.createElement("span");
      nm.className = "bl-name";
      nm.textContent = entry.name;
      row.append(ic, nm);
      blacklistResults.appendChild(row);
    });

    // Timestamp
    const ts = document.createElement("p");
    ts.className = "form-hint blacklist-timestamp";
    ts.textContent = `Checked at ${new Date(data.checkedAt).toLocaleTimeString()}`;
    blacklistResults.appendChild(ts);
  }

  // ── Initial Load ────────────────────────────────────────────────────────────
  loadSettings();
  loadWizardOptions();
  drawChart(0, 0, 0);
});
