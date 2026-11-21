'use strict';
// Test reporter for `npm run test:quiet`: prints only what fails, then one summary line.
//   node --test --test-reporter=./tools/quiet-reporter.js test/*.test.js
module.exports = async function* quietReporter(source) {
  let pass = 0;
  let fail = 0;
  let skipped = 0;
  for await (const e of source) {
    if (e.type === 'test:pass' && e.data.details?.type !== 'suite') {
      if (e.data.skip || e.data.todo) skipped++; else pass++;
    } else if (e.type === 'test:fail' && e.data.details?.type !== 'suite') {
      fail++;
      const err = e.data.details?.error;
      const msg = String(err?.cause?.message || err?.message || err || 'failed').split('\n').slice(0, 14).join('\n    ');
      const file = e.data.file ? e.data.file.replace(/^.*[\\/]test[\\/]/, 'test/') : '';
      yield `✖ ${e.data.name}${file ? `  (${file})` : ''}\n    ${msg}\n`;
    }
  }
  yield `${fail ? 'FAIL' : 'ok'}: ${pass} passed, ${fail} failed${skipped ? `, ${skipped} skipped` : ''}\n`;
};
