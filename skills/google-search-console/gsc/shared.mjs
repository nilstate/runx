export function propertyCovers(property, candidate) {
  try {
    const url = Runx.parseUrl(candidate);
    if (property.startsWith("sc-domain:")) {
      const domain = property.slice("sc-domain:".length).toLowerCase();
      const host = url.hostname.toLowerCase();
      return host === domain || host.endsWith(`.${domain}`);
    }
    return url.href.startsWith(property);
  } catch {
    return false;
  }
}

export function validProperty(value) {
  if (value.startsWith("sc-domain:")) {
    return /^[a-z0-9.-]+$/u.test(value.slice("sc-domain:".length))
      && !value.endsWith(".")
      && !value.includes("..");
  }
  return webUrl(value);
}

export function webUrl(value) {
  try {
    const url = Runx.parseUrl(value);
    return new Set(["http:", "https:"]).has(url.protocol) && Boolean(url.hostname);
  } catch {
    return false;
  }
}

export function digest(value) {
  const candidate = text(object(value).digest);
  return /^sha256:[0-9a-f]{64}$/u.test(candidate) ? candidate : "";
}

export function finding(code, message) {
  return { code, message };
}

export function object(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

export function text(value) {
  return typeof value === "string" ? value.trim() : "";
}

export function stringArray(value) {
  return Array.isArray(value) ? value.map((item) => text(item)).filter(Boolean) : [];
}

export function nonNegativeIntegerOrNull(value) {
  return Number.isInteger(value) && value >= 0 ? value : null;
}
