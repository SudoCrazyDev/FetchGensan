/**
 * Creates the local development users that supabase/seed.sql cannot.
 *
 *   pnpm seed:users
 *
 * Auth users need the Admin API, so this runs against the SERVICE ROLE key
 * and refuses to run against anything that is not a local Supabase stack.
 * That guard is not paranoia: a service-role key plus a script that
 * makes an account an admin is exactly the combination you do not want
 * pointed at production by a stray .env.
 */

import { createClient } from '@supabase/supabase-js';

const url = process.env.SUPABASE_URL ?? 'http://127.0.0.1:54321';
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!serviceKey) {
  console.error('SUPABASE_SERVICE_ROLE_KEY is not set.');
  console.error('For the local stack, run `supabase status` and copy the service_role key.');
  process.exit(1);
}

const isLocal =
  url.includes('127.0.0.1') || url.includes('localhost') || url.includes('host.docker.internal');

if (!isLocal && process.env.I_REALLY_MEAN_IT !== 'yes') {
  console.error(`Refusing to seed users against a non-local Supabase URL: ${url}`);
  console.error('This script grants an admin role. If you truly intend this, set');
  console.error('I_REALLY_MEAN_IT=yes -- but you almost certainly do not.');
  process.exit(1);
}

const admin = createClient(url, serviceKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

/** Every seeded account signs in with this. Local stack only. */
const DEV_PASSWORD = 'fetchgensan-dev';

interface SeedUser {
  phone: string;
  email?: string;
  fullName: string;
  role: 'customer' | 'driver' | 'dispatcher' | 'admin';
  driver?: {
    status: 'pending' | 'approved';
    make: string;
    model: string;
    color: string;
    plate: string;
    license: string;
    walletCentavos?: number;
  };
}

const USERS: SeedUser[] = [
  { phone: '+639170000001', fullName: 'Maria Santos', role: 'customer' },
  {
    phone: '+639170000002',
    fullName: 'Ramon Dela Cruz',
    role: 'driver',
    driver: {
      status: 'approved',
      make: 'Honda',
      model: 'Click 125i',
      color: 'Black',
      plate: 'GS 1234',
      license: 'D01-23-456789',
      // Already owes a bit of commission, so the wallet screen has content.
      walletCentavos: -8_500,
    },
  },
  {
    phone: '+639170000003',
    fullName: 'Boy Reyes',
    role: 'driver',
    driver: {
      status: 'pending',
      make: 'Yamaha',
      model: 'Mio i 125',
      color: 'Blue',
      plate: 'GS 5678',
      license: 'D01-98-765432',
    },
  },
  {
    phone: '+639170000004',
    email: 'ops@fetchgensan.test',
    fullName: 'Ops Desk',
    role: 'dispatcher',
  },
  {
    phone: '+639170000005',
    email: 'admin@fetchgensan.test',
    fullName: 'Site Admin',
    role: 'admin',
  },
];

const STAFF_ROLES = new Set(['dispatcher', 'admin']);

async function findByPhone(phone: string): Promise<string | null> {
  // listUsers has no phone filter, so page through. Fine for four users.
  let page = 1;
  for (;;) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 200 });
    if (error) throw error;
    const found = data.users.find((u) => u.phone === phone.replace('+', ''));
    if (found) return found.id;
    if (data.users.length < 200) return null;
    page += 1;
  }
}

async function seed(user: SeedUser): Promise<void> {
  let userId = await findByPhone(user.phone);

  const login = {
    password: DEV_PASSWORD,
    ...(user.email ? { email: user.email, email_confirm: true } : {}),
  };

  if (userId) {
    // Re-running brings older OTP-only seed accounts up to date.
    const { error } = await admin.auth.admin.updateUserById(userId, login);
    if (error) throw error;
    console.log(`  = ${user.phone} already exists; password reset`);
  } else {
    const { data, error } = await admin.auth.admin.createUser({
      phone: user.phone,
      phone_confirm: true,
      ...login,
      user_metadata: { full_name: user.fullName },
    });
    if (error) throw error;
    userId = data.user.id;
    console.log(`  + created ${user.phone}`);
  }

  // handle_new_user() created the profile row; set the name. Staff access
  // comes from user_roles below, and profiles.role follows it by trigger.
  const { error: profileError } = await admin.from('profiles').upsert(
    {
      id: userId,
      phone: user.phone,
      full_name: user.fullName,
      ...(STAFF_ROLES.has(user.role) ? {} : { role: user.role }),
    },
    { onConflict: 'id' },
  );
  if (profileError) throw profileError;

  if (STAFF_ROLES.has(user.role)) {
    const { data: role, error: roleError } = await admin
      .from('roles')
      .select('id')
      .eq('key', user.role)
      .single();
    if (roleError) throw roleError;

    const { error: grantError } = await admin
      .from('user_roles')
      .upsert({ user_id: userId, role_id: role.id }, { onConflict: 'user_id,role_id' });
    if (grantError) throw grantError;
    console.log(`    role: ${user.role}`);
  }

  if (user.driver) {
    const d = user.driver;
    const { error: driverError } = await admin.from('drivers').upsert(
      {
        id: userId,
        status: d.status,
        vehicle_make: d.make,
        vehicle_model: d.model,
        vehicle_color: d.color,
        plate_number: d.plate,
        license_number: d.license,
        wallet_balance_centavos: d.walletCentavos ?? 0,
      },
      { onConflict: 'id' },
    );
    if (driverError) throw driverError;
    console.log(`    driver row: ${d.status}, plate ${d.plate}`);
  }
}

async function main(): Promise<void> {
  console.log(`Seeding development users into ${url}\n`);
  for (const user of USERS) {
    console.log(`${user.fullName} (${user.role})`);
    await seed(user);
  }
  console.log(`\nDone. Sign in with any of those numbers and the password ${DEV_PASSWORD}.`);
  console.log('Staff can also use their email. Password-reset codes are 123456.');
}

main().catch((error: unknown) => {
  console.error('\nSeeding failed:', error);
  process.exit(1);
});
