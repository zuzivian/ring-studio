// Render layers. Each pass enables only the layers it draws.
export const L = {
  BG: 1, // photo or studio backdrop, contact shadow catchers
  METAL: 2, // band, head, prongs, beads
  GEM: 3, // every stone
  OCCLUDER: 4, // depth-only finger stand-ins that hide the back of the band
  ENV: 5, // environment sphere and light panels (reflections only)
  SKIN: 6, // finger proxy seen in the stone's reflections
};
export const mask = (...ls) => ls.reduce((m, l) => m | (1 << l), 0);
