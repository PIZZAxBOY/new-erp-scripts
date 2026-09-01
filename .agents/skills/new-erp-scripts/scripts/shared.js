const fs = require('node:fs');
const path = require('node:path');

class CliError extends Error {
  constructor(message, exitCode = 1) {
    super(message);
    this.exitCode = exitCode;
  }
}

class ArgumentError extends CliError {}

class AuthRequiredError extends CliError {
  constructor(host, message) {
    super(`${message} (${host})`);
    this.host = host;
  }
}

class CommandExecutionError extends CliError {}

class EmptyResultError extends CliError {}

function parseBoolean(value, label) {
  if (value === true || value === false) return value;
  const text = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(text)) return true;
  if (['0', 'false', 'no', 'off'].includes(text)) return false;
  throw new ArgumentError(`${label} must be true or false`);
}

function parseArgs(argv, definitions) {
  const byName = new Map(definitions.map((definition) => [definition.name, definition]));
  const values = Object.fromEntries(definitions.map((definition) => [definition.name, definition.default]));
  values.help = false;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--help' || argument === '-h') {
      values.help = true;
      continue;
    }
    if (!argument.startsWith('--')) {
      throw new ArgumentError(`unexpected argument: ${argument}`);
    }

    const equalsIndex = argument.indexOf('=');
    const name = equalsIndex === -1 ? argument.slice(2) : argument.slice(2, equalsIndex);
    const inlineValue = equalsIndex === -1 ? undefined : argument.slice(equalsIndex + 1);
    const definition = byName.get(name);
    if (!definition) throw new ArgumentError(`unknown option: --${name}`);

    if (definition.type === 'bool') {
      const next = argv[index + 1];
      if (inlineValue !== undefined) {
        values[name] = parseBoolean(inlineValue, name);
      } else if (next !== undefined && !next.startsWith('--') && /^(true|false|yes|no|on|off|1|0)$/i.test(next)) {
        values[name] = parseBoolean(next, name);
        index += 1;
      } else {
        values[name] = true;
      }
      continue;
    }

    const rawValue = inlineValue ?? argv[++index];
    if (rawValue === undefined || rawValue.startsWith('--')) {
      throw new ArgumentError(`--${name} requires a value`);
    }
    if (definition.type === 'int') {
      const number = Number(rawValue);
      if (!Number.isInteger(number)) throw new ArgumentError(`--${name} must be an integer`);
      values[name] = number;
    } else {
      values[name] = rawValue;
    }
  }

  return values;
}

function formatHelp({ name, description, args }) {
  const lines = [`Usage: node ${name}.js [options]`, '', description, '', 'Options:'];
  for (const argument of args) {
    const value = argument.type === 'bool' ? '' : ` <${argument.type}>`;
    const defaultText = argument.default === '' || argument.default === undefined
      ? ''
      : ` (default: ${argument.default})`;
    const choicesText = argument.choices ? ` [${argument.choices.join('|')}]` : '';
    lines.push(`  --${argument.name}${value}${choicesText}  ${argument.help || ''}${defaultText}`.trimEnd());
  }
  lines.push('  -h, --help  show this help');
  return `${lines.join('\n')}\n`;
}

async function runCli({ name, description, args, func }) {
  try {
    const values = parseArgs(process.argv.slice(2), args);
    if (values.help) {
      process.stdout.write(formatHelp({ name, description, args }));
      return;
    }
    const result = await func(values);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Error: ${message}\n`);
    process.exitCode = error?.exitCode || 1;
  }
}

function configFilePath() {
  const configuredPath = String(process.env.NEW_ERP_CONFIG ?? '').trim();
  return configuredPath ? path.resolve(process.cwd(), configuredPath) : path.resolve(process.cwd(), 'config.json');
}

function readConfig() {
  const filename = configFilePath();
  if (!fs.existsSync(filename)) {
    if (String(process.env.NEW_ERP_CONFIG ?? '').trim()) {
      throw new CommandExecutionError(`new-erp config file not found: ${filename}`);
    }
    return {};
  }
  try {
    const config = JSON.parse(fs.readFileSync(filename, 'utf8'));
    if (!config || typeof config !== 'object' || Array.isArray(config)) {
      throw new Error('config must be a JSON object');
    }
    return config;
  } catch (error) {
    throw new CommandExecutionError(`failed to read new-erp config: ${error?.message || error}`);
  }
}

function configuredValue(environmentName, configName) {
  const environmentValue = String(process.env[environmentName] ?? '').trim();
  if (environmentValue) return environmentValue;
  return String(readConfig()[configName] ?? '').trim();
}

function normalizeBaseUrl(value) {
  const raw = String(value ?? '').trim();
  if (!raw) throw new ArgumentError('NEW_ERP_BASE_URL is required');

  let parsed;
  try {
    parsed = new URL(raw);
  } catch (error) {
    throw new ArgumentError(`NEW_ERP_BASE_URL must be a valid URL, got: ${raw}`);
  }
  if (!/^https?:$/.test(parsed.protocol)) {
    throw new ArgumentError(`NEW_ERP_BASE_URL must use http or https, got: ${parsed.protocol}`);
  }
  if (parsed.search || parsed.hash) {
    throw new ArgumentError('NEW_ERP_BASE_URL must not include query parameters or a hash');
  }

  parsed.pathname = parsed.pathname.replace(/\/index\.php\/?$/i, '').replace(/\/+$/, '');
  return parsed.href.replace(/\/+$/, '');
}

function getBaseUrl() {
  return normalizeBaseUrl(configuredValue('NEW_ERP_BASE_URL', 'baseUrl'));
}

function requiredString(value, label) {
  const text = String(value ?? '').trim();
  if (!text) throw new ArgumentError(`${label} is required`);
  return text;
}

function positiveInteger(value, defaultValue, label, maxValue = null) {
  const raw = value ?? defaultValue;
  const number = Number(raw);
  if (!Number.isInteger(number) || number <= 0) {
    throw new ArgumentError(`${label} must be a positive integer`);
  }
  if (maxValue !== null && number > maxValue) {
    throw new ArgumentError(`${label} must be <= ${maxValue}`);
  }
  return number;
}

async function requestJson(url, { method = 'GET', headers = {}, body = undefined, label = 'new-erp request' } = {}) {
  let response;
  const baseUrl = getBaseUrl();
  try {
    const options = {
      method,
      headers: {
        Accept: 'application/json, text/plain, */*',
        'User-Agent': 'Mozilla/5.0',
        Referer: `${baseUrl}/`,
        ...headers,
      },
      body,
    };
    response = await fetch(url, options);
  } catch (error) {
    const causeMessage = error?.cause?.message || error?.cause?.code || '';
    const message = [error?.message || String(error), causeMessage]
      .filter((item, index, items) => item && items.indexOf(item) === index)
      .join(': ');
    throw new CommandExecutionError(`${label} failed: ${message}`);
  }

  const responseText = await response.text();
  let json;
  try {
    json = JSON.parse(responseText);
  } catch (error) {
    const sample = responseText.replace(/\s+/g, ' ').slice(0, 180);
    throw new CommandExecutionError(`${label} returned non-JSON response: HTTP ${response.status}; ${sample}`);
  }

  if (response.status === 401 || Number(json?.code) === 401 || /请登录/.test(String(json?.msg ?? ''))) {
    throw new AuthRequiredError(new URL(url).host, json?.msg || `${label} requires login`);
  }
  if (!response.ok) {
    const apiMessage = String(json?.msg ?? '').trim();
    throw new CommandExecutionError(`${label} failed: HTTP ${response.status}${apiMessage ? `, msg=${apiMessage}` : ''}`);
  }
  if (json?.code !== undefined && Number(json.code) !== 200) {
    throw new CommandExecutionError(`${label} failed: code=${json.code}, msg=${json.msg || ''}`);
  }

  return json;
}

async function loginToken({ username, password }) {
  const baseUrl = getBaseUrl();
  const loginURL = `${baseUrl}/index.php?r=/user/check-login`;
  const user = requiredString(username || configuredValue('NEW_ERP_USERNAME', 'username'), 'username');
  const pass = requiredString(password || configuredValue('NEW_ERP_PASSWORD', 'password'), 'password');

  const json = await requestJson(loginURL, {
    method: 'POST',
    label: 'new-erp login',
    headers: {
      'Content-Type': 'application/json',
      Origin: baseUrl,
    },
    body: JSON.stringify({ username: user, password: pass }),
  });

  const token = json?.data?.token;
  if (!token) throw new AuthRequiredError(new URL(baseUrl).host, 'login succeeded but token is missing');
  return {
    username: user,
    token,
    expireTime: json?.data?.expire_time ?? null,
    userId: json?.data?.user_id ?? null,
  };
}

function getTokenFromArgs(args) {
  const token = String(args.token || configuredValue('NEW_ERP_TOKEN', 'token') || '').trim();
  return token || null;
}

async function fetchCatalogRows(token) {
  const url = new URL(`${getBaseUrl()}/index.php`);
  url.searchParams.set('r', '/products/game-product-list/selected-options');
  const json = await requestJson(url.href, {
    label: 'new-erp catalog selected-options',
    headers: { token },
  });
  const rows = [];
  const walk = (nodes) => {
    for (const node of Array.isArray(nodes) ? nodes : []) {
      rows.push(node);
      walk(node?.son);
    }
  };
  walk(json?.data?.catalog_list);
  return rows;
}

function parseIdList(value, label) {
  const text = String(value ?? '').trim();
  if (!text) return null;
  const ids = [...new Set(text.split(/[\s,，;；|]+/).map((item) => item.trim()).filter(Boolean))];
  if (ids.some((id) => !/^\d+$/.test(id))) {
    throw new ArgumentError(`${label} must be numeric id list, separated by comma/space`);
  }
  return ids.join(',');
}

const BROWSER_CATALOG_GROUPS = {
  '1674': ['1674', '1675', '1677', '1676', '512', '490'],
};

function expandCatalogIds(value, catalogRows = []) {
  const parsed = parseIdList(value, 'catalogId');
  if (!parsed) return null;
  const ids = parsed.split(',');
  if (ids.length > 1) return parsed;

  const children = catalogRows.reduce((map, row) => {
    const parentId = String(row?.parent ?? '').trim();
    const childId = String(row?.id ?? '').trim();
    if (!parentId || !childId) return map;
    if (!map.has(parentId)) map.set(parentId, []);
    map.get(parentId).push(childId);
    return map;
  }, new Map());
  const seen = new Set();
  const expandedIds = [];
  const add = (id) => {
    if (seen.has(id)) return;
    seen.add(id);
    expandedIds.push(id);
  };
  const walk = (id) => {
    add(id);
    for (const child of children.get(id) ?? []) walk(child);
  };

  const rootId = ids[0];
  const browserGroup = BROWSER_CATALOG_GROUPS[rootId];
  if (browserGroup) {
    for (const id of browserGroup) add(id);
  } else {
    walk(rootId);
  }
  return expandedIds.join(',');
}

function catalogNamesForIds(value, catalogRows = []) {
  if (!value) return null;
  const ids = new Set(value.split(','));
  return new Set(
    catalogRows
      .filter((row) => ids.has(String(row?.id ?? '').trim()))
      .map((row) => String(row?.name_cn ?? '').trim())
      .filter(Boolean),
  );
}

module.exports = {
  ArgumentError,
  AuthRequiredError,
  CommandExecutionError,
  EmptyResultError,
  catalogNamesForIds,
  expandCatalogIds,
  fetchCatalogRows,
  formatHelp,
  getBaseUrl,
  getTokenFromArgs,
  loginToken,
  parseArgs,
  positiveInteger,
  requestJson,
  requiredString,
  runCli,
};
