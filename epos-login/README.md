# The Open Lane

A login page for an EPOS company, built as a working till. The design concept
is in [EPOS-login.md](EPOS-login.md); this is how to run what exists so far.

## Run it

```bash
docker compose up -d
```

Then open <http://localhost:8089>. Stop with `docker compose down`.

Two containers: nginx serves the static client and proxies `/api` to a
dependency-free Node auth service. If the API is unreachable the client falls
back to an in-browser stand-in with the same timing, attempt counting and
lockout, so the whole sequence can always be seen — the terminal header says
`Offline` when that happens.

### Credentials

| Email | Password | Role |
| --- | --- | --- |
| `dan@counterpoint.co` | `openlane` | Manager |
| `operator@counterpoint.co` | `till04` | Operator |
| `demo@counterpoint.co` | `demo1234` | Trainee |

Anything else is declined. **Five failures locks the till for 30 seconds** —
worth seeing, and the lock is held server-side, so reloading does not escape it.

## What to try

- **Watch it before touching anything.** Goods travel the belt, get scanned,
  and total up on the till. It is never idle.
- **Click into a field.** The sale suspends: a `HELD` chip appears, the list
  greys back, and goods queue up short of the scanner instead of crossing it.
- **Type an address.** A staff badge assembles below the fields, printing your
  address and drawing a barcode.
- **Type a password.** The chip wakes, the card reader lights and reads
  `READY`, the lane light goes amber and `F1` picks up the accent.
- **Submit.** The badge lifts out of its holder, flies to the scanner and gets
  read, then slots into the card reader. The terminal takes over with a strip
  of receipt paper feeding across as the progress indicator - no spinner
  anywhere. The belt stops and the lane light turns amber while the server
  decides. Then green, or red.
- **On approval**, the drawer bangs, warm light rakes up across the counter,
  and the sign-in pane is pulled away like a receipt to reveal the till that
  was already underneath. The sale that was running by itself is now yours.
- **Sign out** from the header to run the whole thing again.
- **F1** recalls the password from anywhere on the page.

## Development

Everything is bind-mounted and served with `no-store`, so edits are live on
reload. No build step, no dependencies, vanilla ES modules.

| URL | |
| --- | --- |
| `?debug` | State switcher panel; number keys `1`–`7` also work |
| `?state=authorising` | Jump straight to a stage state |

`window.stage` and `window.lane` are exposed for tuning from the console.

## Build progress

| Step | | |
| --- | --- | --- |
| 1 | The set | done |
| 2 | POS screen UI | done |
| 3 | The lane — **Phase 0 complete** | done |
| 4 | Stage state machine | done |
| 5 | Input choreography — **Phase 1 complete** | done |
| 6 | Auth service | done |
| 7 | Authorising — **Phase 2 complete** | done |
| 8 | Approved — **Phase 3a complete** | done |
| 9 | Declined — **Phase 3b complete**, plus the sign-on receipt | done |
| 10 | Supervisor lockout — **Phase 3c complete** | done |
| 11 | Sound | next |
| 12 | Polish, responsive, contrast audit | |
