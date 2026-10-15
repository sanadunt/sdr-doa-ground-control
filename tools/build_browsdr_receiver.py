#!/usr/bin/env python3
"""Build the pinned BrowSDR source as a same-origin Ground Console sub-app."""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import tarfile
import tempfile
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent
BROWSDR_REVISION = "54f6cb7c0d69848461eedc46d278518be6f939d3"
BROWSDR_OVERLAY_BASE_REVISION = "54f6cb7c0d69848461eedc46d278518be6f939d3"
SOURCE_ARCHIVE_NAME = "freq-spectrum-source.tar.gz"
# postMessage channel of the Overview dashboard bridge; BRIDGE_CHANNEL in the
# overlay's console-bridge-protocol.ts. A build without it leaves the dashboard
# spectrum and its Start, Listen and tuning controls without a receiver.
CONSOLE_BRIDGE_CHANNEL = "sdr-console-receiver"
# Earlier embedded builds registered a Workbox service worker. It cached /api/
# replies, reloaded the iframe on install, and made Chromium cancel the keepalive
# request that saves a recording when the Receiver page unloads. Current builds
# register none; this script replaces the old worker, deletes its caches and
# unregisters itself without reloading open pages.
RETIRED_SERVICE_WORKER = """\
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => {
\tevent.waitUntil((async () => {
\t\tconst keys = await caches.keys();
\t\tawait Promise.all(keys.filter((key) => key.startsWith('workbox-') || key === 'api-cache').map((key) => caches.delete(key)));
\t\tawait self.registration.unregister();
\t})());
});
"""
_COPY_IGNORES = {
    ".git",
    ".wrangler",
    ".vscode",
    "AGENTS.md",
    "__pycache__",
    "dist",
    "node_modules",
}


def _copy_ignore(_: str, names: list[str]) -> set[str]:
    return _COPY_IGNORES.intersection(names)


def _replace_once(path: Path, old: str, new: str, label: str) -> None:
    content = path.read_text(encoding="utf-8")
    count = content.count(old)
    if count != 1:
        raise RuntimeError(f"expected one {label} anchor in {path}, found {count}")
    path.write_text(content.replace(old, new, 1), encoding="utf-8")


def _replace_count(path: Path, old: str, new: str, expected: int, label: str) -> None:
    content = path.read_text(encoding="utf-8")
    count = content.count(old)
    if count != expected:
        raise RuntimeError(f"expected {expected} {label} anchors in {path}, found {count}")
    path.write_text(content.replace(old, new), encoding="utf-8")


def _remove_between(path: Path, start: str, end: str, label: str) -> None:
    content = path.read_text(encoding="utf-8")
    if content.count(start) != 1 or content.count(end) != 1:
        raise RuntimeError(f"expected one start/end marker for {label} in {path}")
    start_index = content.index(start)
    end_index = content.index(end, start_index + len(start))
    if end_index < start_index:
        raise RuntimeError(f"invalid marker order for {label} in {path}")
    path.write_text(content[:start_index] + content[end_index:], encoding="utf-8")


def _remove_block(path: Path, start: str, end: str, label: str) -> None:
    content = path.read_text(encoding="utf-8")
    if content.count(start) != 1:
        raise RuntimeError(f"expected one start marker for {label} in {path}")
    start_index = content.index(start)
    end_index = content.find(end, start_index + len(start))
    if end_index < 0:
        raise RuntimeError(f"expected an end marker after the start marker for {label} in {path}")
    end_index += len(end)
    path.write_text(content[:start_index] + content[end_index:], encoding="utf-8")


def _apply_embedded_changes(source: Path) -> None:
    html = source / "src/client/index.html"
    _remove_block(
        html,
        '\n\t\t\t<a href="https://github.com/jLynx/BrowSDR" target="_blank" rel="noopener noreferrer" class="icon-btn github-link" title="View on GitHub">',
        "\n\t\t\t</a>",
        "header GitHub link",
    )
    _replace_once(
        html,
        "<title>BrowSDR - Web-Based SDR Receiver</title>",
        "<title>Freq. Spectrum</title>",
        "Receiver browser title",
    )
    _replace_once(
        html,
        '<meta name="title" content="BrowSDR - Web-Based SDR Receiver" />',
        '<meta name="title" content="Freq. Spectrum" />',
        "Receiver page metadata title",
    )
    _replace_once(
        html,
        '<meta name="keywords" content="BrowSDR, WebSDR, SDR, Software Defined Radio, WebUSB, Browser SDR, Radio" />',
        '<meta name="keywords" content="Frequency Spectrum, WebSDR, SDR, Software Defined Radio, WebUSB, Browser SDR, Radio" />',
        "Receiver page metadata keywords",
    )
    _replace_once(
        html,
        '<meta property="og:title" content="BrowSDR - Web-Based SDR Receiver" />',
        '<meta property="og:title" content="Freq. Spectrum" />',
        "Receiver Open Graph title",
    )
    _replace_once(
        html,
        '<meta property="twitter:title" content="BrowSDR - Web-Based SDR Receiver" />',
        '<meta property="twitter:title" content="Freq. Spectrum" />',
        "Receiver social metadata title",
    )
    _replace_once(
        html,
        '<meta property="og:image" content="https://browsdr.jlynx.net/icon-1280.png" />',
        '<meta property="og:image" content="/receiver/icon-512.png" />',
        "Receiver Open Graph image",
    )
    _replace_once(
        html,
        '<meta property="twitter:image" content="https://browsdr.jlynx.net/icon-1280.png" />',
        '<meta property="twitter:image" content="/receiver/icon-512.png" />',
        "Receiver social metadata image",
    )
    _replace_count(html, "https://browsdr.jlynx.net/", "/receiver/", 2, "Receiver social metadata URL")
    _replace_once(
        html,
        '<div class="brand" v-show="activeWorkspace === \'listener\'">BrowSDR</div>',
        '<div class="brand" v-show="activeWorkspace === \'listener\'">{{ t(\'Freq. Spectrum\') }}</div>',
        "Receiver header brand",
    )
    audio_button = (
        '\t\t\t\t<button class="btn audio-record-button top-audio-record-button" '
        ':class="{ recording: audioRecording.armed }" @click="toggleVfoAudioRecording" '
        ':disabled="!running || audioRecording.starting || audioRecording.stopping || sweep.active || sweep.starting || sweep.stopping" '
        ':aria-pressed="audioRecording.armed" '
        ':aria-label="t(audioRecording.starting ? \'Starting audio…\' : audioRecording.stopping ? \'Finalizing audio…\' : audioRecording.armed ? \'Stop VFO audio\' : \'Record VFO audio\')" '
        ':title="t(audioRecording.starting ? \'Starting audio…\' : audioRecording.stopping ? \'Finalizing audio…\' : audioRecording.armed ? \'Stop VFO audio\' : \'Record VFO audio\')">\n'
        '\t\t\t\t\t<svg class="audio-record-icon" viewBox="0 0 16 16" aria-hidden="true">\n'
        '\t\t\t\t\t\t<circle v-if="!audioRecording.armed" cx="8" cy="8" r="5" fill="currentColor"></circle>\n'
        '\t\t\t\t\t\t<rect v-else x="4" y="4" width="8" height="8" rx="1" fill="currentColor"></rect>\n'
        '\t\t\t\t\t</svg>\n'
        '\t\t\t\t\t<span class="audio-record-button-label">{{ t(audioRecording.starting ? \'Starting audio…\' : audioRecording.stopping ? \'Finalizing audio…\' : audioRecording.armed ? \'Stop VFO audio\' : \'Record VFO audio\') }}</span>\n'
        '\t\t\t\t</button>\n'
    )
    _remove_block(
        html,
        '\t\t\t\t\t<header class="listener-workspace-header">',
        '\t\t\t\t\t</header>',
        "Listener title, caption, and old audio control",
    )
    _replace_once(
        html,
        '\t\t\t\t</button>\n\t\t\t\t<button class="icon-btn" @click="showStats = !showStats"',
        "\t\t\t\t</button>\n" + audio_button + '\t\t\t\t<button class="icon-btn" @click="showStats = !showStats"',
        "Listener toolbar audio recording control",
    )
    _replace_once(
        html,
        '\t\t\t\t\t\t<div class="form-row info-row" v-if="connected && remoteMode !== \'client\'">\n'
        '\t\t\t\t\t\t\t<small>{{ info.boardName }}</small>\n'
        '\t\t\t\t\t\t</div>',
        '\t\t\t\t\t\t<div class="form-row info-row radio-status-row" role="status">\n'
        '\t\t\t\t\t\t\t<span class="radio-status-dot" :class="{ \'is-on\': connected }" aria-hidden="true"></span>\n'
        '\t\t\t\t\t\t\t<span>Radio SDR {{ connected ? (mockDevice ? \'ON · MOCK (\' + t(\'no RF\') + \')\' : \'ON\') : \'OFF\' }}</span>\n'
        '\t\t\t\t\t\t</div>',
        "Radio SDR connection status",
    )
    _replace_once(
        html,
        "\t\t\t\t\t\t<p>RX only · Bias-T forced OFF · relative dBFS-like power, not calibrated dBm</p>\n",
        "",
        "wide scan caption",
    )
    _replace_once(
        html,
        '\t<script src="lib/peerjs.min.js"></script>\n',
        "",
        "PeerJS script tag",
    )
    _replace_once(
        html,
        '\t\t\t\t\t\t\t\t<button class="btn btn-secondary" style="width: 100%;" @click="showRemoteConnectDialog = true">Connect Remote</button>\n',
        "",
        "remote connect button",
    )
    _remove_between(
        html,
        '\t\t\t\t\t\t<div class="form-row" v-if="connected && remoteMode === \'none\'">',
        '\n\t\t\t\t\t</div>\n\t\t\t\t</div>\n\n\t\t\t\t<div class="panel" :class="{ disabled: !connected }">',
        "remote host controls",
    )
    _remove_between(
        html,
        '\t\t<!-- Remote clients management dialog -->',
        '\t\t<!-- Device picker dialog -->',
        "remote clients dialog",
    )
    _remove_between(
        html,
        '\t\t<!-- Audio unlock overlay (shown when auto-connecting via URL, browser requires a user gesture) -->',
        '\t\t<!-- VFO conflict resolution dialog -->',
        "remote URL connection dialogs",
    )
    sweep = source / "src/client/app/sweep.ts"
    _replace_once(
        sweep,
        "downloadFile(`browsdr-sweep-${timestamp}.json`",
        "downloadFile(`freq-spectrum-sweep-${timestamp}.json`",
        "sweep download filename",
    )
    _replace_once(
        sweep,
        "downloadFile(`browsdr-candidates-${timestamp}.csv`",
        "downloadFile(`freq-spectrum-candidates-${timestamp}.csv`",
        "candidate download filename",
    )
    _replace_once(
        sweep,
        "export const sweepMethods = {\n",
        "export const sweepMethods = {\n"
        "\tasync pauseReceiverForSweep(this: AppInstance) {\n"
        "\t\tif (this.remoteMode !== 'none') return;\n"
        "\t\tif (!this.backend) {\n"
        "\t\t\tif (this.running) throw new Error('Receiver backend is unavailable while RX is active.');\n"
        "\t\t\treturn;\n"
        "\t\t}\n"
        "\t\tif (this.running) await this.togglePlay(false, true);\n"
        "\t\telse if (this.connected) await this.backend.stopRx();\n"
        "\t\tif (this.running) throw new Error('Receiver remained active after pause.');\n"
        "\t},\n"
        "\n",
        "exclusive Receiver pause before wide scan",
    )
    _replace_once(
        sweep,
        "\t\t\tif (this.running) await this.togglePlay(false, true);\n\t\t\tif (runtime.stopRequested) {",
        "\t\t\tawait this.pauseReceiverForSweep();\n\t\t\tif (runtime.stopRequested) {",
        "awaited Receiver pause before starting sweep",
    )
    _replace_count(
        html,
        "sweep.active || sweep.starting || sweep.stopping || sweep.hasResults",
        "sweep.active || sweep.starting || sweep.stopping || sweep.listening || sweep.listenStarting",
        10,
        "editable stopped sweep acquisition settings",
    )
    _replace_once(
        html,
        "\t\t\t\t\t<label>Graph minimum\n"
        "\t\t\t\t\t\t<div class=\"sweep-input-unit\">\n"
        "\t\t\t\t\t\t\t<input type=\"number\" v-model.number=\"sweep.displayMinDb\" min=\"-160\" :max=\"sweep.displayMaxDb - 5\" step=\"5\" @change=\"updateSweepDisplayRange('min')\">\n"
        "\t\t\t\t\t\t\t<span>dBFS</span>\n"
        "\t\t\t\t\t\t</div>\n"
        "\t\t\t\t\t</label>\n"
        "\t\t\t\t\t<label>Graph maximum\n"
        "\t\t\t\t\t\t<div class=\"sweep-input-unit\">\n"
        "\t\t\t\t\t\t\t<input type=\"number\" v-model.number=\"sweep.displayMaxDb\" :min=\"sweep.displayMinDb + 5\" max=\"0\" step=\"5\" @change=\"updateSweepDisplayRange('max')\">\n"
        "\t\t\t\t\t\t\t<span>dBFS</span>\n"
        "\t\t\t\t\t\t</div>\n"
        "\t\t\t\t\t</label>\n",
        "\t\t\t\t\t<div class=\"sweep-display-range\" role=\"group\" :aria-label=\"t('Spectrum display limits')\">\n"
        "\t\t\t\t\t\t<label>{{ t('Graph min.') }}\n"
        "\t\t\t\t\t\t\t<div class=\"sweep-input-unit\">\n"
        "\t\t\t\t\t\t\t\t<input type=\"number\" v-model.number=\"sweep.displayMinDb\" min=\"-160\" :max=\"sweep.displayMaxDb - 5\" step=\"5\" :aria-label=\"t('Graph minimum dBFS')\" @input=\"previewSweepDisplayRange('min', $event)\" @change=\"updateSweepDisplayRange('min')\">\n"
        "\t\t\t\t\t\t\t\t<span>dBFS</span>\n"
        "\t\t\t\t\t\t\t</div>\n"
        "\t\t\t\t\t\t</label>\n"
        "\t\t\t\t\t\t<label>{{ t('Graph max.') }}\n"
        "\t\t\t\t\t\t\t<div class=\"sweep-input-unit\">\n"
        "\t\t\t\t\t\t\t\t<input type=\"number\" v-model.number=\"sweep.displayMaxDb\" :min=\"sweep.displayMinDb + 5\" max=\"60\" step=\"5\" :aria-label=\"t('Graph maximum dBFS')\" @input=\"previewSweepDisplayRange('max', $event)\" @change=\"updateSweepDisplayRange('max')\">\n"
        "\t\t\t\t\t\t\t\t<span>dBFS</span>\n"
        "\t\t\t\t\t\t\t</div>\n"
        "\t\t\t\t\t\t</label>\n"
        "\t\t\t\t\t</div>\n",
        "display-only graph range controls",
    )
    html_content = html.read_text(encoding="utf-8")
    range_start = "\t\t\t\t\t<div class=\"sweep-display-range\""
    trace_start = "\t\t\t\t\t<label>{{ t('Trace') }}\n"
    listen_start = "\t\t\t\t\t<label>{{ t('Listen mode') }}\n"
    listen_end = "\t\t\t\t\t</label>\n"
    if any(html_content.count(marker) != 1 for marker in (range_start, trace_start, listen_start)):
        raise RuntimeError("expected one graph-range, trace, and listen-mode control to reorder")
    range_index = html_content.index(range_start)
    trace_index = html_content.index(trace_start)
    listen_index = html_content.index(listen_start)
    if not trace_index < range_index < listen_index:
        raise RuntimeError("graph range/listen controls are not in the expected source order")
    block_end = html_content.index(listen_end, listen_index) + len(listen_end)
    range_and_listen = html_content[range_index:block_end]
    html_content = html_content[:range_index] + html_content[block_end:]
    trace_index = html_content.index(trace_start)
    html_content = html_content[:trace_index] + range_and_listen + html_content[trace_index:]
    html.write_text(html_content, encoding="utf-8")
    style = source / "src/client/style.css"
    _replace_once(
        style,
        ".receiver-toggle-label {\n\tfont-size: 11px;\n\tfont-weight: 600;\n}\n",
        ".receiver-toggle-label {\n\tfont-size: 11px;\n\tfont-weight: 600;\n}\n\n"
        ".top-controls .top-audio-record-button {\n"
        "\tdisplay: inline-flex;\n"
        "\talign-items: center;\n"
        "\tjustify-content: center;\n"
        "\tflex: 0 0 auto;\n"
        "\tgap: 6px;\n"
        "\twidth: auto;\n"
        "\tmin-width: 34px;\n"
        "\tmin-height: 34px;\n"
        "\tpadding: 4px 9px;\n"
        "\twhite-space: nowrap;\n"
        "}\n\n"
        ".top-audio-record-button .audio-record-icon {\n"
        "\twidth: 12px;\n"
        "\theight: 12px;\n"
        "\tflex: 0 0 auto;\n"
        "}\n\n"
        ".top-controls .top-audio-record-button:focus-visible {\n"
        "\toutline: 2px solid var(--accent);\n"
        "\toutline-offset: 2px;\n"
        "}\n\n"
        ".radio-status-row {\n"
        "\tgap: 7px;\n"
        "}\n\n"
        ".radio-status-dot {\n"
        "\twidth: 8px;\n"
        "\theight: 8px;\n"
        "\tflex: 0 0 8px;\n"
        "\tborder-radius: 50%;\n"
        "\tbackground-color: #c75a67;\n"
        "}\n"
        ".radio-status-dot.is-on {\n"
        "\tbackground-color: #329d64;\n"
        "}\n\n"
        "@media (max-width: 800px) {\n"
        "\t.top-controls .top-audio-record-button {\n"
        "\t\tbox-sizing: border-box;\n"
        "\t\twidth: 34px;\n"
        "\t\tmin-width: 34px;\n"
        "\t\theight: 34px;\n"
        "\t\tmin-height: 34px;\n"
        "\t\tpadding: 6px;\n"
        "\t}\n"
        "\t.top-audio-record-button .audio-record-button-label {\n"
        "\t\tdisplay: none;\n"
        "\t}\n"
        "}\n",
        "Listener toolbar and radio status styles",
    )
    _replace_once(
        style,
        ".radio-status-dot.is-on {\n\tbackground-color: #329d64;\n}\n\n",
        ".radio-status-dot.is-on {\n\tbackground-color: #329d64;\n}\n\n"
        ".records-audio-filters {\n"
        "\tdisplay: grid;\n"
        "\tgrid-template-columns: minmax(250px, 1.45fr) repeat(3, minmax(135px, 1fr));\n"
        "\talign-items: start;\n"
        "\tgap: 10px;\n"
        "\tpadding: 10px;\n"
        "\tborder: 1px solid var(--border);\n"
        "\tborder-radius: 5px;\n"
        "\tbackground: var(--bg-panel);\n"
        "}\n\n"
        ".records-audio-filters label,\n"
        ".records-audio-filters .audio-filter-fieldset legend,\n"
        ".records-audio-filters .audio-date-picker summary {\n"
        "\tcolor: var(--text-main);\n"
        "\tfont-size: 12px;\n"
        "}\n\n"
        ".records-audio-filters .audio-filter-fieldset {\n"
        "\tmin-width: 0;\n"
        "\tmargin: 0;\n"
        "\tpadding: 0;\n"
        "\tborder: 0;\n"
        "}\n\n"
        ".records-audio-filters .audio-filter-fieldset legend {\n"
        "\tmargin-bottom: 5px;\n"
        "\tpadding: 0;\n"
        "\tfont-weight: 600;\n"
        "}\n\n"
        ".records-audio-filters .audio-filter-fieldset label,\n"
        ".records-audio-filters .audio-filter-select {\n"
        "\tdisplay: flex;\n"
        "\tflex-direction: column;\n"
        "\tgap: 5px;\n"
        "\tmin-width: 0;\n"
        "}\n\n"
        ".audio-filter-pair {\n"
        "\tdisplay: grid;\n"
        "\tgrid-template-columns: repeat(2, minmax(0, 1fr));\n"
        "\tgap: 7px;\n"
        "}\n\n"
        ".records-audio-filters input,\n"
        ".records-audio-filters select,\n"
        ".audio-date-picker > summary {\n"
        "\twidth: 100%;\n"
        "\tmin-height: 36px;\n"
        "\tpadding: 6px 8px;\n"
        "\tborder: 1px solid var(--border);\n"
        "\tborder-radius: 4px;\n"
        "\tbackground: var(--bg-dark);\n"
        "\tcolor: var(--text-main);\n"
        "\tfont: inherit;\n"
        "\tfont-size: 12px;\n"
        "}\n\n"
        ".audio-date-picker {\n"
        "\tmin-width: 0;\n"
        "}\n\n"
        ".audio-date-picker > summary {\n"
        "\tdisplay: flex;\n"
        "\talign-items: center;\n"
        "\tjustify-content: space-between;\n"
        "\tgap: 8px;\n"
        "\tcursor: pointer;\n"
        "}\n\n"
        ".audio-date-picker > summary strong {\n"
        "\tcolor: var(--text-main);\n"
        "\tfont-size: 12px;\n"
        "}\n\n"
        ".audio-calendar {\n"
        "\tmargin-top: 8px;\n"
        "\tpadding: 8px;\n"
        "\tborder: 1px solid var(--border);\n"
        "\tborder-radius: 4px;\n"
        "\tbackground: var(--bg-dark);\n"
        "}\n\n"
        ".audio-calendar-header {\n"
        "\tdisplay: grid;\n"
        "\tgrid-template-columns: auto minmax(0, 1fr) auto;\n"
        "\talign-items: center;\n"
        "\tgap: 8px;\n"
        "\tmargin-bottom: 8px;\n"
        "\ttext-align: center;\n"
        "}\n\n"
        ".audio-calendar-header strong {\n"
        "\tcolor: var(--text-main);\n"
        "\tfont-size: 12px;\n"
        "}\n\n"
        ".audio-calendar-nav {\n"
        "\tmin-width: 54px;\n"
        "\tmin-height: 32px;\n"
        "\tpadding: 4px 8px;\n"
        "}\n\n"
        ".audio-calendar-grid {\n"
        "\tdisplay: grid;\n"
        "\tgap: 3px;\n"
        "}\n\n"
        ".audio-calendar-weekdays,\n"
        ".audio-calendar-week {\n"
        "\tdisplay: grid;\n"
        "\tgrid-template-columns: repeat(7, minmax(0, 1fr));\n"
        "\tgap: 3px;\n"
        "}\n\n"
        ".audio-calendar-weekdays {\n"
        "\tmargin-bottom: 3px;\n"
        "\tcolor: var(--text-muted);\n"
        "\tfont-size: 11px;\n"
        "\ttext-align: center;\n"
        "}\n\n"
        ".audio-calendar-cell {\n"
        "\tmin-width: 0;\n"
        "}\n\n"
        ".audio-calendar-day {\n"
        "\tposition: relative;\n"
        "\tdisplay: grid;\n"
        "\tplace-items: center;\n"
        "\twidth: 100%;\n"
        "\tmin-height: 38px;\n"
        "\tpadding: 3px 0 6px;\n"
        "\tborder: 1px solid transparent;\n"
        "\tborder-radius: 4px;\n"
        "\tbackground: transparent;\n"
        "\tcolor: var(--text-main);\n"
        "\tfont: inherit;\n"
        "\tfont-size: 12px;\n"
        "\tcursor: pointer;\n"
        "}\n\n"
        ".audio-calendar-day:disabled {\n"
        "\tcolor: var(--text-muted);\n"
        "\topacity: 0.42;\n"
        "\tcursor: default;\n"
        "}\n\n"
        ".audio-calendar-day.has-recordings {\n"
        "\tborder-color: color-mix(in srgb, var(--accent) 45%, transparent);\n"
        "\tbackground: color-mix(in srgb, var(--accent) 16%, transparent);\n"
        "\tfont-weight: 700;\n"
        "}\n\n"
        ".audio-calendar-day.has-recordings::after {\n"
        "\tposition: absolute;\n"
        "\tbottom: 3px;\n"
        "\twidth: 4px;\n"
        "\theight: 4px;\n"
        "\tborder-radius: 50%;\n"
        "\tbackground: var(--accent);\n"
        "\tcontent: '';\n"
        "}\n\n"
        ".audio-calendar-day.is-selected {\n"
        "\tborder: 2px solid var(--accent);\n"
        "}\n\n"
        ".audio-calendar-help {\n"
        "\tmargin: 8px 0 0;\n"
        "\tcolor: var(--text-muted);\n"
        "\tfont-size: 12px;\n"
        "}\n\n"
        ".records-audio-filters input:focus-visible,\n"
        ".records-audio-filters select:focus-visible,\n"
        ".records-audio-filters button:focus-visible,\n"
        ".audio-date-picker > summary:focus-visible {\n"
        "\toutline: 2px solid var(--accent);\n"
        "\toutline-offset: 1px;\n"
        "}\n\n"
        ".audio-clear-filters {\n"
        "\talign-self: end;\n"
        "\tmin-height: 36px;\n"
        "}\n\n"
        ".audio-record-segment-details {\n"
        "\tdisplay: flex;\n"
        "\tflex: 1 1 auto;\n"
        "\tflex-direction: column;\n"
        "\tgap: 2px;\n"
        "\tmin-width: 0;\n"
        "\tfont-size: 11px;\n"
        "\tline-height: 1.5;\n"
        "}\n\n"
        ".audio-record-segment-details time {\n"
        "\tcolor: var(--text-main);\n"
        "\tfont-size: 11px;\n"
        "\tfont-weight: 600;\n"
        "}\n\n"
        ".audio-record-segment .audio-record-delete-button {\n"
        "\tflex: 0 0 auto;\n"
        "\tmin-height: 34px;\n"
        "\tpadding: 4px 8px;\n"
        "}\n\n"
        "@media (max-width: 1000px) {\n"
        "\t.records-audio-filters {\n"
        "\t\tgrid-template-columns: repeat(2, minmax(0, 1fr));\n"
        "\t}\n"
        "}\n\n"
        "@media (max-width: 700px) {\n"
        "\t.records-audio-filters {\n"
        "\t\tgrid-template-columns: minmax(0, 1fr);\n"
        "\t}\n"
        "\t.audio-record-segment .audio-record-delete-button {\n"
        "\t\twidth: 100%;\n"
        "\t}\n"
        "}\n\n"
        "@media (max-width: 400px) {\n"
        "\t.records-audio-filters input,\n"
        "\t.records-audio-filters select {\n"
        "\t\tfont-size: 16px;\n"
        "\t}\n"
        "}\n\n",
        "VFO audio filter and segment action styles",
    )
    _replace_once(
        style,
        ".listener-workspace-header,\n.records-header {",
        ".records-header {",
        "unused Listener header layout style",
    )
    _replace_once(
        style,
        ".listener-workspace-header h2,\n.records-header h2 {",
        ".records-header h2 {",
        "unused Listener heading style",
    )
    _replace_once(
        style,
        ".listener-workspace-header p,\n.records-header p,\n.records-settings p,\n.marker-settings-heading p {",
        ".records-header p,\n.records-settings p,\n.marker-settings-heading p {",
        "unused Listener caption style",
    )
    _replace_once(
        style,
        "\t.listener-workspace-header,\n\t.records-header,\n\t.marker-settings-heading {",
        "\t.records-header,\n\t.marker-settings-heading {",
        "unused mobile Listener header layout style",
    )
    _replace_once(
        style,
        "\t.listener-workspace-header,\n\t.records-header {",
        "\t.records-header {",
        "unused mobile Listener header padding",
    )
    _replace_once(
        style,
        ".sweep-controls {\n\tdisplay: grid;\n\tgrid-template-columns: repeat(auto-fit, minmax(125px, 1fr));\n",
        ".sweep-controls {\n\tdisplay: grid;\n\tgrid-template-columns: repeat(auto-fit, minmax(95px, 1fr));\n",
        "compact settings row",
    )
    _replace_once(
        style,
        ".sweep-controls select,\n.sweep-controls input[type='number'] {",
        ".sweep-display-range {\n"
        "\tgrid-column: span 2;\n"
        "\tmin-width: 0;\n"
        "\tdisplay: grid;\n"
        "\tgrid-template-columns: repeat(2, minmax(0, 1fr));\n"
        "\talign-items: end;\n"
        "\tgap: 8px 12px;\n"
        "\tpadding: 8px 10px;\n"
        "\tborder: 1px solid #3a4557;\n"
        "\tborder-radius: 5px;\n"
        "\tbackground: rgba(12, 16, 23, 0.55);\n"
        "}\n\n"
        ".sweep-display-range > label {\n"
        "\tdisplay: flex;\n"
        "\tflex-direction: column;\n"
        "\tgap: 5px;\n"
        "\tmin-width: 0;\n"
        "\tcolor: #aab5c5;\n"
        "\tfont-size: 11px;\n"
        "}\n\n"
        ".sweep-controls select,\n.sweep-controls input[type='number'] {",
        "display range layout",
    )
    _replace_once(
        style,
        ".github-link {\n"
        "\ttext-decoration: none;\n"
        "\tmargin-right: 6px;\n"
        "\tcolor: var(--text-dim);\n"
        "}\n"
        ".github-link:hover {\n"
        "\tcolor: var(--text-main);\n"
        "}\n",
        "",
        "header GitHub icon styles",
    )
    _remove_block(style, "\n\t.github-link {", "\n\t}", "mobile GitHub icon styles")
    _remove_block(style, "\n.sweep-header p {", "\n}", "scan caption styles")
    _remove_block(style, "\n\t.sweep-header p {", "\n\t}", "mobile scan caption styles")
    session = source / "src/client/app/sweep-session.ts"
    _replace_once(
        session,
        "export type SweepCandidateSort =",
        "export const SWEEP_DISPLAY_MAX_DB = 60;\n\nexport type SweepCandidateSort =",
        "shared spectrum display ceiling",
    )
    _replace_once(
        session,
        "|| !isFiniteNumber(display.displayMaxDb) || display.displayMaxDb > 0\n",
        "|| !isFiniteNumber(display.displayMaxDb) || display.displayMaxDb > SWEEP_DISPLAY_MAX_DB\n",
        "spectrum session display ceiling",
    )

    sweep = source / "src/client/app/sweep.ts"
    _replace_once(
        sweep,
        "import { exportSweepCandidatesCsv, parseSweepSession, serializeSweepSession } from './sweep-session';\n",
        "import { SWEEP_DISPLAY_MAX_DB, exportSweepCandidatesCsv, parseSweepSession, serializeSweepSession } from './sweep-session';\n",
        "spectrum display ceiling import",
    )
    _replace_once(
        sweep,
        "import { SweepWaterfallHistory, SweepWaterfallRenderer, SWEEP_WATERFALL_BINS, SWEEP_WATERFALL_ROWS } from './sweep-waterfall';\n",
        "import {\n"
        "\tSWEEP_WATERFALL_BINS,\n"
        "\tSWEEP_WATERFALL_MAX_DB,\n"
        "\tSWEEP_WATERFALL_MIN_DB,\n"
        "\tSWEEP_WATERFALL_ROWS,\n"
        "\tSweepWaterfallHistory,\n"
        "\tSweepWaterfallRenderer,\n"
        "} from './sweep-waterfall';\n",
        "waterfall hover sampling imports",
    )
    _replace_once(
        sweep,
        "\tupdateSweepDisplayRange(this: AppInstance, changed: 'min' | 'max') {\n",
        "\tpreviewSweepDisplayRange(this: AppInstance, changed: 'min' | 'max', event: Event) {\n"
        "\t\tconst target = event.target as HTMLInputElement;\n"
        "\t\tconst value = target.valueAsNumber;\n"
        "\t\tconst other = Number(changed === 'min' ? this.sweep.displayMaxDb : this.sweep.displayMinDb);\n"
        "\t\tif (!Number.isFinite(value) || !Number.isFinite(other)) return;\n"
        "\t\tconst validRange = changed === 'min'\n"
        "\t\t\t? value >= -160 && value <= other - 5\n"
        "\t\t\t: value >= other + 5 && value <= SWEEP_DISPLAY_MAX_DB;\n"
        "\t\tif (!validRange) return;\n"
        "\t\tif (changed === 'min') this.sweep.displayMinDb = value;\n"
        "\t\telse this.sweep.displayMaxDb = value;\n"
        "\t\tthis.drawSweepSpectrum();\n"
        "\t},\n\n"
        "\tupdateSweepDisplayRange(this: AppInstance, changed: 'min' | 'max') {\n",
        "live display range redraw",
    )
    _replace_once(
        sweep,
        "\tupdateSweepDisplayRange(this: AppInstance, changed: 'min' | 'max') {\n"
        "\t\tconst minimum = Number(this.sweep.displayMinDb);\n"
        "\t\tconst maximum = Number(this.sweep.displayMaxDb);\n"
        "\t\tif (changed === 'min') {\n"
        "\t\t\tconst nextMaximum = clamp(Number.isFinite(maximum) ? maximum : 0, -155, 0);\n"
        "\t\t\tthis.sweep.displayMaxDb = nextMaximum;\n"
        "\t\t\tthis.sweep.displayMinDb = clamp(Number.isFinite(minimum) ? minimum : -120, -160, nextMaximum - 5);\n"
        "\t\t} else {\n"
        "\t\t\tconst nextMinimum = clamp(Number.isFinite(minimum) ? minimum : -120, -160, -5);\n"
        "\t\t\tthis.sweep.displayMinDb = nextMinimum;\n"
        "\t\t\tthis.sweep.displayMaxDb = clamp(Number.isFinite(maximum) ? maximum : 0, nextMinimum + 5, 0);\n"
        "\t\t}\n"
        "\t\tthis.drawSweepSpectrum();\n"
        "\t},",
        "\tupdateSweepDisplayRange(this: AppInstance, changed: 'min' | 'max') {\n"
        "\t\tconst minimum = Number(this.sweep.displayMinDb);\n"
        "\t\tconst maximum = Number(this.sweep.displayMaxDb);\n"
        "\t\tif (changed === 'min') {\n"
        "\t\t\tconst nextMaximum = clamp(Number.isFinite(maximum) ? maximum : 0, -155, SWEEP_DISPLAY_MAX_DB);\n"
        "\t\t\tthis.sweep.displayMaxDb = nextMaximum;\n"
        "\t\t\tthis.sweep.displayMinDb = clamp(Number.isFinite(minimum) ? minimum : -60, -160, nextMaximum - 5);\n"
        "\t\t} else {\n"
        "\t\t\tconst nextMinimum = clamp(Number.isFinite(minimum) ? minimum : -60, -160, SWEEP_DISPLAY_MAX_DB - 5);\n"
        "\t\t\tthis.sweep.displayMinDb = nextMinimum;\n"
        "\t\t\tthis.sweep.displayMaxDb = clamp(Number.isFinite(maximum) ? maximum : 0, nextMinimum + 5, SWEEP_DISPLAY_MAX_DB);\n"
        "\t\t}\n"
        "\t\tthis.drawSweepSpectrum();\n"
        "\t},",
        "spectrum range input clamping",
    )
    _replace_once(
        sweep,
        "\tsetSweepVisualization(this: AppInstance, visualization: 'spectrum' | 'waterfall') {\n"
        "\t\tthis.sweep.visualization = visualization;\n"
        "\t\tthis.drawSweepSpectrum();\n"
        "\t},",
        "\tsetSweepVisualization(this: AppInstance, visualization: 'spectrum' | 'waterfall') {\n"
        "\t\tthis.sweep.visualization = visualization;\n"
        "\t\tthis.sweep.hoverFrequencyHz = null;\n"
        "\t\tthis.sweep.hoverPowerDb = null;\n"
        "\t\tthis.sweep.hoverWaterfallY = null;\n"
        "\t\tthis.sweep.hoverWaterfallRow = null;\n"
        "\t\tthis.drawSweepSpectrum();\n"
        "\t},",
        "clear chart hover when changing visualization",
    )
    _replace_once(
        sweep,
        "\t\tconst x = event.clientX - rect.left;\n"
        "\t\tif (x < 54 || x > rect.width - 12) return;\n"
        "\t\tconst ratio = (x - 54) / Math.max(1, rect.width - 66);\n"
        "\t\tconst frequencyHz = this.sweep.viewportStartHz + ratio * (this.sweep.viewportEndHz - this.sweep.viewportStartHz);\n"
        "\t\tthis.sweep.hoverFrequencyHz = frequencyHz;\n"
        "\t\tconst frame = runtime.frame;\n"
        "\t\tif (frame && frequencyHz >= frame.startHz && frequencyHz < frame.endHz) {\n"
        "\t\t\tconst values = this.sweep.view === 'current' ? frame.current : this.sweep.view === 'max' ? frame.maxHold : frame.average;\n"
        "\t\t\tconst index = Math.min(values.length - 1, Math.floor((frequencyHz - frame.startHz) / (frame.endHz - frame.startHz) * values.length));\n"
        "\t\t\tthis.sweep.hoverPowerDb = values[index];\n"
        "\t\t} else {\n"
        "\t\t\tthis.sweep.hoverPowerDb = null;\n"
        "\t\t}\n"
        "\t\tthis.drawSweepSpectrum();",
        "\t\tconst x = event.clientX - rect.left;\n"
        "\t\tconst y = event.clientY - rect.top;\n"
        "\t\tif (x < 54 || x > rect.width - 12 || y < 14 || y > rect.height - 28) {\n"
        "\t\t\tthis.sweep.hoverFrequencyHz = null;\n"
        "\t\t\tthis.sweep.hoverPowerDb = null;\n"
        "\t\t\tthis.sweep.hoverWaterfallY = null;\n"
        "\t\t\tthis.sweep.hoverWaterfallRow = null;\n"
        "\t\t\tthis.drawSweepSpectrum();\n"
        "\t\t\treturn;\n"
        "\t\t}\n"
        "\t\tconst ratio = (x - 54) / Math.max(1, rect.width - 66);\n"
        "\t\tconst frequencyHz = this.sweep.viewportStartHz + ratio * (this.sweep.viewportEndHz - this.sweep.viewportStartHz);\n"
        "\t\tthis.sweep.hoverFrequencyHz = frequencyHz;\n"
        "\t\tif (this.sweep.visualization === 'waterfall') {\n"
        "\t\t\tthis.sweep.hoverWaterfallY = y;\n"
        "\t\t\tconst history = runtime.waterfallHistory;\n"
        "\t\t\tconst plotHeight = Math.max(1, rect.height - 14 - 28);\n"
        "\t\t\tconst dataHeight = plotHeight * history.rowCount / SWEEP_WATERFALL_ROWS;\n"
        "\t\t\tconst dataTop = 14 + plotHeight - dataHeight;\n"
        "\t\t\tconst rowIndex = dataHeight > 0 && y >= dataTop && y <= dataTop + dataHeight\n"
        "\t\t\t\t? Math.min(history.rowCount - 1, Math.floor((y - dataTop) / dataHeight * history.rowCount))\n"
        "\t\t\t\t: -1;\n"
        "\t\t\tconst row = rowIndex >= 0 ? history.readChronologicalRow(rowIndex) : null;\n"
        "\t\t\tthis.sweep.hoverWaterfallRow = row ? rowIndex : null;\n"
        "\t\t\tconst frame = runtime.frame;\n"
        "\t\t\tif (row && frame && frequencyHz >= frame.startHz && frequencyHz < frame.endHz) {\n"
        "\t\t\t\tconst bin = Math.min(row.length - 1, Math.floor((frequencyHz - frame.startHz) / (frame.endHz - frame.startHz) * SWEEP_WATERFALL_BINS));\n"
        "\t\t\t\tthis.sweep.hoverPowerDb = SWEEP_WATERFALL_MIN_DB + row[bin] * (SWEEP_WATERFALL_MAX_DB - SWEEP_WATERFALL_MIN_DB) / 255;\n"
        "\t\t\t} else {\n"
        "\t\t\t\tthis.sweep.hoverPowerDb = null;\n"
        "\t\t\t}\n"
        "\t\t} else {\n"
        "\t\t\tthis.sweep.hoverWaterfallY = null;\n"
        "\t\t\tthis.sweep.hoverWaterfallRow = null;\n"
        "\t\t\tconst frame = runtime.frame;\n"
        "\t\t\tif (frame && frequencyHz >= frame.startHz && frequencyHz < frame.endHz) {\n"
        "\t\t\t\tconst values = this.sweep.view === 'current' ? frame.current : this.sweep.view === 'max' ? frame.maxHold : frame.average;\n"
        "\t\t\t\tconst index = Math.min(values.length - 1, Math.floor((frequencyHz - frame.startHz) / (frame.endHz - frame.startHz) * values.length));\n"
        "\t\t\t\tthis.sweep.hoverPowerDb = values[index];\n"
        "\t\t\t} else {\n"
        "\t\t\t\tthis.sweep.hoverPowerDb = null;\n"
        "\t\t\t}\n"
        "\t\t}\n"
        "\t\tthis.drawSweepSpectrum();",
        "waterfall cursor power and row sampling",
    )
    _replace_once(
        sweep,
        "\t\tthis.sweep.hoverFrequencyHz = null;\n"
        "\t\tthis.sweep.hoverPowerDb = null;\n"
        "\t\tthis.drawSweepSpectrum();\n"
        "\t},\n\n\tsweepCanvasWheel",
        "\t\tthis.sweep.hoverFrequencyHz = null;\n"
        "\t\tthis.sweep.hoverPowerDb = null;\n"
        "\t\tthis.sweep.hoverWaterfallY = null;\n"
        "\t\tthis.sweep.hoverWaterfallRow = null;\n"
        "\t\tthis.drawSweepSpectrum();\n"
        "\t},\n\n\tsweepCanvasWheel",
        "clear waterfall cursor on leave",
    )

    sweep_canvas = source / "src/client/app/sweep-canvas.ts"
    _replace_once(
        sweep_canvas,
        "\thoverFrequencyHz: number | null;\n\tminDb: number;\n",
        "\thoverFrequencyHz: number | null;\n\thoverPowerDb: number | null;\n\tminDb: number;\n",
        "sweep chart hover power",
    )
    _replace_once(
        sweep_canvas,
        "\t\tcontext.strokeStyle = '#7dd3fc';\n",
        "\t\tconst powerGradient = context.createLinearGradient(0, top + plotHeight, 0, top);\n"
        "\t\tpowerGradient.addColorStop(0, '#1d4ed8');\n"
        "\t\tpowerGradient.addColorStop(0.3, '#06b6d4');\n"
        "\t\tpowerGradient.addColorStop(0.62, '#facc15');\n"
        "\t\tpowerGradient.addColorStop(1, '#ef4444');\n"
        "\t\tcontext.strokeStyle = powerGradient;\n",
        "spectrum trace power intensity gradient",
    )
    _replace_once(
        sweep_canvas,
        "\t\tcontext.lineWidth = 1.4;\n",
        "\t\tcontext.lineWidth = 1.8;\n",
        "higher contrast spectrum trace weight",
    )
    _replace_once(
        sweep_canvas,
        "\tif (options.hoverFrequencyHz !== null && options.hoverFrequencyHz >= options.startHz && options.hoverFrequencyHz <= options.endHz) {\n"
        "\t\tconst x = left + (options.hoverFrequencyHz - options.startHz) / viewSpan * plotWidth;\n"
        "\t\tcontext.strokeStyle = 'rgba(255,255,255,0.55)';\n"
        "\t\tcontext.setLineDash([2, 3]);\n"
        "\t\tcontext.beginPath();\n"
        "\t\tcontext.moveTo(x, top);\n"
        "\t\tcontext.lineTo(x, top + plotHeight);\n"
        "\t\tcontext.stroke();\n"
        "\t\tcontext.setLineDash([]);\n"
        "\t}\n",
        "\tif (options.hoverFrequencyHz !== null && options.hoverFrequencyHz >= options.startHz && options.hoverFrequencyHz <= options.endHz) {\n"
        "\t\tconst x = left + (options.hoverFrequencyHz - options.startHz) / viewSpan * plotWidth;\n"
        "\t\tconst powerDb = options.hoverPowerDb;\n"
        "\t\tconst y = powerDb !== null && Number.isFinite(powerDb)\n"
        "\t\t\t? yForDb(Math.max(options.minDb, Math.min(options.maxDb, powerDb)))\n"
        "\t\t\t: null;\n"
        "\t\tcontext.save();\n"
        "\t\tcontext.strokeStyle = 'rgba(255,255,255,0.62)';\n"
        "\t\tcontext.setLineDash([2, 3]);\n"
        "\t\tcontext.beginPath();\n"
        "\t\tcontext.moveTo(x, top);\n"
        "\t\tcontext.lineTo(x, top + plotHeight);\n"
        "\t\tcontext.stroke();\n"
        "\t\tif (y !== null) {\n"
        "\t\t\tcontext.beginPath();\n"
        "\t\t\tcontext.moveTo(left, y);\n"
        "\t\t\tcontext.lineTo(left + plotWidth, y);\n"
        "\t\t\tcontext.stroke();\n"
        "\t\t\tcontext.setLineDash([]);\n"
        "\t\t\tcontext.beginPath();\n"
        "\t\t\tcontext.arc(x, y, 4, 0, Math.PI * 2);\n"
        "\t\t\tcontext.fillStyle = '#ef4444';\n"
        "\t\t\tcontext.fill();\n"
        "\t\t\tcontext.lineWidth = 1.5;\n"
        "\t\t\tcontext.strokeStyle = '#fff';\n"
        "\t\t\tcontext.stroke();\n"
        "\t\t\tif (powerDb !== null && Number.isFinite(powerDb)) {\n"
        "\t\t\t\tconst frequencyText = `${(options.hoverFrequencyHz / 1_000_000).toFixed(6)} MHz`;\n"
        "\t\t\t\tconst powerText = `${powerDb.toFixed(1)} dBFS-like`;\n"
        "\t\t\t\tcontext.font = '10px \"Roboto Mono\", monospace';\n"
        "\t\t\t\tconst boxWidth = Math.ceil(Math.max(context.measureText(frequencyText).width, context.measureText(powerText).width)) + 14;\n"
        "\t\t\t\tconst boxHeight = 34;\n"
        "\t\t\t\tlet boxX = x + 9;\n"
        "\t\t\t\tif (boxX + boxWidth > left + plotWidth - 4) boxX = x - boxWidth - 9;\n"
        "\t\t\t\tboxX = Math.max(left + 4, Math.min(left + plotWidth - boxWidth - 4, boxX));\n"
        "\t\t\t\tlet boxY = y - boxHeight - 9;\n"
        "\t\t\t\tif (boxY < top + 4) boxY = y + 9;\n"
        "\t\t\t\tboxY = Math.max(top + 4, Math.min(top + plotHeight - boxHeight - 4, boxY));\n"
        "\t\t\t\tcontext.fillStyle = 'rgba(8,11,17,0.96)';\n"
        "\t\t\t\tcontext.fillRect(boxX, boxY, boxWidth, boxHeight);\n"
        "\t\t\t\tcontext.strokeStyle = 'rgba(255,255,255,0.68)';\n"
        "\t\t\t\tcontext.strokeRect(boxX, boxY, boxWidth, boxHeight);\n"
        "\t\t\t\tcontext.fillStyle = '#f8fafc';\n"
        "\t\t\t\tcontext.textAlign = 'left';\n"
        "\t\t\t\tcontext.textBaseline = 'top';\n"
        "\t\t\t\tcontext.fillText(frequencyText, boxX + 7, boxY + 5);\n"
        "\t\t\t\tcontext.fillText(powerText, boxX + 7, boxY + 19);\n"
        "\t\t\t}\n"
        "\t\t}\n"
        "\t\tcontext.setLineDash([]);\n"
        "\t\tcontext.restore();\n"
        "\t}\n",
        "sweep chart crosshair peak marker and on-plot tooltip",
    )
    _replace_once(
        sweep,
        "\t\t\t\thoverFrequencyHz: this.sweep.hoverFrequencyHz,\n"
        "\t\t\t\tminDb: this.sweep.displayMinDb,\n",
        "\t\t\t\thoverFrequencyHz: this.sweep.hoverFrequencyHz,\n"
        "\t\t\t\thoverPowerDb: this.sweep.hoverPowerDb,\n"
        "\t\t\t\tminDb: this.sweep.displayMinDb,\n",
        "pass cursor power to sweep chart",
    )

    waterfall = source / "src/client/app/sweep-waterfall.ts"
    _replace_once(
        waterfall,
        "\tselectedCandidate: SweepCandidate | null;\n",
        "\tselectedCandidate: SweepCandidate | null;\n"
        "\thoverFrequencyHz: number | null;\n"
        "\thoverY: number | null;\n"
        "\thoverPowerDb: number | null;\n"
        "\thoverRow: number | null;\n",
        "waterfall cursor render options",
    )
    _replace_once(
        waterfall,
        "\t\tcontext.strokeStyle = 'rgba(160, 180, 205, 0.45)';\n"
        "\t\tcontext.strokeRect(left, top, plotWidth, plotHeight);\n",
        "\t\tif (options.hoverFrequencyHz !== null && options.hoverY !== null\n"
        "\t\t\t&& options.hoverFrequencyHz >= options.viewportStartHz && options.hoverFrequencyHz <= options.viewportEndHz) {\n"
        "\t\t\tconst x = left + (options.hoverFrequencyHz - options.viewportStartHz) / viewSpan * plotWidth;\n"
        "\t\t\tconst y = Math.max(top, Math.min(top + plotHeight, options.hoverY));\n"
        "\t\t\tcontext.save();\n"
        "\t\t\tcontext.strokeStyle = 'rgba(255,255,255,0.82)';\n"
        "\t\t\tcontext.lineWidth = 1;\n"
        "\t\t\tcontext.setLineDash([3, 3]);\n"
        "\t\t\tcontext.beginPath();\n"
        "\t\t\tcontext.moveTo(x, top);\n"
        "\t\t\tcontext.lineTo(x, top + plotHeight);\n"
        "\t\t\tcontext.moveTo(left, y);\n"
        "\t\t\tcontext.lineTo(left + plotWidth, y);\n"
        "\t\t\tcontext.stroke();\n"
        "\t\t\tcontext.setLineDash([]);\n"
        "\t\t\tcontext.beginPath();\n"
        "\t\t\tcontext.arc(x, y, 4, 0, Math.PI * 2);\n"
        "\t\t\tcontext.fillStyle = '#ef4444';\n"
        "\t\t\tcontext.fill();\n"
        "\t\t\tcontext.lineWidth = 1.5;\n"
        "\t\t\tcontext.strokeStyle = '#fff';\n"
        "\t\t\tcontext.stroke();\n"
        "\t\t\tconst frequencyText = `${(options.hoverFrequencyHz / 1_000_000).toFixed(6)} MHz`;\n"
        "\t\t\tconst powerText = options.hoverPowerDb === null ? sweepCanvasText('No stored sample') : `${options.hoverPowerDb.toFixed(1)} dBFS-like`;\n"
        "\t\t\tconst rowText = options.hoverRow === null ? sweepCanvasText('No history row') : `${sweepCanvasText('History row')} ${options.hoverRow + 1}/${history.rowCount}`;\n"
        "\t\t\tcontext.font = '10px \"Roboto Mono\", monospace';\n"
        "\t\t\tconst boxWidth = Math.max(1, Math.min(plotWidth - 8, Math.ceil(Math.max(context.measureText(frequencyText).width, context.measureText(powerText).width, context.measureText(rowText).width)) + 14));\n"
        "\t\t\tconst boxHeight = 48;\n"
        "\t\t\tlet boxX = x + 10;\n"
        "\t\t\tif (boxX + boxWidth > left + plotWidth - 4) boxX = x - boxWidth - 10;\n"
        "\t\t\tboxX = Math.max(left + 4, Math.min(left + plotWidth - boxWidth - 4, boxX));\n"
        "\t\t\tlet boxY = y + 10;\n"
        "\t\t\tif (boxY + boxHeight > top + plotHeight - 4) boxY = y - boxHeight - 10;\n"
        "\t\t\tboxY = Math.max(top + 4, Math.min(top + plotHeight - boxHeight - 4, boxY));\n"
        "\t\t\tcontext.fillStyle = 'rgba(8,11,17,0.96)';\n"
        "\t\t\tcontext.fillRect(boxX, boxY, boxWidth, boxHeight);\n"
        "\t\t\tcontext.strokeStyle = 'rgba(255,255,255,0.72)';\n"
        "\t\t\tcontext.strokeRect(boxX, boxY, boxWidth, boxHeight);\n"
        "\t\t\tcontext.fillStyle = '#f8fafc';\n"
        "\t\t\tcontext.textAlign = 'left';\n"
        "\t\t\tcontext.textBaseline = 'top';\n"
        "\t\t\tcontext.fillText(frequencyText, boxX + 7, boxY + 5);\n"
        "\t\t\tcontext.fillText(powerText, boxX + 7, boxY + 19);\n"
        "\t\t\tcontext.fillStyle = '#aebbd0';\n"
        "\t\t\tcontext.fillText(rowText, boxX + 7, boxY + 33);\n"
        "\t\t\tcontext.restore();\n"
        "\t\t}\n"
        "\t\tcontext.strokeStyle = 'rgba(160, 180, 205, 0.45)';\n"
        "\t\tcontext.strokeRect(left, top, plotWidth, plotHeight);\n",
        "waterfall crosshair and sample tooltip",
    )
    _replace_once(
        sweep,
        "\t\t\t\truntime.waterfallRenderer.draw(canvas, runtime.waterfallHistory, runtime.frame, {\n"
        "\t\t\t\t\tviewportStartHz: this.sweep.viewportStartHz,\n"
        "\t\t\t\t\tviewportEndHz: this.sweep.viewportEndHz,\n"
        "\t\t\t\t\tminDb: this.sweep.displayMinDb,\n"
        "\t\t\t\t\tmaxDb: this.sweep.displayMaxDb,\n"
        "\t\t\t\t\tselectedCandidate: this.sweep.selectedCandidate,\n"
        "\t\t\t\t});",
        "\t\t\t\truntime.waterfallRenderer.draw(canvas, runtime.waterfallHistory, runtime.frame, {\n"
        "\t\t\t\t\tviewportStartHz: this.sweep.viewportStartHz,\n"
        "\t\t\t\t\tviewportEndHz: this.sweep.viewportEndHz,\n"
        "\t\t\t\t\tminDb: this.sweep.displayMinDb,\n"
        "\t\t\t\t\tmaxDb: this.sweep.displayMaxDb,\n"
        "\t\t\t\t\tselectedCandidate: this.sweep.selectedCandidate,\n"
        "\t\t\t\t\thoverFrequencyHz: this.sweep.hoverFrequencyHz,\n"
        "\t\t\t\t\thoverY: this.sweep.hoverWaterfallY,\n"
        "\t\t\t\t\thoverPowerDb: this.sweep.hoverPowerDb,\n"
        "\t\t\t\t\thoverRow: this.sweep.hoverWaterfallRow,\n"
        "\t\t\t\t});",
        "pass waterfall cursor data to renderer",
    )

    canvas = source / "src/client/app/canvas.ts"

    _replace_once(
        canvas,
        "\t// Check for remote connection link in URL\n\tconst urlParams = new URLSearchParams(window.location.search);\n\tconst connectId = urlParams.get('connect');\n\tif (connectId) {\n\t\t// Use connectToRemoteId to also add to recents\n\t\tsetTimeout(() => this.connectToRemoteId(connectId), 500);\n\t\t// Show overlay so the user provides a click gesture to unlock AudioContext.\n\t\tthis.audioUnlockPendingId = connectId;\n\t}\n",
        "",
        "remote URL auto-connect",
    )

    _replace_once(
        source / "src/client/app/ui-helpers.ts",
        "fetch('/30-seconds-of-silence.mp3')",
        "fetch('/receiver/30-seconds-of-silence.mp3')",
        "Receiver-scoped MediaSource audio asset path",
    )
    _replace_once(
        source / "src/client/app/ui-helpers.ts",
        "el.src = '/30-seconds-of-silence.mp3';",
        "el.src = '/receiver/30-seconds-of-silence.mp3';",
        "Receiver-scoped fallback audio asset path",
    )

    _replace_once(
        source / "src/client/dsp-worker.ts",
        '"/hackrf-web/pkg/hackrf_web.js"',
        '"/receiver/hackrf-web/pkg/hackrf_web.js"',
        "DSP worker WASM module path",
    )
    _replace_once(
        source / "src/client/worker/wasm-init.ts",
        "'/hackrf-web/pkg/hackrf_web.js'",
        "'/receiver/hackrf-web/pkg/hackrf_web.js'",
        "WASM initializer module path",
    )
    _replace_once(
        source / "src/client/env.d.ts",
        "declare module '/hackrf-web/pkg/hackrf_web.js' {",
        "declare module '/receiver/hackrf-web/pkg/hackrf_web.js' {",
        "WASM module type declaration",
    )
    _replace_once(
        source / "tsconfig.json",
        "\"/hackrf-web/pkg/*\": [\"hackrf-web/pkg/*\"]",
        "\"/receiver/hackrf-web/pkg/*\": [\"hackrf-web/pkg/*\"]",
        "WASM TypeScript path mapping",
    )

    vite = source / "vite.config.ts"
    _replace_once(
        vite,
        "\t\t\tinjectRegister: 'script',\n",
        "\t\t\tinjectRegister: false,\n",
        "no service worker registration",
    )
    _replace_once(
        vite,
        "\t\t\t\truntimeCaching: [\n"
        "\t\t\t\t\t{\n"
        "\t\t\t\t\t\t// API routes: network-first (only works online)\n"
        "\t\t\t\t\t\turlPattern: /^.*\\/api\\/.*/i,\n"
        "\t\t\t\t\t\thandler: 'NetworkFirst',\n"
        "\t\t\t\t\t\toptions: {\n"
        "\t\t\t\t\t\t\tcacheName: 'api-cache',\n"
        "\t\t\t\t\t\t\tnetworkTimeoutSeconds: 5,\n"
        "\t\t\t\t\t\t\texpiration: { maxEntries: 50, maxAgeSeconds: 60 * 60 },\n"
        "\t\t\t\t\t\t},\n"
        "\t\t\t\t\t},\n"
        "\t\t\t\t],\n",
        # Receiver records must come from the live console: a cached /api reply would
        # show deleted or stale records without any error while the console is down.
        "\t\t\t\truntimeCaching: [],\n",
        "service worker API cache",
    )
    _replace_count(
        vite,
        "path.resolve(__dirname, 'dist')",
        "process.env.BROWSDR_OUT_DIR || path.resolve(__dirname, 'dist')",
        2,
        "temporary output-directory",
    )
    _replace_once(
        vite,
        "\t\t\t\tstart_url: '/',\n",
        "\t\t\t\tstart_url: '/receiver/',\n\t\t\t\tscope: '/receiver/',\n",
        "scoped PWA start URL",
    )
    _replace_once(
        vite,
        "{ src: '/icon-192.png'",
        "{ src: '/receiver/icon-192.png'",
        "scoped 192px PWA icon",
    )
    _replace_once(
        vite,
        "{ src: '/icon-512.png'",
        "{ src: '/receiver/icon-512.png'",
        "scoped 512px PWA icon",
    )

    sweep_canvas = source / "src/client/app/sweep-canvas.ts"
    _replace_once(
        sweep_canvas,
        "\tcontext.setTransform(scale, 0, 0, scale, 0, 0);\n",
        "\tcontext.setTransform(scale, 0, 0, scale, 0, 0);\n"
        "\tconst lightTheme = document.documentElement.dataset.theme === 'light';\n",
        "select sweep canvas colors from the embedded theme",
    )
    for dark_color, light_color in (
        ("context.fillStyle = '#080b11';", "context.fillStyle = lightTheme ? '#fafbf9' : '#080b11';"),
        (
            "context.strokeStyle = 'rgba(170, 190, 215, 0.18)';",
            "context.strokeStyle = lightTheme ? 'rgba(71, 86, 76, 0.18)' : 'rgba(170, 190, 215, 0.18)';",
        ),
        ("context.fillStyle = '#8994a4';", "context.fillStyle = lightTheme ? '#47564c' : '#8994a4';"),
        ("context.fillStyle = '#aab4c2';", "context.fillStyle = lightTheme ? '#47564c' : '#aab4c2';"),
        ("context.fillStyle = '#8ea0b8';", "context.fillStyle = lightTheme ? '#58685d' : '#8ea0b8';"),
        (
            "context.strokeStyle = 'rgba(255,255,255,0.62)';",
            "context.strokeStyle = lightTheme ? 'rgba(32, 40, 36, 0.45)' : 'rgba(255,255,255,0.62)';",
        ),
        (
            "context.strokeStyle = 'rgba(160, 180, 205, 0.45)';",
            "context.strokeStyle = lightTheme ? 'rgba(71, 86, 76, 0.45)' : 'rgba(160, 180, 205, 0.45)';",
        ),
        (
            "context.fillStyle = 'rgba(255, 193, 7, 0.13)';",
            "context.fillStyle = lightTheme ? 'rgba(128, 84, 0, 0.1)' : 'rgba(255, 193, 7, 0.13)';",
        ),
        (
            "context.strokeStyle = 'rgba(255, 193, 7, 0.9)';",
            "context.strokeStyle = lightTheme ? '#805400' : 'rgba(255, 193, 7, 0.9)';",
        ),
        ("context.strokeStyle = '#fff';", "context.strokeStyle = lightTheme ? '#fafbf9' : '#fff';"),
        (
            "context.fillStyle = 'rgba(8,11,17,0.96)';",
            "context.fillStyle = lightTheme ? 'rgba(250,251,249,0.96)' : 'rgba(8,11,17,0.96)';",
        ),
        (
            "context.strokeStyle = 'rgba(255,255,255,0.68)';",
            "context.strokeStyle = lightTheme ? 'rgba(71,86,76,0.5)' : 'rgba(255,255,255,0.68)';",
        ),
        ("context.fillStyle = '#f8fafc';", "context.fillStyle = lightTheme ? '#202824' : '#f8fafc';"),
    ):
        _replace_once(sweep_canvas, dark_color, light_color, "theme sweep canvas colors")

    marker_renderer = source / "src/client/app/sweep-marker-renderer.ts"
    _replace_once(
        marker_renderer,
        "\tcontext.save();\n",
        "\tcontext.save();\n\tconst lightTheme = document.documentElement.dataset.theme === 'light';\n",
        "select marker colors from the embedded theme",
    )
    for dark_color, light_color in (
        ("\t\tcontext.strokeStyle = '#ff75a0';", "\t\tcontext.strokeStyle = lightTheme ? '#a23557' : '#ff75a0';"),
        (
            "\t\tcontext.fillStyle = 'rgba(55, 23, 37, 0.9)';",
            "\t\tcontext.fillStyle = lightTheme ? 'rgba(250, 251, 249, 0.96)' : 'rgba(55, 23, 37, 0.9)';",
        ),
        ("\t\tcontext.fillStyle = '#ffd3e0';", "\t\tcontext.fillStyle = lightTheme ? '#74243f' : '#ffd3e0';"),
    ):
        _replace_once(marker_renderer, dark_color, light_color, "theme sweep marker colors")


    listener_canvas = source / "src/client/app/canvas.ts"
    _replace_once(
        listener_canvas,
        '\t\tctx.fillStyle = "rgba(0, 0, 0, 1)";',
        '\t\tconst lightTheme = document.documentElement.dataset.theme === "light";\n'
        '\t\tctx.fillStyle = lightTheme ? "#fafbf9" : "rgba(0, 0, 0, 1)";',
        "select Listener canvas colors from the embedded theme",
    )
    for dark_color, light_color in (
        (
            'ctx.strokeStyle = "rgba(255, 255, 255, 0.15)";',
            'ctx.strokeStyle = lightTheme ? "rgba(71, 86, 76, 0.18)" : "rgba(255, 255, 255, 0.15)";',
        ),
        (
            'ctx.strokeStyle = "rgba(255, 255, 255, 0.8)";',
            'ctx.strokeStyle = lightTheme ? "#2f6386" : "rgba(255, 255, 255, 0.8)";',
        ),
        (
            'ctx.fillStyle = "rgba(255, 255, 255, 0.2)";',
            'ctx.fillStyle = lightTheme ? "rgba(47, 99, 134, 0.14)" : "rgba(255, 255, 255, 0.2)";',
        ),
    ):
        _replace_once(listener_canvas, dark_color, light_color, "theme Listener canvas colors")

    # The Dengar tab's dB scale (overlay listener-display.ts): the trace and the
    # waterfall draw with the Auto or Manual range instead of display.minDB/maxDB.
    _replace_once(
        listener_canvas,
        "\t\tthis._waterfallEngine.setRange(this.display.minDB, this.display.maxDB);\n",
        "\t\tthis._listenerEngineRange = null;\n"
        "\t\tthis.syncListenerEngineRange(true);\n",
        "Listener waterfall range from the dB scale",
    )
    _replace_once(
        listener_canvas,
        "\t\tconst dbRange = this.display.maxDB - this.display.minDB;\n",
        "\t\tconst displayRange = this.listenerDbRange();\n"
        "\t\tconst dbRange = displayRange.max - displayRange.min;\n",
        "Listener trace range from the dB scale",
    )
    _replace_once(
        listener_canvas,
        "\t\t\tvalDB = Math.max(this.display.minDB, Math.min(this.display.maxDB, valDB));\n",
        "\t\t\tvalDB = Math.max(displayRange.min, Math.min(displayRange.max, valDB));\n",
        "Listener trace clamp from the dB scale",
    )
    _replace_once(
        listener_canvas,
        "\t\t\tconst n = (valDB - this.display.minDB) / dbRange;\n",
        "\t\t\tconst n = (valDB - displayRange.min) / dbRange;\n",
        "Listener trace position from the dB scale",
    )
    # The Receiver's spectrum markers (overlay listener-markers.ts) on the Listener trace, over the
    # VFO highlights; the console's Spektrum dock marks into the same list.
    _replace_once(
        listener_canvas,
        "\t\t\tctx.restore();\n\t\t}\n\t},\n};\n\nexport function mountCanvas(",
        "\t\t\tctx.restore();\n\t\t}\n\n\t\tthis.drawListenerMarkers(ctx, w, h);\n\t},\n};\n\nexport function mountCanvas(",
        "spectrum markers on the Listener trace",
    )

    theme_css = (PROJECT_ROOT / "frontend/src/receiver-embedded-theme.css").read_text(
        encoding="utf-8"
    )
    style.write_text(
        f"{style.read_text(encoding='utf-8')}\n{theme_css}",
        encoding="utf-8",
    )

    boot_script = source / "src/client/receiver-boot.js"
    if not boot_script.is_file():
        raise RuntimeError(f"expected the Receiver boot script at {boot_script}")
    shutil.copy2(boot_script, source / "public/receiver-boot.js")

    peerjs = source / "public/lib/peerjs.min.js"
    if not peerjs.is_file():
        raise RuntimeError(f"expected bundled PeerJS asset at {peerjs}")
    peerjs.unlink()

    _patch_rx_transfer_errors(source)


def _patch_rx_transfer_errors(source: Path) -> None:
    """Report HackRF RX transfer failures instead of only logging them.

    Upstream's RX loop logs a failed bulk transfer and ends that loop, so an
    unplugged radio leaves the Receiver showing RX running while no samples arrive.
    """
    hackrf = source / "src/client/hackrf.ts"
    _replace_once(
        hackrf,
        "\tasync startRx(callback: RxCallback): Promise<void> {\n",
        "\tasync startRx(callback: RxCallback, onError?: (error: unknown) => void): Promise<void> {\n",
        "HackRF RX error callback parameter",
    )
    _replace_once(
        hackrf,
        "\t\t\t\t\t\tconsole.error('startRx: transfer status not ok:', result.status);\n"
        "\t\t\t\t\t\tbreak;\n",
        "\t\t\t\t\t\tconsole.error('startRx: transfer status not ok:', result.status);\n"
        "\t\t\t\t\t\tonError?.(new Error(result.status === 'ok' ? 'USB transfer returned no data' : `USB transfer status ${result.status}`));\n"
        "\t\t\t\t\t\tbreak;\n",
        "HackRF RX transfer status error report",
    )
    _replace_once(
        hackrf,
        "\t\t\t\t\t\tconsole.error('startRx: transfer error:', msg);\n",
        "\t\t\t\t\t\tconsole.error('startRx: transfer error:', msg);\n"
        "\t\t\t\t\t\tonError?.(error);\n",
        "HackRF RX transfer exception report",
    )
    _replace_once(
        source / "src/client/sdr-device.ts",
        "\tstartRx(callback: (data: ArrayBufferView) => void): Promise<void>;\n",
        "\tstartRx(callback: (data: ArrayBufferView) => void, onError?: (error: unknown) => void): Promise<void>;\n",
        "SDR device RX error callback",
    )


def _write_source_instructions(source: Path) -> None:
    instructions = (
        "BrowSDR embedded source for SDR-DoA Ground Console\n"
        f"Pinned upstream fork commit: {BROWSDR_REVISION}\n"
        "License: GNU Affero General Public License version 3 (see LICENSE).\n\n"
        "This is the complete BrowSDR source used by the embedded /receiver/ app, "
        "with Ground Console integration changes applied: WebRTC remote host/client "
        "entry points and URL auto-connect are disabled; the embedded Receiver opens on "
        "Spectrum and keeps the existing receiver UI in Listener. One HackRF already "
        "authorized for the current origin reconnects and starts a supported native or "
        "manual hardware scan when Spectrum is active. First-time permission requires "
        "a user action; zero or multiple authorized HackRFs remain manual. Selecting "
        "Listener stops an active scan without starting RX; selecting Spectrum stops "
        "Listener RX and leaves scanning stopped. Start scan, Play, and candidate Listen "
        "are explicit actions. Candidate listening moves to Listener after RX starts; "
        "the explicit Stop listening and start new scan action restores tuning and starts "
        "a fresh scan that replaces old results. Stop shows RF shutdown and archive "
        "finalization separately and waits for queued candidate/trace writes. Manual "
        "sweeps avoid redundant RX-stop transfers while preserving retry and HackRF USB "
        "recovery. Marker controls sit beside Peak history and support manual MHz entry, "
        "frequency/label edits, deletion, named sets, and marker-only JSON/CSV exports; "
        "unmeasured power stays null. Sweep startup stops RX before scanning, and "
        "acquisition controls unlock when the scan is stopped. Graph range defaults to "
        "-60 dBFS and supports a +60 dBFS ceiling, rescaling Spectrum and Waterfall data "
        "without changing the captured scan, and is saved with the scan settings. The Listener has a dB scale (Auto fits the "
        "visible spectrum, Manual takes a minimum and maximum) for its trace and waterfall, "
        "saved with its settings. The Spectrum workspace uses a high-contrast "
        "blue-to-red trace; both charts show a cursor crosshair, and Waterfall reports "
        "frequency, power, and history row in its hover tooltip. Public media, worker, "
        "asset, and PWA paths are scoped to /receiver/. The embedded page registers no "
        "service worker (sw.js only removes the caching worker of older builds), loads no "
        "remote fonts, takes the console theme and language from its URL before first paint, "
        "and offers the Mock SDR only when opened with ?mock=1. Inside the console's same-origin "
        "frame, a postMessage bridge lets the console dashboard start and stop RX, tune, listen, "
        "set the Listener dB scale, gains and sample rate, and receive a cropped spectrum; it "
        "stamps each tuning change with its source. During a wide scan its tune, VFO and gain "
        "changes only update the stopped Listener's settings, and it never changes the sample "
        "rate; a rate change restarts RX as the Listener select does, and continues an armed "
        "recording only after the console page asked the operator. The bridge also starts and "
        "stops the wide scan through the same queue and connect path as RX (a scan that would "
        "end an armed recording needs the same console confirmation), sets the scan range, "
        "resolution and gains only while no scan runs and the graph range at any time, and "
        "sends the running scan's trace, downsampled with max-hold, to the console. Spectrum "
        "markers are also drawn on the Listener trace in its visible span, and the bridge "
        "mirrors the marker list to the console and adds or removes markers in it (saved to "
        "the selected marker set, at any time, with the power measured from a running scan) "
        "without opening a dialog.\n\n"
        "Build with Node.js 22 or later: run npm ci --ignore-scripts, then npm run build -- --base=/receiver/. "
        "The Ground Console repository also includes tools/build_browsdr_receiver.py, "
        "which applies these integration changes and creates this source archive from the "
        "pinned submodule.\n"
    )
    (source / "GROUND_CONSOLE_BUILD.txt").write_text(instructions, encoding="utf-8")


def _source_filter(member: tarfile.TarInfo) -> tarfile.TarInfo | None:
    if Path(member.name).name in _COPY_IGNORES:
        return None
    return member


def _create_source_archive(source: Path, destination: Path) -> None:
    with tarfile.open(destination, mode="w:gz") as archive:
        archive.add(source, arcname="BrowSDR", filter=_source_filter)
        archive.add(
            Path(__file__),
            arcname="GROUND_CONSOLE_BUILD/build_browsdr_receiver.py",
        )


def _set_receiver_manifest_brand(build_dir: Path) -> None:
    manifest = build_dir / "manifest.webmanifest"
    data = json.loads(manifest.read_text(encoding="utf-8"))
    data["name"] = "Freq. Spectrum"
    data["short_name"] = "Freq. Spectrum"
    data["description"] = "Frequency spectrum receiver."
    manifest.write_text(
        json.dumps(data, separators=(",", ":"), ensure_ascii=False) + "\n",
        encoding="utf-8",
    )


def _retire_service_worker(build_dir: Path) -> None:
    for workbox in build_dir.glob("workbox-*.js"):
        workbox.unlink()
    (build_dir / "sw.js").write_text(RETIRED_SERVICE_WORKER, encoding="utf-8")


def _verify_embedded_build(build_dir: Path) -> None:
    index = build_dir / "index.html"
    manifest = build_dir / "manifest.webmanifest"
    if not index.is_file() or not manifest.is_file():
        raise RuntimeError("BrowSDR build did not emit index.html and manifest.webmanifest")
    html = index.read_text(encoding="utf-8")
    if "/receiver/assets/" not in html:
        raise RuntimeError("BrowSDR build assets are not rooted at /receiver/")
    manifest_data = json.loads(manifest.read_text(encoding="utf-8"))
    if manifest_data.get("start_url") != "/receiver/" or manifest_data.get("scope") != "/receiver/":
        raise RuntimeError("BrowSDR PWA manifest escaped the /receiver/ scope")
    wasm_module = build_dir / "hackrf-web/pkg/hackrf_web.js"
    wasm_binary = build_dir / "hackrf-web/pkg/hackrf_web_bg.wasm"
    if not wasm_module.is_file() or not wasm_binary.is_file():
        raise RuntimeError("BrowSDR build is missing the HackRF WebAssembly runtime")

    bundle_text = "\n".join(
        path.read_text(encoding="utf-8", errors="ignore")
        for path in build_dir.rglob("*.js")
    )
    forbidden = (
        "0.peerjs.com",
        "Share Remote Access",
        "Connect Remote",
        "/api/turn",
        '"/hackrf-web/pkg/hackrf_web.js"',
        "'/30-seconds-of-silence.mp3'",
        '"/30-seconds-of-silence.mp3"',
        "'/icon-96.png'",
        '"/icon-96.png"',
        "'/icon-192.png'",
        '"/icon-192.png"',
        "'/icon-512.png'",
        '"/icon-512.png"',
    )
    remaining = [item for item in forbidden if item in bundle_text]
    if remaining:
        raise RuntimeError(
            "forbidden remote-sharing code or root-scoped asset path remains in the embedded JavaScript bundle: "
            + ", ".join(remaining)
        )
    service_worker = build_dir / "sw.js"
    if not service_worker.is_file() or service_worker.read_text(encoding="utf-8") != RETIRED_SERVICE_WORKER:
        raise RuntimeError("the embedded build must ship the self-removing service worker")
    if "registerSW" in html or "serviceWorker.register" in bundle_text or list(build_dir.glob("workbox-*.js")):
        raise RuntimeError("the embedded Receiver still registers a caching service worker")
    if "fonts.googleapis.com" in html or "fonts.gstatic.com" in html:
        raise RuntimeError("the embedded Receiver page still loads remote fonts")
    if '<script src="/receiver/receiver-boot.js"></script>' not in html or not (build_dir / "receiver-boot.js").is_file():
        raise RuntimeError("the embedded Receiver page is missing its theme boot script")
    if (build_dir / "lib/peerjs.min.js").exists():
        raise RuntimeError("PeerJS was unexpectedly copied into the embedded build")
    if CONSOLE_BRIDGE_CHANNEL not in bundle_text:
        raise RuntimeError("the embedded Receiver bundle is missing the console dashboard bridge")


def _install_built_receiver(build_dir: Path, output: Path) -> None:
    if output.is_symlink():
        raise RuntimeError(f"refusing to replace symlinked Receiver output: {output}")
    output.parent.mkdir(parents=True, exist_ok=True)
    staging_root = Path(tempfile.mkdtemp(prefix=".receiver-build-", dir=output.parent))
    staged = staging_root / "receiver"
    backup = output.parent / f".receiver-backup-{os.getpid()}"
    try:
        shutil.copytree(build_dir, staged)
        if backup.exists():
            raise RuntimeError(f"refusing to replace unexpected build backup: {backup}")
        if output.exists():
            os.replace(output, backup)
        try:
            os.replace(staged, output)
        except Exception:
            if backup.exists() and not output.exists():
                os.replace(backup, output)
            raise
        if backup.exists():
            shutil.rmtree(backup)
    finally:
        shutil.rmtree(staging_root, ignore_errors=True)


def _assert_pinned_source(source: Path) -> None:
    if not (source / ".git").exists():
        raise RuntimeError("BrowSDR source is not a Git checkout; initialize the pinned submodule first")
    result = subprocess.run(
        ["git", "-C", str(source), "rev-parse", "HEAD"],
        capture_output=True,
        check=False,
        text=True,
    )
    if result.returncode != 0:
        raise RuntimeError("could not verify the BrowSDR source revision")
    revision = result.stdout.strip()
    if revision != BROWSDR_REVISION:
        raise RuntimeError(f"BrowSDR source is {revision}, expected pinned commit {BROWSDR_REVISION}")

    status = subprocess.run(
        ["git", "-C", str(source), "status", "--porcelain"],
        capture_output=True,
        check=False,
        text=True,
    )
    if status.returncode != 0:
        raise RuntimeError("could not verify the BrowSDR source worktree")
    if status.stdout.strip():
        raise RuntimeError("BrowSDR submodule has local changes; pin and review them before building")


def _apply_receiver_source_overlay(source: Path, overlay: Path) -> None:
    if overlay.is_symlink() or not overlay.is_dir():
        raise RuntimeError(f"Receiver source overlay not found at {overlay}")

    applied = 0
    for patch_path in sorted(overlay.rglob("*")):
        if patch_path.is_symlink():
            raise RuntimeError(f"Receiver source overlay contains a symlink: {patch_path}")
        if not patch_path.is_file():
            continue
        relative = patch_path.relative_to(overlay)
        if len(relative.parts) < 3 or relative.parts[:2] != ("src", "client"):
            raise RuntimeError(f"Receiver source overlay path is outside src/client: {relative}")
        destination = source / relative
        if destination.is_symlink():
            raise RuntimeError(f"Receiver source overlay would replace a symlink: {destination}")
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(patch_path, destination)
        applied += 1
    if not applied:
        raise RuntimeError("Receiver source overlay contains no client files")


def _npm_command() -> str:
    # On Windows npm is npm.cmd. CreateProcess does not search PATHEXT, so a bare
    # "npm" fails with WinError 2; shutil.which does search it.
    npm = shutil.which("npm")
    if npm is None:
        raise RuntimeError(
            "npm was not found on PATH; install Node.js 22.12 or later (it provides npm, "
            "npm.cmd on Windows) and open a new terminal"
        )
    return npm


def build_receiver(source: Path) -> Path:
    npm = _npm_command()
    source = source.resolve()
    if not source.is_dir():
        raise RuntimeError(f"BrowSDR source not found at {source}; initialize the submodule first")
    required = (source / "package.json", source / "package-lock.json", source / "LICENSE", source / "src/client/index.html")
    if any(not path.is_file() for path in required):
        raise RuntimeError("BrowSDR source is incomplete; initialize vendor/BrowSDR at the pinned revision")
    if BROWSDR_OVERLAY_BASE_REVISION != BROWSDR_REVISION:
        raise RuntimeError("Receiver source overlay does not match the configured BrowSDR pin")
    _assert_pinned_source(source)

    output = PROJECT_ROOT / "frontend/dist/receiver"
    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="ground-console-browsdr-") as temporary:
        temporary_root = Path(temporary)
        work_source = temporary_root / "source"
        shutil.copytree(source, work_source, ignore=_copy_ignore)
        _apply_receiver_source_overlay(work_source, PROJECT_ROOT / "tools/browsdr_receiver_overlay")
        _apply_embedded_changes(work_source)
        _write_source_instructions(work_source)

        source_archive = temporary_root / SOURCE_ARCHIVE_NAME
        _create_source_archive(work_source, source_archive)

        build_dir = temporary_root / "build"
        environment = os.environ.copy()
        environment["BROWSDR_OUT_DIR"] = str(build_dir)
        subprocess.run([npm, "ci", "--ignore-scripts", "--no-audit", "--no-fund"], cwd=work_source, check=True)
        subprocess.run(
            [npm, "run", "build", "--", "--base=/receiver/", f"--outDir={build_dir}"],
            cwd=work_source,
            env=environment,
            check=True,
        )
        _set_receiver_manifest_brand(build_dir)
        _retire_service_worker(build_dir)
        _verify_embedded_build(build_dir)
        shutil.copy2(source_archive, build_dir / SOURCE_ARCHIVE_NAME)
        _install_built_receiver(build_dir, output)
    return output


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--source",
        type=Path,
        default=PROJECT_ROOT / "vendor/BrowSDR",
        help="pinned BrowSDR checkout (default: vendor/BrowSDR)",
    )
    args = parser.parse_args()
    try:
        output = build_receiver(args.source)
    except (OSError, RuntimeError, subprocess.CalledProcessError) as exc:
        print(f"BrowSDR build failed: {exc}", file=sys.stderr)
        return 1
    print(f"Embedded BrowSDR build ready at {output}", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
