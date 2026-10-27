# Optional automatic Google sign-in for unattended installs

An install that nobody sits at (a container, a server, an always-on machine) can't have a person click through Google every 7 days, and an agent can't click either. So the login window can sign in to Google by itself. It is off unless `ITFIN_GOOGLE_EMAIL` is set. This partly supersedes [0002](0002-token-only-from-human-login.md), which rejected automating the Google sign-in.

While the login window waits for the `itfin-jwt` cookie, `src/googleSignIn.ts` drives the same browser over the DevTools protocol. It clicks the Google button on the workspace login page, picks the account in Google's chooser, and types the login and password only if Google asks for them. It lives in the package, next to the code that opens the window, so it works the same in a container, in MCP mode and in CLI mode, on macOS and Linux. It finds the browser by the debugging port the login code just opened, not by scanning processes.

What stays the same: the ITFin token still comes only from a real Google login, the window still opens only when `itfin_login` or `itfin login` is called, and nothing runs during an unattended call unless someone asked for a login.

## Considered Options

- A separate script that finds the browser by scanning `/proc` (used for the first test): rejected. It is Linux-only, runs as a second process, and each deployment has to start it.
- Storing the password in the config file or the keychain: rejected. The password comes only from `ITFIN_GOOGLE_PASSWORD` in the environment of whoever runs the tool, so it is never written by this tool.
- Reading a 2-step verification code: rejected. The code cannot come from the environment. Google then keeps waiting on that page for a person.

## Consequences

- A Google password grants far more than ITFin access. Set `ITFIN_GOOGLE_PASSWORD` only where the environment is private, and prefer a signed-in browser profile with only `ITFIN_GOOGLE_EMAIL` set: the account chooser needs no password.
- Google may block or change its pages. Then the steps do nothing and the window waits for a person, as before. The selectors are in `googleSignIn.ts`.
- With 2-step verification or a security challenge, a person must finish the sign-in in the window.
