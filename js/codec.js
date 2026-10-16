// Serverless signaling codes: an SDP offer/answer (with all ICE candidates
// already gathered) is packed into a compact, copy-pasteable string.
// Format: "z" + base64url(deflate-raw(JSON)) or "j" + base64url(JSON).

function b64urlEncode(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64urlDecode(str) {
  const s = str.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(s + '==='.slice((s.length + 3) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function pipe(bytes, stream) {
  const res = new Response(new Blob([bytes]).stream().pipeThrough(stream));
  return new Uint8Array(await res.arrayBuffer());
}

// Strip SDP lines a remote peer doesn't need, to keep codes short.
function slimSdp(sdp) {
  return sdp.split('\r\n').filter((l) => !/^a=(extmap-allow-mixed|msid-semantic)/.test(l)).join('\r\n');
}

export async function encodeSignal(obj) {
  const o = { ...obj };
  if (o.sdp) o.sdp = slimSdp(o.sdp);
  const json = new TextEncoder().encode(JSON.stringify(o));
  if (typeof CompressionStream === 'function') {
    return 'z' + b64urlEncode(await pipe(json, new CompressionStream('deflate-raw')));
  }
  return 'j' + b64urlEncode(json);
}

export async function decodeSignal(input) {
  let code = String(input || '').trim();
  // Accept a whole link as well as a bare code.
  const m = code.match(/[#&?]c=([A-Za-z0-9_-]+)/);
  if (m) code = m[1];
  code = code.replace(/\s+/g, '');
  if (!code) throw new Error('The code is empty.');
  let bytes;
  try {
    const kind = code[0];
    const raw = b64urlDecode(code.slice(1));
    if (kind === 'z') bytes = await pipe(raw, new DecompressionStream('deflate-raw'));
    else if (kind === 'j') bytes = raw;
    else throw new Error();
    const obj = JSON.parse(new TextDecoder().decode(bytes));
    if (!obj || typeof obj !== 'object' || !obj.t) throw new Error();
    return obj;
  } catch {
    throw new Error('That code is not valid. Copy the whole code (it is long) and try again.');
  }
}
