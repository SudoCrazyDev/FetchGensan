/**
 * Regenerates every FetchGensan logo file and app icon from the geometry
 * below. Edit this file, never the generated SVG or PNG output, or the next
 * run will silently undo your change.
 *
 * The tools are deliberately kept out of the workspace: they are needed
 * once per logo change, not on every `pnpm install`.
 *
 *   npm i --prefix /tmp/brand-tools @resvg/resvg-js opentype.js \
 *     @fontsource/plus-jakarta-sans png-to-ico
 *   BRAND_TOOLS=/tmp/brand-tools node brand/scripts/build.mjs
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const tools = process.env.BRAND_TOOLS;
if (!tools) {
  console.error('Set BRAND_TOOLS to the folder the brand tools were installed into.');
  process.exit(1);
}
const require = createRequire(join(resolve(tools), 'node_modules', '_'));
const { Resvg } = require('@resvg/resvg-js');
const opentype = require('opentype.js');
const pngToIco = require('png-to-ico').default ?? require('png-to-ico');

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const out = (p) => {
  const abs = join(root, p);
  mkdirSync(dirname(abs), { recursive: true });
  return abs;
};

// ---------------------------------------------------------------------------
// Colour. Mirrors packages/ui/src/theme.ts -- change both or neither.
// ---------------------------------------------------------------------------
const C = {
  amber: '#F98A15', // amber500: the mark, always
  amberText: '#EA700B', // amber600: "Gensan" on light grounds (contrast)
  amberOnDark: '#FBA338', // amber400: "Gensan" on dark grounds
  night: '#020617', // slate950
  midnight: '#0F172A', // slate900
  cloud: '#F8FAFC', // slate50
  white: '#FFFFFF',
};

// ---------------------------------------------------------------------------
// The mark: a map pin with a forward-leaning F knocked out of it.
// Drawn on a 512 grid. The pin is a 168-radius circle centred at (256, 216)
// whose tangents meet at (256, 488), with the tip softened.
// ---------------------------------------------------------------------------
const PIN =
  'M242.4 470.7 L123.9 319.8 A168 168 0 1 1 388.1 319.8 L269.6 470.7 Q256 488 242.4 470.7 Z';

// The F's bar ends are cut on a forward slant: the letter is already moving.
const F = 'M190 128 H330 L317 178 H242 V198 H306 L293 246 H242 V304 H190 Z';

/** Pin bounding box on the 512 grid, for layout maths. */
const PIN_BOX = { x: 88, y: 48, w: 336, h: 440 };

let maskId = 0;
/**
 * The mark as an SVG fragment. `knockout` true cuts the F out (transparent);
 * otherwise `fColor` paints it, which renders identically on a solid ground
 * and survives tools that choke on masks.
 */
function mark({ color, fColor = null, x = 0, y = 0, scale = 1 }) {
  const t = `translate(${x} ${y}) scale(${scale})`;
  if (fColor) {
    return `<g transform="${t}"><path d="${PIN}" fill="${color}"/><path d="${F}" fill="${fColor}" stroke="${fColor}" stroke-width="6" stroke-linejoin="round"/></g>`;
  }
  const id = `fg-knockout-${maskId++}`;
  return (
    `<g transform="${t}"><mask id="${id}" maskUnits="userSpaceOnUse" x="0" y="0" width="512" height="512">` +
    `<rect width="512" height="512" fill="#fff"/>` +
    `<path d="${F}" fill="#000" stroke="#000" stroke-width="6" stroke-linejoin="round"/></mask>` +
    `<path d="${PIN}" fill="${color}" mask="url(#${id})"/></g>`
  );
}

const svg = (w, h, body, title) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img" aria-label="${title}"><title>${title}</title>${body}</svg>\n`;

/** Mark centred in a square canvas, pin height = `fill` of the canvas. */
function markInSquare(size, fill, opts) {
  const scale = (size * fill) / PIN_BOX.h;
  const x = size / 2 - (PIN_BOX.x + PIN_BOX.w / 2) * scale;
  const y = size / 2 - (PIN_BOX.y + PIN_BOX.h / 2) * scale;
  return mark({ ...opts, x, y, scale });
}

// ---------------------------------------------------------------------------
// Wordmark: Plus Jakarta Sans ExtraBold, outlined so the files never depend
// on the font being installed. Tracking tightened 2%.
// ---------------------------------------------------------------------------
const fontFile = join(
  tools,
  'node_modules/@fontsource/plus-jakarta-sans/files/plus-jakarta-sans-latin-800-normal.woff',
);
const buf = readFileSync(fontFile);
const font = opentype.parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
const FS = 100; // font size the wordmark is set at before scaling
const TRACK = -0.02 * FS;
const CAP = (font.tables.os2.sCapHeight / font.unitsPerEm) * FS;

// opentype's own toPathData() emits NaN for some coordinates, so format here.
const n = (v) => +v.toFixed(2);
function pathData(path) {
  return path.commands
    .map((c) => {
      if (c.type === 'M' || c.type === 'L') return `${c.type}${n(c.x)} ${n(c.y)}`;
      if (c.type === 'Q') return `Q${n(c.x1)} ${n(c.y1)} ${n(c.x)} ${n(c.y)}`;
      if (c.type === 'C') return `C${n(c.x1)} ${n(c.y1)} ${n(c.x2)} ${n(c.y2)} ${n(c.x)} ${n(c.y)}`;
      return 'Z';
    })
    .join('');
}

function setWord(text, x0, f = font, track = TRACK) {
  let x = x0;
  let d = '';
  for (const ch of text) {
    const g = f.charToGlyph(ch);
    d += pathData(g.getPath(x, 0, FS));
    x += (g.advanceWidth / f.unitsPerEm) * FS + track;
  }
  return { d, end: x - track };
}
const bufBody = readFileSync(fontFile.replace('-800-', '-600-'));
const fontBody = opentype.parse(
  bufBody.buffer.slice(bufBody.byteOffset, bufBody.byteOffset + bufBody.byteLength),
);
const fetchWord = setWord('Fetch', 0);
const gensanWord = setWord('Gensan', fetchWord.end + TRACK);
const WORD_W = gensanWord.end;
// Descender of "Gensan" is none; baseline sits at y = 0 and caps rise to -CAP.

function wordmark({ ink, accent, x = 0, y = 0, scale = 1 }) {
  return `<g transform="translate(${x} ${y}) scale(${scale})"><path d="${fetchWord.d}" fill="${ink}"/><path d="${gensanWord.d}" fill="${accent}"/></g>`;
}

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------
const written = [];
function write(path, content) {
  writeFileSync(out(path), content);
  written.push(path);
}
function png(svgText, path, size) {
  const r = new Resvg(svgText, { fitTo: { mode: 'width', value: size } });
  write(path, r.render().asPng());
}

// Logo SVGs -----------------------------------------------------------------
const logos = {};

logos.mark = svg(
  PIN_BOX.w,
  PIN_BOX.h,
  mark({ color: C.amber, x: -PIN_BOX.x, y: -PIN_BOX.y }),
  'FetchGensan',
);
logos.markMono = svg(
  PIN_BOX.w,
  PIN_BOX.h,
  mark({ color: '#000000', x: -PIN_BOX.x, y: -PIN_BOX.y }),
  'FetchGensan',
);
logos.markWhite = svg(
  PIN_BOX.w,
  PIN_BOX.h,
  mark({ color: C.white, x: -PIN_BOX.x, y: -PIN_BOX.y }),
  'FetchGensan',
);

// Wordmark alone: cap height 100 units.
{
  const s = 100 / CAP;
  const w = Math.ceil(WORD_W * s);
  const h = Math.ceil(100 * 1.02);
  logos.wordmark = svg(
    w,
    h,
    wordmark({ ink: C.midnight, accent: C.amberText, y: 100, scale: s }),
    'FetchGensan',
  );
  logos.wordmarkDark = svg(
    w,
    h,
    wordmark({ ink: C.cloud, accent: C.amberOnDark, y: 100, scale: s }),
    'FetchGensan',
  );
}

// Horizontal lockup: pin height = 1.9x cap height; gap = 0.5x cap height.
function lockupH(ink, accent) {
  const cap = 100;
  const pinH = cap * 1.9;
  const ms = pinH / PIN_BOX.h;
  const pinW = PIN_BOX.w * ms;
  const gap = cap * 0.5;
  const ws = cap / CAP;
  const h = Math.ceil(pinH);
  // The caps centre on the pin's round head; the tip hangs below them.
  const baseline = (216 - PIN_BOX.y) * ms + cap / 2;
  const w = Math.ceil(pinW + gap + WORD_W * ws);
  return svg(
    w,
    h,
    mark({ color: C.amber, x: -PIN_BOX.x * ms, y: -PIN_BOX.y * ms, scale: ms }) +
      wordmark({ ink, accent, x: pinW + gap, y: baseline, scale: ws }),
    'FetchGensan',
  );
}
logos.lockup = lockupH(C.midnight, C.amberText);
logos.lockupDark = lockupH(C.cloud, C.amberOnDark);

// Stacked lockup: mark above, wordmark centred below.
function lockupV(ink, accent) {
  const cap = 100;
  const ws = cap / CAP;
  const wordW = WORD_W * ws;
  const pinH = cap * 3.2;
  const ms = pinH / PIN_BOX.h;
  const pinW = PIN_BOX.w * ms;
  const gap = cap * 0.7;
  const w = Math.ceil(wordW);
  const h = Math.ceil(pinH + gap + cap);
  return svg(
    w,
    h,
    mark({ color: C.amber, x: (w - pinW) / 2 - PIN_BOX.x * ms, y: -PIN_BOX.y * ms, scale: ms }) +
      wordmark({ ink, accent, y: pinH + gap + cap, scale: ws }),
    'FetchGensan',
  );
}
logos.stacked = lockupV(C.midnight, C.amberText);
logos.stackedDark = lockupV(C.cloud, C.amberOnDark);

write('brand/logo/fetchgensan-mark.svg', logos.mark);
write('brand/logo/fetchgensan-mark-black.svg', logos.markMono);
write('brand/logo/fetchgensan-mark-white.svg', logos.markWhite);
write('brand/logo/fetchgensan-wordmark.svg', logos.wordmark);
write('brand/logo/fetchgensan-wordmark-on-dark.svg', logos.wordmarkDark);
write('brand/logo/fetchgensan-lockup.svg', logos.lockup);
write('brand/logo/fetchgensan-lockup-on-dark.svg', logos.lockupDark);
write('brand/logo/fetchgensan-stacked.svg', logos.stacked);
write('brand/logo/fetchgensan-stacked-on-dark.svg', logos.stackedDark);

// App icons -----------------------------------------------------------------
// Customer app: amber ground, midnight pin. Driver app: night ground, amber
// pin -- the inverse, so a rider who also books rides can tell the two apart
// on their home screen at a glance, and the driver icon matches the app's
// dark-only UI.
const APPS = {
  rider: { ground: C.amber, pin: C.midnight, name: 'FetchGensan' },
  driver: { ground: C.night, pin: C.amber, name: 'FetchGensan Rider' },
};

for (const [app, a] of Object.entries(APPS)) {
  const S = 1024;
  // iOS / store icon: full bleed square, the OS applies its own mask.
  const icon = svg(
    S,
    S,
    `<rect width="${S}" height="${S}" fill="${a.ground}"/>` +
      markInSquare(S, 0.62, { color: a.pin, fColor: a.ground }),
    a.name,
  );
  write(`brand/app-icons/${app}-icon.svg`, icon);
  png(icon, `apps/${app}/assets/icon.png`, 1024);

  // Web favicon: rounded, since browsers do not mask.
  const fav = svg(
    S,
    S,
    `<rect width="${S}" height="${S}" rx="${S * 0.22}" fill="${a.ground}"/>` +
      markInSquare(S, 0.7, { color: a.pin, fColor: a.ground }),
    a.name,
  );
  png(fav, `apps/${app}/assets/favicon.png`, 48);

  // Android adaptive icon. The launcher shows the middle 72/108 and may
  // crop to a circle of 66/108, so the pin stays inside ~56%.
  const A = 512;
  png(
    svg(A, A, markInSquare(A, 0.56, { color: a.pin }), a.name),
    `apps/${app}/assets/android-icon-foreground.png`,
    A,
  );
  png(
    svg(A, A, `<rect width="${A}" height="${A}" fill="${a.ground}"/>`, a.name),
    `apps/${app}/assets/android-icon-background.png`,
    A,
  );
  // Themed (Material You) icon: a white silhouette the launcher recolours.
  const M = 432;
  png(
    svg(M, M, markInSquare(M, 0.56, { color: C.white }), a.name),
    `apps/${app}/assets/android-icon-monochrome.png`,
    M,
  );

  // Splash: the pin alone on transparent; app.json supplies the ground.
  png(
    svg(S, S, markInSquare(S, 0.8, { color: a.pin }), a.name),
    `apps/${app}/assets/splash-icon.png`,
    S,
  );

  // In-app mark for the sign-in screen: amber on transparent, 3x density.
  png(
    svg(
      PIN_BOX.w,
      PIN_BOX.h,
      mark({ color: C.amber, x: -PIN_BOX.x, y: -PIN_BOX.y }),
      'FetchGensan',
    ),
    `apps/${app}/assets/brand-mark.png`,
    PIN_BOX.w * (192 / PIN_BOX.h),
  );
}

// Dispatch console ---------------------------------------------------------
{
  const S = 512;
  const icon = svg(
    S,
    S,
    `<rect width="${S}" height="${S}" rx="${S * 0.22}" fill="${C.night}"/>` +
      markInSquare(S, 0.72, { color: C.amber, fColor: C.night }),
    'FetchGensan Dispatch',
  );
  write('apps/admin/src/app/icon.svg', icon);
  const apple = svg(
    S,
    S,
    `<rect width="${S}" height="${S}" fill="${C.night}"/>` +
      markInSquare(S, 0.62, { color: C.amber, fColor: C.night }),
    'FetchGensan Dispatch',
  );
  png(apple, 'apps/admin/src/app/apple-icon.png', 180);

  const sizes = [16, 32, 48];
  const pngs = sizes.map((s) =>
    new Resvg(icon, { fitTo: { mode: 'width', value: s } }).render().asPng(),
  );
  const ico = await pngToIco(pngs);
  rmSync(out('apps/admin/src/app/favicon.ico'), { force: true });
  write('apps/admin/src/app/favicon.ico', ico);
}

// Social card for link previews --------------------------------------------
{
  const W = 1200;
  const H = 630;
  const cap = 88;
  const ws = cap / CAP;
  const pinH = 300;
  const ms = pinH / PIN_BOX.h;
  const pinTop = (H - pinH) / 2;
  const baseline = pinTop + (216 - PIN_BOX.y) * ms + cap / 2;
  const card = svg(
    W,
    H,
    `<rect width="${W}" height="${H}" fill="${C.night}"/>` +
      mark({
        color: C.amber,
        fColor: C.night,
        x: 96 - PIN_BOX.x * ms,
        y: pinTop - PIN_BOX.y * ms,
        scale: ms,
      }) +
      wordmark({
        ink: C.cloud,
        accent: C.amberOnDark,
        x: 96 + PIN_BOX.w * ms + 56,
        y: baseline,
        scale: ws,
      }) +
      `<path transform="translate(${96 + PIN_BOX.w * ms + 60} ${baseline + 76}) scale(0.34)" fill="#94A3B8" d="${
        setWord('Rides, errands and deliveries. Any hour.', 0, fontBody, 0).d
      }"/>`,
    'FetchGensan',
  );
  write('brand/social/fetchgensan-social.svg', card);
  png(card, 'brand/social/fetchgensan-social.png', W);
}

console.log(written.join('\n'));
