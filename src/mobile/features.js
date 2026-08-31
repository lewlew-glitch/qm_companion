// Mobile listener and enrolment features default to disabled.

function flag(name) {
  return process.env[name] === 'true';
}

export function mobileFeatures() {
  const api = flag('MOBILE_API_ENABLED');
  return {
    api,
    enrolment: api && flag('MOBILE_ENROLMENT_ENABLED'),
  };
}
