# Cad-version-Change-tool
A personal CAD versioning and history marker for documentation.

Log Fusion 360 parts and their revisions: what changed and why, parameter deltas,
BOM changes and before/after screenshots. Runs locally; nothing goes online.

## Features
- One title block per part: part number, project, material, units, Fusion 360 link
- Auto part numbers: `PROJECT-INITIALS-001` (e.g. "Motor Mount Bracket" in "TC-9" → `TC9-MMB-001`)
- Revisions with rev label, date, Fusion version, status (Draft / In review / Released)
- Parameter table with was → now and Δ / %; "Pull from previous rev" to carry values forward
- BOM change rows (Added / Changed / Removed)
- Screenshots by file pick or paste (Ctrl/Cmd+V), tagged Before / After / Section / Drawing
- Parameter history view across all revisions
- Copy the full changelog as Markdown

## Run
Needs Python 3.8+ (standard library only).

- **Windows:** double-click `Start CAD Log.bat`
- **macOS / Linux:** `./start.sh` or `python3 app.py`

Your browser opens at http://127.0.0.1:8765. Keep the console window open while you work;
press Ctrl+C to stop. The server listens on 127.0.0.1 only.

Options: `--data <folder>` · `--port 8800` · `--no-browser`

## Data
Stored in `data/` next to the app (ignored by Git):
- `data/log.json`: parts and revisions (readable JSON)
- `data/log.json.bak`: previous save
- `data/images/`: screenshots

To version your log too, point it at a separate folder or repo:
`python app.py --data "D:\CAD\change-log"`

## Files
| File | Purpose |
|---|---|
| `app.py` | Local server and JSON/image storage |
| `index.html` | The app UI |
| `Start CAD Log.bat`, `start.sh` | Launchers |
