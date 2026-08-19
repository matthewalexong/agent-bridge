export function optimize(items, maxBytes) {
  let bytesAccum = 0;
  let overflow = false;
  const events = [];

  for (const item of items) {
    const bytes = computeJsonByteLength(item);
    if (bytesAccum + bytes > maxBytes) {
      overflow = true;
      break;
    }
    events.push(item);
    bytesAccum += bytes;
  }

  return { events, bytes: bytesAccum, overflow };
}

function computeJsonByteLength(obj) {
  let len = 0;

  if (obj === null) {
    len = 2; // "null"
  } else if (typeof obj === 'boolean') {
    len = obj ? 4 : 5; // "true" / "false"
  } else if (typeof obj === 'number') {
    const s = String(obj);
    len = s.length;
  } else if (typeof obj === 'string') {
    len = escapeString(obj);
  } else if (typeof obj === 'object') {
    if (obj instanceof Date) {
      const s = obj.toISOString();
      len = escapeString(s);
    } else if (obj instanceof Array) {
      len = 1; // "["
      for (let i = 0; i < obj.length; i++) {
        len += computeJsonByteLength(obj[i]);
        if (i < obj.length - 1) len += 1; // ","
      }
      len += 1; // "]"
    } else {
      len = 1; // "{"
      const keys = Object.keys(obj);
      for (let i = 0; i < keys.length; i++) {
        len += escapeString(keys[i]);
        len += 2; // ": "
        len += computeJsonByteLength(obj[keys[i]]);
        if (i < keys.length - 1) len += 1; // ","
      }
      len += 1; // "}"
    }
  }

  return len;
}

function escapeString(str) {
  let len = 0;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    if (ch === 0x22) {
      len += 6; // \"
    } else if (ch === 0x5C) {
      len += 6; // \\
    } else if (ch === 0x08) {
      len += 6; // \b
    } else if (ch === 0x0C) {
      len += 6; // \f
    } else if (ch === 0x0A) {
      len += 6; // \n
    } else if (ch === 0x0D) {
      len += 6; // \r
    } else if (ch === 0x09) {
      len += 6; // \t
    } else if (ch < 0x20) {
      len += 6; // \uXXXX
    } else {
      len += 1;
    }
  }
  len += 2; // surrounding quotes
  return len;
}
