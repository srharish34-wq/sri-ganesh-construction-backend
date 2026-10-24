import { env } from '../config/env.js';

/*
  Small logger with levels. In production it prints one JSON line per message,
  which hosting dashboards can search. In development it prints readable text.
  Never pass passwords, tokens or full payment details to the logger.
*/
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const minLevel = env.NODE_ENV === 'production' ? LEVELS.info : LEVELS.debug;
const isProd = env.NODE_ENV === 'production';

function format(err) {
  return err instanceof Error ? { message: err.message, stack: isProd ? undefined : err.stack } : err;
}

function write(level, message, meta) {
  if (LEVELS[level] < minLevel) return;
  const stream = level === 'error' || level === 'warn' ? console.error : console.log;

  if (isProd) {
    stream(JSON.stringify({ time: new Date().toISOString(), level, message, ...(meta !== undefined && { meta: format(meta) }) }));
  } else {
    const tag = { debug: '🔍', info: 'ℹ️ ', warn: '⚠️ ', error: '❌' }[level];
    stream(`${tag} ${message}`, ...(meta !== undefined ? [format(meta)] : []));
  }
}

export const logger = {
  debug: (message, meta) => write('debug', message, meta),
  info: (message, meta) => write('info', message, meta),
  warn: (message, meta) => write('warn', message, meta),
  error: (message, meta) => write('error', message, meta),
};