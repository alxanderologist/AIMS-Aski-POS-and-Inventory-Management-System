@echo off
REM Opens the POS screen fullscreen with no address bar, tabs, or window chrome, so a cashier can't
REM accidentally navigate away from it or close it. Uses Microsoft Edge, which ships with every
REM Windows 10 install -- no extra browser needed.
REM
REM Setup (once, on the cashier PC):
REM   1. Edit POS_URL below to the real store server's LAN address (see deployment.md's Phase 1 --
REM      the server's fixed LAN IP/hostname is still a placeholder as of this writing).
REM   2. Press Win+R, type shell:startup, press Enter -- this opens the current user's Startup
REM      folder. Copy this .bat file (or a shortcut to it) in there. Windows then runs it
REM      automatically every time this account logs in.
REM
REM To get out of kiosk mode for maintenance: Alt+F4 closes the browser window; if it's
REM unresponsive, Ctrl+Shift+Esc opens Task Manager to end the msedge.exe process.

set POS_URL=http://REPLACE-WITH-SERVER-LAN-ADDRESS:5000/pos

start "" msedge --kiosk "%POS_URL%" --edge-kiosk-type=fullscreen --no-first-run
