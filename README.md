# Gymclo — Medal Studio & Premium Swipe Update (9 Nov 2026)

## Features
- **Admin → Achievements:** upload transparent PNG/WebP artwork (up to 550 KB) for achievement card symbols, global bronze/silver/gold/platinum/diamond medals, and per-achievement/per-tier medal overrides. Image transparency is preserved and images are served using stable, immutable URLs.
- **Member → Profile → Medal Wardrobe:** choose up to five **earned** medals to display alongside your name. Use ↑/↓ to set which overlaps in front/behind. The order persists across devices and can be hidden any time.
- **Profile selection / PIN / Crew:** selected medals show as a premium overlapping stack, using custom images where configured.
- **Smoother tab swiping:** drag-follow movement, ease-out transition, no accidental navigation inside forms/music/interactive controls, with reduced-motion support.

## Deployment
Copy `server.js`, `package.json`, and the contents of `public/` into the matching paths in your GitHub Gymclo repository. Keep existing Railway environment variables and **do not delete or replace the `/app/data` persistent volume**.

`server.js` writes uploaded medal artwork into `/app/data/medal-art`. You do not need to pre-create the folder. Restarting or redeploying does not delete uploaded files. Published artwork URLs are returned by `/api/medal-art/<hash>.png` or `.webp`.

For new symbols, open Gymclo > Admin > Achievements, unlock Admin if prompted, upload the files, then press **Save achievements & medals** to apply them crew-wide. Users set their own visible stack from Profile > Medal Wardrobe.

## Validation
- Node JavaScript syntax passed for frontend and backend.
- Local isolated-server tests passed: upload authentication, PNG/WebP transparency, immutable artwork URLs, editor config validation, earned-only display, stacking order, and persistence across a simulated restart.
- Real iPhone / Android touch-animation checks are still recommended.

No existing attendance, PINs, profile data, forfeits, or music history are removed by this update.
