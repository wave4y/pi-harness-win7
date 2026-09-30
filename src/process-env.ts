// Ambient secrets and interpreter/loader injection settings must not be passed
// to model-requested programs. This is not an OS sandbox: programs still run as
// the current user. MCP's explicitly configured environment is handled elsewhere.
export function cleanProcessEnvironment(source: { [key: string]: string | undefined } = process.env) {
  const result: { [key: string]: string } = {};
  for (const key of Object.keys(source)) {
    if (/(?:API_?KEY|TOKEN|PASSWORD|SECRET|CREDENTIAL|COOKIE|AUTH)/i.test(key)) continue;
    if (/^(?:PYTHON|DYLD_)/i.test(key)) continue;
    if (/^(?:NODE_OPTIONS|NODE_PATH|LD_PRELOAD|LD_LIBRARY_PATH|BASH_ENV|ENV|RUBYOPT|RUBYLIB|PERL5OPT|PERL5LIB|VIRTUAL_ENV|CONDA_PREFIX|CONDA_DEFAULT_ENV)$/i.test(key)) continue;
    const value = source[key];
    if (typeof value === 'string') result[key] = value;
  }
  return result;
}
