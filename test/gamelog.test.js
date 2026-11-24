'use strict';
// The game's console output: log4j XML becomes readable lines, and the token, sign-in app ID and Xbox ID never show.
const test = require('node:test');
const assert = require('node:assert');
const { makeRedactor, createGameLogReader } = require('../src/core/minecraft/gamelog');

const ts = new Date(2026, 10, 24, 17, 35, 12).getTime();
const read = (lines, redact) => {
  const out = [];
  const r = createGameLogReader((l) => out.push(l), redact);
  for (const l of lines) r.push(l);
  r.end();
  return out;
};

test('a log4j XML event becomes one latest.log-style line', () => {
  const out = read([
    `  <log4j:Event logger="net.minecraft.client.Minecraft" timestamp="${ts}" level="INFO" thread="Render thread">`,
    '    <log4j:Message><![CDATA[Setting user: Steve]]></log4j:Message>',
    '  </log4j:Event>',
  ]);
  assert.deepEqual(out, ['[17:35:12] [Render thread/INFO]: Setting user: Steve']);
});

test('multi-line messages, stack traces, split CDATA and escaped attributes are kept', () => {
  const out = read([
    `<log4j:Event logger="FabricLoader" timestamp="${ts}" level="INFO" thread="main">`,
    '<log4j:Message><![CDATA[Loading 2 mods:',
    '\t- fabricloader 0.20.1',
    '\t- sodium 0.9.3]]></log4j:Message>',
    '</log4j:Event>',
    `<log4j:Event logger="X" timestamp="${ts}" level="ERROR" thread="Worker &quot;1&quot;">`,
    '<log4j:Message><![CDATA[odd ]]]]><![CDATA[> text]]></log4j:Message>',
    '<log4j:Throwable><![CDATA[java.lang.IllegalStateException: boom',
    '\tat a.b.C.d(C.java:1)',
    ']]></log4j:Throwable>',
    '</log4j:Event>',
  ]);
  assert.deepEqual(out, [
    '[17:35:12] [main/INFO]: Loading 2 mods:',
    '\t- fabricloader 0.20.1',
    '\t- sodium 0.9.3',
    '[17:35:12] [Worker "1"/ERROR]: odd ]]> text',
    'java.lang.IllegalStateException: boom',
    '\tat a.b.C.d(C.java:1)',
  ]);
});

test('plain lines pass through, and a half-finished event is not lost', () => {
  const out = read([
    'WARNING: A terminally deprecated method in sun.misc.Unsafe has been called',
    `<log4j:Event logger="X" timestamp="${ts}" level="WARN" thread="main">`,
    '<log4j:Message><![CDATA[cut off',
  ]);
  assert.equal(out[0], 'WARNING: A terminally deprecated method in sun.misc.Unsafe has been called');
  assert.ok(out.some((l) => l.includes('cut off')), 'the game was killed mid-event: show what arrived');
});

test('the access token, sign-in app ID and Xbox user ID are hidden everywhere, short or empty values are not touched', () => {
  const hide = makeRedactor([['tok3n-secret-value', '<access token>'], ['0d05caf7-1111-2222-3333-444444444444', '<client id>'], ['2535444075684444', '<xuid>'], ['0', '<x>'], ['', '<y>'], [undefined, '<z>']]);
  const args = '--accessToken tok3n-secret-value --clientId 0d05caf7-1111-2222-3333-444444444444 --xuid 2535444075684444 --versionType release -Xmx8192M';
  const shown = hide(args);
  assert.equal(shown, '--accessToken <access token> --clientId <client id> --xuid <xuid> --versionType release -Xmx8192M');
  // inside the game's own log lines too, and after XML formatting
  const out = read([
    `<log4j:Event logger="X" timestamp="${ts}" level="INFO" thread="main">`,
    '<log4j:Message><![CDATA[session tok3n-secret-value for 2535444075684444]]></log4j:Message>',
    '</log4j:Event>',
    'tok3n-secret-value',
  ], hide);
  assert.ok(out.every((l) => !l.includes('tok3n-secret-value') && !l.includes('2535444075684444')), out.join('\n'));
});

test('launch.js uses the reader and hides all three values', () => {
  const src = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'src', 'core', 'minecraft', 'launch.js'), 'utf8');
  assert.match(src, /makeRedactor\(\[\[creds\.accessToken, '<access token>'\], \[ctx\.settings\.get\('msClientId'\), '<client id>'\], \[creds\.xuid, '<xuid>'\]\]\)/);
  assert.match(src, /createGameLogReader\(onLog, hide\)/);
  assert.match(src, /onLog\(hide\(`\[Junction\] Arguments:/);
  assert.match(src, /reader\.end\(\)/, 'the last line is redacted too');
});

test('the Logs tab colours game lines by their real level, so an INFO line saying "type=ERROR" stays plain', () => {
  const src = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'src', 'renderer', 'instance.js'), 'utf8');
  const fn = /function logLineClass\(l\) \{[\s\S]*?\n\}/.exec(src)[0];
  const logLineClass = require('node:vm').runInNewContext(`(${fn})`);
  assert.equal(logLineClass("[17:55:53] [Render thread/INFO]: OpenGL debug message: id=1280, source=API, type=ERROR, severity=HIGH, message='GL_INVALID_ENUM error generated.'"), '');
  assert.equal(logLineClass('[17:55:11] [main/WARN]: Sodium has applied one or more workarounds'), 'l-warn');
  assert.equal(logLineClass('[17:55:11] [Server thread/ERROR]: Encountered an unexpected exception'), 'l-err');
  assert.equal(logLineClass('java.lang.IllegalStateException: boom'), 'l-err', 'stack trace lines have no level: judged by their words');
  assert.equal(logLineClass('WARNING: A terminally deprecated method'), '');
  assert.equal(logLineClass('[Junction] Launching fabric'), 'l-j');
});

test('Java error names in stack traces are red', () => {
  const src = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'src', 'renderer', 'instance.js'), 'utf8');
  const logLineClass = require('node:vm').runInNewContext(`(${/function logLineClass\(l\) \{[\s\S]*?\n\}/.exec(src)[0]})`);
  assert.equal(logLineClass('java.lang.OutOfMemoryError: Java heap space'), 'l-err');
  assert.equal(logLineClass('Caused by: java.io.IOException: closed'), 'l-err');
  assert.equal(logLineClass('\tat net.minecraft.Main.main(Main.java:1)'), '', 'the "at …" lines stay plain so the error itself stands out');
});
