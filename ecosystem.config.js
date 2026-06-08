module.exports = {
  apps: [{
    name:          "vps-sender",
    script:        "vps-sender.js",
    args:          "--gui",
    instances:     1,
    autorestart:   true,
    watch:         false,
    max_memory_restart: "512M",
    env: {
      NODE_ENV:  "production",
      PORT:      "3000",
    },
    error_file:    "logs/pm2-error.log",
    out_file:      "logs/pm2-out.log",
    log_date_format: "YYYY-MM-DD HH:mm:ss Z",
    kill_timeout:  5000,     // allow 5s for graceful shutdown
    listen_timeout: 8000,
  }],
};
