// models/Auth.js
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { prisma } = require('./Product');
const logger = require('../services/logger');
const loginThrottle = require('../services/loginThrottle');

const JWT_SECRET = process.env.JWT_SECRET;
const JWT_EXPIRES_IN = '12h';

if (!JWT_SECRET) {
  logger.warn('[auth] JWT_SECRET is not set in the environment — login will fail until it is configured in backend/.env.');
}

// Errors the routes should answer with a specific HTTP status (401 bad credentials, 429 locked).
class AuthError extends Error {
  constructor(message, status = 401) {
    super(message);
    this.status = status;
  }
}

// Compared against when the username doesn't exist, so an unknown user costs the same bcrypt work
// as a wrong password and response time doesn't reveal which usernames are real.
const DUMMY_HASH = bcrypt.hashSync('timing-equalizer-not-a-real-password', 10);

const assertNotLocked = (username) => {
  const remaining = loginThrottle.lockRemainingMs(username);
  if (remaining > 0) throw new AuthError(loginThrottle.lockMessage(remaining), 429);
};

const AuthModel = {
  login: async (username, password) => {
    if (typeof username !== 'string' || typeof password !== 'string' || !username.trim() || !password) {
      throw new AuthError('Username and password are required.', 400);
    }
    if (!JWT_SECRET) {
      throw new AuthError('Server auth is not configured (missing JWT_SECRET).', 500);
    }

    const name = username.trim();
    assertNotLocked(name);

    const user = await prisma.user.findUnique({ where: { username: name } });
    const valid = await bcrypt.compare(password, user ? user.password : DUMMY_HASH);
    if (!user || !valid) {
      loginThrottle.recordFailure(name);
      throw new AuthError('Invalid username or password.');
    }
    loginThrottle.clear(name);

    if (!user.isActive) throw new AuthError('This account has been deactivated. Contact an administrator.');

    const payload = { id: user.id, username: user.username, fullName: user.fullName, role: user.role };
    const token = jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });
    return { token, user: payload };
  },

  // Re-checks the caller's own password against their stored hash. Used to gate
  // sensitive admin-only screens (e.g. User Management) behind a fresh password
  // prompt even though their session JWT is already valid.
  verifyPassword: async (userId, password) => {
    if (!password) throw new AuthError('Password is required.', 400);

    const user = await prisma.user.findUnique({ where: { id: parseInt(userId, 10) } });
    if (!user) throw new AuthError('Invalid admin password. Access denied.');
    assertNotLocked(user.username);

    const valid = await bcrypt.compare(String(password), user.password);
    if (!valid) {
      loginThrottle.recordFailure(user.username);
      throw new AuthError('Invalid admin password. Access denied.');
    }
    loginThrottle.clear(user.username);

    if (!user.isActive) throw new AuthError('This account has been deactivated. Contact an administrator.');

    return true;
  },
};

// Thrown by model .create() calls when a JWT verifies fine but the user id it
// carries no longer exists (e.g. the users table was reseeded after the
// token was issued). Route handlers map this to 401 so the frontend can
// force a re-login instead of showing a generic 500.
const STALE_SESSION_ERROR = 'Authenticated user no longer exists.';
const DEACTIVATED_ERROR = 'This account has been deactivated. Contact an administrator.';

// Verifies the "Authorization: Bearer <token>" header, then re-loads the user
// so a deactivated/deleted account or a changed role takes effect immediately
// instead of waiting for the JWT to expire. req.user reflects the DB row.
async function authenticateToken(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Missing authentication token.' });
  if (!JWT_SECRET) return res.status(500).json({ error: 'Server auth is not configured.' });

  let decoded;
  try {
    decoded = jwt.verify(token, JWT_SECRET);
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token.' });
  }

  try {
    const user = await prisma.user.findUnique({
      where: { id: parseInt(decoded.id, 10) },
      select: { id: true, username: true, role: true, isActive: true },
    });
    if (!user) return res.status(401).json({ error: STALE_SESSION_ERROR });
    if (!user.isActive) return res.status(401).json({ error: DEACTIVATED_ERROR });

    req.user = { id: user.id, username: user.username, role: user.role };
    next();
  } catch (error) {
    logger.error({ err: error }, '[auth] user lookup failed');
    return res.status(500).json({ error: 'Failed to verify session.' });
  }
}

// Role gate. Must run after authenticateToken. ADMIN is always allowed.
function requireRole(...roles) {
  const allowed = new Set([...roles, 'ADMIN']);
  return (req, res, next) => {
    if (!req.user || !allowed.has(req.user.role)) {
      return res.status(403).json({ error: 'You do not have permission to perform this action.' });
    }
    next();
  };
}

// Verifies a JWT for a Socket.IO handshake and returns the DB user, or null.
async function authenticateSocketToken(token) {
  if (!token || !JWT_SECRET) return null;
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    const user = await prisma.user.findUnique({
      where: { id: parseInt(decoded.id, 10) },
      select: { id: true, username: true, role: true, isActive: true },
    });
    return user && user.isActive ? user : null;
  } catch {
    return null;
  }
}

module.exports = {
  AuthModel,
  AuthError,
  authenticateToken,
  requireRole,
  authenticateSocketToken,
  STALE_SESSION_ERROR,
};
