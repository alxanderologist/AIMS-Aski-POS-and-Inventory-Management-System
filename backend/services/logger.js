// Structured logging, replacing scattered console.* calls across the backend with leveled,
// timestamped log lines. Writes JSON to stdout in production, so the process manager (NSSM/pm2,
// set up in Phase 4) can redirect and rotate it into a file without this app reimplementing that;
// pretty-printed for a human terminal everywhere else (local dev, tests).
const pino = require('pino');

const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  transport:
    process.env.NODE_ENV === 'production'
      ? undefined
      : { target: 'pino-pretty', options: { colorize: true, translateTime: 'SYS:HH:MM:ss', ignore: 'pid,hostname' } },
});

module.exports = logger;
