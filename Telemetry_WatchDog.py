"""
Telemetry_WatchDog.py
Telemetry Watchdog - Trend Detectives: Ethical Hackers in Space

Opens the Telemetry Watchdog page in the default web browser.

The page holds no data. It reads the NASA Giovanni CSV files from the
same folder and calculates everything in the browser (JavaScript).
A browser does not let a page opened as a local file read other files,
so this script serves the folder on this computer only and opens the
page from there. This script does not calculate anything.

Usage:
    python Telemetry_WatchDog.py
    python Telemetry_WatchDog.py 8123        (use another port)

Stop it with Ctrl+C.

Requirements:
    Python 3.8+
    No external packages required.

Security:
    - The server listens on 127.0.0.1 only, other computers cannot reach it.
    - It serves only the folder this script is in, read-only.
    - No shell commands are executed.
"""

import functools
import http.server
import socketserver
import sys
import webbrowser
from pathlib import Path

SCRIPT_NAME = "Telemetry_WatchDog.py"
PAGE = "index.html"
HOST = "127.0.0.1"
DEFAULT_PORT = 8000
PORTS_TO_TRY = 20
LIVE_REPORT_URL = "https://nicochiro.github.io/telemetry-watchdog/"


class QuietHandler(http.server.SimpleHTTPRequestHandler):
    """Serve files without printing a line for every request."""

    def log_message(self, format, *args):  # noqa: A002 (name set by the base class)
        pass


def port_from_arguments():
    """Return the port given on the command line, the default, or None if it is not valid."""
    if len(sys.argv) == 1:
        return DEFAULT_PORT
    try:
        port = int(sys.argv[1])
    except ValueError:
        return None
    return port if 1024 <= port <= 65535 else None


def start_server(folder, first_port):
    """Start a read-only server for the folder on the first free port."""
    handler = functools.partial(QuietHandler, directory=str(folder))
    socketserver.TCPServer.allow_reuse_address = True
    for port in range(first_port, min(first_port + PORTS_TO_TRY, 65536)):
        try:
            return socketserver.TCPServer((HOST, port), handler), port
        except OSError:
            continue
    return None, None


def main():
    if len(sys.argv) > 2:
        print(f"Usage: python {SCRIPT_NAME} [port]", file=sys.stderr)
        return 2

    first_port = port_from_arguments()
    if first_port is None:
        print("Error: the port must be a number from 1024 to 65535.", file=sys.stderr)
        return 2

    # The page and the CSV files sit next to this script.
    folder = Path(__file__).resolve().parent
    if not (folder / PAGE).is_file():
        print(
            f"Error: {PAGE} not found in {folder}\n"
            f"Keep this script in the same folder as {PAGE}.\n"
            f"You can also view the report online: {LIVE_REPORT_URL}",
            file=sys.stderr,
        )
        return 1
    if not (folder / "files.json").is_file():
        print(
            f"Warning: {folder / 'files.json'} is missing, the page will have no data to read.",
            file=sys.stderr,
        )

    server, port = start_server(folder, first_port)
    if server is None:
        print(
            f"Error: no free port from {first_port} to {first_port + PORTS_TO_TRY - 1}.\n"
            f"Try another one: python {SCRIPT_NAME} 8123",
            file=sys.stderr,
        )
        return 1

    url = f"http://{HOST}:{port}/{PAGE}"
    print(f"Serving {folder}")
    print(f"Opening {url}")
    print("Leave this window open while you use the page. Stop with Ctrl+C.")

    try:
        if not webbrowser.open(url, new=2):
            print(f"Could not open a browser. Open this address yourself: {url}")
    except webbrowser.Error:
        print(f"Could not open a browser. Open this address yourself: {url}")

    try:
        with server:
            server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
