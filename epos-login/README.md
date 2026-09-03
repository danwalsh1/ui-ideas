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
- **Submit.** The whole counter goes amber and the belt stops while the server
  decides. Then green, or red.
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
| 7 | Authorising — Phase 2 | next |
| 8 | Approved — Phase 3a | |
| 9 | Declined — Phase 3b | |
| 10 | Supervisor lockout — Phase 3c | |
| 11 | Sound | |
| 12 | Polish, responsive, contrast audit | |
