# solo-export-fixer

Mozilla Solo shuts down on 2026-11-30. Its export ZIP contains your pages and text, but the images are only links. This tool downloads every linked image into the export and rewrites the links to point at the local copies.

```
npx solo-export-fixer my-site-export.zip
```

Run it while the image links still work.

## What it does

1. Opens the ZIP (or an already unzipped folder).
2. Finds image URLs in HTML, CSS and CSV files: `src`, `srcset`, `poster`, `content`, `url(...)`.
3. Downloads each image into `images/`.
4. Rewrites the references to the local files and writes the result to `<name>-complete/`.
5. Lists anything it could not download in `FAILED-DOWNLOADS.txt`.

The original export is never modified.

## Options

```
solo-export-fixer <export.zip | folder> [-o outDir] [--dry-run]
```

- `-o outDir`: where to write the fixed copy.
- `--dry-run`: list the images it would download, change nothing.

Exit code is `0` when every image was saved and `2` when some failed.

## Limits

- Tested on a synthetic export, not yet on a real Solo ZIP. If yours breaks it, please open an issue and attach the file list (not your content).
- Images hosted on Unsplash will likely keep working after the shutdown. A local copy still protects you if they move.
- It works on any export that links to remote images, not only Solo.
- Needs Node 18 or newer. No dependencies.

Not affiliated with Mozilla.

## License

MIT
