// Explain proxy refusals without guessing the install system or exposing keys.

import { dockerProxyKeyProblem } from '../docker.js';
import { escapeHtml } from '../http.js';

const code = (value) => `<code class="mono">${escapeHtml(value)}</code>`;

export function proxyRecoveryLines(flag) {
  const problem = dockerProxyKeyProblem();
  const key = code('QM_PROXY_KEY');
  const keyProblem = {
    missing: `Companion's ${key} is missing.`,
    short: `Companion's ${key} is too short. It must contain at least 32 characters.`,
    malformed: `Companion's ${key} contains unsupported separators or surrounding whitespace.`,
  }[problem];
  const lines = keyProblem
    ? [keyProblem, `Enter the same private ${key} in Companion and its socket proxy.`]
    : [`First check that ${code('QM_PROXY_KEY')} is the same in Companion and its socket proxy. A key mismatch can block every Docker read request.`];
  if (!problem) {
    lines.push(flag
      ? `If the keys match, check that ${code(`${flag}: 1`)} is enabled on the socket proxy.`
      : 'If the keys match, check that the required Docker read APIs are enabled on the socket proxy.');
  }
  lines.push('On Unraid, edit the affected container settings and Apply. For Compose, recreate the affected containers using the same project and ordered files as the existing installation.');
  lines.push(`Keep ${code('POST: 0')} and ${code('EXEC: 0')} for a read-only installation. Docker writes and shell access are not needed to fix read requests.`);
  return lines;
}
