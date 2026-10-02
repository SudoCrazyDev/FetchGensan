# FetchGensan

24/7 habal-habal rides, errands and deliveries in General Santos City.

Logo, colours, type and voice: see [`brand/`](brand/README.md).

Three apps, one codebase, one database:

| App | Target | Who uses it |
|---|---|---|
| `apps/rider` | iOS · Android · web | Customers booking rides, errands and deliveries |
| `apps/driver` | Android (iOS builds, but is not the priority) | Habal-habal riders taking jobs |
| `apps/admin` | Web | Dispatchers: live board, driver roster, wallets |

## Getting it running

You need Node 20+, [pnpm](https://pnpm.io), the [Supabase CLI](https://supabase.com/docs/guides/cli), and Docker running.

```bash
pnpm install
```

Start the database. This applies every migration in `supabase/migrations` and then runs `supabase/seed.sql`:

```bash
npx supabase start && npx supabase db reset
```

`supabase start` prints an API URL, an anon key and a service-role key. Copy them into the three env files:

```bash
cp apps/rider/.env.example apps/rider/.env
cp apps/driver/.env.example apps/driver/.env
cp apps/admin/.env.example apps/admin/.env.local
```

Create the test accounts (auth users need the Admin API, so this cannot live in `seed.sql`):

```bash
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key pnpm --filter @fetch/api seed:users
```

That gives you:

| Number | Email | Role | Notes |
|---|---|---|---|
| `0917 000 0001` | | customer | Maria Santos |
| `0917 000 0002` | | driver | Approved, already owes a little commission |
| `0917 000 0003` | | driver | Pending — use this to test the approval gate |
| `0917 000 0004` | `ops@fetchgensan.test` | Dispatcher | Signs in to the console |
| `0917 000 0005` | `admin@fetchgensan.test` | Admin | Manages users and roles |
| `0917 000 0006` | | — | Not seeded: walk a brand-new customer signup |
| `0917 000 0007` | | — | Not seeded: walk a brand-new rider signup |

Every account's password is `fetchgensan-dev`. Password-reset codes texted to
these numbers are always `123456` on the local stack; reset emails land in
Mailpit at http://127.0.0.1:54324.

Sign-in and password reset go through the `auth` edge function, and account
management through `admin-users`, so serve them alongside the apps:

```bash
npx supabase functions serve
```

Then run whichever app you need:

```bash
pnpm rider    # Expo dev server
pnpm driver   # Expo dev server
pnpm admin    # http://localhost:3000
```

## How it fits together

```
apps/rider ─┐
apps/driver ─┼─→ packages/api ─→ Supabase (Postgres + PostGIS + Realtime + Auth + Storage)
apps/admin ─┘        │
                     └─→ packages/core   fare maths, job state machine, money, geo, phone
                     └─→ packages/ui     shared React Native primitives (mobile only)
```

`packages/core` holds every rule that must behave identically on a phone and
on the server: the fare formula, the job state machine, peso arithmetic,
PH phone normalisation. It has no React and no Supabase dependency, and it is
the only package with real unit tests.

`packages/api` is the entire server surface the apps may touch, plus the
react-query hooks over it.

### The parts worth understanding before changing anything

**Sign-in is password-based, and goes through our own edge function.**
`supabase/functions/auth` takes a mobile number (any common format) or an
email plus a password, and hands back a normal Supabase session, which the
apps install with `setSession()`. From there supabase-js refreshes it and
RLS sees the user as usual. The function exists for the rules Supabase Auth
cannot express:

- Five wrong passwords per account in 15 minutes, then a wait.
- A per-IP ceiling set high on purpose, because Philippine carriers put
  thousands of phones behind one CGNAT address.
- Deactivated accounts are refused even with the right password.
- "Forgot password" never reveals whether an account exists.

Attempts are counted in `auth_attempts`, keyed by SHA-256 hashes, and only
the service role can touch that table.

Password reset is a 6-digit code rather than a link, by SMS or email, so it
works without deep links. A successful reset signs out every other device.
Accounts from the OTP era have no password yet; the sign-in screen tells
them to use Forgot password, which doubles as "set a password".

There is no sign-up screen yet, so public sign-up is off in `config.toml`.
Staff create accounts in the console.

**Staff access is role-based.** `permissions` is a fixed catalogue with one
row per thing the database actually checks. `roles` bundle permissions and
admins create them; `user_roles` says who holds what. `has_permission()` is
the single check, and `is_staff()` is now "holds `console.access`", so every
policy written before RBAC kept working unchanged. Three rules are enforced
in SQL, not in the console:

- Nobody can grant a permission they do not hold themselves.
- Nobody can edit or deactivate someone with more access than they have.
- There is always at least one active admin.

The built-in Admin role always has every permission, including ones added
later. `profiles.role` still exists, but it is derived from the roles
someone holds by trigger, so do not write it directly.

Creating a login, changing a phone, email or password, deactivating and
deleting all need the Auth Admin API. Those go through
`supabase/functions/admin-users`, which holds the service-role key but asks
the database, as the caller, whether each action is allowed before doing
anything. Everything else is plain RPCs from the browser, so the console
still never holds a service-role key.

If you add a permission, insert it into `permissions` in a migration,
enforce it with `has_permission('your.key')` somewhere, and add the key to
`PermissionKey` in `packages/api/src/types.ts`.

**Money is integer centavos, everywhere.** Database columns are `int`/`bigint`
centavos; `packages/core/src/money.ts` is the only sanctioned way to convert.
Floating-point pesos produce a fare of ₱38.500000000000004, which becomes a
driver arguing with a customer over a coin.

**Clients cannot write job state.** RLS grants `authenticated` SELECT and a
short list of column-level UPDATEs, nothing more. Booking is `create_job()`,
state changes are `advance_job()` / `complete_job()` / `cancel_job()`, and all
of them are `SECURITY DEFINER`. If you find yourself wanting a raw `.update()`
on `jobs`, add an RPC instead.

**Function privileges are an allowlist, and revoking from `anon` is not
enough.** PostgreSQL grants `EXECUTE` on every new function to `PUBLIC`, and
`anon` inherits `PUBLIC` -- so `REVOKE ... FROM anon, authenticated` does
nothing at all. This shipped as a real hole: `adjust_wallet()`, which is
`SECURITY DEFINER` and writes the money ledger, was callable by anyone
holding the publishable key. `…0908000100` revokes from `PUBLIC`, changes the
schema default so new functions do not reintroduce it, and grants back only
what a client actually calls. `02_privilege_test.sql` asserts the privilege
graph so it cannot regress.

If you add a function, it is owner-only until you name it in that grant list.
That is the intended direction of failure.

One correction to that migration: its `alter default privileges in schema
public revoke ... from public` did nothing. PostgreSQL cannot revoke
per-schema a default that is granted globally, so new functions were still
PUBLIC-callable. `…0930000050` revokes the global default, and Supabase's
per-schema grants to anon and authenticated. No function was created in
between, so nothing was exposed. `02_privilege_test.sql` now creates a
scratch function and checks what it actually received.

**The fare the client shows is not the fare that gets charged.** The booking
screen computes an estimate locally so the number updates as the pin moves;
`create_job()` recomputes it server-side and writes that. A tampered client
cannot book a ₱1 airport run.

**Dispatch is broadcast-and-first-accept-wins.** `dispatch_job()` offers the
job to the nearest eligible drivers; `claim_job()` does the assignment with
`WHERE status = 'searching' AND driver_id IS NULL`. Two drivers tapping Accept
in the same millisecond both run it, exactly one wins, and the loser gets a
clean "already taken". No scoring engine — with a fleet of tens it would be
harder to debug and no better.

**Commission is charged on the service, never on the goods.** A ₱2,000 grocery
run earns a cut of the ₱80 errand fee, not ₱400 of someone's groceries.
Enforced by `commission_base_centavos()` and asserted in `fare.test.ts`.

**The driver wallet goes negative, and that is normal.** On cash bookings the
driver collects the whole fare including our commission, so they owe us. They
top up to clear it, and `set_online()` refuses them past their credit floor.
This ships in v1 even though payments are cash-only, because retrofitting it
later means migrating live money.

**Maps are OpenStreetMap, through MapLibre, with no API key.** The rider
app uses `@maplibre/maplibre-react-native` on phones and `maplibre-gl` on
the web; the console uses `maplibre-gl`. Tiles and styles come from
OpenFreeMap (`MAP_STYLE` in `packages/core/src/geo.ts`), which is free with
no usage cap. Do not point it at tile.openstreetmap.org: the OSM
Foundation's tile policy forbids apps from using it as their map server.
On the web, maplibre-gl's worker is served from each app's `public/maplibre/`
folder, which `pnpm install` fills (`scripts/copy-maplibre-worker.mjs`).
Without it the map stays blank with "Worker failed to load". The native map
needs a development or release build, not Expo Go.

**Addressing is landmark-first.** There is no street-address search anywhere in
the rider app, on purpose — Gensan addressing is landmark-based and a geocoder
mostly returns nothing useful for it. Customers pick from saved places and the
`landmark_suggestions` table, or drop a pin, and always add a free-text
landmark note. That note is what the driver actually reads on arrival.

## The dispatch console

`pnpm admin`, sign in with a dispatcher or admin number. Pages:

| Page | What it is for |
|---|---|
| Dispatch board | Live bookings; re-broadcast, widen, **assign a rider by hand**, cancel |
| Bookings | Every booking, searchable by reference, name, phone or plate; per-booking timeline, receipt photos, and an override to move a job on when a rider's phone dies |
| Riders | Approve / reject / suspend, review document photos, cash top-ups, ledger; admins also post adjustments and set credit limits |
| Customers | Search, block with a dated note, change roles (admin) |
| Landmarks | Add, move and hide landmarks -- paste a Google Maps pin or link |
| Fares | Per-service pricing with a live price preview; admin-only to change, history kept |
| Reports | Daily trips, gross, commission, and bookings nobody took |

Every staff action is a `SECURITY DEFINER` RPC that checks a permission
itself with `require_permission()`. Which page needs what: the board,
bookings, customers, landmarks and reports need `console.access`; approving
riders `drivers.manage`; top-ups `wallet.topup`; adjustments and credit
limits `wallet.adjust`; fares `pricing.manage`; Users and Roles their own
permissions. The built-in Admin role holds all of them.

## Checks

```bash
pnpm test        # packages/core -- fare maths, state machine, money, geo, phone
pnpm typecheck   # every package and app
pnpm test:e2e    # every flow over the real API as real users (local stack)
```

`pnpm test:e2e` signs in as each seeded account and drives the whole
business through `createApi` -- rider signup and document review, a ride, an
errand with a rejected-then-approved receipt, an out-of-stock errand,
manual assignment, blocking, pricing, landmarks, saved places, roles. Unlike
the SQL suite it goes through RLS, which is how it found that the function
lockdown had broken the customer's "your rider" card, the Riders page,
landmark search with a location, and the server fare quote. It needs the
local stack up and seeded, and refuses to run anywhere else.

Two more scripts for poking at the apps by hand:

```bash
pnpm --filter @fetch/api demo:data   # a waiting booking + a document to review
pnpm --filter @fetch/api rider:bot   # a pretend rider that accepts and walks the next job
```

`job-state.test.ts` parses `allowed_job_transitions()` out of the SQL migration
and asserts the TypeScript transition table matches it, so the two cannot drift.

## Database layout

Migrations are ordered and each one is self-contained:

| File | What it adds |
|---|---|
| `…000100_init` | Extensions, enums, shared helpers |
| `…000200_identity` | `profiles`, `drivers`, documents, saved places, zones |
| `…000300_pricing` | `fare_config` and the authoritative `quote_fare()` |
| `…000400_jobs` | `jobs`, `errand_items`, `job_events` |
| `…000500_job_state` | The transition table and its guard trigger |
| `…000600_dispatch` | `job_offers`, matching, `claim_job()`, location pings |
| `…000700_wallet` | Ledger, commission settlement |
| `…000800_lifecycle` | `create_job()` and the rest of the lifecycle RPCs |
| `…000900_ratings` | Two-way ratings |
| `…001000_views` | `public_driver_info`, `dispatch_board`, `driver_roster` |
| `…001100_rls` | Row and column level security, grants |
| `…001200_maintenance` | Offer expiry, re-dispatch, cron, realtime publication |
| `…001300_storage` | Buckets and their access rules |
| `…001400_landmarks` | Landmark suggestions and fuzzy search |
| `…001500_push_tokens` | Per-device push registration |
| `…0908000100_lock_down_function_grants` | Revokes EXECUTE from PUBLIC; grants back an allowlist |
| `…0908000200_restore_anon_landmark_search` | Lets signed-out users search landmarks again |
| `…0930000050_fix_function_default_privileges` | Makes new functions owner-only for real |
| `…0930000100_rbac` | Permissions, roles, `has_permission()`, the user/role RPCs |
| `…0930000200_auth_rate_limit` | `auth_attempts` and the sliding-window limiter |
| `…0930000300_console_driver_actions` | `set_driver_status()`, `assign_job()` for the console |
| `…0930000400_fix_landmark_search` | Lets `search_landmarks()` call `point_of()` again |
| `…1002000100_admin_console` | Staff RPCs (approve, assign, block, fares, landmarks, wallet), `admin_*` views |
| `…1002000200_app_flow_fixes` | `register_driver()`, receipt reject/zero-cost cancel, push triggers, grants views need |
| `…1003000100_reconcile_rbac` | Puts the console RPCs on `has_permission()`, adds `wallet.adjust`, merges the duplicate assign/status RPCs |

## Before you launch

These are decisions and tasks that are outside the code, and each one will
bite if skipped.

- **Verify the landmark coordinates.** The ones in `supabase/seed.sql` are
  approximate placeholders and some are likely a few hundred metres out. A
  landmark that is 400 m wrong sends a driver to the wrong gate. Replace each
  with a coordinate you have confirmed on the ground.
- **Replace the service-area polygon.** `seed.sql` ships a rectangle that
  includes water and farmland. Use the barangay boundaries you actually serve.
- **Set real fares.** The numbers in `…000300_pricing` are a starting guess,
  not a benchmark. Tune them from the admin console once you have trip data.
- **Motorcycle taxi legality (LTFRB / DOTr).** Motorcycle taxis for passengers
  in the Philippines are only formally sanctioned through the DOTr pilot
  programme. Confirm where an independent operation stands before submitting
  to the app stores — Apple and Google may ask for local transport permits
  during review for a ride-hailing app, and that affects how the listing is
  positioned. Get advice on this rather than guessing.
- **Test on a cheap Android with aggressive battery management.** A Xiaomi,
  Realme, Oppo or Vivo handset will suspend the driver app and silently stop
  delivering offers. The foreground service, the 5-second offer poll and push
  notifications all exist for this, and all three need verifying on real
  hardware before drivers rely on them. Add "disable battery optimisation for
  this app" to driver onboarding.
- **Pick an SMS provider, and budget for the integration rather than a
  settings change.** Supabase's built-in phone providers are Twilio, Twilio
  Verify, MessageBird, TextLocal and Vonage. Semaphore and Movider -- the
  cheaper options for PH numbers, and the ones that support sender-name
  registration -- are not in that list. Reaching either means implementing the
  Send SMS auth hook: an HTTPS hook in the dashboard pointing at an edge
  function that calls the provider's API. It is a morning's work, not a
  dropdown, and it needs to be on the plan before launch. OTP cost is a real
  per-signup line item either way.

  Nothing blocks development while you decide. Enable the Phone provider with
  placeholder SMS credentials and add test numbers under Authentication, then
  sign in with their fixed codes -- a test OTP short-circuits before any
  provider call is made. That is the same mechanism `[auth.sms.test_otp]` uses
  in `config.toml` for the local stack.
- **Configure Auth on the hosted project to match `config.toml`.** The
  local file does not reach production. In the dashboard:
  - Turn off "Allow new users to sign up" until a sign-up screen exists.
  - Keep the Email provider enabled, or staff cannot sign in by email.
  - Set the minimum password length to 8.
  - Replace the "Reset password" email template with one that shows
    `{{ .Token }}`; the apps ask for the code, not a link. Copy
    `supabase/templates/recovery.html`.
  - Deploy the functions with `supabase functions deploy auth admin-users`.
    Both are `verify_jwt = false` on purpose; see the comments in
    `config.toml`.
- **Give the first real admin their role.** Nobody can grant Admin except an
  admin. On a fresh project, create the account, then run once in the SQL
  editor: `insert into user_roles (user_id, role_id) select '<their uuid>',
  id from roles where key = 'admin';`
- **Turn on push notifications.** Nothing reaches a phone that is locked
  until all of this is done:
  1. `eas init` in `apps/driver` and `apps/rider`; put each project id in that
     app's `.env` as `EAS_PROJECT_ID` (read by `app.config.ts`).
  2. Deploy `supabase/functions/push-notify` and set its `PUSH_NOTIFY_SECRET`.
  3. Store the URL and the same secret in Vault so the database triggers can
     call it:
     ```sql
     select vault.create_secret('https://<ref>.supabase.co/functions/v1/push-notify', 'push_notify_url');
     select vault.create_secret('<PUSH_NOTIFY_SECRET>', 'push_notify_secret');
     ```
  Until the Vault secrets exist the triggers do nothing (and never fail a
  booking).
- **Set `EXPO_PUBLIC_DISPATCH_PHONE`** in both apps. Every "Call dispatch"
  button dials it; the fallback is the seeded test number, which rings nobody.
- **Set `DISPATCH_TICK_SECRET`** if you use the `dispatch-tick` edge function
  instead of pg_cron. It fails closed without one, so dispatch retries would
  quietly stop.
- **Turn on pg_cron** if your Supabase project supports it, and confirm
  `dispatch_tick()` is actually running. Nothing re-broadcasts a job nobody
  accepted without it.

### The SQL suite

`pnpm test:db` applies every migration to a throwaway Postgres+PostGIS
container and then runs `supabase/tests/01_dispatch_test.sql` against it. It
needs only Docker, takes about twenty seconds, and catches the class of bug a
typecheck cannot: a policy that recurses, a function referencing a table from a
later migration, an enum that needs an explicit cast, a transition the guard
trigger wrongly allows.

It asserts the things that would cost real money if they broke — first-accept-
wins under contention, that a driver cannot bypass errand receipt approval,
that commission lands on the service fee and not on the customer's groceries,
and that completing a job twice does not charge commission twice.

`03_rbac_test.sql` runs as `authenticated` with a JWT subject set, so grants
and row-level security apply as they would over the API. It covers:

- Each escalation guard.
- The last-admin rule.
- That a deactivated account loses every permission immediately.
- That `record_topup()` now needs `wallet.topup` rather than any staff role.
- The rate limiter's window, per-key isolation and clearing.

`02_privilege_test.sql` checks the privilege graph rather than behaviour: that
no money mover or destructive sweeper is reachable by `anon` or
`authenticated`, that nothing in `public` grants `EXECUTE` to `PUBLIC`, that
the schema default cannot reintroduce it, that the ledger and audit tables are
not directly writable, that RLS is on for every table we own — and that the
lockdown did not break any RPC the apps rely on.

A caveat worth knowing about both files: `psql` connects as superuser, which
bypasses RLS entirely. Behavioural tests here therefore prove the *logic*, not
the *policies*. Row-level rules need exercising over the API with a real user
JWT — that is how the RLS recursion bug got found, long after this suite was
green.

`pnpm test:all` runs the typecheck, the unit tests and the SQL suite together.
