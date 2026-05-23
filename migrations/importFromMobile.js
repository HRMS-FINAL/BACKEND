/**
 * Migration: pull every user from the mobile backend's User collection
 * (anyone created via the old admin.html, the mobile signup flow, or any
 * other tool that wrote directly to the mobile DB) into the HRMS Employee
 * collection — so they appear in the Employee List page.
 *
 * Idempotent: anyone whose email OR employeeId already exists in HRMS is
 * skipped. Safe to re-run on every server startup.
 *
 * The mobile User schema is much looser than HRMS Employee (no department,
 * no joiningDate, no salary, no education). We fill those required fields
 * with placeholders ("Imported (Mobile)" department, today's joiningDate,
 * etc.) so the import doesn't fail the Mongoose validators. HR admin can
 * edit each employee afterwards via the existing Edit Employee modal to
 * fill in real values.
 *
 * Exported as a function so it can be:
 *  • Called automatically on server startup (see server.js)
 *  • Hit manually via POST /api/employees/import-from-mobile
 */

const Employee    = require('../models/Employee');
const Department  = require('../models/Department');
const Designation = require('../models/Designation');

const MOBILE_API   = (process.env.MOBILE_API_URL    || 'https://backend-emqy.onrender.com').replace(/\/+$/, '');
const ADMIN_SECRET =  process.env.MOBILE_ADMIN_SECRET || '';

/**
 * Run the migration once.
 * @param {object} opts
 * @param {number} opts.timeoutMs — how long to wait for the mobile API (default 60s)
 * @returns {Promise<{success, total, imported, skipped, errors, message}>}
 */
async function importMobileUsers(opts = {}) {
  const timeoutMs = opts.timeoutMs || 60_000;

  if (!ADMIN_SECRET) {
    return {
      success: false,
      message: 'MOBILE_ADMIN_SECRET is not set on the HRMS backend (.env). Add it and restart.',
      imported: 0, skipped: 0, errors: [],
    };
  }
  if (typeof fetch !== 'function') {
    return { success: false, message: 'Node 18+ required for global fetch.', imported: 0, skipped: 0, errors: [] };
  }

  // ─── Fetch the mobile user list with a timeout (server may be cold) ──
  let mobileUsers;
  try {
    const ctrl  = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    const r = await fetch(`${MOBILE_API}/api/auth/admin/users?limit=500`, {
      headers: { 'x-admin-secret': ADMIN_SECRET },
      signal:  ctrl.signal,
    }).finally(() => clearTimeout(timer));
    const data = await r.json().catch(() => ({}));
    if (!r.ok || !Array.isArray(data?.users)) {
      return {
        success: false,
        message: data?.message || `Mobile API responded ${r.status}`,
        imported: 0, skipped: 0, errors: [],
      };
    }
    mobileUsers = data.users;
  } catch (err) {
    return {
      success: false,
      message: `Could not reach mobile backend: ${err.message}`,
      imported: 0, skipped: 0, errors: [],
    };
  }

  // ─── Resolve / create the "Imported (Mobile)" department ──────────
  let importedDept = await Department.findOne({ name: 'Imported (Mobile)' });
  if (!importedDept) {
    importedDept = await Department.create({ name: 'Imported (Mobile)' });
  }

  let imported = 0;
  let skipped  = 0;
  const errors = [];

  for (const u of mobileUsers) {
    try {
      if (!u.email) { skipped++; continue; }

      // Skip if matching HRMS employee already exists (by email OR employeeId).
      const existing = await Employee.findOne({
        $or: [
          { email: String(u.email).toLowerCase() },
          { employeeId: u.userId },
        ],
      }).lean();
      if (existing) { skipped++; continue; }

      // Split single `name` into first/last.
      const parts = String(u.name || 'Unknown User').trim().split(/\s+/);
      const firstName = parts[0] || 'Unknown';
      const lastName  = parts.slice(1).join(' ') || 'User';

      // Username: email local-part, sanitised to schema regex, made unique.
      const usernameBase = String(u.email).toLowerCase().split('@')[0]
        .replace(/[^a-z0-9_.-]/g, '');
      let username = usernameBase || 'user' + Math.random().toString(36).slice(2, 6);
      let n = 0;
      while (await Employee.findOne({ username }).lean()) {
        n++;
        username = `${usernameBase}${n}`;
      }

      // Resolve / create Designation if mobile has one.
      let desigId = null;
      if (u.designation && typeof u.designation === 'string' && u.designation.trim()) {
        let desig = await Designation.findOne({
          title: { $regex: new RegExp(`^${u.designation}$`, 'i') },
        });
        if (!desig) {
          desig = await Designation.create({ title: u.designation, dept: 'Imported (Mobile)' });
        }
        desigId = desig._id;
      }

      // Phone — schema validator requires 10+ digits.
      let phone = String(u.phone || '').replace(/[\s-]/g, '');
      if (!/^\d{10,15}$/.test(phone)) phone = '0000000000';

      // Joining date — use mobile createdAt if parseable, else today.
      let joiningDate = new Date(u.createdAt || Date.now());
      if (isNaN(joiningDate.getTime())) joiningDate = new Date();

      await Employee.create({
        firstName,
        lastName,
        username,
        // Placeholder local HRMS password — the user logs into the MOBILE
        // app with their original mobile-side password (untouched). Admin
        // can reset this via the Edit Employee modal if HRMS login matters.
        password:   'ImportedFromMobile!2026',
        email:      String(u.email).toLowerCase(),
        phone,
        employeeId: u.userId,
        department: importedDept._id,
        designation: desigId,
        joiningDate,
        salary:      0,
        assignedTo: 'HR (auto-imported)',
        education: {
          degree:         'Other Professional Certificate',
          university:     'Not specified',
          fieldOfStudy:   'Not specified',
          graduationYear: 2020,
        },
        status:   u.status === 'Inactive' ? 'Inactive' : 'Active',
        isActive: u.status !== 'Inactive',
        address: {
          street: typeof u.address === 'string' ? u.address : '',
          city: '', state: '', zipCode: '', country: '',
        },
      });
      imported++;
    } catch (err) {
      errors.push({ userId: u.userId, email: u.email, error: err.message });
    }
  }

  return {
    success: true,
    total:    mobileUsers.length,
    imported,
    skipped,
    errors,
    message:  `Imported ${imported} employee(s) from mobile. ${skipped} already existed.`,
  };
}

module.exports = { importMobileUsers };
