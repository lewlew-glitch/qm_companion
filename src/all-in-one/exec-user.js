// docker exec runs as root in the all-in-one image. A script that reads or writes DATA_DIR imports this
// first and runs as the node user, so it can open Companion's files and Companion can open its files.

import { APP_GID, APP_UID } from './plan.js';

if (process.env.QM_ALL_IN_ONE === '1' && process.getuid?.() === 0) {
  try {
    process.setgroups([]);
    process.setgid(APP_GID);
    process.setuid(APP_UID);
  } catch {
    process.stderr.write('\n  Could not switch to the node user. Run this with docker exec -u node.\n\n');
    process.exit(1);
  }
}
