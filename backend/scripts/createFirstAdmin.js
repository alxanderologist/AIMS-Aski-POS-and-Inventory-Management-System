// Creates the first real ADMIN account for a fresh install, without wiping any table and without a
// guessable default password (unlike seeder.js's demo admin/admin123). Deliberately talks to Prisma
// directly instead of going through UserModel.create(), because that API intentionally excludes
// 'ADMIN' from CREATABLE_ROLES (the normal user-management UI can't create more admins) — this
// script is the one sanctioned way around that, meant to be run once per install.
//
// Usage:
//   node scripts/createFirstAdmin.js --username=admin --fullName="Store Owner"
//   node scripts/createFirstAdmin.js --username=admin --fullName="Store Owner" --force   (allow
//     creating another admin even though an active one already exists)
require('dotenv').config();
const bcrypt = require('bcryptjs');
const { prisma } = require('../models/Product');

const SALT_ROUNDS = 10;
// Unambiguous characters only (no 0/O, 1/l/I), same alphabet as models/User.js's temp-password
// generator, so a printed password can be read out or retyped without confusion.
const PASSWORD_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
const PASSWORD_LENGTH = 16;

function parseArgs(argv) {
  const args = {};
  for (const raw of argv) {
    if (raw === '--force') {
      args.force = true;
      continue;
    }
    const m = raw.match(/^--([a-zA-Z]+)=(.*)$/);
    if (m) args[m[1]] = m[2];
  }
  return args;
}

function generatePassword() {
  const crypto = require('crypto');
  return Array.from({ length: PASSWORD_LENGTH }, () => PASSWORD_ALPHABET[crypto.randomInt(PASSWORD_ALPHABET.length)]).join('');
}

async function main() {
  const { username, fullName, force } = parseArgs(process.argv.slice(2));

  if (!username || !username.trim() || !fullName || !fullName.trim()) {
    console.error('Usage: node scripts/createFirstAdmin.js --username=<username> --fullName="<Full Name>" [--force]');
    process.exitCode = 1;
    return;
  }

  const existingUsername = await prisma.user.findUnique({ where: { username: username.trim() } });
  if (existingUsername) {
    console.error(`Username "${username}" is already taken.`);
    process.exitCode = 1;
    return;
  }

  if (!force) {
    const existingActiveAdmin = await prisma.user.count({ where: { role: 'ADMIN', isActive: true, deletedAt: null } });
    if (existingActiveAdmin > 0) {
      console.error(
        `An active admin already exists (${existingActiveAdmin}). Re-run with --force if you really want to create another.`,
      );
      process.exitCode = 1;
      return;
    }
  }

  const password = generatePassword();
  const hashedPassword = await bcrypt.hash(password, SALT_ROUNDS);

  const admin = await prisma.user.create({
    data: {
      fullName: fullName.trim(),
      username: username.trim(),
      password: hashedPassword,
      role: 'ADMIN',
      isActive: true,
    },
    select: { id: true, username: true, fullName: true, createdAt: true },
  });

  console.log('\nAdmin account created:');
  console.log(`  Username: ${admin.username}`);
  console.log(`  Password: ${password}`);
  console.log('\nThis password is shown once and is not stored anywhere in plaintext. Save it now,');
  console.log('sign in, and change it immediately from the account menu.');
}

main()
  .catch((err) => {
    console.error('Failed to create admin:', err.message);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
