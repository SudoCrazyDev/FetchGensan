# FetchGensan

24/7 habal-habal rides, errands and deliveries in General Santos City.

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

| Number | Role | Notes |
|---|---|---|
| `+639170000001` | customer | Maria Santos |
| `+639170000002` | driver | Approved, already owes a little commission |
| `+639170000003` | driver | Pending — use this to test the approval gate |
| `+639170000004` | dispatcher | Signs in to the console |

On the local stack the OTP for all of them is `123456`.

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

**Addressing is landmark-first.** There is no street-address search anywhere in
the rider app, on purpose — Gensan addressing is landmark-based and a geocoder
mostly returns nothing useful for it. Customers pick from saved places and the
`landmark_suggestions` table, or drop a pin, and always add a free-text
landmark note. That note is what the driver actually reads on arrival.

## Checks

```bash
pnpm test        # packages/core -- fare maths, state machine, money, geo, phone
pnpm typecheck   # every package and app
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
- **Pick an SMS provider.** Semaphore and Movider are both cheaper per SMS for
  PH numbers than Twilio and support sender-name registration. OTP cost is a
  real per-signup line item.
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
