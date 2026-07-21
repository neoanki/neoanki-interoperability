# Anki & CSV Import/Export

Move study material between Neo Anki, Anki, and spreadsheets. Preview an `.apkg`, `.colpkg`, or CSV file before importing it, and export your current collection whenever you need a portable copy.

## Features

- Import Anki `.apkg` deck packages.
- Import Anki `.colpkg` collection packages.
- Import CSV files with `prompt` and `answer` columns plus optional tags.
- Preview note, card, media, and compatibility details before making changes.
- Export the current collection as `.apkg`, `.colpkg`, or CSV.
- Create a rollback checkpoint automatically before every import.

## Install

Download the `.neoanki-extension` file from the latest release, then open **Extensions → Browse → Install from file** in Neo Anki. Import and export controls appear in the extension's Configure view after setup.

## Privacy and permissions

All files are processed locally. Anki & CSV Import/Export can replace or add collection data only after you review the preview and choose **Import**. It cannot connect to the internet.

## Development

Clone this repository beside `neoanki/neo-anki`, then run `npm install`, `npm run typecheck`, `npm test`, `npm run check`, and `npm run build`.
