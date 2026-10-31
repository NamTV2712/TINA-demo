"""Small standard-library terminal menu; every operation calls the same CLI dispatcher."""
import curses
import sys
from tina_style import curses_theme, paint

MENU = [
    ("Service status", ["status"]),
    ("System check", ["doctor"]),
    ("Full system check", ["doctor", "--full"]),
    ("Repository checks", ["check"]),
    ("ASR settings", ["asr"]),
    ("Set up a new installation", ["setup"]),
    ("Deployment plan", ["plan"]),
    ("View logs", ["logs"]),
    ("Open TINA Terminal", ["open", "terminal"]),
    ("Start existing images", ["up"]),
    ("Restart services", ["restart"]),
    ("Build images", ["build"]),
    ("Deploy latest code", ["deploy"]),
    ("Stop stack", ["down"]),
]


def move(index, key, count):
    if key in (curses.KEY_UP, ord("k")):
        return (index - 1) % count
    if key in (curses.KEY_DOWN, ord("j")):
        return (index + 1) % count
    return index


HINTS = {
    "setup": "New configuration and volumes; keep existing installations unchanged.",
    "status": "Inspect services, ports and the active deployment.",
    "doctor": "Check images, configuration and service readiness.",
    "check": "Run repository checks without deploying. Save private logs.",
    "asr": "Inspect or configure ASR scope; credentials stay hidden.",
    "plan": "Preview the deployment configuration. No changes are made.",
    "logs": "Read recent logs from the stack or a selected service.",
    "open": "Open the enabled interface in your default browser.",
    "up": "Start existing images. No build. Data volumes are retained.",
    "restart": "Restart existing containers. Images and data are retained.",
    "build": "Build images without restarting running containers.",
    "deploy": "Build and update the stack. Brief downtime is possible.",
    "down": "Stop the stack and remove containers. Keep data volumes.",
}


def draw(screen, options, heading, details):
    curses.curs_set(0)
    screen.keypad(True)
    theme, restore = curses_theme(curses)
    selected = 0
    try:
        screen.bkgd(" ", theme["text"])
        while True:
            screen.erase()
            height, width = screen.getmaxyx()
            left = 3 if width >= 60 else 1
            def line(y, value, role="text", fill=False):
                if 0 <= y < height - 1 and width > left + 1:
                    available = width - left * 2
                    value = value[:available]
                    screen.addnstr(y, left, value.ljust(available) if fill else value,
                                   available, theme[role])
            line(1, heading, "brand")
            line(2, "LOCAL OPERATIONS", "muted")
            if height < 16 or width < 48:
                line(4, "Window too small. Resize, or press q to exit.", "muted")
            else:
                line(4, details, "brand")
                line(5, "─" * (width - left * 2), "line")
                available = height - 12
                first = max(0, selected - available + 1)
                for offset, (label, _) in enumerate(options[first:first + available]):
                    active = first + offset == selected
                    line(7 + offset, ("  ›  " if active else "     ") + label,
                         "selected" if active else "text", fill=active)
                action = options[selected][1]
                hint = ("Inspect host Desktop, configured ASR and worker health; no inference."
                        if action == ["doctor", "--full"] else HINTS.get(action[0], ""))
                line(height - 4, hint, "muted")
                line(height - 3, "─" * (width - left * 2), "line")
                footer = ("↑↓ / j k  Navigate    Enter  Select    r  Refresh    Esc/q  Exit" if width >= 80
                          else "↑↓ Move  Enter Select  r Refresh  Esc/q Exit")
                line(height - 2, footer, "muted")
            screen.refresh()
            key = screen.getch()
            if key in (27, ord("q")):
                return None
            if key == ord("r"):
                return ["refresh"]
            if key in (10, 13, curses.KEY_ENTER) and height >= 16 and width >= 48:
                return options[selected][1]
            selected = move(selected, key, len(options))
    finally:
        restore()


def run_tui(dispatch, read_status):
    import termios
    fd = sys.stdin.fileno() if sys.stdin.isatty() else None
    original = termios.tcgetattr(fd) if fd is not None else None
    try:
        return menu_loop(dispatch, read_status)
    finally:
        if original is not None:
            termios.tcsetattr(fd, termios.TCSADRAIN, original)


def menu_loop(dispatch, read_status):
    while True:
        try:
            data = read_status()
            heading = f"TINA · {data['docker_context']} · {data['project']}"
            healthy = sum(row["health"] == "healthy" for row in data["services"])
            details = f"{healthy} healthy · Host ASR / Capture not checked"
        except Exception:
            data = {"services": []}
            heading, details = "TINA", "Docker is unavailable. Choose System check for details."
        try:
            command = curses.wrapper(draw, MENU, heading, details)
            if command is None:
                return 0
            if command == ["refresh"]:
                continue
            if command[0] == "asr":
                options = [("Global and Desktop status", ["asr", "status"]),
                           ("Verify global and Desktop", ["asr", "verify"]),
                           ("Current account status", ["asr", "status", "--scope", "account"]),
                           ("Verify current account", ["asr", "verify", "--scope", "account"]),
                           ("Configure ASR settings", ["asr", "configure"])]
                command = curses.wrapper(draw, options, heading, "ASR settings · Esc to go back")
                if command is None or command == ["refresh"]:
                    continue
            if command[0] == "check":
                from tina_checks import CHECKS
                options = [("All repository checks", ["check", "all"])]
                options += [(name.title(), ["check", name]) for name in CHECKS]
                command = curses.wrapper(draw, options, heading, "Select a check · Esc to go back")
                if command is None or command == ["refresh"]:
                    continue
            if command[0] in {"restart", "logs"}:
                options = [("Entire stack", command)]
                options += [(row["service"], command + [row["service"]])
                            for row in data["services"] if row["service"] != "storage-init"]
                command = curses.wrapper(draw, options, heading, "Select a service · Esc to go back")
                if command is None or command == ["refresh"]:
                    continue
        except KeyboardInterrupt:
            return 130
        print("\n" + paint(heading, bold=True))
        dispatch([*command, "--format", "table"])
        try:
            input("\nPress Enter to return to the menu… ")
        except (EOFError, KeyboardInterrupt):
            return 0
