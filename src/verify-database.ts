import { drizzle } from 'drizzle-orm/node-postgres';
import { sql } from 'drizzle-orm';
import pg from 'pg';
import * as dotenv from 'dotenv';

dotenv.config();

const { Pool } = pg;

async function verifyDatabase() {
  console.log('⏳ Connecting to Supabase...');

  const connectionString = process.env.DATABASE_URL;
  const isSupabase =
    connectionString?.includes('supabase.co') ||
    connectionString?.includes('supabase.com') ||
    connectionString?.includes('pooler.supabase');

  const pool = new Pool({
    connectionString,
    ssl: isSupabase ? { rejectUnauthorized: false } : undefined,
  });

  const db = drizzle(pool);

  try {
    // 1. Test raw connection and fetch database time
    const timeResult = await db.execute(sql`SELECT NOW();`);
    console.log('✅ Connected successfully!');
    console.log('🕒 Server Time:', (timeResult.rows[0] as any).now);

    // 2. Fetch all public user-defined tables from Supabase
    const tablesResult = await db.execute(sql`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public' 
        AND table_type = 'BASE TABLE';
    `);

    console.log('\n📊 Tables found in your Supabase database:');
    if (tablesResult.rows.length === 0) {
      console.log('⚠️  No public tables found. Did you run `npx drizzle-kit push`?');
    } else {
      tablesResult.rows.forEach((row: any, index: number) => {
        console.log(`  ${index + 1}. ${row.table_name}`);
      });
    }

  } catch (error) {
    console.error('❌ Database connection failed:');
    console.error(error);
  } finally {
    await pool.end();
  }
}

verifyDatabase();
