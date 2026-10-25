# Nat's Ring Studio

A browser app for trying engagement rings on a photo of a hand. Upload the photo and the app finds the ring finger (MediaPipe hand landmarks), sizes the ring from the ring size you pick, tilts it with the finger in 3D and lights it from the photo's own light direction. You can still drag the finger-edge guides or place it by hand. Every part of the ring is adjustable and the stone is rendered by tracing light through its real facets.

No build step, no server, no upload: open `index.html` from any static host. The photo never leaves the browser.

## What you can change

**Stone**
- Type: natural or lab diamond, moissanite, cubic zirconia, white sapphire, and 15 coloured gems (sapphire in 8 colours, ruby, emerald, morganite, aquamarine, alexandrite with colour change, tanzanite, spinel, amethyst, garnet, topaz, tourmaline, peridot, citrine, onyx). Each has its own refractive index, dispersion and density.
- Shape: round, oval, cushion, elongated cushion, princess, radiant, emerald, asscher, pear, marquise, heart, old European, old mine, rose cut, trillion, baguette (tapered baguettes for side stones). Length-to-width ratio, north–south or east–west, and point direction.
- Carat weight 0.2–8 ct. Millimetre dimensions come from the real cut volume and the material's density, so a 1 ct cubic zirconia is smaller than a 1 ct diamond.
- Colour: the D–Z scale as a yellow absorption curve; fancy colours (yellow, pink, blue, green, champagne, cognac, orange, purple, red, grey salt-and-pepper, black) in six intensities.
- Clarity FL–I3 as inclusions inside the stone, plus fluorescence that only shows in daylight presets.
- Cut grade (Ideal to Poor) or hand-set table, crown angle, pavilion angle and girdle.

**Setting**: solitaire, cathedral, hidden halo, halo, double halo, bezel, half bezel, three-stone, five-stone, toi et moi, tension. Prong count and tip style (V-tips appear on points and corners automatically), prong thickness, basket, height above the finger, halo stone size and gap, milgrain, side-stone shape and weight, head metal.

**Band**: ring size in US with UK/EU/Japan conversions (the inner diameter sets the photo scale), width, thickness, profile (domed, half-round, flat, comfort, knife-edge, square), shank (plain, tapered, split, twisted), pavé / double pavé / channel / eternity stones, milgrain, 16 metals (platinum, white/yellow/rose/green gold in several karats, palladium, silver, titanium, tungsten, black rhodium), four finishes, and a stacked wedding band (plain, pavé, eternity or curved).

**Light**: ten environments (jeweller's light tent, dark studio, window daylight, overcast, direct sun, office, candlelight, golden hour, spotlights, table lamp, soft room light matched to the photo), light direction, height, colour temperature, exposure, highlight glow, star glints, shadow strength, and a gentle rock to watch the sparkle.

**Photo**: automatic finger detection (MediaPipe hand landmarker, loaded from jsDelivr and Google's model host; falls back to tapping the finger edges), light direction read from the skin shading, finger tilt and turn offsets, slide along the finger, fingers-together occlusion, edge snapping for the guides, colour and brightness matching, softness, grain, and how much of the photo appears in the stone's reflections. Pinch or scroll to zoom. Save a full-resolution PNG of the composite.

## How it works

- `js/gems.js` builds each cut as a faceted solid (57-facet round brilliant topology generalised to any outline, step cuts, rose cuts), returns the facet planes for the shader, and computes volume for carat → millimetres.
- `js/gemMaterial.js` is a GLSL ray tracer: Fresnel split at the entry facet, refraction, up to ten internal bounces against the stone's facet planes, spectral dispersion (3–8 wavelengths with Cauchy-fitted indices), Beer–Lambert body colour, inclusions and fluorescence. Exits sample a cube map captured at the stone, so the finger, the band and the lights all show in the facets.
- `js/ring.js` assembles the metalwork in millimetres: swept band sections, tube prongs, extruded V-tips, halo frames, bezel cups, pavé with beads, wedding bands.
- `js/lighting.js` defines the environments as emissive panels and sky gradients; `js/metals.js` holds measured metal reflectances.
- `js/engine.js` renders in passes (reflection cubes → ring → photo with contact shadow → composite with tone mapping, bloom and film match) using three.js r170 from jsDelivr.
- `js/main.js` and `js/ui.js` hold the state, the control schema and the placement interaction.

## Running locally

Any static file server works, for example `python3 -m http.server` in the repo folder, then open `http://localhost:8000/`. ES modules will not load from `file://`.

## Tests

Development checks (a Playwright harness and headless geometry builds) lived outside the repo during the first build; every cut and setting combination was built and verified to have no NaNs and outward-facing solids.
