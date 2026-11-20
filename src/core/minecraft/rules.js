'use strict';
// Mojang's version JSON "rules" system: decides which libraries and arguments
// apply to this OS / architecture / feature set.
const os = require('os');
const { osName } = require('../util');

function osMatches(ruleOs, env) {
  if (!ruleOs) return true;
  if (ruleOs.name && ruleOs.name !== env.os) return false;
  if (ruleOs.arch) {
    const a = ruleOs.arch;
    if (a === 'x86' && env.arch !== 'ia32') return false;
    if (a !== 'x86' && a !== env.arch) return false;
  }
  if (ruleOs.version) {
    try { if (!new RegExp(ruleOs.version).test(env.osVersion)) return false; } catch { return false; }
  }
  return true;
}

function featuresMatch(ruleFeatures, features) {
  if (!ruleFeatures) return true;
  return Object.entries(ruleFeatures).every(([k, v]) => Boolean(features[k]) === Boolean(v));
}

function currentEnv() {
  return { os: osName(), arch: process.arch, osVersion: os.release() };
}

function rulesAllow(rules, features = {}, env = currentEnv()) {
  if (!Array.isArray(rules) || rules.length === 0) return true;
  let allowed = false;
  for (const r of rules) {
    if (osMatches(r.os, env) && featuresMatch(r.features, features)) allowed = r.action === 'allow';
  }
  return allowed;
}

function substitute(str, vars) {
  return String(str).replace(/\$\{([^}]+)\}/g, (m, k) => (vars[k] !== undefined && vars[k] !== null ? String(vars[k]) : m));
}

// Flattens a modern "arguments.game"/"arguments.jvm" list into strings.
function evaluateArgs(list, vars, features = {}, env = currentEnv()) {
  const out = [];
  for (const item of list || []) {
    if (typeof item === 'string') {
      out.push(substitute(item, vars));
    } else if (item && rulesAllow(item.rules, features, env)) {
      const vals = Array.isArray(item.value) ? item.value : [item.value];
      for (const v of vals) out.push(substitute(v, vars));
    }
  }
  return out;
}

module.exports = { rulesAllow, evaluateArgs, substitute, currentEnv };
