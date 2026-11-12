/**
 * payrollReportParser.js
 * ----------------------------------------------------------------------------
 * Parses an uploaded HR payroll Excel/CSV and turns it into a reviewable list
 * of payslip rows. Supports TWO distinct report formats and keeps their
 * mapping + salary logic completely separate:
 *
 *   1. EMPLOYEE report — columns: S/No, Name, Designation, No of Permissions,
 *      No of Present days, No of Absent days, No of HLOP, Extra Working Hours
 *      and Days, Late, Carry Forward Days, Salary Advance, Deduction Amount of
 *      Salary Advance (prev month), Deduction Amount of Salary Advance (this
 *      month), Remaining Amount, Salary Amount.
 *      Earnings come from the employee's EXISTING salary structure
 *      (Basic + DA = 50% of salary, HRA = the rest). Deductions = PF +
 *      Professional Tax from the employee record. The uploaded Salary Amount is
 *      VALIDATED against the structure net and flagged on mismatch — never
 *      silently applied.
 *
 *   2. LABOUR report — columns: S/No, Employee Name, Designation, No of Working
 *      Days, LOP, HLOP, OT, OT Amount, Per Day Salary, Total Amount.
 *      Wages = Working Days × Per Day Salary, Overtime = OT Amount (from the
 *      report). Total Payable = Wages + OT, validated against the uploaded
 *      Total Amount and flagged on mismatch. LOP / HLOP are read for reference
 *      only — the uploaded Working Days already nets them out, so they are NOT
 *      deducted again.
 *
 * The report TYPE is auto-detected from the header row. Employees are matched
 * to existing HRMS Employee records by employeeId (if ever present) or by a
 * normalised name (+ designation to break ties). Unmatched rows are returned
 * as-is for HR to resolve — no records are created or mutated here.
 *
 * This module is PURE: it never pushes anything. Routes own the preview /
 * commit split so HR always reviews before payroll is finalised.
 */

const XLSX = (() => { try { return require('xlsx'); } catch { return null; } })();

// ── small helpers ───────────────────────────────────────────────────────────

/** Normalise a header / name to lowercase alphanumeric words. */
function norm(s) {
  return String(s == null ? '' : s)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** First number found in a messy cell: "27DAYS"→27, "2(5,11oct)"→2, "5,000"→5000. */
function firstNum(v) {
  if (v == null) return 0;
  if (typeof v === 'number') return isFinite(v) ? v : 0;
  const m = String(v).replace(/,(?=\d{3}\b)/g, '').match(/-?\d+(?:\.\d+)?/);
  return m ? Number(m[0]) : 0;
}

/** Sum of every number in a cell: "30000 + 10000"→40000. Used for advances. */
function sumNums(v) {
  if (v == null) return 0;
  if (typeof v === 'number') return isFinite(v) ? v : 0;
  const nums = String(v).replace(/,(?=\d{3}\b)/g, '').match(/-?\d+(?:\.\d+)?/g);
  return nums ? nums.reduce((a, b) => a + Number(b), 0) : 0;
}

const MONTH_NAMES = [
  '', 'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

// ── header dictionaries ──────────────────────────────────────────────────────
// Each field maps to a predicate on a normalised header string. We test the
// whole header against these so partial / reordered / re-worded columns still
// bind (e.g. "no of present days" and "present days" both hit presentDays).

const EMPLOYEE_FIELDS = {
  sno:          h => /^s ?no\b/.test(h) || h === 'sl no' || h === 'serial',
  name:         h => h === 'name' || h === 'employee name' || h === 'emp name',
  designation:  h => h.includes('designation'),
  permissions:  h => h.includes('permission'),
  presentDays:  h => h.includes('present'),
  absentDays:   h => h.includes('absent'),
  hlop:         h => h.includes('hlop'),
  extraWork:    h => h.includes('extra working'),
  late:         h => h === 'late' || h.startsWith('late'),
  carryForward: h => h.includes('carry forward'),
  salaryAdvance:h => h.includes('salary advance') && !h.includes('deduction'),
  advPrev:      h => h.includes('deduction') && h.includes('advance') && h.includes('previous'),
  advThis:      h => h.includes('deduction') && h.includes('advance') && h.includes('this month'),
  remaining:    h => h.includes('remaining'),
  salaryAmount: h => h.includes('salary amount'),
};

const LABOUR_FIELDS = {
  sno:         h => /^s ?no\b/.test(h) || h === 'sl no' || h === 'serial',
  name:        h => h === 'employee name' || h === 'name' || h === 'emp name',
  designation: h => h.includes('designation'),
  workingDays: h => h.includes('working day'),
  lop:         h => h === 'lop' || (h.includes('lop') && !h.includes('hlop')),
  hlop:        h => h.includes('hlop'),
  ot:          h => h === 'ot' || (h.startsWith('ot') && !h.includes('amount')),
  otAmount:    h => h.includes('ot') && h.includes('amount'),
  perDay:      h => h.includes('per day'),
  totalAmount: h => h.includes('total amount') || h === 'total',
};

/** Build { fieldName: columnIndex } by testing every header cell. */
function mapColumns(headerCells, fieldDefs) {
  const map = {};
  headerCells.forEach((cell, idx) => {
    const h = norm(cell);
    if (!h) return;
    for (const [field, test] of Object.entries(fieldDefs)) {
      if (map[field] === undefined && test(h)) map[field] = idx;
    }
  });
  return map;
}

/**
 * Decide which format a header row is. Returns 'employee' | 'labour' | null.
 * Scores the distinctive columns of each type (name/designation/hlop are shared
 * and excluded from scoring).
 */
function detectType(headerCells) {
  const norms = headerCells.map(norm);
  const has = (pred) => norms.some(pred);

  let empScore = 0;
  if (has(h => h.includes('permission')))     empScore++;
  if (has(h => h.includes('present')))        empScore++;
  if (has(h => h.includes('absent')))         empScore++;
  if (has(h => h.includes('carry forward')))  empScore++;
  if (has(h => h.includes('salary advance'))) empScore++;
  if (has(h => h.includes('remaining')))      empScore++;
  if (has(h => h.includes('salary amount')))  empScore++;

  let labScore = 0;
  if (has(h => h.includes('working day')))                labScore++;
  if (has(h => h.includes('per day')))                    labScore++;
  if (has(h => h.includes('ot') && h.includes('amount'))) labScore++;
  if (has(h => h.includes('total amount')))               labScore++;
  if (has(h => h === 'lop' || (h.includes('lop') && !h.includes('hlop')))) labScore++;

  if (labScore >= 2 && labScore >= empScore) return 'labour';
  if (empScore >= 2) return 'employee';
  if (labScore >= 2) return 'labour';
  return null;
}

/** Find the header row in a sheet matrix (first row that detects a type). */
function findHeaderRow(matrix) {
  for (let i = 0; i < Math.min(matrix.length, 15); i++) {
    const t = detectType(matrix[i] || []);
    if (t) return { index: i, type: t };
  }
  return { index: -1, type: null };
}

// ── employee matching ────────────────────────────────────────────────────────

/**
 * Index employees for lookup. employees: array of lean Employee docs.
 * Returns { byEmpId, byName } where byName maps normalised full name → [docs].
 */
function indexEmployees(employees) {
  const byEmpId = {};
  const byName = {};
  (employees || []).forEach(e => {
    const empId = norm(e.employeeId);
    if (empId) byEmpId[empId] = e;
    const full = norm(`${e.firstName || ''} ${e.lastName || ''}`);
    const alt  = norm(e.name || e.fullName || '');
    [full, alt].forEach(n => {
      if (!n) return;
      (byName[n] = byName[n] || []).push(e);
    });
  });
  return { byEmpId, byName };
}

/** Match one report row's name/designation to an employee. */
function matchEmployee(index, nameRaw, designationRaw) {
  const nm = norm(nameRaw);
  if (!nm) return null;
  // exact employeeId not present in these reports, but keep the hook.
  if (index.byEmpId[nm]) return index.byEmpId[nm];
  let candidates = index.byName[nm];
  if (!candidates || candidates.length === 0) {
    // loose: name is a prefix/subset (handles middle names / trailing words).
    const keys = Object.keys(index.byName);
    const hit = keys.find(k => k === nm || k.startsWith(nm + ' ') || nm.startsWith(k + ' '));
    if (hit) candidates = index.byName[hit];
  }
  if (!candidates || candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0];
  // disambiguate on designation
  const dz = norm(designationRaw);
  const byDes = candidates.find(c => norm(c.designationTitle || c.designation) === dz);
  return byDes || candidates[0];
}

// ── per-type row builders ────────────────────────────────────────────────────

function cell(row, map, field) {
  const idx = map[field];
  return idx === undefined ? '' : (row[idx] == null ? '' : row[idx]);
}

/** Is this data row real (has a name and isn't a totals / note line)? */
function isDataRow(row, map) {
  const name = norm(cell(row, map, 'name'));
  if (!name || name === 'total' || name === 'totals') return false;
  // require at least a name plus one other mapped non-empty value
  let filled = 0;
  Object.values(map).forEach(idx => {
    if (idx !== undefined && String(row[idx] ?? '').trim() !== '') filled++;
  });
  return filled >= 2;
}

function buildEmployeeRow(row, map, index) {
  const name        = String(cell(row, map, 'name') || '').trim();
  const designation = String(cell(row, map, 'designation') || '').trim();
  const emp = matchEmployee(index, name, designation);

  const presentDays = firstNum(cell(row, map, 'presentDays'));
  const remaining   = firstNum(cell(row, map, 'remaining'));
  const reportSalary = firstNum(cell(row, map, 'salaryAmount'));

  const detail = {
    permissions:  String(cell(row, map, 'permissions')  || '').trim(),
    presentDays:  String(cell(row, map, 'presentDays')  || '').trim(),
    absentDays:   String(cell(row, map, 'absentDays')   || '').trim(),
    hlop:         String(cell(row, map, 'hlop')         || '').trim(),
    extraWork:    String(cell(row, map, 'extraWork')    || '').trim(),
    late:         String(cell(row, map, 'late')         || '').trim(),
    carryForward: String(cell(row, map, 'carryForward') || '').trim(),
    salaryAdvance:String(cell(row, map, 'salaryAdvance')|| '').trim(),
    advPrev:      String(cell(row, map, 'advPrev')      || '').trim(),
    advThis:      String(cell(row, map, 'advThis')      || '').trim(),
    remaining:    String(cell(row, map, 'remaining')    || '').trim(),
    salaryAmount: String(cell(row, map, 'salaryAmount') || '').trim(),
  };

  const base = {
    reportType: 'employee',
    name, designation,
    status: emp ? 'matched' : 'unmatched',
    flags: [],
    paidDays: presentDays,
    balAdvance: remaining,
    detail,
    // raw numerics so the client can recompute on manual assignment
    raw: { salaryAmount: reportSalary, remaining },
  };

  if (!emp) return base;

  const gross = Number(emp.salary) || 0;
  const basicDA = Math.round(gross / 2);
  const hra = gross - basicDA;
  const pf = Number(emp.pf ?? emp.providentFund ?? 0) || 0;
  const pt = Number(emp.professionalTax ?? emp.profTax ?? 0) || 0;
  const totalDed = pf + pt;
  const net = gross - totalDed;

  const flags = [];
  if (gross <= 0) flags.push('No salary on employee record — earnings are 0.');
  if (reportSalary > 0 && Math.abs(reportSalary - net) > 1) {
    flags.push(`Report Salary Amount ₹${reportSalary.toLocaleString('en-IN')} ≠ structure net ₹${net.toLocaleString('en-IN')} — review.`);
  }

  return {
    ...base,
    flags,
    employeeId: emp.employeeId || '',
    userId: String(emp._id || ''),
    email: emp.email || '',
    department: emp.departmentName || emp.department || '',
    earnings: { basicDA, hra },
    deductions: { pf, pt },
    net,
    reportSalary,
    // exact upsert payload (minus month/year, filled at commit time)
    push: {
      employeeId: emp.employeeId || undefined,
      userId: String(emp._id || '') || undefined,
      email: emp.email || undefined,
      earnings:   { basicSalary: basicDA, hraAllowance: hra, performanceBonus: 0, otherEarnings: 0 },
      deductions: { incomeTax: 0, providentFund: pf, healthInsurance: 0, lopDeduction: 0, otherDeductions: pt },
    },
  };
}

function buildLabourRow(row, map, index) {
  const name        = String(cell(row, map, 'name') || '').trim();
  const designation = String(cell(row, map, 'designation') || '').trim();
  const emp = matchEmployee(index, name, designation);

  const workingDays = firstNum(cell(row, map, 'workingDays'));
  const perDay      = firstNum(cell(row, map, 'perDay'));
  const otAmount    = firstNum(cell(row, map, 'otAmount'));
  const reportTotal = firstNum(cell(row, map, 'totalAmount'));

  const wages = Math.round(workingDays * perDay);
  const totalPayable = wages + otAmount;

  const detail = {
    workingDays: String(cell(row, map, 'workingDays') || '').trim(),
    lop:         String(cell(row, map, 'lop')  || '').trim(),
    hlop:        String(cell(row, map, 'hlop') || '').trim(),
    ot:          String(cell(row, map, 'ot')   || '').trim(),
    otAmount:    String(cell(row, map, 'otAmount')  || '').trim(),
    perDay:      String(cell(row, map, 'perDay')    || '').trim(),
    totalAmount: String(cell(row, map, 'totalAmount')|| '').trim(),
  };

  const base = {
    reportType: 'labour',
    name, designation,
    status: emp ? 'matched' : 'unmatched',
    flags: [],
    paidDays: workingDays,
    balAdvance: 0,
    detail,
    // raw numerics so the client can recompute on manual assignment
    raw: { workingDays, perDay, otAmount, totalAmount: reportTotal },
  };

  if (!emp) return base;

  const pf = Number(emp.pf ?? emp.providentFund ?? 0) || 0;
  const pt = Number(emp.professionalTax ?? emp.profTax ?? 0) || 0;
  const totalDed = pf + pt;
  const net = totalPayable - totalDed;

  const flags = [];
  if (perDay <= 0) flags.push('Per Day Salary is 0 in the report — wages compute to 0.');
  if (reportTotal > 0 && Math.abs(reportTotal - totalPayable) > 1) {
    flags.push(`Report Total ₹${reportTotal.toLocaleString('en-IN')} ≠ (days×rate + OT) ₹${totalPayable.toLocaleString('en-IN')} — review.`);
  }

  // Labour wages → Basic + DA row, OT → HRA row (keeps the agreed payslip
  // layout/labels; labour has no Basic/HRA split of its own).
  return {
    ...base,
    flags,
    employeeId: emp.employeeId || '',
    userId: String(emp._id || ''),
    email: emp.email || '',
    department: emp.departmentName || emp.department || '',
    earnings: { basicDA: wages, hra: otAmount },
    deductions: { pf, pt },
    net,
    reportTotal,
    wages, otAmount, workingDays, perDay,
    push: {
      employeeId: emp.employeeId || undefined,
      userId: String(emp._id || '') || undefined,
      email: emp.email || undefined,
      earnings:   { basicSalary: wages, hraAllowance: otAmount, performanceBonus: 0, otherEarnings: 0 },
      deductions: { incomeTax: 0, providentFund: pf, healthInsurance: 0, lopDeduction: 0, otherDeductions: pt },
    },
  };
}

// ── public API ───────────────────────────────────────────────────────────────

/**
 * Parse a report buffer (xlsx/csv) into a reviewable preview.
 * @param {Buffer} buffer         - the uploaded file bytes
 * @param {Object} opts
 * @param {Array}  opts.employees - lean Employee docs for matching
 * @param {number} opts.month, opts.year
 * @param {string} [opts.forceType] - 'employee' | 'labour' fallback override
 * @returns {Object} preview
 */
function parseReport(buffer, { employees = [], month, year, forceType } = {}) {
  if (!XLSX) {
    return { success: false, message: 'The "xlsx" package is not installed on the HRMS server. Run `npm install` in the backend.' };
  }
  let wb;
  try {
    wb = XLSX.read(buffer, { type: 'buffer', cellDates: false, raw: false });
  } catch (e) {
    return { success: false, message: 'Could not read the file. Please upload a valid .xlsx or .csv report.' };
  }
  const sheetName = wb.SheetNames[0];
  const sheet = wb.Sheets[sheetName];
  if (!sheet) return { success: false, message: 'The uploaded file has no sheets.' };

  const matrix = XLSX.utils.sheet_to_json(sheet, { header: 1, blankrows: false, defval: '' });
  if (!matrix.length) return { success: false, message: 'The uploaded sheet is empty.' };

  let { index: hdrIdx, type } = findHeaderRow(matrix);
  if (!type && (forceType === 'employee' || forceType === 'labour')) {
    // fall back: assume the first non-empty row is the header
    hdrIdx = matrix.findIndex(r => r.some(c => String(c).trim() !== ''));
    type = forceType;
  }
  if (!type || hdrIdx < 0) {
    return {
      success: false,
      unknownFormat: true,
      message: 'Could not recognise this report. Expected an Employee report (Present Days / Salary Advance / Salary Amount) or a Labour report (Working Days / Per Day Salary / Total Amount). You can pick the type manually and re-upload.',
    };
  }

  const header = matrix[hdrIdx];
  const fieldDefs = type === 'labour' ? LABOUR_FIELDS : EMPLOYEE_FIELDS;
  const map = mapColumns(header, fieldDefs);
  if (map.name === undefined) {
    return { success: false, message: 'A Name column was not found in the report header.' };
  }

  const index = indexEmployees(employees);
  const build = type === 'labour' ? buildLabourRow : buildEmployeeRow;

  const rows = [];
  for (let i = hdrIdx + 1; i < matrix.length; i++) {
    const r = matrix[i] || [];
    if (!isDataRow(r, map)) continue;
    rows.push(build(r, map, index));
  }

  const matched   = rows.filter(r => r.status === 'matched');
  const unmatched = rows.filter(r => r.status === 'unmatched');
  const flagged   = matched.filter(r => r.flags && r.flags.length);

  return {
    success: true,
    reportType: type,
    sheetName,
    month: Number(month) || null,
    year: Number(year) || null,
    monthLabel: (month && year) ? `${MONTH_NAMES[Number(month)]} ${year}` : '',
    summary: {
      total: rows.length,
      matched: matched.length,
      unmatched: unmatched.length,
      flagged: flagged.length,
    },
    rows,
  };
}

module.exports = {
  parseReport,
  // exported for unit tests
  _internals: { norm, firstNum, sumNums, detectType, mapColumns, findHeaderRow, matchEmployee, EMPLOYEE_FIELDS, LABOUR_FIELDS },
};
