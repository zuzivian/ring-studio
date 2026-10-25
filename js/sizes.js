// Ring size conversions. US/Canada sizes are the reference:
// inner diameter (mm) = 11.63 + 0.8128 × US size (ISO 8653 circumference = π × diameter).

export const US_SIZES = [];
for (let s = 3; s <= 13.0001; s += 0.25) US_SIZES.push(Math.round(s * 100) / 100);

export const diameterFromUS = (us) => 11.63 + 0.8128 * us;
export const usFromDiameter = (d) => (d - 11.63) / 0.8128;

const HALF = '½', QUARTER = '¼', THREE_Q = '¾';
const frac = (x) => {
  const f = Math.round((x - Math.floor(x)) * 4) / 4;
  return f === 0.25 ? QUARTER : f === 0.5 ? HALF : f === 0.75 ? THREE_Q : '';
};

export function formatUS(us) {
  const whole = Math.floor(us + 1e-6);
  return `${whole}${frac(us)}`;
}

// UK / Australia letters: A = 37.8 mm circumference, +1.25 mm per letter
export function ukFromUS(us) {
  const circ = Math.PI * diameterFromUS(us);
  const idx = Math.round(((circ - 37.8) / 1.25) * 2) / 2;
  const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const i = Math.floor(idx);
  if (i < 0) return 'A';
  if (i >= letters.length) return 'Z+' + (i - letters.length + 1);
  return letters[i] + (idx - i >= 0.5 ? HALF : '');
}

// EU / ISO: inner circumference in mm
export const euFromUS = (us) => Math.round(Math.PI * diameterFromUS(us));

// Japan: roughly one size per 0.33 mm of diameter, JP 1 ≈ 13.0 mm
export const jpFromUS = (us) => Math.max(1, Math.round((diameterFromUS(us) - 13.0) / 0.333 + 1));

export function sizeSummary(us) {
  const d = diameterFromUS(us);
  return { us: formatUS(us), uk: ukFromUS(us), eu: euFromUS(us), jp: jpFromUS(us), diameter: d, circumference: Math.PI * d };
}
