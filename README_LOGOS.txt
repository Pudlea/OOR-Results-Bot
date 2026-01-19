Logo overrides (SimGrid pane)

Why you were still seeing the tiny SimGrid icons
- Your bot correctly detects the make (carMakeKey), but Wikimedia is rate-limiting you (HTTP 429).
- That means any override URLs hosted on upload.wikimedia.org will often fail, and the renderer falls back to SimGrid.

This update changes the approach:
- Toyota Gazoo Racing is **local-only** (no remote URL).
- Other makes are also set up as **local-only** if you want full standardisation.
- McLaren can optionally fall back to the same OOR-hosted team logo used in pane 1.

How to install local logos
1) Create this folder in your bot project (if it doesn't exist):
   ./assets/logos/

2) Drop PNG files in there using the make key names:
   ./assets/logos/toyota_gazoo.png
   ./assets/logos/mclaren.png
   ./assets/logos/porsche.png
   ./assets/logos/ferrari.png
   ...etc

3) Restart the bot or run /refresh.

Where do I get the Toyota Gazoo Racing logo?
- The link you shared (SimilarPNG) appears to require credits to download, so it's not a great source for this.
- Best option: download a Toyota Gazoo Racing logo PNG yourself (any source you trust), then save it as:
    ./assets/logos/toyota_gazoo.png

Tip: keep them square-ish and reasonably large (e.g. 256x256 or 512x512). The renderer will scale them down.

Where to put the files
- Create this folder in your bot project (if it doesn't exist):
    assets/logos/

- Add PNGs named exactly like the make key:
    assets/logos/toyota_gazoo.png
    assets/logos/mclaren.png
    assets/logos/porsche.png
    assets/logos/bmw.png
    ...etc

Make keys you will see in logs
- mclaren, toyota_gazoo, alpine, cadillac, peugeot, porsche, bmw, ferrari, mercedes,
  lexus, honda, aston_martin, lamborghini, corvette

Getting a Toyota Gazoo Racing logo
- The link you posted (similarpng.com) requires credits to download, so it's not a good source for this.
- Best workflow:
  1) Find a Toyota Gazoo Racing logo PNG/SVG from a source you can download without rate limits.
  2) Save it as: assets/logos/toyota_gazoo.png
  3) Restart the bot (or run /refresh).

Tip: 256px-512px wide PNG with transparent background works great.

About the SimilarPNG link you sent
- That site requires credits to download (it's effectively paywalled), so it won't work well as an automated source.
- Best practice: download the image once in your browser, save it as a PNG, and place it in assets/logos/.

Recommended Toyota Gazoo Racing logo
- Please use the Toyota Gazoo Racing logo (not the generic Toyota oval) for Hypercar.
- Download a Toyota Gazoo Racing PNG you like and save as:
    assets/logos/toyota_gazoo.png

Then restart the bot or run /refresh.
