// Run: node resetPassword.js
// Resets admin@tesco.com password to "password123"
require('dotenv').config();
const mongoose = require('mongoose');
const bcrypt   = require('bcryptjs');

async function reset() {
  await mongoose.connect(process.env.MONGO_URI);
  const User = require('./models/User');

  const email    = 'admin@tesco.com';
  const newPass  = 'password123';
  const hashed   = await bcrypt.hash(newPass, 10);

  const result = await User.findOneAndUpdate(
    { email },
    { password: hashed, isActive: true },
    { new: true }
  );

  if (result) {
    console.log(`✅ Password reset for ${email} → password123`);
  } else {
    // Create fresh admin account
    await User.create({ name: 'Admin', email, password: newPass, role: 'admin' });
    console.log(`✅ Created new admin account: ${email} / password123`);
  }
  process.exit(0);
}

reset().catch(err => { console.error(err.message); process.exit(1); });
