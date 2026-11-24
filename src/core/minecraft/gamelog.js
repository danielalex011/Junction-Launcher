'use strict';
// The game's console output, made fit to show and share:
//  - Minecraft (with Mojang's log4j config) writes each log entry as an XML block; this turns those into the
//    normal one-line form you know from latest.log: "[17:35:12] [Render thread/INFO]: Setting user: Steve".
//  - Values that must never be shown (the access token, the sign-in app ID, the Xbox user ID) are hidden in every line.
// Plain Node, no Electron.

const MAX_EVENT_LINES = 4000; // an event that never closes is passed on as it is

/** Returns text -> text that replaces each secret value with its label. Values shorter than 6 characters (or "0") are ignored. */
function makeRedactor(pairs) {
  const list = (pairs || [])
    .filter(([value]) => typeof value === 'string' && value.length >= 6 && value !== '0')
    .sort((a, b) => b[0].length - a[0].length);
  return (text) => {
    let out = String(text);
    for (const [value, label] of list) if (out.includes(value)) out = out.split(value).join(label);
    return out;
  };
}

const ENTITIES = { '&quot;': '"', '&apos;': "'", '&lt;': '<', '&gt;': '>', '&amp;': '&' };
const unescapeAttr = (s) => String(s).replace(/&(quot|apos|lt|gt|amp);/g, (m) => ENTITIES[m]);

function attrsOf(tag) {
  const out = {};
  for (const m of tag.matchAll(/([\w:-]+)="([^"]*)"/g)) out[m[1]] = unescapeAttr(m[2]);
  return out;
}

/** The text inside every CDATA section of an element (log4j splits a message that contains "]]>" into several). */
function cdataOf(block, element) {
  const m = new RegExp(`<log4j:${element}>([\\s\\S]*?)</log4j:${element}>`).exec(block);
  if (!m) return null;
  const parts = [...m[1].matchAll(/<!\[CDATA\[([\s\S]*?)\]\]>/g)].map((x) => x[1]);
  return parts.length ? parts.join('') : unescapeAttr(m[1].trim());
}

const pad = (n) => String(n).padStart(2, '0');
function clock(ms) {
  const d = new Date(Number(ms));
  return Number.isFinite(d.getTime()) ? `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` : '--:--:--';
}

/** One finished XML event as plain lines. */
function formatEvent(block) {
  const open = /<log4j:Event\b[^>]*>/.exec(block);
  const a = attrsOf(open ? open[0] : '');
  const message = cdataOf(block, 'Message') ?? '';
  const thrown = cdataOf(block, 'Throwable');
  const lines = String(message).replace(/\r/g, '').split('\n');
  const out = [`[${clock(a.timestamp)}] [${a.thread || 'main'}/${a.level || 'INFO'}]: ${lines[0]}`, ...lines.slice(1)];
  if (thrown) out.push(...String(thrown).replace(/\r/g, '').split('\n').filter((l, i, all) => l || i < all.length - 1));
  return out;
}

/**
 * Reads the game's output line by line and calls emit(line) with readable, redacted lines.
 * push(line) for each line that arrives, end() when the stream closes (passes on anything left half-finished).
 */
function createGameLogReader(emit, redact = (s) => s) {
  let block = null; // lines of the XML event being collected
  const send = (line) => emit(redact(line));
  return {
    push(line) {
      const t = String(line);
      if (block === null) {
        if (/^\s*<log4j:Event\b/.test(t)) {
          block = [t];
          if (/<\/log4j:Event>\s*$/.test(t)) { for (const l of formatEvent(t)) send(l); block = null; }
          return;
        }
        send(t);
        return;
      }
      block.push(t);
      if (/<\/log4j:Event>\s*$/.test(t)) {
        for (const l of formatEvent(block.join('\n'))) send(l);
        block = null;
      } else if (block.length > MAX_EVENT_LINES) {
        for (const l of block) send(l);
        block = null;
      }
    },
    end() {
      if (block) for (const l of block) send(l);
      block = null;
    },
  };
}

module.exports = { makeRedactor, createGameLogReader, formatEvent };
