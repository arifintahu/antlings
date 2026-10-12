# Design notes

`mockup.html` is a single file with fake data. Serve it with `python -m http.server` from this folder.

## Decisions so far

- Characters are ants. The lead is a crowned ant. Each subagent is a worker ant with its own vest color.
- Sprites are drawn in code on a 32x28 canvas and scaled by whole numbers with `image-rendering: pixelated`.
- Six states drive the animation: idle, thinking, running a tool, needs approval, done, error. Each state also has a text label.
- Animation runs at 8 frames per second, stops when the tab is hidden, and shows a still frame when `prefers-reduced-motion` is set.
- Font: VT323. Interface text stays at 17px or larger.
- Dark and light themes follow the system setting.
- Phone layout: sessions in a drawer, the focused ant on top, the conversation below. The "Agents" button shows the whole team.

## Screens in the mockup

- Login: passkey button, password then six-digit code, wrong-input messages with tries left, 15-minute lockout with a countdown. A guard ant at the desk shows the state (waiting, checking, wrong, welcome). Demo values: any password with 8 or more characters, code `123456`. Add `?app` to the address to skip the login while reviewing the rest.
- Re-check dialog (passkey or code) before Bypass mode, a session in the home folder, and deleting a session. Follows [0002-authentication-and-trust-boundary](../docs/adr/0002-authentication-and-trust-boundary.md).
- "Sign out" in the sidebar footer returns to the login screen.
- Security page (sidebar footer, "Security"): passkeys with add and remove, the fallback status with the server reset command, signed-in devices with per-device sign-out and "Sign out everywhere", recent activity with a warnings filter, idle timeout, sign-in alerts. Removing the last sign-in method is blocked. Adding or removing a passkey and "Sign out everywhere" use the re-check dialog.
- First-run setup (add `?first` to the address, or "Demo", then "Preview first-run"): step 1 setup code printed by `antlings setup` on the server (demo code `ANT-7K2Q-9XMD`), step 2 create the first passkey and name the device, step 3 optional fallback (password of 12 or more characters, authenticator code), then "Your colony is ready". A crowned ant moves in. The skip link leaves passkey-only.
- Session list with Active and Archived tabs, plan usage at the bottom.
- Conversation with a subagent row per delegated task.
- Subagent view with activity log, final report, approval card and a follow-up box.
- New session dialog with folder picker, model, effort and mode.
- Session settings and the context window panel.

## Not yet designed

- Change password and replace authenticator (the security page shows the status only).
- Empty and error views for the session list when the server is unreachable.
- Install prompt and notification settings for the phone.
- Per-subagent Stop button (the SDK has `stopTask`, see [SDK notes](../docs/sdk-notes.md)).
