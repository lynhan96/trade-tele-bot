module.exports = {
  apps: [{
    name: 'ai-ops-agent',
    script: 'src/agent/index.js',
    interpreter: '/home/ubuntu/.nvm/versions/node/v18.20.2/bin/node',
    autorestart: true,
    watch: false,
    max_restarts: 10,
    restart_delay: 5000,
    env: { NODE_ENV: 'production' },
    out_file: './logs/agent-out.log',
    error_file: './logs/agent-error.log',
    log_date_format: 'YYYY-MM-DD HH:mm:ss',
    merge_logs: true,
    max_memory_restart: '256M',
    cron_restart: '0 */6 * * *'
  }]
}
