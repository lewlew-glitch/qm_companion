const fs = require('node:fs');
const orig = fs.renameSync;
fs.renameSync = function patchedRenameSync(from, to) {
  const suffix = process.env.QM_FAIL_RENAME_SUFFIX;
  if (suffix && String(to).endsWith(suffix)) {
    const err = new Error('injected rename failure');
    err.code = 'EIO';
    throw err;
  }
  return orig.call(fs, from, to);
};
