const configuredOrigins = process.env.FRONTEND_ORIGIN;

if (configuredOrigins === undefined && process.env.NODE_ENV === 'production') {
  throw new Error('FRONTEND_ORIGIN must be set in production');
}

if (configuredOrigins !== undefined && !configuredOrigins.trim()) {
  throw new Error('FRONTEND_ORIGIN must contain at least one origin');
}

const originValues = configuredOrigins === undefined
  ? ['http://localhost:4200']
  : configuredOrigins.split(',');

export const allowedFrontendOrigins = new Set(
  originValues.map((value) => {
    const origin = value.trim();
    let parsed: URL;

    try {
      parsed = new URL(origin);
    } catch {
      throw new Error(`Invalid frontend origin in FRONTEND_ORIGIN: ${origin}`);
    }

    if (
      !['http:', 'https:'].includes(parsed.protocol) ||
      parsed.username ||
      parsed.password ||
      parsed.pathname !== '/' ||
      parsed.search ||
      parsed.hash
    ) {
      throw new Error(`FRONTEND_ORIGIN values must be HTTP(S) origins: ${origin}`);
    }

    return parsed.origin;
  })
);

export function isAllowedFrontendOrigin(origin: string): boolean {
  return allowedFrontendOrigins.has(origin);
}
