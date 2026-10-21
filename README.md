# Cad-version-Change-tool
A personal CAD versioning and history marker for documentation.

Log Fusion 360 parts and assemblies through their revisions: what changed and why, parameter
deltas, BOM changes, attached CAD files, verification results, first-article inspection and
issues. Runs locally; nothing goes online.

## Features
**Design record**
- Title block per part: auto part number (`TC9-MMB-001`), project, material, units, Fusion link
- Revisions with rev label, date, Fusion version and status (Draft / In review / Released)
- Parameter was → now with Δ and %, plus a parameter history across all revisions
- BOM changes, screenshots (pick or paste), and attached files (STEP, F3D, STL, PDF…)

**Control**
- **Released revisions are locked.** Design content can't be edited or deleted; log a new revision.
  Verification and inspection results can still be added.
- **Assemblies:** list components with quantities. Each part shows where it's used, and an
  assembly warns when a component was revised after the assembly's latest revision.
- **Backups:** a snapshot of the log on every launch (last 20 kept), and automatic recovery
  from the newest readable copy if `log.json` is ever damaged.

**PCBs** (part type *PCB*)
- **KiCad BOM import:** the Symbol Fields Table CSV export, or the `.kicad_sch` files directly
  (select every sheet). MPN, Manufacturer, LCSC/Digi-Key/Mouser and DNP fields are picked up;
  power symbols and multi-unit duplicates are handled, and unannotated symbols are flagged.
- **BOM diff** against the previous revision: added, removed and changed references
  (e.g. `R5: 10k → 4.7k`)
- Unit prices, cost per board and a *build N boards* quantity/cost calculator; export CSV.
  Prices carry over to new revisions for unchanged parts.
- **Fab spec** (layers, thickness, finish…), fab files, and an **order log** per revision
- **Boards:** a serial per assembled board (`TC9-FC-001-B03`) with status, bring-up checklist
  results and rework history. Checklists are set per revision and carry forward.
- Released PCB revisions lock the BOM and fab spec; prices, orders and checklists stay editable.

**Evidence**
- **Verification** per revision: test, analysis, inspection or demonstration, with
  pass/fail and an attached data file
- **First-article inspection:** characteristics with nominal and tolerance; pass/fail is
  calculated from the measured value (OK/NOK for go/no-go checks)
- **Issues:** what happened, root cause, corrective action, found-in and fixed-in revisions
- **Report:** printable design record per part (Print → Save as PDF)
- Search across parts, revision text, parameters, files and issues
- Copy a part's changelog as Markdown

## Run
Needs Python 3.8+ (standard library only).

- **Windows:** double-click `Start CAD Log.bat`
- **macOS / Linux:** `./start.sh` or `python3 app.py`

Your browser opens at http://127.0.0.1:8765. Keep the console window open while you work;
press Ctrl+C to stop. The server listens on 127.0.0.1 only.

Options: `--data <folder>` · `--port 8800` · `--no-browser`

## Fusion 360 add-in
`fusion-addin/CADChangeLog` adds a **Capture to CAD Log** button that sends the active design's
name, saved version number, user parameters, a screenshot and (optionally) a STEP export to
the app. The capture shows up under **From Fusion 360** in the sidebar; click **Log** to turn it
into a revision with only the changed parameters filled in.

Install:
1. In Fusion: **Utilities → Add-Ins → Scripts and Add-Ins** (Shift+S) → **Add-Ins** tab.
2. Click **+** and select the `fusion-addin/CADChangeLog` folder.
3. Select **CADChangeLog** → **Run** (tick *Run on Startup* to keep it loaded).
4. The button appears in **Utilities → Add-Ins**. Save your design before capturing.

The app must be running when you capture. The add-in finds it through `~/.cad-change-log.json`,
which `app.py` writes on start.

## Data
Stored in `data/` next to the app (ignored by Git):

| Path | Contents |
|---|---|
| `data/log.json` | Parts, revisions, issues, pending captures (readable JSON) |
| `data/log.json.bak` | The previous save |
| `data/backups/` | A snapshot from each launch, last 20 |
| `data/images/` | Screenshots |
| `data/files/` | Attached files |

To keep the log elsewhere (e.g. a synced or versioned folder):
`python app.py --data "D:\CAD\change-log"`

## Files
| File | Purpose |
|---|---|
| `app.py` | Local server and storage |
| `index.html`, `static/` | The app (`static/pcb.js` is the PCB module) |
| `report.html` | Printable part report |
| `fusion-addin/` | Fusion 360 capture add-in |
| `Start CAD Log.bat`, `start.sh` | Launchers |
