import bcrypt from 'bcryptjs';
import { db } from '../postgres.js';
import { env } from '../../config/env.js';

export async function runDemoSeed({ client = db } = {}) {
  // Change #12: Strictly refuse to execute in production environment
  if (process.env.NODE_ENV === 'production' || env.NODE_ENV === 'production') {
    throw new Error('Refusing to run seed:demo in production environment');
  }

  console.log('[seed:demo] Starting idempotent demo seeding...');

  const passwordHash = await bcrypt.hash('DemoPass123!', 10);

  // 1. Upsert demo users with @example.test emails (Change #12)
  const usersToSeed = [
    { email: 'host@example.test', role: 'HOST' },
    { email: 'provider@example.test', role: 'PROVIDER' },
    { email: 'customer@example.test', role: 'CUSTOMER' },
  ];

  const userMap = new Map();

  for (const u of usersToSeed) {
    const userRes = await client.query(
      `
      INSERT INTO users (email, password_hash, role)
      VALUES ($1, $2, $3)
      ON CONFLICT (email)
      DO UPDATE SET password_hash = EXCLUDED.password_hash, role = EXCLUDED.role
      RETURNING id, email, role;
      `,
      [u.email, passwordHash, u.role],
    );
    userMap.set(u.role, userRes.rows[0]);
  }

  const hostUser = userMap.get('HOST');
  const providerUser = userMap.get('PROVIDER');
  const customerUser = userMap.get('CUSTOMER');

  console.log(`[seed:demo] Seeded users: Host (${hostUser.email}), Provider (${providerUser.email}), Customer (${customerUser.email})`);

  // 2. Upsert provider profile for provider@example.test
  const providerProfileRes = await client.query(
    `
    INSERT INTO providers (user_id, business_name, bio)
    VALUES ($1, $2, $3)
    ON CONFLICT (user_id)
    DO UPDATE SET business_name = EXCLUDED.business_name, bio = EXCLUDED.bio
    RETURNING id, business_name;
    `,
    [
      providerUser.id,
      'Grand Celebrations Vendor',
      'Professional catering, decor, and audiovisual setup for weddings and corporate events.',
    ],
  );
  const providerProfile = providerProfileRes.rows[0];
  console.log(`[seed:demo] Seeded provider profile: ${providerProfile.business_name}`);

  // 3. Upsert active properties for host
  const propertiesToSeed = [
    {
      title: 'Emerald Lakeside Villa',
      description: 'A luxurious villa facing the lake, perfect for gatherings, celebrations, and intimate retreats.',
      location: 'Udaipur',
      capacity: 20,
      pricingMinor: 4500000,
      currency: 'INR',
      amenities: ['wifi', 'pool', 'kitchen', 'parking'],
    },
    {
      title: 'Palm Grove Pavilion',
      description: 'Charming seaside villa surrounded by lush coconut palms with open banquet lawn.',
      location: 'Goa',
      capacity: 15,
      pricingMinor: 3500000,
      currency: 'INR',
      amenities: ['wifi', 'parking', 'garden'],
    },
  ];

  for (const p of propertiesToSeed) {
    const propRes = await client.query(
      `
      INSERT INTO properties (host_id, title, description, location, capacity, pricing_minor, currency, status)
      VALUES ($1, $2, $3, $4, $5, $6, $7, 'ACTIVE')
      ON CONFLICT DO NOTHING
      RETURNING id;
      `,
      [hostUser.id, p.title, p.description, p.location, p.capacity, p.pricingMinor, p.currency],
    );

    let propId = propRes.rows[0]?.id;
    if (!propId) {
      const existing = await client.query('SELECT id FROM properties WHERE host_id = $1 AND title = $2;', [
        hostUser.id,
        p.title,
      ]);
      propId = existing.rows[0]?.id;
    }

    if (propId && p.amenities) {
      // Seed amenities
      for (const amenity of p.amenities) {
        await client.query(
          `
          INSERT INTO amenities (property_id, name)
          VALUES ($1, $2)
          ON CONFLICT DO NOTHING;
          `,
          [propId, amenity],
        );
      }
    }
  }

  // 4. Upsert active services for provider
  const servicesToSeed = [
    {
      title: 'Sound & DJ Production',
      description: 'Complete high-end acoustic sound system, DJ console, and dynamic ambient lighting.',
      category: 'music',
      kind: 'exclusive',
      priceMinor: 1500000,
      currency: 'INR',
      capacity: null,
    },
    {
      title: 'Artisan Banquet Catering',
      description: 'Farm-to-table multi-course gourmet buffet with live preparation counters.',
      category: 'catering',
      kind: 'capacity',
      priceMinor: 80000, // ₹800 per plate/guest
      currency: 'INR',
      capacity: 50,
    },
  ];

  for (const s of servicesToSeed) {
    const svcRes = await client.query(
      `
      INSERT INTO services (provider_id, title, description, category, kind, price_minor, currency, capacity, status)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'ACTIVE')
      ON CONFLICT DO NOTHING
      RETURNING id, kind, capacity;
      `,
      [providerProfile.id, s.title, s.description, s.category, s.kind, s.priceMinor, s.currency, s.capacity],
    );

    let svc = svcRes.rows[0];
    if (!svc) {
      const existing = await client.query(
        'SELECT id, kind, capacity FROM services WHERE provider_id = $1 AND title = $2;',
        [providerProfile.id, s.title],
      );
      svc = existing.rows[0];
    }

    // Pre-seed capacity slots for next 14 days if capacity service
    if (svc && svc.kind === 'capacity') {
      const now = new Date();
      for (let dayOffset = 0; dayOffset < 14; dayOffset++) {
        const d = new Date(now);
        d.setDate(d.getDate() + dayOffset);
        const yyyy = d.getFullYear();
        const mm = String(d.getMonth() + 1).padStart(2, '0');
        const dd = String(d.getDate()).padStart(2, '0');
        const slot = `${yyyy}-${mm}-${dd}`;

        await client.query(
          `
          INSERT INTO service_capacity (service_id, slot, capacity, reserved)
          VALUES ($1, $2, $3, 0)
          ON CONFLICT (service_id, slot) DO NOTHING;
          `,
          [svc.id, slot, svc.capacity],
        );
      }
    }
  }

  console.log('[seed:demo] Demo seeding completed successfully.');
  return {
    host: hostUser.email,
    provider: providerUser.email,
    customer: customerUser.email,
  };
}

// Direct invocation CLI runner
if (process.argv[1]?.endsWith('seedDemo.js')) {
  runDemoSeed()
    .then(() => {
      process.exit(0);
    })
    .catch((err) => {
      console.error('[seed:demo] Failed:', err);
      process.exit(1);
    });
}
