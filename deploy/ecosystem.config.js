/**
 * PM2 process file — docseditor on the VPS.
 *
 *   pm2 start deploy/ecosystem.config.js
 *
 * Secrets live in <app>/.env (git-ignored) and are loaded by Node's
 * --env-file flag, so nothing sensitive sits in this file.
 */
const path = require('path');

module.exports = {
  apps: [
    {
      name: 'docseditor',
      script: 'server.js',
      cwd: path.join(__dirname, '..'),
      instances: 1,
      exec_mode: 'fork',
      max_memory_restart: '400M',
      node_args: '--env-file=.env',
      env: { NODE_ENV: 'production' },
      out_file: path.join(__dirname, '..', 'logs', 'pm2-out.log'),
      error_file: path.join(__dirname, '..', 'logs', 'pm2-error.log'),
      merge_logs: true,
      time: true,
    },
  ],
};
