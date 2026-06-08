"use strict";

const fs = require("fs");
const path = require("path");

const LOG_DIR  = path.join(__dirname, "..", "logs");
const LOG_FILE = path.join(LOG_DIR, "vps-sender.log");
const MAX_SIZE = 10 * 1024 * 1024; // 10 MB rotate threshold

let _stream = null;

function ensureStream() {
  if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
  // Rotate if file too large — checked on every write, not just first open
  try {
    if (fs.existsSync(LOG_FILE) && fs.statSync(LOG_FILE).size > MAX_SIZE) {
      if (_stream) {
        // Close fd synchronously before rename — async .end() leaves fd open on
        // Windows causing EPERM; direct closeSync releases the handle immediately.
        try { fs.closeSync(_stream.fd); } catch { /**/ }
        _stream = null;
      }
      fs.renameSync(LOG_FILE, LOG_FILE + "." + Date.now() + ".bak");
    }
  } catch { /**/ }
  if (!_stream) {
    _stream = fs.createWriteStream(LOG_FILE, { flags: "a" });
  }
}

function write(level, msg, data = {}) {
  ensureStream();
  const entry = JSON.stringify({ ts: new Date().toISOString(), level, msg, ...data });
  try { _stream.write(entry + "\n"); } catch { /**/ }
}

module.exports = {
  info:  (msg, data) => write("info",  msg, data),
  warn:  (msg, data) => write("warn",  msg, data),
  error: (msg, data) => write("error", msg, data),
  debug: (msg, data) => write("debug", msg, data),
  LOG_FILE,
};
