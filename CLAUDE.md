# Branch structure

- `main`: upstream. Do not commit directly.
- `fork`: Sam's fork branch. Contains admin/fork-specific changes (e.g. manifest rename, README updates). Feature branches are merged here after development.
- Feature branches: branch off `main` unless that would introduce merge conflicts with `fork`, in which case branch off `fork`. Merge into `fork` when done.

# Development

- `npm install` to install dependencies
- `npm run build` to build
- `just install` to copy built plugin into the local Obsidian vault
