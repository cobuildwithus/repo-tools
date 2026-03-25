import path from 'node:path';

export function trimCr(value) {
  return value.replace(/\r$/u, '');
}

export function normalizeAuditPath(filePath) {
  return filePath.replace(/\\/g, '/').replace(/^\.\/+/u, '').replace(/\/+$/u, '');
}

export function splitEnvLines(value) {
  return String(value ?? '')
    .split('\n')
    .map((entry) => trimCr(entry).trim())
    .filter((entry) => entry.length > 0);
}

export function parseBooleanFlag(value, fallback) {
  if (value === undefined) {
    return fallback;
  }

  const normalized = value.trim().toLowerCase();
  if (normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on') {
    return true;
  }
  if (normalized === '0' || normalized === 'false' || normalized === 'no' || normalized === 'off') {
    return false;
  }
  return fallback;
}

export function parseScanSpec(rawSpec) {
  const normalized = trimCr(rawSpec).trim();
  if (normalized.length === 0) {
    throw new Error('Scan spec cannot be empty.');
  }

  const separatorIndex = normalized.indexOf(':');
  if (separatorIndex === -1) {
    return {
      root: normalizeAuditPath(normalized),
      fileGlob: '*',
    };
  }

  return {
    root: normalizeAuditPath(normalized.slice(0, separatorIndex)),
    fileGlob: normalized.slice(separatorIndex + 1) || '*',
  };
}

function globToRegExp(glob) {
  const escaped = glob
    .replace(/[|\\{}()[\]^$+?.]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`, 'u');
}

export function matchesScanSpec(relativePath, spec) {
  const normalizedPath = normalizeAuditPath(relativePath);
  const normalizedRoot = normalizeAuditPath(spec.root);
  const fileName = path.posix.basename(normalizedPath);
  const pattern = globToRegExp(spec.fileGlob);

  if (!pattern.test(fileName)) {
    return false;
  }

  if (normalizedPath === normalizedRoot) {
    return true;
  }

  return normalizedPath.startsWith(`${normalizedRoot}/`);
}

export function pathHasDirectorySegment(relativePath, segmentNames) {
  const normalizedPath = normalizeAuditPath(relativePath);
  const segments = normalizedPath.split('/');
  return segments.slice(0, -1).some((segment) => segmentNames.has(segment));
}
