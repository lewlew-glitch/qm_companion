const fs = require('node:fs');
const orig = fs.openSync;
fs.openSync = function patchedOpenSync(path, flags, mode) {
  const dir = process.env.QM_FAIL_DIRFSYNC_DIR;
  if (dir && String(path) === dir && flags === 'r') {
    const err = new Error('injected directory fsync failure');
    err.code = 'EIO';
    throw err;
  }
  return orig.call(fs, path, flags, mode);
};
