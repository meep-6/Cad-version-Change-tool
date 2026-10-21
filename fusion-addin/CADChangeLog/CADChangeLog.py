"""CAD Change Log capture add-in for Autodesk Fusion 360.

Adds a "Capture to CAD Log" button (UTILITIES > ADD-INS panel in the Design workspace).
Clicking it sends the active design's name, saved version number, user parameters,
a viewport screenshot and, optionally, a STEP export to the CAD Change Log app running
on this computer. The capture then appears under "From Fusion 360" in the app, ready to
be logged as a revision.

CAD Change Log (app.py) must be running. Its address is read from ~/.cad-change-log.json,
which app.py writes on start; it falls back to http://127.0.0.1:8765/.
"""
import json
import os
import re
import tempfile
import time
import traceback
import urllib.error
import urllib.parse
import urllib.request
import uuid

import adsk.core
import adsk.fusion

CMD_ID = "cadChangeLogCapture"
CMD_NAME = "Capture to CAD Log"
CMD_TIP = "Send version, user parameters, a screenshot and a STEP export to CAD Change Log"
PANEL_ID = "SolidScriptsAddinsPanel"
PORT_FILE = os.path.join(os.path.expanduser("~"), ".cad-change-log.json")
DEFAULT_URL = "http://127.0.0.1:8765/"

_handlers = []


# ---------------- talking to the app ----------------
def _base_url():
    try:
        with open(PORT_FILE, encoding="utf-8") as f:
            return json.load(f).get("url") or DEFAULT_URL
    except Exception:
        return DEFAULT_URL


def _request(method, path, data=None, headers=None):
    h = {"X-Requested-With": "cadlog"}
    h.update(headers or {})
    req = urllib.request.Request(_base_url().rstrip("/") + path, data=data, headers=h, method=method)
    with urllib.request.urlopen(req, timeout=120) as r:
        body = r.read()
        return json.loads(body) if body else None


def _upload_image(path):
    with open(path, "rb") as f:
        return _request("POST", "/api/images", f.read(), {"Content-Type": "image/png"})


def _upload_file(path, name):
    with open(path, "rb") as f:
        return _request("POST", "/api/files", f.read(),
                        {"Content-Type": "application/octet-stream", "X-Filename": urllib.parse.quote(name)})


# ---------------- reading the design ----------------
def _params(design):
    um = design.unitsManager
    out = []
    for i in range(design.userParameters.count):
        p = design.userParameters.item(i)
        try:
            value = um.formatInternalValue(p.value, p.unit, False) if p.unit else ("%g" % p.value)
        except Exception:
            value = "%g" % p.value
        out.append({"name": p.name, "value": value.strip(), "unit": p.unit or "", "expression": p.expression})
    return out


def _capture(include_step):
    app = adsk.core.Application.get()
    ui = app.userInterface
    design = adsk.fusion.Design.cast(app.activeProduct)
    if not design:
        ui.messageBox("Open a design in the Design workspace first.", CMD_NAME)
        return
    doc = app.activeDocument
    if not doc.dataFile:
        ui.messageBox("Save the design first, so the capture has a version number.", CMD_NAME)
        return

    name = re.sub(r"\s+v\d+$", "", doc.name)
    version = doc.dataFile.versionNumber
    if doc.isModified:
        if ui.messageBox("The design has unsaved changes, so they won't match v%d.\n\nCapture anyway?" % version,
                         CMD_NAME, adsk.core.MessageBoxButtonTypes.YesNoButtonType) != adsk.core.DialogResults.DialogYes:
            return

    tmp = tempfile.mkdtemp(prefix="cadlog-")
    safe = re.sub(r'[\\/:*?"<>|]+', "_", name)
    capture = {"fusionDoc": name, "version": version, "params": _params(design),
               "createdAt": int(time.time() * 1000)}
    try:
        img_path = os.path.join(tmp, "view.png")
        if app.activeViewport.saveAsImageFile(img_path, 1600, 1000):
            capture["image"] = _upload_image(img_path)
        if include_step:
            step_path = os.path.join(tmp, "%s v%d.step" % (safe, version))
            em = design.exportManager
            if em.execute(em.createSTEPExportOptions(step_path, design.rootComponent)) and os.path.exists(step_path):
                up = _upload_file(step_path, os.path.basename(step_path))
                capture["file"] = {k: up[k] for k in ("id", "name", "size", "url")}
        _request("PUT", "/api/captures/" + uuid.uuid4().hex, json.dumps(capture).encode("utf-8"),
                 {"Content-Type": "application/json"})
    except urllib.error.URLError:
        ui.messageBox("CAD Change Log isn't running.\n\nStart it (Start CAD Log.bat or app.py), then capture again.", CMD_NAME)
        return
    finally:
        for f in os.listdir(tmp):
            try:
                os.remove(os.path.join(tmp, f))
            except OSError:
                pass
        try:
            os.rmdir(tmp)
        except OSError:
            pass

    ui.messageBox("Captured %s v%d: %d parameters%s%s.\n\nOpen CAD Change Log and click Log under \"From Fusion 360\"."
                  % (name, version, len(capture["params"]),
                     ", screenshot" if "image" in capture else "",
                     ", STEP" if "file" in capture else ""), CMD_NAME)


# ---------------- command plumbing ----------------
class _ExecuteHandler(adsk.core.CommandEventHandler):
    def notify(self, args):
        try:
            inputs = args.command.commandInputs
            _capture(inputs.itemById("includeStep").value)
        except Exception:
            adsk.core.Application.get().userInterface.messageBox("Capture failed:\n" + traceback.format_exc(), CMD_NAME)


class _CreatedHandler(adsk.core.CommandCreatedEventHandler):
    def notify(self, args):
        try:
            cmd = args.command
            cmd.okButtonText = "Capture"
            cmd.commandInputs.addBoolValueInput("includeStep", "Include STEP export", True, "", True)
            on_exec = _ExecuteHandler()
            cmd.execute.add(on_exec)
            _handlers.append(on_exec)
        except Exception:
            adsk.core.Application.get().userInterface.messageBox(traceback.format_exc(), CMD_NAME)


def run(context):
    try:
        ui = adsk.core.Application.get().userInterface
        cmd_def = ui.commandDefinitions.itemById(CMD_ID) or \
            ui.commandDefinitions.addButtonDefinition(CMD_ID, CMD_NAME, CMD_TIP, "")
        on_created = _CreatedHandler()
        cmd_def.commandCreated.add(on_created)
        _handlers.append(on_created)
        panel = ui.allToolbarPanels.itemById(PANEL_ID)
        if panel and not panel.controls.itemById(CMD_ID):
            panel.controls.addCommand(cmd_def)
    except Exception:
        adsk.core.Application.get().userInterface.messageBox("CAD Change Log add-in failed to start:\n" + traceback.format_exc())


def stop(context):
    try:
        ui = adsk.core.Application.get().userInterface
        panel = ui.allToolbarPanels.itemById(PANEL_ID)
        ctrl = panel.controls.itemById(CMD_ID) if panel else None
        if ctrl:
            ctrl.deleteMe()
        cmd_def = ui.commandDefinitions.itemById(CMD_ID)
        if cmd_def:
            cmd_def.deleteMe()
    except Exception:
        pass
