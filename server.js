// Load .env only in development - on Render, env vars are injected by the platform
if (process.env.NODE_ENV !== 'production') {
  require('dotenv').config();
}

const express   = require('express');
const cors      = require('cors');
const morgan    = require('morgan');
const connectDB = require('./config/db');

const app = express();

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(morgan('dev'));

// Health check
app.get('/', (req, res) => {
  res.status(200).json({
    success: true,
    message: 'HRM Backend API is running',
    modules: ['dashboard', 'departments', 'designations', 'employees', 'attendance', 'reports', 'access-management', 'announcements', 'assets'],
    timestamp: new Date().toISOString(),
  });
});

// Routes
app.use('/api/auth',              require('./routes/authRoutes'));
app.use('/api/dashboard',         require('./routes/dashboardRoutes'));
app.use('/api/departments',       require('./routes/departmentRoutes'));
app.use('/api/designations',      require('./routes/designationRoutes'));
app.use('/api/employees',         require('./routes/employeeRoutes'));
app.use('/api/attendance',        require('./routes/attendanceRoutes'));
app.use('/api/reports',           require('./routes/reportRoutes'));
app.use('/api/access-management', require('./routes/accessManagementRoutes'));
app.use('/api/announcements',     require('./routes/announcementRoutes'));
app.use('/api/assets',            require('./routes/assetRoutes'));

// 404 handler
app.use((req, res) => {
  res.status(404).json({ success: false, message: `Route not found: ${req.method} ${req.originalUrl}` });
});

// Global error handler
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(err.status || 500).json({ success: false, message: err.message || 'Internal Server Error' });
});

const PORT = process.env.PORT || 8000;

connectDB().then(() => {
  app.listen(PORT, () => {
    console.log(`\nHRM Backend running on port ${PORT} [${process.env.NODE_ENV || 'development'}]`);
    console.log(`  API base: http://localhost:${PORT}/api\n`);
  });
}).catch(err => {
  console.error('Failed to connect to MongoDB:', err.message);
  process.exit(1);
});
