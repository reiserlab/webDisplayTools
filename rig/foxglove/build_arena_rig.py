#!/usr/bin/env python3
"""Build rig/foxglove/arena-rig.json: one layout, a hero view on the left, a status bar and tabs on the right.

Composition follows Foxglove's own example layouts (a large view + a tabbed column of full-width,
titled panels with fixed series colors). Every topic is one that viz_node / stimulus_node / the
rig-nodes host monitor publish today.

Two rules from the first live run (ww18, 2026-11-10):
* Everything watched DURING a run is on the first tab (Overview). A Foxglove tab that is not showing
  is not subscribed, so on a live connection a plot starts empty each time its tab is opened; the
  other tabs (Timing, Host, Health) are for diagnosis and are expected to start empty.
* The data gets the space: legends float over the plot (or are off when the title names the one
  series), and only the bottom plot of a stack shows its time axis (the plots are synced).
"""
import json
import sys

# One color per data source, the same in every panel (Okabe-Ito; readable in the light and dark themes).
FLY, ARENA, CAMERA, HOST, ALERT, GRAY = "#56B4E9", "#E69F00", "#009E73", "#CC79A7", "#D55E00", "#8b949e"
OK, WARN, BAD = "#009E73", "#E69F00", "#D55E00"


def series(path, label, color, **kw):
    return {"value": path, "enabled": True, "timestampMethod": "receiveTime", "label": label, "color": color, **kw}


def plot(title, paths, legend=True, **kw):
    return {
        "foxglovePanelTitle": title, "paths": paths,
        "showXAxisLabels": True, "showYAxisLabels": True,
        "showLegend": legend, "legendDisplay": "floating", "showPlotValuesInLegend": False,
        "isSynced": True, "xAxisVal": "timestamp", "followingViewWidth": 60, **kw,
    }


def bulb(title, path, rules):
    return {"foxglovePanelTitle": title, "path": path, "style": "background",
            "fallbackColor": GRAY, "fallbackLabel": "no data", "rules": rules}


def rule(op, value, color, label):
    return {"operator": op, "rawValue": value, "color": color, "label": label}


def split(direction, first, second, pct):
    return {"direction": direction, "first": first, "second": second, "splitPercentage": pct}


def stack(panels):
    """Equal-height column of panel ids."""
    if len(panels) == 1:
        return panels[0]
    return split("column", panels[0], stack(panels[1:]), round(100 / len(panels), 1))


def plots(panels):
    """A stack of synced plots: only the bottom one keeps its time axis labels."""
    for p in panels[:-1]:
        C[p]["showXAxisLabels"] = False
    return stack(panels)


def tab(tabs):
    return {"activeTabIdx": 0, "tabs": [{"title": t, "layout": l} for t, l in tabs]}


C = {}

# ---- left: what the fly sees and does -------------------------------------------------------
C["3D!arena"] = {
    "foxglovePanelTitle": "Fly, ball and pattern",
    "cameraState": {"perspective": True, "distance": 9, "phi": 58, "thetaOffset": 35, "targetOffset": [0, 0, 1.2],
                    "target": [0, 0, 0], "targetOrientation": [0, 0, 0, 1], "fovy": 45, "near": 0.1, "far": 1000},
    "followMode": "follow-pose", "followTf": "arena",
    "scene": {"backgroundColor": "#0f1419", "enableStats": False, "transforms": {"showLabel": False, "axisScale": 0}},
    "transforms": {}, "topics": {"/viz/markers": {"visible": True}}, "layers": {}, "imageMode": {},
}
C["Image!camera"] = {"foxglovePanelTitle": "Camera", "imageMode": {"imageTopic": "/camera/image"}}
C["Tab!view"] = tab([("Arena", "3D!arena"), ("Camera", "Image!camera")])
C["Image!display"] = {"foxglovePanelTitle": "Arena display (commanded)", "imageMode": {"imageTopic": "/arena/display"}}
C["Image!observed"] = {"foxglovePanelTitle": "Arena display (controller-reported)", "imageMode": {"imageTopic": "/arena/display_observed"}}
C["Tab!display"] = tab([("Display", "Image!display"), ("Observed", "Image!observed")])

# ---- right, top: one status bar -------------------------------------------------------------
C["Indicator!fictrac"] = bulb("FicTrac", "/viz/fictrac/rate_hz.data",
                              [rule(">", "5", OK, "tracking"), rule("<=", "5", BAD, "stalled")])
C["Indicator!arena"] = bulb("Arena", "/viz/arena/ok.data",
                            [rule("=", "true", OK, "on schedule"), rule("=", "false", WARN, "check")])
C["Indicator!camera"] = bulb("Camera", "/viz/bias/state.data",
                             [rule("=", "recording", OK, "recording"), rule("=", "preview", WARN, "preview"),
                              rule("=", "idle", WARN, "idle"), rule("=", "unreachable", BAD, "unreachable")])

# ---- tab 1 (Overview): everything watched during a run ------------------------------------------------------------------
C["StateTransitions!run"] = {
    "foxglovePanelTitle": "Trial",
    "paths": [{"value": "/viz/arena/condition.data", "timestampMethod": "receiveTime", "label": "condition"},
              {"value": "/viz/arena/state.data", "timestampMethod": "receiveTime", "label": "arena"},
              {"value": "/viz/bias/state.data", "timestampMethod": "receiveTime", "label": "camera"}],
    "isSynced": True,
}
C["Plot!position"] = plot("Pattern position in the fly's view (deg)",
                          [series("/viz/arena/azimuth_deg.data", "pattern azimuth", ARENA, showLine=False)],
                          legend=False, minYValue=-180, maxYValue=180)
C["Plot!turning"] = plot("Turning (deg/s)",
                         [series("/viz/fictrac/speed_dps.data", "yaw rate", FLY)], legend=False)
C["Plot!walking"] = plot("Walking (deg/s of ball rotation)",
                         [series("/viz/fictrac/fwd_dps.data", "forward", FLY),
                          series("/viz/fictrac/side_dps.data", "sideways", GRAY)])

# ---- rates go on the Overview; tab 2 (Timing): is the rig keeping time ---------------------------------------------------------
C["Plot!rates"] = plot("Rates (Hz)",
                       [series("/viz/fictrac/rate_hz.data", "FicTrac", FLY),
                        series("/viz/arena/display_rate_hz.data", "arena display", ARENA),
                        series("/viz/arena/cmd_fps.data", "arena commanded", ARENA, lineSize=0.5),
                        series("/viz/bias/fps.data", "camera", CAMERA)])
C["Plot!lag"] = plot("Arena lag (frames; 0 = on schedule)",
                     [series("/viz/arena/lag_frames.data", "observed - expected", ARENA)], legend=False)
C["Plot!cameraloss"] = plot("Camera: dropped frames and writer queue",
                            [series("/viz/bias/drops.data", "dropped (total)", ALERT),
                             series("/viz/bias/log_queue.data", "writer queue", CAMERA)])

# ---- tab 3: the PC --------------------------------------------------------------------------
C["Plot!cpu"] = plot("CPU (busy cores)",
                     [series("/rig/host.cpu_busy_cores_mean", "mean", HOST),
                      series("/rig/host.cpu_busy_cores_peak", "peak", HOST, lineSize=0.5)])
C["Plot!stall"] = plot("Scheduler stall (ms late)",
                       [series("/rig/host.sampler_late_ms_max", "worst wake-up", ALERT)], legend=False)
C["Plot!memory"] = plot("Memory and log disk",
                        [series("/rig/host.mem_used_mb", "memory used (MB)", HOST),
                         series("/rig/host.log_volume_free_gb", "log disk free (GB)", GRAY)])
C["Table!procs"] = {"foxglovePanelTitle": "Processes", "topicPath": "/rig/host.procs"}

# ---- tab 4: when something is wrong ---------------------------------------------------------
C["DiagnosticSummary!health"] = {"foxglovePanelTitle": "Health", "minLevel": 0, "pinnedIds": [],
                                 "hardwareIdFilter": "", "topicToRender": "/diagnostics", "sortByLevel": True}
C["RawMessages!stimulus"] = {"foxglovePanelTitle": "Current stimulus", "topicPath": "/arena/stimulus",
                             "diffEnabled": False, "diffMethod": "custom", "diffTopicPath": "",
                             "showFullMessageForDiff": False, "expansion": "all"}
C["RawMessages!lasterror"] = {"foxglovePanelTitle": "Last error", "topicPath": "/viz/last_error",
                              "diffEnabled": False, "diffMethod": "custom", "diffTopicPath": "",
                              "showFullMessageForDiff": False, "expansion": "all"}
C["RosOut!log"] = {"foxglovePanelTitle": "ROS log (live only)", "searchTerms": [], "minLogLevel": 3, "nameFilter": {}}

C["Tab!main"] = tab([
    ("Overview", split("column", "StateTransitions!run",
                       plots(["Plot!position", "Plot!turning", "Plot!walking", "Plot!rates"]), 12)),
    ("Timing", plots(["Plot!lag", "Plot!cameraloss"])),
    ("Host", split("column", plots(["Plot!cpu", "Plot!stall", "Plot!memory"]), "Table!procs", 62)),
    ("Health", split("column", "DiagnosticSummary!health",
                     split("column", "RawMessages!stimulus",
                           split("column", "RawMessages!lasterror", "RosOut!log", 30), 40), 30)),
])

status = split("row", "Indicator!fictrac", split("row", "Indicator!arena", "Indicator!camera", 50), 33.3)
layout = split("row",
               split("column", "Tab!view", "Tab!display", 76),
               split("column", status, "Tab!main", 7),
               50)

doc = {"configById": C, "globalVariables": {}, "userNodes": {},
       "playbackConfig": {"speed": 1}, "layout": layout}


def ids(node):
    if isinstance(node, str):
        yield node
    else:
        yield from ids(node["first"])
        yield from ids(node["second"])


placed = set(ids(layout))
for k, v in C.items():
    if k.startswith("Tab!"):
        for t in v["tabs"]:
            placed |= set(ids(t["layout"]))
assert placed == set(C), (placed ^ set(C))

json.dump(doc, open(sys.argv[1], "w"), indent=2)
print(len(C), "panel configs ->", sys.argv[1])
