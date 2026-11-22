'use strict';
// Which release channels an update may come from. Plain script that also loads in Node, so the tests can use it.
// A mod keeps to its own channel by default: a release stays on releases, a beta can take betas or releases, an alpha can take anything.

const JunctionChannel = (function channelModule() {
  const RANK = { release: 0, beta: 1, alpha: 2 };
  const rank = (t) => RANK[t] ?? 0;

  /** The least stable channel allowed: mode is 'auto' (follow the installed file), 'release', 'beta' or 'alpha'. */
  function ceiling(mode, installedType) {
    return mode in RANK ? RANK[mode] : rank(installedType);
  }

  /** Can a version of type `candidateType` be the default for a file whose installed version is `installedType`? */
  function allowed(mode, installedType, candidateType) {
    return rank(candidateType) <= ceiling(mode, installedType);
  }

  return { RANK, allowed, ceiling };
}());

if (typeof module !== 'undefined' && module.exports) module.exports = JunctionChannel;
