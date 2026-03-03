module.exports = {
  apps: [
    {
      name: "binance-bot",
      script: "dist/main.js",
      watch: false,           // disabled on production server (no hot-reload needed)
      autorestart: true,
      max_restarts: 10,
      restart_delay: 3000,
      node_args: "--enable-source-maps",
      env: {
        NODE_ENV: "production",
      },
      // Logs
      out_file: "logs/pm2-out.log",
      error_file: "logs/pm2-error.log",
      merge_logs: true,
      log_date_format: "YYYY-MM-DD HH:mm:ss",
    },
  ],
};
