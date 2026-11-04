// A hash of browser traits that only flags likely repeat ballots for the host.
// It never blocks a vote: identical iPhones look the same to Safari. Each trait falls
// back to an empty string, and the result is always hex, because the server rejects
// anything else.

function trait(read) {
  try {
    const value = read();
    return value === undefined || value === null ? '' : String(value);
  } catch {
    return '';
  }
}

// FNV-1a, twice with different seeds. crypto.subtle only exists on HTTPS and
// localhost, so this covers a page opened over plain HTTP during testing.
function fallbackHash(text) {
  const fnv = (seed) => {
    let h = seed;
    for (let i = 0; i < text.length; i += 1) {
      h ^= text.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return (h >>> 0).toString(16).padStart(8, '0');
  };
  return fnv(0x811c9dc5) + fnv(0x01000193);
}

async function hashHex(text) {
  try {
    const bytes = new TextEncoder().encode(text);
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
  } catch {
    return fallbackHash(text);
  }
}

function webglTraits() {
  try {
    const gl = document.createElement('canvas').getContext('webgl');
    const info = gl.getExtension('WEBGL_debug_renderer_info');
    const traits = [
      trait(() => gl.getParameter(info.UNMASKED_VENDOR_WEBGL)),
      trait(() => gl.getParameter(info.UNMASKED_RENDERER_WEBGL)),
    ];
    // Browsers limit live WebGL contexts, so let this one go.
    trait(() => gl.getExtension('WEBGL_lose_context').loseContext());
    return traits;
  } catch {
    return ['', ''];
  }
}

function canvasData() {
  const canvas = document.createElement('canvas');
  canvas.width = 200;
  canvas.height = 50;
  const ctx = canvas.getContext('2d');
  ctx.textBaseline = 'top';
  ctx.fillStyle = '#ff6a13';
  ctx.font = '16px Arial';
  ctx.fillText('Discount Halloween 70% off', 2, 2);
  ctx.fillStyle = '#121010';
  ctx.font = '14px Georgia';
  ctx.fillText('Discount Halloween 70% off', 4, 24);
  ctx.beginPath();
  ctx.arc(170, 25, 18, 0, Math.PI * 1.5);
  ctx.stroke();
  return canvas.toDataURL();
}

export async function fingerprint() {
  const [vendor, renderer] = webglTraits();
  const canvasHash = await hashHex(trait(canvasData));

  const traits = [
    trait(() => screen.width),
    trait(() => screen.height),
    trait(() => screen.colorDepth),
    trait(() => devicePixelRatio),
    trait(() => Intl.DateTimeFormat().resolvedOptions().timeZone),
    trait(() => navigator.languages.join(',')),
    trait(() => navigator.hardwareConcurrency),
    trait(() => navigator.deviceMemory),
    trait(() => navigator.maxTouchPoints),
    trait(() => navigator.platform),
    vendor,
    renderer,
    canvasHash,
  ];

  return (await hashHex(traits.join('|'))).slice(0, 16);
}
