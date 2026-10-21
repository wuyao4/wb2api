import { execFile } from 'node:child_process';

/**
 * Read the OS clipboard.
 *
 * This is deliberately the *only* automation applied to third-party provider
 * pages: the user logs in and clicks "create key" in their own browser, then
 * clicks "copy". We pick the key up from the clipboard and verify it, which
 * removes the paste step without ever touching their session.
 *
 * Clipboard access is local-only and read-only; nothing is written back.
 */

const MAX_CLIPBOARD_CHARS = 4096;

function run(command, args, timeout = 3000) {
  return new Promise((resolve) => {
    execFile(
      command,
      args,
      { timeout, windowsHide: true, maxBuffer: 1024 * 1024, encoding: 'utf8' },
      (error, stdout) => resolve(error ? '' : String(stdout || ''))
    );
  });
}

/**
 * Windows: PowerShell is always present. The explicit UTF-8 console encoding
 * matters — without it non-ASCII clipboard contents come back as mojibake.
 */
async function readWindows() {
  const script = [
    '[Console]::OutputEncoding=[Text.Encoding]::UTF8',
    '$OutputEncoding=[Text.Encoding]::UTF8',
    'Get-Clipboard -Raw'
  ].join('; ');
  return run('powershell', ['-NoProfile', '-NonInteractive', '-Command', script]);
}

async function readMac() {
  return run('pbpaste', []);
}

async function readLinux() {
  const wayland = await run('wl-paste', ['--no-newline']);
  if (wayland) return wayland;
  const xclip = await run('xclip', ['-selection', 'clipboard', '-o']);
  if (xclip) return xclip;
  return run('xsel', ['--clipboard', '--output']);
}

/** Returns the clipboard text, or '' when unavailable. Never throws. */
export async function readClipboard() {
  let text = '';
  try {
    if (process.platform === 'win32') text = await readWindows();
    else if (process.platform === 'darwin') text = await readMac();
    else text = await readLinux();
  } catch {
    return '';
  }
  if (!text) return '';
  return text.slice(0, MAX_CLIPBOARD_CHARS);
}

/**
 * Shape check for an API key.
 *
 * Deliberately provider-agnostic: keys range from `gsk_…` and `sk-or-v1-…` to
 * bare 64-char hex and JWTs, so a strict per-provider regex would reject real
 * keys. Anything that looks like one opaque token is a candidate; the real
 * gate is a live verification request.
 */
export function looksLikeApiKey(text) {
  const value = String(text || '').trim();
  if (value.length < 20 || value.length > 512) return false;
  if (/\s/.test(value)) return false;
  // `=` is only legal as base64 padding at the end; anywhere else it means we
  // are looking at an `KEY=value` assignment rather than the value itself.
  if (!/^[A-Za-z0-9._~+/-]+={0,2}$/.test(value)) return false;
  // Reject things that are obviously not keys.
  if (/^https?:\/\//i.test(value)) return false;
  if (/^[\d.]+$/.test(value)) return false;
  if (/^(?:true|false|null|undefined)$/i.test(value)) return false;
  // Require some entropy: a single repeated character or a plain word is not a key.
  if (new Set(value).size < 8) return false;
  return true;
}

/**
 * Pull a key candidate out of arbitrary clipboard text.
 *
 * Handles the common real-world cases: the bare key, a key wrapped in quotes,
 * and a line such as `GROQ_API_KEY=gsk_…` copied from a `.env` snippet.
 */
export function extractKeyCandidate(text) {
  const raw = String(text || '').trim();
  if (!raw) return '';

  // Assignment form first: `KEY=value` would otherwise look like a bare token
  // once `=` is tolerated as base64 padding.
  const lines = raw.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  for (const line of lines) {
    const assigned = line.match(/^[A-Za-z_][A-Za-z0-9_]*\s*[=:]\s*(.+)$/);
    if (assigned) {
      const value = assigned[1].trim().replace(/^["']|["']$/g, '');
      if (looksLikeApiKey(value)) return value;
    }
  }

  if (looksLikeApiKey(raw)) return raw;

  for (const line of lines) {
    if (looksLikeApiKey(line)) return line;
  }

  // A key embedded in surrounding prose/quotes.
  const quoted = raw.match(/["'`]([A-Za-z0-9._~+/-]{20,512}={0,2})["'`]/);
  if (quoted && looksLikeApiKey(quoted[1])) return quoted[1];

  return '';
}

/** Stable digest so the caller can tell whether the clipboard changed. */
export function clipboardSignature(text) {
  const value = String(text || '');
  if (!value) return '0:0';
  let hash = 0;
  for (let i = 0; i < value.length; i += 1) {
    hash = (hash * 31 + value.charCodeAt(i)) | 0;
  }
  return `${value.length}:${hash}`;
}

export async function clipboardStatus() {
  const text = await readClipboard();
  const candidate = extractKeyCandidate(text);
  return {
    available: Boolean(text),
    signature: clipboardSignature(text),
    candidate,
    // Never return arbitrary clipboard contents: only a shape-checked key.
    length: text.length
  };
}
