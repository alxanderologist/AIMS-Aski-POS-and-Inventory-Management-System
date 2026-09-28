BigInt.prototype.toJSON = function () {
  return Number(this);
};

require('dotenv').config();

// --- Startup env validation: fail fast and loudly instead of starting in a silently-broken or
// silently-insecure state (a missing JWT_SECRET used to only log a warning and 500 on first login;
// a missing DATABASE_URL wasn't checked until the first query ran). ---
(function assertValidEnv() {
  const problems = [];
  if (!process.env.DATABASE_URL) problems.push('DATABASE_URL is not set.');

  const jwtSecret = process.env.JWT_SECRET || '';
  if (!jwtSecret) {
    problems.push('JWT_SECRET is not set.');
  } else if (jwtSecret.length < 32 || jwtSecret === 'REPLACE_WITH_A_LONG_RANDOM_SECRET') {
    problems.push('JWT_SECRET looks weak or is still the placeholder value — use a long random string (see backend/.env.example).');
  }

  if (process.env.NODE_ENV === 'production' && !process.env.AI_SERVICE_KEY) {
    problems.push(
      'AI_SERVICE_KEY is not set. Required when NODE_ENV=production so the AI forecasting service ' +
        'cannot be called by anything but this backend (set the same value in ai-service/.env).',
    );
  }

  if (problems.length > 0) {
    console.error(
      '\nFATAL: invalid backend configuration:\n' +
        problems.map((p) => `  - ${p}`).join('\n') +
        '\n\nFix backend/.env and restart. See backend/.env.example for guidance.\n',
    );
    process.exit(1);
  }
})();

const express = require('express');
const path = require('path');
const fs = require('fs');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const cron = require('node-cron');

// Import Models
const { ProductModel, ProductError, ADJUSTMENT_REASONS, prisma } = require('./models/Product');
const { StockMovementModel, STOCK_MOVEMENT_TYPES } = require('./models/StockMovement');
const { StockBatchModel } = require('./models/StockBatch');
const { ReconciliationReportModel } = require('./models/ReconciliationReport');
const { ZReadingModel } = require('./models/ZReading');
const { SaleVoidModel } = require('./models/SaleVoid');
const TransactionModel = require('./models/Transaction');
const ReconciliationModel = require('./models/Reconciliation');
const DashboardModel = require('./models/Dashboard');
const DemandForecastModel = require('./models/DemandForecast');
const ForecastAccuracyModel = require('./models/ForecastAccuracy');
const FinanceModel = require('./models/FinanceModel');
const { PurchaseOrderModel, PurchasingError } = require('./models/PurchaseOrder');
const SupplierModel = require('./models/Supplier');
const { buildPurchaseOrderWorkbook } = require('./services/purchaseOrderExcel');
const { ReceivingReportModel } = require('./models/ReceivingReport');
const { buildReceivingReportWorkbook } = require('./services/receivingReportExcel');
const { PurchaseReturnModel } = require('./models/PurchaseReturn');
const { buildPurchaseReturnWorkbook } = require('./services/purchaseReturnExcel');
const {
  AuthModel,
  authenticateToken,
  requireRole,
  authenticateSocketToken,
  STALE_SESSION_ERROR,
} = require('./models/Auth');
const { UserModel, UserError } = require('./models/User');
const { AuditLogModel, AUDIT_ACTIONS } = require('./models/AuditLog');
const MemberModel = require('./models/Member');

// Import Services
const mailer = require('./services/mailer');
const lowStockAlerts = require('./services/lowStockAlerts');
const expiryAlerts = require('./services/expiryAlerts');
const forecastAlerts = require('./services/forecastAlerts');
const forecastSnapshots = require('./services/forecastSnapshots');
const receiptPrinter = require('./services/receiptPrinter');
const backup = require('./services/backup');
const { WIDTH: RECEIPT_WIDTH, renderToText, buildSaleReceipt, buildVoidReceipt } = require('./services/receiptLayout');
const posApproval = require('./services/posApproval');
const logger = require('./services/logger');

// Without a process manager (Phase 4: pm2/NSSM), a single unhandled rejection or thrown error
// outside any try/catch used to crash the process silently with no log line and no restart. Log it
// clearly, then exit so the process manager's restart-on-crash takes over — staying up in a
// possibly-corrupted state is worse than a clean restart.
process.on('uncaughtException', (err) => {
  logger.fatal({ err }, 'Uncaught exception — exiting');
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  logger.fatal({ err: reason }, 'Unhandled promise rejection — exiting');
  process.exit(1);
});

const app = express();
const PORT = process.env.PORT || 5000;

// Always allow the normal local dev origin; FRONTEND_URL (comma-separated) adds more without
// replacing it — e.g. a VS Code port-forwarded/tunneled URL when testing from another device, or
// the real frontend origin(s) in production. Shared by both the REST API's CORS and Socket.IO's —
// a request from anywhere else is rejected by both.
const allowedOrigins = ['http://localhost:5173', ...String(process.env.FRONTEND_URL || '').split(',').map((s) => s.trim()).filter(Boolean)];

// General-purpose IP rate limit, loose enough that a busy shift never throttles a legitimate
// cashier/admin (this is a small-store LAN deployment, not a public API) — layered on top of the
// existing per-username login lockout (services/loginThrottle.js), not replacing it.
const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
});

// Tighter limit specifically on login, since credential-guessing is the highest-value target for
// an IP-based limit (the per-username lockout already covers repeated guesses at one account; this
// covers an attacker spraying many different usernames from one IP).
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many login attempts from this network. Try again later.' },
});

// Middleware
app.use(helmet());
app.use(cors({ origin: allowedOrigins }));
app.use(generalLimiter);
app.use(express.json());
// Any successful write (a sale, a stock change, a purchase order, a supplier edit...) makes the cached
// forecast out of date, so the next forecast request recomputes.
app.use((req, res, next) => {
  if (req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'OPTIONS') {
    res.on('finish', () => {
      if (res.statusCode < 400) DemandForecastModel.invalidateForecastCache();
    });
  }
  next();
});

const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: allowedOrigins,
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE'],
  },
});

app.set('io', io);

// No auth required — for a process supervisor, uptime monitor, or load balancer to poll.
app.get('/api/health', async (req, res) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    res.json({ status: 'ok', db: 'connected', uptimeSeconds: Math.round(process.uptime()) });
  } catch (err) {
    logger.error({ err }, '[health] database check failed');
    res.status(503).json({ status: 'error', db: 'unreachable' });
  }
});

// Only logged-in, active users may open a socket. Finance broadcasts go to a
// role-scoped room so cashiers/inventory staff never receive them.
io.use(async (socket, next) => {
  const user = await authenticateSocketToken(socket.handshake.auth && socket.handshake.auth.token);
  if (!user) return next(new Error('Authentication required.'));
  socket.data.user = user;
  next();
});

// Role groups shared by the route guards below (ADMIN is always allowed by requireRole).
const ROLES = {
  POS: ['CASHIER', 'SUPERVISOR'],
  DASHBOARD: ['SUPERVISOR', 'INVENTORY', 'ACCOUNTING'],
  INVENTORY_READ: ['SUPERVISOR', 'INVENTORY'],
  INVENTORY_WRITE: ['INVENTORY'],
  PRODUCT_LOOKUP: ['CASHIER', 'SUPERVISOR', 'INVENTORY'],
  FORECAST: ['INVENTORY', 'ACCOUNTING'],
  FINANCE: ['ACCOUNTING'],
  RECONCILIATION_WRITE: ['CASHIER', 'SUPERVISOR', 'ACCOUNTING'],
  RECONCILIATION_READ: ['SUPERVISOR', 'ACCOUNTING'],
};

const FINANCE_ROOM = 'finance';
const DASHBOARD_ROOM = 'dashboard';

io.on('connection', (socket) => {
  const { role } = socket.data.user;
  if (role === 'ADMIN' || ROLES.FINANCE.includes(role)) socket.join(FINANCE_ROOM);
  if (role === 'ADMIN' || ROLES.DASHBOARD.includes(role)) socket.join(DASHBOARD_ROOM);
  logger.info(`Client connected to WebSocket: ${socket.id}`);
  socket.on('disconnect', () => {
    logger.info(`Client disconnected: ${socket.id}`);
  });
});

// --- ROUTES ---

// --- AUTH ROUTES ---
app.post('/api/auth/login', loginLimiter, async (req, res) => {
  try {
    const { username, password } = req.body;
    const result = await AuthModel.login(username, password);
    res.json(result);
  } catch (error) {
    res.status(error.status || 401).json({ error: error.message || 'Login failed' });
  }
});

// Self-service password change (any signed-in user). Requires the current password.
app.post('/api/auth/change-password', authenticateToken, async (req, res) => {
  try {
    await UserModel.changePassword(req.user.id, req.body.currentPassword, req.body.newPassword);
    res.json({ changed: true });
  } catch (error) {
    if (!(error instanceof UserError)) logger.error({ err: error }, 'Error changing password');
    const known = error instanceof UserError;
    res.status(known ? error.status : 500).json({ error: known ? error.message : 'Failed to change password' });
  }
});

// Lets the frontend verify a stored token is still valid (e.g. on page reload).
app.get('/api/auth/me', authenticateToken, (req, res) => {
  res.json({ user: req.user });
});

// Re-verifies the caller's own password. Used to gate sensitive admin screens
// (e.g. User Management) behind a fresh password prompt on top of the session JWT.
app.post('/api/auth/verify-password', authenticateToken, async (req, res) => {
  try {
    if (req.user.role !== 'ADMIN') {
      return res.status(403).json({ error: 'Admin access required.' });
    }
    await AuthModel.verifyPassword(req.user.id, req.body.password);
    res.json({ valid: true });
  } catch (error) {
    res.status(error.status || 401).json({ error: error.message || 'Invalid admin password. Access denied.' });
  }
});

// Only admins may manage user accounts. Must run after authenticateToken so req.user is set.
function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== 'ADMIN') {
    return res.status(403).json({ error: 'Admin access required.' });
  }
  next();
}

// --- USER MANAGEMENT ROUTES (admin only) ---
app.get('/api/users', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const users = await UserModel.findAll();
    res.json(users);
  } catch (error) {
    logger.error({ err: error }, 'Error fetching users');
    res.status(500).json({ error: 'Failed to fetch users' });
  }
});

app.post('/api/users', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const { fullName, username, password, role } = req.body;
    const user = await UserModel.create({ fullName, username, password, role }, req.user);
    res.status(201).json(user);
  } catch (error) {
    logger.error({ err: error }, 'Error creating user');
    res.status(400).json({ error: error.message || 'Failed to create user' });
  }
});

app.patch('/api/users/:id/role', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const user = await UserModel.updateRole(req.params.id, req.body.role, req.user);
    res.json(user);
  } catch (error) {
    logger.error({ err: error }, 'Error updating user role');
    res.status(400).json({ error: error.message || 'Failed to update role' });
  }
});

app.patch('/api/users/:id/status', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const user = await UserModel.setActive(req.params.id, req.body.isActive, req.user);
    res.json(user);
  } catch (error) {
    logger.error({ err: error }, 'Error updating user status');
    res.status(400).json({ error: error.message || 'Failed to update status' });
  }
});

// Soft delete: does not remove the row, just deactivates it and hides it from the user list.
app.delete('/api/users/:id', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const user = await UserModel.softDelete(req.params.id, req.user);
    res.json(user);
  } catch (error) {
    logger.error({ err: error }, 'Error deleting user');
    res.status(400).json({ error: error.message || 'Failed to delete user' });
  }
});

// Set (body: { pin: "1234" }) or clear (body: { pin: null }) a supervisor's POS approval PIN.
app.put('/api/users/:id/pin', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const pin = req.body.pin === null ? null : String(req.body.pin ?? '');
    const user = await UserModel.setPin(req.params.id, pin, req.user);
    res.json(user);
  } catch (error) {
    logger.error({ err: error }, 'Error updating user PIN');
    res.status(400).json({ error: error.message || 'Failed to update PIN' });
  }
});

app.post('/api/users/:id/reset-password', authenticateToken, requireAdmin, async (req, res) => {
  try {
    const result = await UserModel.resetPassword(req.params.id, req.user);
    res.json(result);
  } catch (error) {
    logger.error({ err: error }, 'Error resetting password');
    res.status(400).json({ error: error.message || 'Failed to reset password' });
  }
});

// Admin activity log (newest first). Filters: action, targetUserId, actorId, from, to (dates), limit, before (last id loaded).
app.get('/api/audit-log', authenticateToken, requireAdmin, async (req, res) => {
  try {
    if (req.query.action && !AUDIT_ACTIONS.includes(req.query.action)) {
      return res.status(400).json({ error: `action must be one of: ${AUDIT_ACTIONS.join(', ')}` });
    }
    res.json(await AuditLogModel.findAll(req.query));
  } catch (error) {
    logger.error({ err: error }, 'Error fetching audit log');
    res.status(500).json({ error: 'Failed to fetch audit log' });
  }
});

// 1. Get All Products (Includes supplier relations and computed status)
app.get('/api/products', authenticateToken, requireRole(...ROLES.PRODUCT_LOOKUP), async (req, res) => {
  try {
    const { page, limit, search, category } = req.query;
    const products = await ProductModel.findAll({ page, limit, search, category });
    res.json(products);
  } catch (error) {
    logger.error({ err: error }, 'Error fetching products');
    res.status(500).json({ error: 'Failed to fetch products' });
  }
});

// Maps product/inventory failures onto HTTP: typed errors carry their own status, anything
// unexpected is a generic 500.
const sendProductError = (res, error, action) => {
  logger.error({ err: error }, `Error ${action}`);
  if (error instanceof ProductError) return res.status(error.status).json({ error: error.message });
  return res.status(500).json({ error: `Failed to ${action}` });
};

// 2. Create New Product (any starting stock is logged as an OPENING movement)
app.post('/api/products', authenticateToken, requireRole(...ROLES.INVENTORY_WRITE), async (req, res) => {
  try {
    const product = await ProductModel.create(req.body, req.user.id);
    res.status(201).json(product);
  } catch (error) {
    sendProductError(res, error, 'create product');
  }
});

// 2b. Update a product (expiry, minStock, prices, codes...). Stock only moves through the ledger routes.
app.patch('/api/products/:id', authenticateToken, requireRole(...ROLES.INVENTORY_WRITE), async (req, res) => {
  try {
    if (req.body.stock !== undefined || req.body.currentStock !== undefined) {
      return res.status(400).json({ error: 'Stock cannot be edited directly. Use add-stock or adjust-stock so the change is logged.' });
    }
    const { before, after } = await ProductModel.update(req.params.id, req.body);
    if (!after) return res.status(404).json({ error: 'Product not found' });
    res.json(after);

    // Fire-and-forget expiry-crossing alert after responding.
    if (req.body.expiryDate !== undefined) {
      const crossed = expiryAlerts.detectExpiryCrossing(before.expiryDate, after.expiryDate);
      if (crossed) {
        expiryAlerts.notifyExpiryCrossing(after);
      }
    }
  } catch (error) {
    sendProductError(res, error, 'update product');
  }
});

// 3. Add Stock (logged as MANUAL_ADD)
app.patch('/api/products/:id/add-stock', authenticateToken, requireRole(...ROLES.INVENTORY_WRITE), async (req, res) => {
  try {
    const { quantity, supplierId } = req.body;
    const updatedProduct = await ProductModel.addStock(req.params.id, quantity, supplierId, req.user.id);
    req.app.get('io').to(DASHBOARD_ROOM).emit('stock_updated', { products: [updatedProduct] });
    res.json(updatedProduct);
  } catch (error) {
    sendProductError(res, error, 'update stock');
  }
});

// 3b. Manual stock correction with a required reason (logged as ADJUSTMENT)
app.post('/api/products/:id/adjust-stock', authenticateToken, requireRole(...ROLES.INVENTORY_WRITE), async (req, res) => {
  try {
    const { quantityChange, countedQuantity, reason, notes } = req.body;
    const updatedProduct = await ProductModel.adjustStock(req.params.id, { quantityChange, countedQuantity, reason, notes }, req.user.id);
    req.app.get('io').to(DASHBOARD_ROOM).emit('stock_updated', { products: [updatedProduct] });
    res.json(updatedProduct);
  } catch (error) {
    sendProductError(res, error, 'adjust stock');
  }
});

// 3c. Allowed adjustment reasons, so the UI never hard-codes the list
app.get('/api/stock-adjustment-reasons', authenticateToken, requireRole(...ROLES.INVENTORY_WRITE), (req, res) => {
  res.json(ADJUSTMENT_REASONS);
});

// 3d. Stock movement ledger (newest first). Filters: productId, type, from, to (dates), limit, before (last id loaded).
app.get('/api/stock-movements', authenticateToken, requireRole(...ROLES.INVENTORY_READ), async (req, res) => {
  try {
    if (req.query.type && !STOCK_MOVEMENT_TYPES.includes(req.query.type)) {
      return res.status(400).json({ error: `type must be one of: ${STOCK_MOVEMENT_TYPES.join(', ')}` });
    }
    res.json(await StockMovementModel.findAll(req.query));
  } catch (error) {
    logger.error({ err: error }, 'Error fetching stock movements');
    res.status(500).json({ error: 'Failed to fetch stock movements' });
  }
});

// 3d-2. The whole ledger across every product (unpaginated), for the Ledger/History report's Export button
app.get('/api/stock-movements/export', authenticateToken, requireRole(...ROLES.INVENTORY_READ), async (req, res) => {
  try {
    if (req.query.type && !STOCK_MOVEMENT_TYPES.includes(req.query.type)) {
      return res.status(400).json({ error: `type must be one of: ${STOCK_MOVEMENT_TYPES.join(', ')}` });
    }
    res.json(await StockMovementModel.findAllForExport(req.query));
  } catch (error) {
    logger.error({ err: error }, 'Error exporting stock movements');
    res.status(500).json({ error: 'Failed to export stock movements' });
  }
});

// 3d-3. Stock & sales reconciliation report for a date range (Phase 5) — cross-checks the
// ledger's own math against itself and against the POS's reported sales totals. Deliberately not
// /api/reconciliation — that path is already the cashier's EOD cash-count reconciliation below.
app.get('/api/reconciliation-report', authenticateToken, requireRole(...ROLES.INVENTORY_READ), async (req, res) => {
  try {
    res.json(await ReconciliationReportModel.build({ from: req.query.from, to: req.query.to }));
  } catch (error) {
    if (error instanceof ReconciliationReportModel.ReconciliationError) {
      return res.status(error.status).json({ error: error.message });
    }
    logger.error({ err: error }, 'Error building reconciliation report');
    res.status(500).json({ error: 'Failed to build reconciliation report' });
  }
});

// 3e. One product's movement history
app.get('/api/products/:id/movements', authenticateToken, requireRole(...ROLES.INVENTORY_READ), async (req, res) => {
  try {
    const productId = parseInt(req.params.id, 10);
    if (!productId) return res.status(400).json({ error: 'Invalid product id' });
    res.json(await StockMovementModel.findAll({ ...req.query, productId }));
  } catch (error) {
    logger.error({ err: error }, 'Error fetching product movements');
    res.status(500).json({ error: 'Failed to fetch product movements' });
  }
});

// 3f. That product's whole ledger (unpaginated), for the Stock History modal's Export button
app.get('/api/products/:id/movements/export', authenticateToken, requireRole(...ROLES.INVENTORY_READ), async (req, res) => {
  try {
    const productId = parseInt(req.params.id, 10);
    if (!productId) return res.status(400).json({ error: 'Invalid product id' });
    res.json(await StockMovementModel.findAllForExport({ ...req.query, productId }));
  } catch (error) {
    logger.error({ err: error }, 'Error exporting product movements');
    res.status(500).json({ error: 'Failed to export product movements' });
  }
});

// 3g. That product's cost batches (FIFO-consumed by sales/returns/adjustments), for the Stock
// History modal's Batches tab
app.get('/api/products/:id/batches', authenticateToken, requireRole(...ROLES.INVENTORY_READ), async (req, res) => {
  try {
    const productId = parseInt(req.params.id, 10);
    if (!productId) return res.status(400).json({ error: 'Invalid product id' });
    res.json(await StockBatchModel.findByProduct(productId));
  } catch (error) {
    logger.error({ err: error }, 'Error fetching product batches');
    res.status(500).json({ error: 'Failed to fetch product batches' });
  }
});

// 4. Search Product by Barcode or 6-digit Code
app.get('/api/products/barcode/:code', authenticateToken, requireRole(...ROLES.PRODUCT_LOOKUP), async (req, res) => {
  try {
    const products = await ProductModel.findByBarcode(req.params.code);
    if (!products || products.length === 0) {
      return res.status(404).json({ message: 'Product not found' });
    }
    res.json(products);
  } catch (error) {
    logger.error({ err: error }, 'Error finding barcode');
    res.status(500).json({ error: 'Barcode lookup failed' });
  }
});

// Maps supplier failures onto HTTP: typed errors carry their own status, anything unexpected is a 500.
const sendSupplierError = (res, error, action) => {
  logger.error({ err: error }, `Error ${action}`);
  if (error instanceof SupplierModel.SupplierError) return res.status(error.status).json({ error: error.message });
  return res.status(500).json({ error: `Failed to ${action}` });
};

// 5. Get All Suppliers (for inventory dropdowns and the Supplier Management page)
app.get('/api/suppliers', authenticateToken, requireRole(...ROLES.INVENTORY_READ), async (req, res) => {
  try {
    const suppliers = await SupplierModel.findAll();
    res.json(suppliers);
  } catch (error) {
    sendSupplierError(res, error, 'fetch suppliers');
  }
});

app.post('/api/suppliers', authenticateToken, requireRole(...ROLES.INVENTORY_WRITE), async (req, res) => {
  try {
    const supplier = await SupplierModel.create(req.body);
    res.status(201).json(supplier);
  } catch (error) {
    sendSupplierError(res, error, 'create supplier');
  }
});

// Edits a supplier's details (name, contact info, and lead time -- lead time drives every one of its
// products' reorder points). Partial update: only fields present in the body are changed.
app.patch('/api/suppliers/:id', authenticateToken, requireRole(...ROLES.INVENTORY_WRITE), async (req, res) => {
  try {
    const supplier = await SupplierModel.update(req.params.id, req.body);
    if (!supplier) return res.status(404).json({ error: 'Supplier not found' });
    res.json(supplier);
  } catch (error) {
    sendSupplierError(res, error, 'update supplier');
  }
});

// --- PURCHASE ORDER ROUTES ---

// Maps purchasing failures onto HTTP: typed errors carry their own status, a vanished session is 401,
// anything unexpected is a generic 500.
const sendPurchasingError = (res, error, action) => {
  logger.error({ err: error }, `Error ${action}`);
  if (error.message === STALE_SESSION_ERROR) return res.status(401).json({ error: error.message });
  if (error instanceof PurchasingError) return res.status(error.status).json({ error: error.message });
  return res.status(500).json({ error: `Failed to ${action}` });
};

// Create a Purchase Order (DRAFT or PENDING) for one supplier
app.post('/api/purchase-orders', authenticateToken, requireRole(...ROLES.INVENTORY_WRITE), async (req, res) => {
  try {
    const { supplierId, supplierName, items, terms, remarks, discount, shipTo, shippingAddress, purpose, tagging, status } = req.body;
    const purchaseOrder = await PurchaseOrderModel.create({
      supplierId,
      supplierName,
      items,
      terms,
      remarks,
      discount,
      shipTo,
      shippingAddress,
      purpose,
      tagging,
      status,
      preparedBy: req.user.username,
      createdById: req.user.id,
    });
    res.status(201).json(purchaseOrder);
  } catch (error) {
    sendPurchasingError(res, error, 'create purchase order');
  }
});

// Download the styled .xlsx for a saved Purchase Order
app.get('/api/purchase-orders/:id/export', authenticateToken, requireRole(...ROLES.INVENTORY_WRITE), async (req, res) => {
  try {
    const purchaseOrder = await PurchaseOrderModel.findById(req.params.id);
    if (!purchaseOrder) {
      return res.status(404).json({ error: 'Purchase order not found' });
    }

    const workbook = await buildPurchaseOrderWorkbook(purchaseOrder);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${purchaseOrder.poNumber}.xlsx"`);
    await workbook.xlsx.write(res);
    res.end();
  } catch (error) {
    logger.error({ err: error }, 'Error exporting purchase order');
    res.status(500).json({ error: 'Failed to export purchase order' });
  }
});

// Purchase Orders awaiting a Receiving Report
app.get('/api/purchase-orders/pending', authenticateToken, requireRole(...ROLES.INVENTORY_WRITE), async (req, res) => {
  try {
    const pendingOrders = await PurchaseOrderModel.findPending();
    res.json(pendingOrders);
  } catch (error) {
    logger.error({ err: error }, 'Error fetching pending purchase orders');
    res.status(500).json({ error: 'Failed to fetch pending purchase orders' });
  }
});

// All Purchase Orders, for the "Purchase Orders" browse window (optionally filtered by PO number)
app.get('/api/purchase-orders', authenticateToken, requireRole(...ROLES.INVENTORY_WRITE), async (req, res) => {
  try {
    const purchaseOrders = await PurchaseOrderModel.findAll(req.query.search);
    res.json(purchaseOrders);
  } catch (error) {
    logger.error({ err: error }, 'Error fetching purchase orders');
    res.status(500).json({ error: 'Failed to fetch purchase orders' });
  }
});

// A single Purchase Order, for the "Open" view/edit action
app.get('/api/purchase-orders/:id', authenticateToken, requireRole(...ROLES.INVENTORY_WRITE), async (req, res) => {
  try {
    const purchaseOrder = await PurchaseOrderModel.findById(req.params.id);
    if (!purchaseOrder) {
      return res.status(404).json({ error: 'Purchase order not found' });
    }
    res.json(purchaseOrder);
  } catch (error) {
    logger.error({ err: error }, 'Error fetching purchase order');
    res.status(500).json({ error: 'Failed to fetch purchase order' });
  }
});

// Edit a DRAFT purchase order (header and items are replaced)
app.put('/api/purchase-orders/:id', authenticateToken, requireRole(...ROLES.INVENTORY_WRITE), async (req, res) => {
  try {
    const { supplierId, supplierName, items, terms, remarks, discount, shipTo, shippingAddress, purpose, tagging } = req.body;
    const purchaseOrder = await PurchaseOrderModel.updateDraft(req.params.id, {
      supplierId,
      supplierName,
      items,
      terms,
      remarks,
      discount,
      shipTo,
      shippingAddress,
      purpose,
      tagging,
    });
    res.json(purchaseOrder);
  } catch (error) {
    sendPurchasingError(res, error, 'update purchase order');
  }
});

// Submit a DRAFT so it becomes PENDING (receivable)
app.post('/api/purchase-orders/:id/submit', authenticateToken, requireRole(...ROLES.INVENTORY_WRITE), async (req, res) => {
  try {
    res.json(await PurchaseOrderModel.submit(req.params.id));
  } catch (error) {
    sendPurchasingError(res, error, 'submit purchase order');
  }
});

// Cancel a DRAFT or PENDING purchase order
app.post('/api/purchase-orders/:id/cancel', authenticateToken, requireRole(...ROLES.INVENTORY_WRITE), async (req, res) => {
  try {
    res.json(await PurchaseOrderModel.cancel(req.params.id));
  } catch (error) {
    sendPurchasingError(res, error, 'cancel purchase order');
  }
});

// Delete a DRAFT or CANCELLED purchase order
app.delete('/api/purchase-orders/:id', authenticateToken, requireRole(...ROLES.INVENTORY_WRITE), async (req, res) => {
  try {
    await PurchaseOrderModel.delete(req.params.id);
    res.status(204).end();
  } catch (error) {
    sendPurchasingError(res, error, 'delete purchase order');
  }
});

// --- RECEIVING REPORT ROUTES ---

// File a Receiving Report against a pending Purchase Order (tops up stock/cost, closes the PO)
app.post('/api/receiving-reports', authenticateToken, requireRole(...ROLES.INVENTORY_WRITE), async (req, res) => {
  try {
    const { purchaseOrderId, items, deliveryNote, invoiceNo, remarks } = req.body;
    const receivingReport = await ReceivingReportModel.create({
      purchaseOrderId,
      items,
      deliveryNote,
      invoiceNo,
      remarks,
      receivedById: req.user.id,
    });
    const changedProducts = await ProductModel.findManyFormatted(receivingReport.items.map((i) => i.productId));
    req.app.get('io').to(DASHBOARD_ROOM).emit('stock_updated', { products: changedProducts });
    res.status(201).json(receivingReport);
  } catch (error) {
    sendPurchasingError(res, error, 'create receiving report');
  }
});

// Download the styled .xlsx for a saved Receiving Report
app.get('/api/receiving-reports/:id/export', authenticateToken, requireRole(...ROLES.INVENTORY_WRITE), async (req, res) => {
  try {
    const receivingReport = await ReceivingReportModel.findById(req.params.id);
    if (!receivingReport) {
      return res.status(404).json({ error: 'Receiving report not found' });
    }

    const workbook = await buildReceivingReportWorkbook(receivingReport);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${receivingReport.rrNumber}.xlsx"`);
    await workbook.xlsx.write(res);
    res.end();
  } catch (error) {
    logger.error({ err: error }, 'Error exporting receiving report');
    res.status(500).json({ error: 'Failed to export receiving report' });
  }
});

// All Receiving Reports, for the "Create Purchase Return" picker
app.get('/api/receiving-reports', authenticateToken, requireRole(...ROLES.INVENTORY_WRITE), async (req, res) => {
  try {
    const receivingReports = await ReceivingReportModel.findAll({ supplierId: req.query.supplierId });
    res.json(receivingReports);
  } catch (error) {
    logger.error({ err: error }, 'Error fetching receiving reports');
    res.status(500).json({ error: 'Failed to fetch receiving reports' });
  }
});

// A single Receiving Report, for the "View Receiving Report" action
app.get('/api/receiving-reports/:id', authenticateToken, requireRole(...ROLES.INVENTORY_WRITE), async (req, res) => {
  try {
    const receivingReport = await ReceivingReportModel.findById(req.params.id);
    if (!receivingReport) {
      return res.status(404).json({ error: 'Receiving report not found' });
    }
    res.json(receivingReport);
  } catch (error) {
    logger.error({ err: error }, 'Error fetching receiving report');
    res.status(500).json({ error: 'Failed to fetch receiving report' });
  }
});

// --- PURCHASE RETURN ROUTES ---

// File a Purchase Return against a supplier — each item names which Receiving Report (delivery
// batch) it's drawn from, so one return can span several of that supplier's deliveries.
app.post('/api/purchase-returns', authenticateToken, requireRole(...ROLES.INVENTORY_WRITE), async (req, res) => {
  try {
    const { supplierId, items, reason, remarks } = req.body;
    const purchaseReturn = await PurchaseReturnModel.create({
      supplierId,
      items,
      reason,
      remarks,
      createdById: req.user.id,
    });
    const changedProducts = await ProductModel.findManyFormatted(purchaseReturn.items.map((i) => i.productId));
    req.app.get('io').to(DASHBOARD_ROOM).emit('stock_updated', { products: changedProducts });
    res.status(201).json(purchaseReturn);
  } catch (error) {
    sendPurchasingError(res, error, 'create purchase return');
  }
});

// All Purchase Returns
app.get('/api/purchase-returns', authenticateToken, requireRole(...ROLES.INVENTORY_WRITE), async (req, res) => {
  try {
    res.json(await PurchaseReturnModel.findAll());
  } catch (error) {
    logger.error({ err: error }, 'Error fetching purchase returns');
    res.status(500).json({ error: 'Failed to fetch purchase returns' });
  }
});

// A single Purchase Return
app.get('/api/purchase-returns/:id', authenticateToken, requireRole(...ROLES.INVENTORY_WRITE), async (req, res) => {
  try {
    const purchaseReturn = await PurchaseReturnModel.findById(req.params.id);
    if (!purchaseReturn) {
      return res.status(404).json({ error: 'Purchase return not found' });
    }
    res.json(purchaseReturn);
  } catch (error) {
    logger.error({ err: error }, 'Error fetching purchase return');
    res.status(500).json({ error: 'Failed to fetch purchase return' });
  }
});

// Download the styled .xlsx for a saved Purchase Return
app.get('/api/purchase-returns/:id/export', authenticateToken, requireRole(...ROLES.INVENTORY_WRITE), async (req, res) => {
  try {
    const purchaseReturn = await PurchaseReturnModel.findById(req.params.id);
    if (!purchaseReturn) {
      return res.status(404).json({ error: 'Purchase return not found' });
    }

    const workbook = await buildPurchaseReturnWorkbook(purchaseReturn);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${purchaseReturn.returnNo}.xlsx"`);
    await workbook.xlsx.write(res);
    res.end();
  } catch (error) {
    logger.error({ err: error }, 'Error exporting purchase return');
    res.status(500).json({ error: 'Failed to export purchase return' });
  }
});

// --- BALIK TANGKILIK MEMBERS ---

// Read access is shared by the POS "attach member" lookup and the admin Members page.
const MEMBERS_READ = [...ROLES.POS, ...ROLES.INVENTORY_READ];

// Name/card-number search for the POS "attach member" lookup box (and, with no query, the
// admin Members page's full list).
app.get('/api/members', authenticateToken, requireRole(...MEMBERS_READ), async (req, res) => {
  try {
    if (req.query.search) return res.json(await MemberModel.search(req.query.search));
    res.json(await MemberModel.findAll());
  } catch (error) {
    logger.error({ err: error }, 'Error fetching members');
    res.status(500).json({ error: 'Failed to fetch members' });
  }
});

// A member's points-earning history (newest first), for the admin Members page.
app.get('/api/members/:id/points-history', authenticateToken, requireRole(...MEMBERS_READ), async (req, res) => {
  try {
    res.json(await MemberModel.findPointsHistory(req.params.id));
  } catch (error) {
    if (error instanceof MemberModel.MemberError) {
      return res.status(error.status).json({ error: error.message });
    }
    logger.error({ err: error }, 'Error fetching member points history');
    res.status(500).json({ error: 'Failed to fetch points history' });
  }
});

// Exact card-number lookup, e.g. after scanning/typing a physical card.
app.get('/api/members/:cardNumber', authenticateToken, requireRole(...MEMBERS_READ), async (req, res) => {
  try {
    res.json(await MemberModel.findByCardNumber(req.params.cardNumber));
  } catch (error) {
    if (error instanceof MemberModel.MemberError) {
      return res.status(error.status).json({ error: error.message });
    }
    logger.error({ err: error }, 'Error looking up member');
    res.status(500).json({ error: 'Failed to look up member' });
  }
});

// Registers a new Balik Tangkilik member, from the POS.
app.post('/api/members', authenticateToken, requireRole(...ROLES.POS), async (req, res) => {
  try {
    const member = await MemberModel.create(req.body);
    res.status(201).json(member);
  } catch (error) {
    if (error instanceof MemberModel.MemberError) {
      return res.status(error.status).json({ error: error.message });
    }
    logger.error({ err: error }, 'Error registering member');
    res.status(500).json({ error: 'Failed to register member' });
  }
});

// --- POS SUPERVISOR APPROVAL ---

// Exchanges a supervisor's PIN for a short-lived approval token. The token is bound to the
// requesting cashier and action, and is presented back on checkout / X-Reading.
app.post('/api/pos/approve', authenticateToken, requireRole(...ROLES.POS), async (req, res) => {
  try {
    const { pin, action, discountPercent } = req.body;
    const result = await posApproval.requestApproval({ requester: req.user, pin, action, discountPercent });
    res.json(result);
  } catch (error) {
    if (error instanceof posApproval.ApprovalError) {
      return res.status(error.status).json({ error: error.message, code: error.code });
    }
    logger.error({ err: error }, 'Approval error');
    res.status(500).json({ error: 'Failed to verify supervisor PIN' });
  }
});

// --- TRANSACTIONS ROUTES ---

// Create New Transaction (Checkout)
app.post('/api/transactions', authenticateToken, requireRole(...ROLES.POS), async (req, res) => {
  try {
    const io = req.app.get('io');
    const result = await TransactionModel.createCheckout({ ...req.body, cashierId: req.user.id }, io);

    // Broadcast updated financial metrics over WebSocket
    const updatedFinance = await FinanceModel.getSummary();
    io.to(FINANCE_ROOM).emit('finance_updated', updatedFinance);

    res.status(201).json(result);

    // Fire-and-forget silent receipt print. Never blocks or fails the sale.
    receiptPrinter
      .printReceipt({
        cashier: req.user.username,
        transactionNo: result.transactionNo || result.id,
        createdAt: result.createdAt,
        items: result.items,
        subtotal: result.subtotal,
        discountAmount: result.discountAmount,
        totalAmount: result.totalAmount,
        paymentMethod: result.paymentMethod,
        referenceNumber: result.referenceNumber,
        amountPaid: req.body.amountPaid ?? result.totalAmount,
      })
      .catch((err) => logger.error({ err }, '[receipt-printer] Unexpected print error'));

    // Fire-and-forget low-stock crossing alert. Never blocks or fails the sale.
    const stockUpdates = result && result._stockUpdates;
    if (Array.isArray(stockUpdates) && stockUpdates.length > 0) {
      const crossings = lowStockAlerts.detectCrossings(stockUpdates);
      if (crossings.length > 0) {
        lowStockAlerts.notifyCrossings(crossings);
      }
    }
  } catch (error) {
    if (error instanceof TransactionModel.CheckoutError || error instanceof posApproval.ApprovalError) {
      return res.status(error.status).json({ error: error.message, code: error.code });
    }
    logger.error({ err: error }, 'Transaction error');
    if (error.message === STALE_SESSION_ERROR) {
      return res.status(401).json({ error: error.message });
    }
    res.status(500).json({ error: 'Transaction failed' });
  }
});

// Silent on-demand print (used by the POS "Print" preview button, and for
// reprints) — same printer path as the automatic post-checkout print above.
app.post('/api/print/receipt', authenticateToken, requireRole(...ROLES.POS), async (req, res) => {
  try {
    const result = await receiptPrinter.printReceipt({ ...req.body, cashier: req.user.username });
    res.json(result);
  } catch (error) {
    logger.error({ err: error }, 'Manual receipt print failed');
    res.status(500).json({ printed: false, reason: 'error', error: error.message });
  }
});

// A past sale's receipt as on-screen text, character-for-character what a reprint puts on paper
// (so it carries the REPRINT marker too). Opened by clicking a sale in the Subsidiary Ledger or a
// product's Stock History, so it has the same roles as those screens.
app.get('/api/transactions/:id/receipt', authenticateToken, requireRole(...ROLES.INVENTORY_READ), async (req, res) => {
  try {
    const sale = await TransactionModel.findReceiptData(req.params.id);
    if (!sale) return res.status(404).json({ error: 'Transaction not found' });
    const lines = renderToText(buildSaleReceipt(sale, { reprintedAt: new Date() }));
    res.json({ id: sale.id, reference: sale.transactionNo, createdAt: sale.createdAt, width: RECEIPT_WIDTH, lines });
  } catch (error) {
    logger.error({ err: error }, 'Error building receipt preview');
    res.status(500).json({ error: 'Failed to load receipt' });
  }
});

// Reprints a past sale's receipt on the thermal printer (marked REPRINT). Unlike the checkout
// print this waits for the printer, so the screen can say whether it actually printed.
app.post('/api/transactions/:id/reprint', authenticateToken, requireRole(...ROLES.INVENTORY_READ), async (req, res) => {
  try {
    const sale = await TransactionModel.findReceiptData(req.params.id);
    if (!sale) return res.status(404).json({ error: 'Transaction not found' });
    res.json(await receiptPrinter.printReceipt(sale, { reprint: true }));
  } catch (error) {
    logger.error({ err: error }, 'Error reprinting receipt');
    res.status(500).json({ printed: false, reason: 'error', error: error.message });
  }
});

// Get All Transactions
app.get('/api/transactions', authenticateToken, requireRole(...ROLES.FINANCE), async (req, res) => {
  try {
    const transactions = await TransactionModel.findAll();
    res.json(transactions);
  } catch (error) {
    logger.error({ err: error }, 'Error fetching transactions');
    res.status(500).json({ error: 'Failed to fetch transactions' });
  }
});

// One row per transaction for a given month (?month=YYYY-MM, defaults to the current store-local month),
// for the Sales Report page.
app.get('/api/sales-report', authenticateToken, requireRole(...ROLES.FINANCE), async (req, res) => {
  try {
    res.json(await TransactionModel.findForReport({ month: req.query.month }));
  } catch (error) {
    logger.error({ err: error }, 'Error building sales report');
    res.status(500).json({ error: 'Failed to build sales report' });
  }
});

// --- DASHBOARD ROUTE ---
app.get('/api/dashboard/summary', authenticateToken, requireRole(...ROLES.DASHBOARD), async (req, res) => {
  try {
    const [todayRevenue, lowStockCount, dailySalesTrend, expiryWatchList, recentTransactions] = await Promise.all([
      DashboardModel.getTodayRevenue(),
      DashboardModel.getLowStockCount(10), // Threshold = 10 items
      DashboardModel.getDailySalesTrend(),
      DashboardModel.getExpiryWatchList(30),
      TransactionModel.findAll({ limit: 5 }),
    ]);

    res.json({
      todayRevenue,
      lowStockCount,
      dailySalesTrend,
      expiryWatchList,
      recentTransactions,
    });
  } catch (error) {
    logger.error({ err: error }, 'Error fetching dashboard summary');
    res.status(500).json({ error: 'Failed to fetch dashboard metrics' });
  }
});

// --- AI FORECASTING ROUTE ---
app.get('/api/forecast', authenticateToken, requireRole(...ROLES.DASHBOARD), async (req, res) => {
  try {
    const { days = 30, asOf, refresh } = req.query;
    if (asOf !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(String(asOf))) {
      return res.status(400).json({ success: false, message: 'asOf must be a date like 2026-09-21.' });
    }
    const forecastData = await DemandForecastModel.getForecastData(days, { asOf, refresh: refresh === '1' || refresh === 'true' });
    // Keep a copy of today's forecast so it can be graded later (no-op after the first request of the day).
    if (asOf === undefined) forecastSnapshots.saveFromRequest(forecastData);

    res.json({
      success: true,
      data: forecastData,
    });
  } catch (error) {
    logger.error({ err: error }, 'Error fetching AI forecast');
    res.status(500).json({
      success: false,
      message: 'Failed to generate AI demand forecast',
      error: error.message,
    });
  }
});

// --- FINANCE CONTROL ROUTE ---
app.get('/api/finance/summary', authenticateToken, requireRole(...ROLES.FINANCE), async (req, res) => {
  try {
    const data = await FinanceModel.getSummary();
    res.json(data);
  } catch (error) {
    logger.error({ err: error }, 'Error fetching finance summary');
    res.status(500).json({ error: 'Failed to fetch financial audit summary' });
  }
});

// --- RECONCILIATION ROUTES ---

// X-Reading needs a supervisor approval token (POST /api/pos/approve with action XREAD),
// sent in the X-Approval-Token header.
const sendApprovalOrReconError = (res, error) => {
  if (error instanceof posApproval.ApprovalError || error instanceof ReconciliationModel.ReconciliationError) {
    res.status(error.status).json({ error: error.message, code: error.code });
    return true;
  }
  return false;
};

// Get today's X-Reading figures for the signed-in cashier
app.get('/api/reconciliation/expected-cash', authenticateToken, requireRole(...ROLES.RECONCILIATION_WRITE), async (req, res) => {
  try {
    await posApproval.verifyApproval(req.headers['x-approval-token'], { action: 'XREAD', cashierId: req.user.id });
    const data = await ReconciliationModel.getExpectedCash(req.user.id);
    return res.status(200).json(data);
  } catch (error) {
    if (sendApprovalOrReconError(res, error)) return;
    logger.error({ err: error }, 'Error calculating expected cash');
    return res.status(500).json({
      error: 'Failed to calculate expected cash',
      expectedCash: 0,
      grossSales: 0,
    });
  }
});

// Save End of Day Reconciliation (one per cashier per day; all totals computed server-side)
app.post('/api/reconciliation', authenticateToken, requireRole(...ROLES.RECONCILIATION_WRITE), async (req, res) => {
  try {
    const approval = await posApproval.verifyApproval(req.headers['x-approval-token'], {
      action: 'XREAD',
      cashierId: req.user.id,
    });
    const record = await ReconciliationModel.create({
      denominations: req.body.denominations,
      notes: req.body.notes,
      cashierId: req.user.id,
    });
    posApproval.consumeApproval(approval);

    // Broadcast updated financial metrics over WebSocket
    const io = req.app.get('io');
    const updatedFinance = await FinanceModel.getSummary();
    io.to(FINANCE_ROOM).emit('finance_updated', updatedFinance);

    res.status(201).json({ message: 'Reconciliation Submitted', record });

    // Fire-and-forget silent print, same pattern as the checkout receipt and Z-Reading —
    // never blocks or fails the request. Mirrors what "Export X-Reading" downloads as a sheet.
    receiptPrinter
      .printXReading(record)
      .catch((err) => logger.error({ err }, '[receipt-printer] Unexpected X-Reading print error'));
  } catch (error) {
    if (sendApprovalOrReconError(res, error)) return;
    logger.error({ err: error }, 'Error creating reconciliation');
    if (error.message === STALE_SESSION_ERROR) {
      return res.status(401).json({ error: error.message });
    }
    res.status(500).json({ error: 'Failed to submit reconciliation' });
  }
});

// Get All Historical Reconciliations
app.get('/api/reconciliation', authenticateToken, requireRole(...ROLES.RECONCILIATION_READ), async (req, res) => {
  try {
    const recons = await ReconciliationModel.findAll();
    res.json(recons);
  } catch (error) {
    logger.error({ err: error }, 'Error fetching reconciliations');
    res.status(500).json({ error: 'Failed to fetch all reconciliations' });
  }
});

// --- Z-READING (supervisor-gated printed sales report) ---

// Closes out everything this cashier has rung up since their last Z-Reading, persists the log,
// and silently prints it. Needs a supervisor approval token (POST /api/pos/approve with action
// ZREAD), sent in the X-Approval-Token header — same pattern as the X-Reading/EOD gate above.
app.post('/api/pos/z-reading', authenticateToken, requireRole(...ROLES.POS), async (req, res) => {
  try {
    const approval = await posApproval.verifyApproval(req.headers['x-approval-token'], {
      action: 'ZREAD',
      cashierId: req.user.id,
    });
    const report = await ZReadingModel.create(req.user.id, approval.approverId);
    posApproval.consumeApproval(approval);

    // The reading is already saved; printing is waited on only so the POS can say whether it
    // actually printed (and why not), instead of assuming it did. A print failure never fails this.
    const print = await receiptPrinter
      .printZReading(report)
      .catch((err) => ({ printed: false, reason: 'error', error: err.message }));
    res.status(201).json({ ...report, print });
  } catch (error) {
    if (error instanceof posApproval.ApprovalError || error instanceof ZReadingModel.ZReadingError) {
      return res.status(error.status).json({ error: error.message, code: error.code });
    }
    logger.error({ err: error }, 'Error creating Z-Reading');
    res.status(500).json({ error: 'Failed to create Z-Reading' });
  }
});

// This cashier's own past Z-Readings; a supervisor/admin may look up another cashier's via ?cashierId=.
app.get('/api/pos/z-reading', authenticateToken, requireRole(...ROLES.POS), async (req, res) => {
  try {
    const canViewOthers = req.user.role === 'SUPERVISOR' || req.user.role === 'ADMIN';
    const cashierId = canViewOthers && req.query.cashierId ? req.query.cashierId : req.user.id;
    res.json(await ZReadingModel.findAll({ cashierId }));
  } catch (error) {
    logger.error({ err: error }, 'Error fetching Z-Readings');
    res.status(500).json({ error: 'Failed to fetch Z-Readings' });
  }
});

// Reprints a saved Z-Reading (marked REPRINT) — e.g. after the printer was off or out of paper. A
// cashier may reprint only their own; a supervisor/admin, anyone's. Nothing is recomputed.
app.post('/api/pos/z-reading/:id/reprint', authenticateToken, requireRole(...ROLES.POS), async (req, res) => {
  try {
    const report = await ZReadingModel.findById(req.params.id);
    const canReprintOthers = req.user.role === 'SUPERVISOR' || req.user.role === 'ADMIN';
    if (!report || (!canReprintOthers && report.cashierId !== req.user.id)) {
      return res.status(404).json({ error: 'Z-Reading not found' });
    }
    res.json(await receiptPrinter.printZReading(report, { reprint: true }));
  } catch (error) {
    logger.error({ err: error }, 'Error reprinting Z-Reading');
    res.status(500).json({ printed: false, reason: 'error', error: error.message });
  }
});

// --- VOID SALE (supervisor-gated) ---

// Void receipts are opened from the POS and from the ledger, so both groups can view/reprint them.
const VOID_RECEIPT_ROLES = [...new Set([...ROLES.POS, ...ROLES.INVENTORY_READ])];

const sendVoidError = (res, error) => {
  if (error instanceof posApproval.ApprovalError || error instanceof SaleVoidModel.VoidError) {
    res.status(error.status).json({ error: error.message, code: error.code });
    return true;
  }
  return false;
};

// The POS "Void Sale" picker: the signed-in user's sales since their last Z-Reading, or, with
// ?search=, any sale whose transaction number contains it. Each says whether it can be voided.
app.get('/api/pos/sales', authenticateToken, requireRole(...ROLES.POS), async (req, res) => {
  try {
    res.json(await SaleVoidModel.listForPos({ userId: req.user.id, search: req.query.search }));
  } catch (error) {
    logger.error({ err: error }, 'Error listing sales for void');
    res.status(500).json({ error: 'Failed to load sales' });
  }
});

// Voids a completed sale: stock and FIFO batches restored, member points reversed, and the void
// slip printed. Needs a supervisor approval token (POST /api/pos/approve with action VOID) in
// X-Approval-Token, and a reason. Like the Z-Reading, it waits for the printer so the POS can say
// whether the slip actually printed; the void itself is already saved either way.
app.post('/api/pos/voids', authenticateToken, requireRole(...ROLES.POS), async (req, res) => {
  try {
    const approval = await posApproval.verifyApproval(req.headers['x-approval-token'], {
      action: 'VOID',
      cashierId: req.user.id,
    });
    const { saleVoid, productIds } = await SaleVoidModel.create({
      transactionId: req.body.transactionId,
      reason: req.body.reason,
      voidedById: req.user.id,
      approvedById: approval.approverId,
    });
    posApproval.consumeApproval(approval);

    const io = req.app.get('io');
    ProductModel.findManyFormatted(productIds)
      .then((products) => io.to(DASHBOARD_ROOM).emit('stock_updated', { products }))
      .catch((err) => logger.error({ err }, 'Error broadcasting stock after void'));
    FinanceModel.getSummary()
      .then((summary) => io.to(FINANCE_ROOM).emit('finance_updated', summary))
      .catch((err) => logger.error({ err }, 'Error broadcasting finance after void'));

    const receipt = await SaleVoidModel.findReceiptData(saleVoid.id);
    const print = await receiptPrinter
      .printVoidReceipt(receipt)
      .catch((err) => ({ printed: false, reason: 'error', error: err.message }));
    res.status(201).json({ ...saleVoid, print });
  } catch (error) {
    if (sendVoidError(res, error)) return;
    logger.error({ err: error }, 'Error voiding sale');
    res.status(500).json({ error: 'Failed to void the sale' });
  }
});

// A void slip as on-screen text, exactly what a reprint puts on paper (REPRINT-marked).
app.get('/api/voids/:id/receipt', authenticateToken, requireRole(...VOID_RECEIPT_ROLES), async (req, res) => {
  try {
    const data = await SaleVoidModel.findReceiptData(req.params.id);
    if (!data) return res.status(404).json({ error: 'Void not found' });
    const lines = renderToText(buildVoidReceipt(data, { reprintedAt: new Date() }));
    res.json({ id: data.id, reference: data.voidNo, createdAt: data.voidedAt, width: RECEIPT_WIDTH, lines });
  } catch (error) {
    logger.error({ err: error }, 'Error building void receipt preview');
    res.status(500).json({ error: 'Failed to load void receipt' });
  }
});

app.post('/api/voids/:id/reprint', authenticateToken, requireRole(...VOID_RECEIPT_ROLES), async (req, res) => {
  try {
    const data = await SaleVoidModel.findReceiptData(req.params.id);
    if (!data) return res.status(404).json({ error: 'Void not found' });
    res.json(await receiptPrinter.printVoidReceipt(data, { reprint: true }));
  } catch (error) {
    logger.error({ err: error }, 'Error reprinting void receipt');
    res.status(500).json({ printed: false, reason: 'error', error: error.message });
  }
});

// --- ALERT ROUTES (low-stock and expiry emails) ---

app.get('/api/alerts/low-stock', authenticateToken, requireRole(...ROLES.DASHBOARD), async (req, res) => {
  try {
    const products = await lowStockAlerts.findCurrentlyLow();
    res.json({ count: products.length, products });
  } catch (error) {
    logger.error({ err: error }, 'Low-stock query failed');
    res.status(500).json({ error: 'Failed to query low-stock products' });
  }
});

app.post('/api/alerts/low-stock/send-now', authenticateToken, requireRole(...ROLES.DASHBOARD), async (req, res) => {
  if (!mailer.isConfigured()) {
    return res.status(503).json({
      error: 'SMTP is not configured. Set SMTP_HOST, SMTP_USER, SMTP_PASS, ALERT_RECIPIENTS in backend/.env.',
    });
  }
  try {
    const result = await lowStockAlerts.sendDigestNow();
    res.json({ ok: true, ...result });
  } catch (error) {
    logger.error({ err: error }, 'Manual low-stock digest failed');
    res.status(500).json({ error: 'Failed to send low-stock digest email' });
  }
});

app.get('/api/alerts/expiry', authenticateToken, requireRole(...ROLES.DASHBOARD), async (req, res) => {
  try {
    const products = await expiryAlerts.findExpiringSoon();
    res.json({
      windowDays: expiryAlerts.getWindowDays(),
      count: products.length,
      products,
    });
  } catch (error) {
    logger.error({ err: error }, 'Expiry query failed');
    res.status(500).json({ error: 'Failed to query expiring products' });
  }
});

app.post('/api/alerts/expiry/send-now', authenticateToken, requireRole(...ROLES.DASHBOARD), async (req, res) => {
  if (!mailer.isConfigured()) {
    return res.status(503).json({
      error: 'SMTP is not configured. Set SMTP_HOST, SMTP_USER, SMTP_PASS, ALERT_RECIPIENTS in backend/.env.',
    });
  }
  try {
    const result = await expiryAlerts.sendDigestNow();
    res.json({ ok: true, ...result });
  } catch (error) {
    logger.error({ err: error }, 'Manual expiry digest failed');
    res.status(500).json({ error: 'Failed to send expiry digest email' });
  }
});

// Forecast accuracy: saved forecasts graded against real sales (live) plus the AI service's backtest.
app.get('/api/forecast/accuracy', authenticateToken, requireRole(...ROLES.DASHBOARD), async (req, res) => {
  try {
    res.json({ success: true, data: await ForecastAccuracyModel.getAccuracy() });
  } catch (error) {
    logger.error({ err: error }, 'Error computing forecast accuracy');
    res.status(500).json({ success: false, message: 'Failed to compute forecast accuracy' });
  }
});

// --- FORECAST DIGEST ROUTES ---

app.post('/api/alerts/forecast/send-now', authenticateToken, requireRole(...ROLES.DASHBOARD), async (req, res) => {
  if (!mailer.isConfigured()) {
    return res.status(503).json({
      error: 'SMTP is not configured. Set SMTP_HOST, SMTP_USER, SMTP_PASS, ALERT_RECIPIENTS in backend/.env.',
    });
  }
  try {
    const days = Number(req.query.days) || 30;
    const result = await forecastAlerts.sendDigestNow(days);
    res.json(result);
  } catch (error) {
    logger.error({ err: error }, 'Manual forecast digest failed');
    res.status(500).json({ error: 'Failed to send forecast digest email' });
  }
});

app.get('/api/alerts/forecast', authenticateToken, requireRole(...ROLES.DASHBOARD), async (req, res) => {
  try {
    const days = Number(req.query.days) || 30;
    const digest = await forecastAlerts.buildDigest(days);
    if (!digest) return res.status(503).json({ error: 'Forecast unavailable' });
    res.json(digest);
  } catch (error) {
    logger.error({ err: error }, 'Forecast query failed');
    res.status(500).json({ error: 'Failed to build forecast digest' });
  }
});

// --- SERVE THE BUILT FRONTEND ---
// Single-process production deployment (see deployment.md): the backend serves the frontend's
// built assets directly instead of a separate static host. Only wired up if frontend/dist actually
// exists — in local dev (frontend served separately by `vite dev` on :5173) it's absent, so this
// silently does nothing and today's two-process dev setup is unaffected. Registered after every
// /api and /socket.io route above, so a request for a real endpoint is never shadowed by it.
const FRONTEND_DIST = path.join(__dirname, '..', 'frontend', 'dist');
if (fs.existsSync(path.join(FRONTEND_DIST, 'index.html'))) {
  app.use(express.static(FRONTEND_DIST));
  // Client-side routing (react-router): any GET that isn't /api or /socket.io falls through to
  // index.html so the frontend router handles the path instead of a 404.
  app.get(/^\/(?!api\/|socket\.io\/).*/, (req, res) => {
    res.sendFile(path.join(FRONTEND_DIST, 'index.html'));
  });
  logger.info(`[static] serving built frontend from ${FRONTEND_DIST}`);
} else {
  logger.info('[static] frontend/dist not found — not serving the frontend (normal in local dev; run `npm run build` in frontend/ for production).');
}

// --- DAILY DIGEST (scheduled) ---

function startDailyDigestCron() {
  const expr = process.env.DAILY_DIGEST_CRON || '0 8 * * *';
  if (!cron.validate(expr)) {
    logger.error(`[digest] invalid DAILY_DIGEST_CRON="${expr}" — digest not scheduled.`);
    return;
  }
  cron.schedule(
    expr,
    async () => {
      if (!mailer.isConfigured()) return;
      try {
        await lowStockAlerts.sendDigestNow();
      } catch (err) {
        logger.error({ err: err.message }, '[low-stock] scheduled digest failed');
      }
      try {
        await expiryAlerts.sendDigestNow();
      } catch (err) {
        logger.error({ err: err.message }, '[expiry] scheduled digest failed');
      }
      try {
        await forecastAlerts.sendDigestNow();
      } catch (err) {
        logger.error({ err: err.message }, '[forecast] scheduled digest failed');
      }
    },
    { timezone: process.env.TZ || 'Asia/Manila' },
  );
  logger.info(
    `[digest] low-stock + expiry + forecast scheduled with cron "${expr}" (tz=${process.env.TZ || 'Asia/Manila'})`,
  );
}

// Saves the forecast for the day that just began (from the complete previous day) so it can be graded
// later. Independent of SMTP; a missed run is caught up by the first forecast request of the day.
function startForecastSnapshotCron() {
  const expr = process.env.FORECAST_SNAPSHOT_CRON || '5 0 * * *';
  if (!cron.validate(expr)) {
    logger.error(`[forecast] invalid FORECAST_SNAPSHOT_CRON="${expr}" — nightly snapshot not scheduled.`);
    return;
  }
  cron.schedule(
    expr,
    async () => {
      try {
        const result = await forecastSnapshots.saveToday();
        logger.info(`[forecast] nightly snapshot: ${result.saved ? `saved ${result.items} products` : result.reason}`);
      } catch (err) {
        logger.error({ err: err.message }, '[forecast] nightly snapshot failed');
      }
    },
    { timezone: DemandForecastModel.STORE_TIMEZONE },
  );
  logger.info(`[forecast] nightly snapshot scheduled with cron "${expr}" (tz=${DemandForecastModel.STORE_TIMEZONE})`);
}

// Nightly pg_dump, mirrored to the external drive / cloud folder when those env vars are set,
// with old dumps pruned past the retention window. See services/backup.js.
function startBackupCron() {
  const expr = process.env.BACKUP_CRON || '30 1 * * *';
  if (!cron.validate(expr)) {
    logger.error(`[backup] invalid BACKUP_CRON="${expr}" — nightly backup not scheduled.`);
    return;
  }
  cron.schedule(
    expr,
    async () => {
      try {
        const result = await backup.runBackup();
        logger.info(
          `[backup] wrote ${result.file} (${(result.sizeBytes / 1024 / 1024).toFixed(2)} MB), ` +
            `copied to ${result.copiedTo.length} off-site location(s), pruned ${result.pruned} old file(s).`,
        );
        for (const w of result.warnings) logger.warn(`[backup] ${w}`);
      } catch (err) {
        logger.error({ err: err.message }, '[backup] nightly backup failed');
      }
    },
    { timezone: process.env.TZ || 'Asia/Manila' },
  );
  logger.info(`[backup] nightly database backup scheduled with cron "${expr}" (tz=${process.env.TZ || 'Asia/Manila'})`);
}

// Retries with backoff before giving up: the process manager (Phase 4: pm2/NSSM) may start
// Postgres and this backend around the same time on boot, and Postgres can take a few seconds
// longer to start accepting connections. Previously the Prisma/pg pool connected lazily, so a
// genuinely unreachable database only surfaced as generic 500s on the first request instead of a
// clear fatal error at boot.
async function waitForDatabase() {
  const maxAttempts = 6;
  const delayMs = 3000;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      await prisma.$queryRaw`SELECT 1`;
      return;
    } catch (err) {
      if (attempt === maxAttempts) {
        logger.fatal({ err }, `Could not reach the database after ${maxAttempts} attempts — check DATABASE_URL and that Postgres is running`);
        process.exit(1);
      }
      logger.warn(`Database not reachable yet (attempt ${attempt}/${maxAttempts}) — retrying in ${delayMs / 1000}s...`);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}

// Guarded so a test file can `require('../index.js')` to get `app` (for supertest-style route
// testing) without also binding the real port, scheduling crons, or verifying SMTP — only running
// this when the file is executed directly (`node index.js` / `npm start` / `npm run dev`).
if (require.main === module) {
  (async () => {
    await waitForDatabase();
    server.listen(PORT, async () => {
      logger.info(`🚀 POS Server running on http://localhost:${PORT}`);
      startForecastSnapshotCron();
      startBackupCron();
      const smtpOk = await mailer.verifyMailer();
      if (smtpOk) {
        startDailyDigestCron();
      } else if (mailer.isConfigured()) {
        logger.info('[digest] SMTP credentials rejected — fix SMTP_PASS in backend/.env and restart. Alerts OFF.');
      } else {
        logger.info('[digest] SMTP not configured — per-event alerts and daily digest disabled.');
      }
    });
  })();
}

module.exports = { app, server, io, prisma };