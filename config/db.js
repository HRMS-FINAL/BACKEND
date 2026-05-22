const mongoose = require('mongoose');

// Set IST timezone (UTC + 5:30)
process.env.TZ = 'Asia/Kolkata';

const connectDB = async () => {
  if (!process.env.MONGO_URI) {
    throw new Error('MONGO_URI is not defined in environment variables');
  }
  const conn = await mongoose.connect(process.env.MONGO_URI);
  console.log(`MongoDB Connected: ${conn.connection.host}`);
  console.log(`Database name   : ${conn.connection.name}`);

  mongoose.connection.on('error', (err) =>
    console.error('Mongo connection error:', err.message)
  );
  mongoose.connection.on('disconnected', () =>
    console.warn('Mongo disconnected')
  );
};

module.exports = connectDB;
