'use strict';

const dns = require('node:dns').promises;
const net = require('node:net');

function isPrivateIPv4(address) {
  const parts = address.split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true;
  const [a, b, c, d] = parts;

  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && c === 0) ||
    (a === 192 && b === 0 && c === 2) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) ||
    a >= 224 ||
    (a === 255 && b === 255 && c === 255 && d === 255)
  );
}

function isPrivateIPv6(address) {
  const normalized = address.toLowerCase().split('%')[0];
  if (normalized === '::' || normalized === '::1') return true;
  if (normalized.startsWith('fc') || normalized.startsWith('fd')) return true;
  if (/^fe[89ab]/.test(normalized)) return true;
  if (normalized.startsWith('ff')) return true;
  if (normalized.startsWith('2001:db8:')) return true;

  const mapped = normalized.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isPrivateIPv4(mapped[1]);
  return false;
}

function isPrivateAddress(address) {
  const family = net.isIP(address);
  if (family === 4) return isPrivateIPv4(address);
  if (family === 6) return isPrivateIPv6(address);
  return true;
}

function isBlockedHostname(hostname) {
  const host = String(hostname || '').toLowerCase().replace(/\.$/, '');
  return (
    !host ||
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal')
  );
}

async function resolveHostname(hostname) {
  if (net.isIP(hostname)) return [hostname];
  const records = await dns.lookup(hostname, { all: true, verbatim: true });
  return [...new Set(records.map((record) => record.address))];
}

async function assertSafeHttpUrl(value, label = 'URL', options = {}) {
  let url;
  try {
    url = new URL(String(value || '').trim());
  } catch {
    throw new Error(`${label} tidak valid.`);
  }

  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error(`${label} hanya boleh menggunakan http:// atau https://.`);
  }
  if (url.username || url.password) {
    throw new Error(`${label} tidak boleh memuat username atau password.`);
  }
  if (options.allowPrivate === true) return url.href;
  if (isBlockedHostname(url.hostname)) {
    throw new Error(`${label} menuju hostname lokal/internal dan diblokir demi keamanan.`);
  }

  let addresses;
  try {
    addresses = await resolveHostname(url.hostname);
  } catch {
    throw new Error(`${label} tidak dapat ditemukan melalui DNS.`);
  }
  if (!addresses.length || addresses.some(isPrivateAddress)) {
    throw new Error(`${label} mengarah ke jaringan lokal/private dan diblokir demi keamanan.`);
  }

  return url.href;
}

function createUrlGuard(options = {}) {
  const cache = new Map();
  return async function isAllowedUrl(value) {
    let url;
    try {
      url = new URL(value);
    } catch {
      return false;
    }
    if (!['http:', 'https:'].includes(url.protocol)) return true;
    if (options.allowPrivate === true) return true;

    const key = url.hostname.toLowerCase();
    if (!cache.has(key)) {
      cache.set(key, assertSafeHttpUrl(`${url.protocol}//${url.host}/`, 'Request', options)
        .then(() => true)
        .catch(() => false));
    }
    return cache.get(key);
  };
}

module.exports = {
  assertSafeHttpUrl,
  createUrlGuard,
  isPrivateAddress
};
