// Minimal validator for the small JSON-Schema subset our tool definitions use
// (flat objects of string / integer / number / boolean, with enum, minimum,
// maximum and required).
//
// Model output is untrusted: small local models regularly send numbers as
// strings or omit required fields, and streamed tool input can arrive
// truncated. Every tool input goes through here before a tool runs.

function coerce(value, spec) {
  switch (spec.type) {
    case 'string':
      return typeof value === 'string' ? value : typeof value === 'number' ? String(value) : undefined;
    case 'integer':
    case 'number': {
      const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
      if (typeof n !== 'number' || !Number.isFinite(n)) return undefined;
      if (spec.type === 'integer' && !Number.isInteger(n)) return undefined;
      return n;
    }
    case 'boolean':
      if (typeof value === 'boolean') return value;
      if (value === 'true') return true;
      if (value === 'false') return false;
      return undefined;
    default:
      return value;
  }
}

/**
 * @returns {{ ok: true, value: object } | { ok: false, error: string }}
 */
export function validateInput(schema, input) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, error: 'Tool input must be a JSON object.' };
  }
  const properties = schema.properties ?? {};
  const value = {};
  const errors = [];

  for (const [key, spec] of Object.entries(properties)) {
    const raw = input[key];
    if (raw === undefined || raw === null) {
      if (schema.required?.includes(key)) errors.push(`"${key}" is required`);
      continue;
    }
    const v = coerce(raw, spec);
    if (v === undefined) {
      errors.push(`"${key}" must be a ${spec.type}`);
      continue;
    }
    if (spec.enum && !spec.enum.includes(v)) {
      errors.push(`"${key}" must be one of: ${spec.enum.join(', ')}`);
      continue;
    }
    if (typeof v === 'number') {
      // Clamp instead of rejecting: "limit: 500" should just mean "the max".
      value[key] = Math.min(spec.maximum ?? v, Math.max(spec.minimum ?? v, v));
    } else if (spec.type === 'string' && schema.required?.includes(key) && v.trim() === '') {
      errors.push(`"${key}" must not be empty`);
    } else {
      value[key] = v;
    }
  }

  if (errors.length) return { ok: false, error: `Invalid tool input: ${errors.join('; ')}.` };
  return { ok: true, value };
}
