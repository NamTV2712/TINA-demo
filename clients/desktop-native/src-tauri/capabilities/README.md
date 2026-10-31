# Tauri capabilities

ACL grants for the windows the shell creates (`main`, `overlay`, `subtitles`): core defaults, window
dragging so the overlay can be moved, and clipboard text writing. An IPC call from the webview only
works if its permission is granted here, so a new command needs a matching entry.
