const pad = (n) => String(n).padStart(2, '0');

function stamp() {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export function log(...args) {
  console.log(`[${stamp()}]`, ...args);
}

export function warn(...args) {
  console.warn(`[${stamp()}] WARN`, ...args);
}

export function error(...args) {
  console.error(`[${stamp()}] ERROR`, ...args);
}
