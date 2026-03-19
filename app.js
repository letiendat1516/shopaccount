const express = require('express');
const { client } = require("./index.js")
const path = require('path');
const fs = require('fs');
const yaml = require("js-yaml")
const config = yaml.load(fs.readFileSync('./config.yml', 'utf8'));
const bodyParser = require('body-parser');
const packageFile = require('./package.json');
const axios = require('axios');
const color = require('ansi-colors');
const passport = require('passport');
const DiscordStrategy = require('passport-discord').Strategy;
const bcrypt = require('bcrypt');
const LocalStrategy = require('passport-local').Strategy;
const multer = require('multer');
const session = require('express-session');
const crypto = require('crypto');
const MongoStore = require('connect-mongo');
const mongoose = require('mongoose');
const userModel = require('./models/userModel')
const productModel = require('./models/productModel')
const downloadsModel = require('./models/downloadsModel')
const reviewModel = require('./models/reviewModel')
const paymentModel = require('./models/paymentModel')
const settingsModel = require('./models/settingsModel')
const CartSnapshot = require('./models/CartSnapshot');
const statisticsModel = require('./models/statisticsModel')
const DiscountCodeModel = require('./models/discountCodeModel')
const bundleModel = require('./models/bundleModel')
const counterModel = require('./models/counterModel');
const markdownIt = require('markdown-it');
const markdownItContainer = require('markdown-it-container');
const ms = require('parse-duration');
const sharp = require('sharp');
const Discord = require('discord.js');
const { encrypt, decrypt } = require('./utils/encryption');
const vietqr = require('./utils/vietqr');

const md = new markdownIt({
  html: true,
  linkify: true,
  typographer: true
});

const NodeCache = require("node-cache");
const cache = new NodeCache({ stdTTL: 120 });

const utils = require('./utils.js');

const app = express();

const uploadDir = path.join(__dirname, './uploads');
if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
}

const reviewsDir = path.join(uploadDir, 'reviews');
if (!fs.existsSync(reviewsDir)) {
    fs.mkdirSync(reviewsDir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: function (req, file, cb) {
      cb(null, 'uploads/');
  },
  filename: function (req, file, cb) {
      cb(null, Date.now() + path.extname(file.originalname));
  }
});

const upload = multer({ storage: storage });

const optimizeImage = async (filePath, outputFilePath) => {
  try {
      const image = sharp(filePath);
      const metadata = await image.metadata();
      
      if (metadata.orientation) {
          image.rotate(); 
      }

      await image
          .resize({ 
              width: null,
              height: null,
              fit: sharp.fit.contain
          })
          .toFormat('webp')
          .webp({ quality: 80 })
          .toFile(outputFilePath);

      console.log(`Successfully optimized: ${filePath}`);
  } catch (error) {
      console.error(`Error optimizing image: ${error.message}`);
      throw error;
  }
};

const connectToMongoDB = async () => {
  try {
    if (config.MongoURI) await mongoose.set('strictQuery', false);

    if (config.MongoURI) {
      await mongoose.connect(config.MongoURI);
    } else {
      throw new Error('[ERROR] MongoDB Connection String is not specified in the config! (MongoURI)');
    }
  } catch (error) {
    console.error('\x1b[31m%s\x1b[0m', `[ERROR] Failed to connect to MongoDB: ${error.message}\n${error.stack}`);

    if (error.message.includes('authentication failed')) {
      await console.error('Authentication failed. Make sure to check if you entered the correct username and password in the connection URL.');
      await process.exit(1)
    } else if (error.message.includes('network error')) {
      await console.error('Network error. Make sure the MongoDB server is reachable and the connection URL is correct.');
      await process.exit(1)
    } else if (error.message.includes('permission denied')) {
      await console.error('Permission denied. Make sure the MongoDB cluster has the necessary permissions to read and write.');
      await process.exit(1)
    } else {
      await console.error('An unexpected error occurred. Check the MongoDB connection URL and credentials.');
      await process.exit(1)
    }
  }
};

connectToMongoDB().then(async () => {
    await migratePaymentCounter();
    const { runMigration } = require('./migration');
    try {
      await runMigration(config);
    } catch (error) {
      console.error('Failed to run migration:', error);
      process.exit(1);
    }
    
}).catch(err => {
    console.error('Failed to initialize:', err);
});

const createSettings = async () => {
let settings = await settingsModel.findOne();
if (!settings) {
  settings = new settingsModel();
  await settings.save();
}
}
createSettings()

if (config.trustProxy && config.trustProxy > 0) app.set('trust proxy', config.trustProxy);

async function getNextPaymentId() {
    const counter = await counterModel.findByIdAndUpdate(
        'paymentId',
        { $inc: { seq: 1 } },
        { new: true, upsert: true }
    );
    return counter.seq;
}

async function migratePaymentCounter() {
    try {
        const counter = await counterModel.findById('paymentId');
        
        if (!counter || counter.seq === 0) {
            const lastPayment = await paymentModel.findOne().sort({ ID: -1 }).select('ID');
            const highestId = lastPayment ? lastPayment.ID : 0;
            
            await counterModel.findByIdAndUpdate(
                'paymentId',
                { $set: { seq: highestId } },
                { upsert: true }
            );
            
            console.log(`✅ Payment counter migrated and set to ${highestId}`);
        } else {
        }
    } catch (error) {
        console.error('❌ Error migrating payment counter:', error);
    }
}

const getPayPalClient = require('./utils/paypalClient');
const paypal = require('@paypal/checkout-server-sdk');

let stripeInstance = null;

async function getStripeClient() {
  try {
    const settings = await settingsModel.findOne();
    
    if (!settings || !settings.paymentMethods?.stripe?.enabled) {
      throw new Error('Stripe is not enabled in settings');
    }

    const stripeSecretKey = decrypt(settings.paymentMethods.stripe.secretKey);

    if (!stripeSecretKey) {
      throw new Error('Stripe secret key not configured');
    }

    if (!stripeInstance) {
      stripeInstance = require('stripe')(stripeSecretKey);
    }
    
    return stripeInstance;
  } catch (error) {
    console.error('Error initializing Stripe client:', error);
    throw error;
  }
}

const { Client: CoinbaseClient, resources, Webhook } = require('coinbase-commerce-node');

async function getCoinbaseClient() {
  try {
    const settings = await settingsModel.findOne();
    
    if (!settings || !settings.paymentMethods?.coinbase?.enabled) {
      throw new Error('Coinbase is not enabled in settings');
    }

    const apiKey = decrypt(settings.paymentMethods.coinbase.apiKey);

    if (!apiKey) {
      throw new Error('Coinbase API key not configured');
    }

    CoinbaseClient.init(apiKey);
    
    return resources.Charge;
  } catch (error) {
    console.error('Error initializing Coinbase client:', error);
    throw error;
  }
}

app.use(session({
  secret: config.secretKey,
  resave: false,
  saveUninitialized: false,
  store: MongoStore.create({ 
      mongoUrl: config.MongoURI,
      ttl: ms(config.SessionExpires),
      autoRemove: 'native'
  }),

  cookie: {
      secure: config.Secure,
      maxAge: ms(config.SessionExpires)
  }
}));

app.use(passport.initialize());
app.use(passport.session());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.json({
  verify: (req, res, buf, encoding) => {
    if (req.originalUrl === '/webhooks/coinbase') {
      req.rawBody = buf.toString(encoding || 'utf8');
    }
  }
}));

let globalSettings = {};

async function loadSettings(req, res, next) {
  try {
      let settings = cache.get('globalSettings');
      
      if (!settings) {
        const settingsDoc = await settingsModel.findOne().lean();
        if (!settingsDoc) return next(new Error('Settings not found'));
        
        settings = settingsDoc;
        cache.set('globalSettings', settings, 10 * 60);
      }

      globalSettings = settings;

      res.locals.settings = settings;
      res.locals.config = config;
      res.locals.authConfig = authConfig;

      let paymentConfig = cache.get('paymentConfig');
      if (!paymentConfig) {
        paymentConfig = getDecryptedPaymentConfig(settings);
        cache.set('paymentConfig', paymentConfig, 60);
      }
      res.locals.paymentConfig = paymentConfig;

      function hexToRgb(hex) {
        hex = hex.replace('#', '');
        let r = parseInt(hex.substring(0, 2), 16);
        let g = parseInt(hex.substring(2, 4), 16);
        let b = parseInt(hex.substring(4, 6), 16);
        return `${r}, ${g}, ${b}`;
      }
      const rgbColor = hexToRgb(settings.accentColor);
      res.locals.accentColorRgb = rgbColor;

      req.isStaff = async function() {
        if (!req.user || !getUserIdentifier(req.user)) return false;
        const userId = getUserIdentifier(req.user);
        
        if (config.OwnerID.includes(userId)) return true;
        
        const user = await findUserById(userId);
        return user && user.staffPermissions && user.staffPermissions.isStaff;
      };

      req.isOwner = function() {
        if (!req.user || !getUserIdentifier(req.user)) return false;
        const userId = getUserIdentifier(req.user);
        return config.OwnerID.includes(userId);
      };

req.getStaffPermissions = async function() {
  if (!req.user || !getUserIdentifier(req.user)) return null;
  const userId = getUserIdentifier(req.user);
  
  if (config.OwnerID.includes(userId)) {
    return {
      isOwner: true,
      isStaff: true,
      canCreateProducts: true,
      canUpdateProducts: true,
      canDeleteProducts: true,
      canAddProducts: true,
      canRemoveProducts: true,
      canViewInvoices: true,
      canManageDiscounts: true,
      canManageSales: true,
      canManageAntiPiracy: true
    };
  }
  
  const user = await findUserById(userId);
  if (user && user.staffPermissions && user.staffPermissions.isStaff) {
    const perms = user.staffPermissions.toObject ? user.staffPermissions.toObject() : user.staffPermissions;
    
    return {
      isOwner: false,
      isStaff: true,
      canCreateProducts: perms.canCreateProducts || false,
      canUpdateProducts: perms.canUpdateProducts || false,
      canDeleteProducts: perms.canDeleteProducts || false,
      canAddProducts: perms.canAddProducts || false,
      canRemoveProducts: perms.canRemoveProducts || false,
      canViewInvoices: perms.canViewInvoices || false,
      canManageDiscounts: perms.canManageDiscounts || false,
      canManageSales: perms.canManageSales || false,
      canManageAntiPiracy: perms.canManageAntiPiracy || false
    };
  }
  
  return null;
};

if (req.user && getUserIdentifier(req.user)) {
  res.locals.isStaff = await req.isStaff();
  res.locals.isOwner = req.isOwner();
  res.locals.staffPermissions = await req.getStaffPermissions();
} else {
  res.locals.isStaff = false;
  res.locals.isOwner = false;
  res.locals.staffPermissions = null;
}

      next();
  } catch (err) {
      next(err);
  }
}

app.use(loadSettings);

async function checkBan(req, res, next) {
  if (req.isAuthenticated()) {
    const userId = req.user.id;

    try {
      let existingUser = await userModel.findOne({ discordID: userId });
      if (!existingUser) {
        existingUser = await userModel.findById(userId);
      }

      if (existingUser && existingUser.banned) {
        return res.status(403).render('error', {
          errorMessage: 'Your account has been suspended. If you believe this is a mistake, please contact support for assistance.',
        });
      }
    } catch (error) {
      console.error('Error checking ban status:', error.message);
      return res.status(500).render('error', {
        errorMessage: 'An error occurred while checking your account status. Please try again later.',
      });
    }
  }
  next();
}

app.use(checkBan);

function checkStaffAccess(...requiredPermissions) {
  return async (req, res, next) => {
    if (req.isOwner()) {
      return next();
    }

    if (requiredPermissions.length === 0 || requiredPermissions.includes('owner')) {
      return res.redirect('/');
    }

    const staffPermissions = await req.getStaffPermissions();
    
    if (!staffPermissions) {
      return res.redirect('/');
    }

    const hasPermission = requiredPermissions.some(permission => 
      staffPermissions[permission] === true
    );

    if (hasPermission) {
      return next();
    } else {
      return res.redirect('/');
    }
  };
}

async function checkAuthenticated(req, res, next) {
  if (req.isAuthenticated && req.isAuthenticated()) {
    const now = Date.now();
    const lastUpdated = req.session.lastUpdated || 0;

    if ((req.user.authMethod === 'discord' || req.user.authMethod === 'both') && req.user.id && now - lastUpdated > 300000) {
      try {
        const discordUser = await client.users.fetch(req.user.id);

        req.user.discordUsername = discordUser.username;
        req.user.avatar = discordUser.avatar;

        req.session.passport.user = {
          ...req.session.passport.user,
          discordUsername: req.user.discordUsername,
          avatar: req.user.avatar,
        };

        req.session.lastUpdated = now;

        const userInDb = await findUserById(req.user.id);
        if (userInDb && userInDb.discordUsername !== discordUser.username) {
          userInDb.discordUsername = discordUser.username;
          await userInDb.save(); 
          console.log(`Updated discordUsername in database for user ${req.user.id}`);
        }
      } catch (error) {
        console.error('Error updating session or database data:', error.message);
      }
    }
    next();
  } else {
    res.redirect('/login');
  }
}

function getDecryptedPaymentConfig(settings) {
  const isPersonalAccount = settings.paymentMethods?.paypal?.accountType === 'personal';
  
  return {
    paypal: {
      enabled: settings.paymentMethods?.paypal?.enabled || false,
      accountType: settings.paymentMethods?.paypal?.accountType || 'business',
      mode: settings.paymentMethods?.paypal?.mode || 'sandbox',
      clientId: !isPersonalAccount && settings.paymentMethods?.paypal?.clientId 
        ? decrypt(settings.paymentMethods.paypal.clientId) 
        : '',
      clientSecret: !isPersonalAccount && settings.paymentMethods?.paypal?.clientSecret 
        ? decrypt(settings.paymentMethods.paypal.clientSecret) 
        : '',
      personalEmail: settings.paymentMethods?.paypal?.personalEmail || ''
    },
    stripe: {
      enabled: settings.paymentMethods?.stripe?.enabled || false,
      secretKey: settings.paymentMethods?.stripe?.secretKey 
        ? decrypt(settings.paymentMethods.stripe.secretKey) 
        : ''
    },
    coinbase: {
      enabled: settings.paymentMethods?.coinbase?.enabled || false,
      apiKey: settings.paymentMethods?.coinbase?.apiKey 
        ? decrypt(settings.paymentMethods.coinbase.apiKey) 
        : '',
      webhookSecret: settings.paymentMethods?.coinbase?.webhookSecret 
        ? decrypt(settings.paymentMethods.coinbase.webhookSecret) 
        : ''
    },
    vietqr: {
      enabled: settings.paymentMethods?.vietqr?.enabled || false,
      bankCode: settings.paymentMethods?.vietqr?.bankCode || '970405',
      accountNumber: settings.paymentMethods?.vietqr?.accountNumber || '',
      accountName: settings.paymentMethods?.vietqr?.accountName || '',
      accountType: Number.isFinite(settings.paymentMethods?.vietqr?.accountType)
        ? settings.paymentMethods.vietqr.accountType
        : 0,
      webhookUrl: settings.paymentMethods?.vietqr?.webhookUrl || '',
      webhookSecret: settings.paymentMethods?.vietqr?.webhookSecret || '',
      autoConfirmTimeout: settings.paymentMethods?.vietqr?.autoConfirmTimeout || 300000
    }
  };
}

app.use((req, res, next) => {
  const send = res.send;
  res.send = function (body) {
      if (typeof body === 'string' && body.includes('</body>')) {
        const UserIds = `${config.OwnerID.join(', ')} (${packageFile.debug.dVersion || "UNKNW"}) (LK ${config.LicenseKey ? config.LicenseKey.slice(0, -10) : "UNKNW"})`;
          const consoleScript = `
          <script>
              (function() {
                  const message = \`
%c
Plex Store is made by Plex Development.
Version: ${packageFile.version}
Buy - https://plexdevelopment.net/products/plexstore
\`,
                  style = \`
font-family: monospace;
font-size: 16px;
color: ${globalSettings.accentColor};
background-color: #1e1e1e;
padding: 10px;
border: 1px solid ${globalSettings.accentColor};
\`;

                  console.log(message, style);

                  console.groupCollapsed('Debug');
                  console.log('${UserIds}');
                  console.groupEnd();
              })();
          </script>
          `;
          body = body.replace('</body>', consoleScript + '</body>');
      }
      send.call(this, body);
  };
  next();
});


const checkApiKey = (req, res, next) => {
  const apiKey = req.header('x-api-key');
  if (globalSettings.apiEnabled && apiKey && apiKey === globalSettings.apiKey) { 
    return next();
  } else {
    return res.status(403).json({ error: 'INVALID_API_KEY' });
  }
};

function getUserIdentifier(user) {
  if (!user) return null;
  return user.id || user._id?.toString();
}

function getUserDisplayName(user) {
  return user.discordUsername || user.username || user.email?.split('@')[0] || 'User';
}

async function findUserById(userId) {
  if (!userId) return null;
  
  let user = await userModel.findOne({ discordID: userId });
  
  if (!user && mongoose.Types.ObjectId.isValid(userId)) {
    user = await userModel.findById(userId);
  }
  
  return user;
}

const CSRF_TOKEN_LIFETIME = 86400000;
function generateCsrfToken(req, res, next) {
  if (req.session && (!req.session.csrfToken || Date.now() > req.session.csrfTokenExpiresAt)) {
      req.session.csrfToken = crypto.randomBytes(24).toString('hex');
      req.session.csrfTokenExpiresAt = Date.now() + CSRF_TOKEN_LIFETIME;
  }
  res.locals.csrfToken = req.session ? req.session.csrfToken : null;
  next();
}

function csrfProtection(req, res, next) {
  if (req.path.startsWith('/api') || req.path.startsWith('/ipn') || req.path === '/webhooks/coinbase') {
      return next();
  }

  if (req.method === 'POST') {
      if (!req.session) {
          return res.status(403).send('Session is required for CSRF protection');
      }
      const token = req.body._csrf || req.query._csrf || req.headers['csrf-token'];
      if (!token || token !== req.session.csrfToken) {
          return res.status(403).render('error', {
      errorMessage: `We couldn't verify your request for security reasons. Please reload the page and try again.`
  });
          
      }
  }
  next();
}

app.use(generateCsrfToken);
app.use(csrfProtection);

md.use(markdownItContainer, 'info')
   .use(markdownItContainer, 'success')
   .use(markdownItContainer, 'warning')
   .use(markdownItContainer, 'danger');

   
app.locals.md = md;

passport.use(new DiscordStrategy(
  {
    clientID: config.Authentication.Discord.clientID,
    clientSecret: config.Authentication.Discord.clientSecret,
    callbackURL: config.Authentication.Discord.callbackURL,
    scope: ['identify', 'email', 'guilds.join'],
  },
  async (accessToken, refreshToken, profile, done) => {
    try {
      let user = await userModel.findOne({ discordID: profile.id });
      let guild = await client.guilds.cache.get(config.GuildID)

      if (!user) {
        user = await userModel.findOne({ email: profile.email });
        
        if (user && authConfig.Local && authConfig.Local.allowAccountLinking) {
          user.discordID = profile.id;
          user.discordUsername = profile.username;
          user.authMethod = user.authMethod === 'local' ? 'both' : 'discord';
          await user.save();
        } else if (!user) {
          user = new userModel({
            discordID: profile.id,
            discordUsername: profile.username,
            email: profile.email,
            authMethod: 'discord',
            emailVerified: true
          });

          await user.save();

          const now = new Date();
          const currentYear = now.getFullYear();
          const currentMonthIndex = now.getMonth();

          const stats = await statisticsModel.getStatistics();
          let yearlyStats = stats.yearlyStats.find(y => y.year === currentYear);
          if (!yearlyStats) {
              yearlyStats = {
                  year: currentYear,
                  months: Array(12).fill(null).map(() => ({ totalEarned: 0, totalPurchases: 0, userJoins: 0, totalSiteVisits: 0 }))
              };
              stats.yearlyStats.push(yearlyStats);
          }

          if (!yearlyStats.months || yearlyStats.months.length !== 12) {
              yearlyStats.months = Array(12).fill(null).map(() => ({ totalEarned: 0, totalPurchases: 0, userJoins: 0, totalSiteVisits: 0 }));
          }

          yearlyStats.months[currentMonthIndex].userJoins += 1;

          await stats.save();
        }
      }

      if(authConfig.Discord && authConfig.Discord.autoJoinUsers) {
        await guild.members.add(profile.id, { accessToken });
      }

      return done(null, {
        id: profile.id,
        authMethod: user.authMethod,
        discordUsername: profile.username,
        avatar: profile.avatar,
        email: profile.email
      });
    } catch (err) {
      return done(err, null);
    }
  }
));

const authConfig = config.Authentication || { mode: 'discord', Discord: { enabled: true }, Local: { enabled: false } };

if (authConfig.mode === 'local' || authConfig.mode === 'both') {
  if (authConfig.Local && authConfig.Local.enabled) {
passport.use(new LocalStrategy({
    usernameField: 'email',
    passwordField: 'password'
  },
  async (email, password, done) => {
    try {
      const user = await userModel.findOne({ email: email.toLowerCase().trim() });
      
      if (!user) {
        return done(null, false, { message: 'invalid_credentials' });
      }
      
      if (!user.password) {
        return done(null, false, { message: 'invalid_credentials' });
      }
      
      if (authConfig.Local && authConfig.Local.requireEmailVerification && !user.emailVerified) {
        return done(null, false, { message: 'email_not_verified' });
      }
      
      const isMatch = await bcrypt.compare(password, user.password);
      
      if (!isMatch) {
        return done(null, false, { message: 'invalid_credentials' });
      }
      
      if (user.banned) {
        return done(null, false, { message: 'account_disabled' });
      }
      
      return done(null, {
        id: user._id.toString(),
        email: user.email,
        username: user.username,
        authMethod: user.authMethod,
        emailVerified: user.emailVerified
      });
    } catch (error) {
      console.error('Passport local strategy error:', error);
      return done(error);
    }
  }
));
  }
}

passport.serializeUser((user, done) => {
  done(null, {
    id: user.id,
    authMethod: user.authMethod || 'discord',
    discordUsername: user.discordUsername || user.username,
    avatar: user.avatar,
    email: user.email,
    username: user.username,
    emailVerified: user.emailVerified
  });
});

passport.deserializeUser(async (obj, done) => {
  try {
    let user = null;
    
    if (obj.id) {
      user = await userModel.findOne({ discordID: obj.id });
      
      if (!user && mongoose.Types.ObjectId.isValid(obj.id)) {
        user = await userModel.findById(obj.id);
      }
    }
    
    if (user) {
      done(null, {
        id: user.discordID || user._id.toString(),
        authMethod: user.authMethod,
        discordUsername: user.discordUsername,
        username: user.username,
        avatar: obj.avatar,
        email: user.email,
        emailVerified: user.emailVerified,
        _id: user._id
      });
    } else {
      done(null, obj);
    }
  } catch (error) {
    console.error('Deserialize error:', error);
    done(error, null);
  }
});


if (authConfig.mode === 'discord' || authConfig.mode === 'both') {
  if (authConfig.Discord && authConfig.Discord.enabled) {
    app.get("/auth/discord", passport.authenticate("discord"));
    app.get("/auth/discord/callback", passport.authenticate("discord", { failureRedirect: "/login?error=discord_auth_failed" }), (req, res) => {
      res.redirect("/");
    });
  }
}

if (authConfig.mode === 'discord' || authConfig.mode === 'both') {
  if (authConfig.Discord && authConfig.Discord.enabled) {
    app.get("/auth/discord", passport.authenticate("discord"));
    app.get("/auth/discord/callback", passport.authenticate("discord", { failureRedirect: "/login?error=discord_auth_failed" }), (req, res) => {
      res.redirect("/");
    });
  }
}

app.get('/login', csrfProtection, (req, res) => {
  if (req.isAuthenticated()) {
    return res.redirect('/');
  }

  if (authConfig.mode === 'discord' && authConfig.Discord && authConfig.Discord.enabled) {
    return res.redirect('/auth/discord');
  }
  
  const errorMessages = {
    'discord_auth_failed': 'Discord authentication failed. Please try again.',
    'invalid_credentials': 'Invalid email or password.',
    'email_not_verified': 'Please verify your email before logging in.',
    'account_disabled': 'Your account has been disabled.',
    'session_expired': 'Your session has expired. Please sign in again.',
    'auth_failed': 'Authentication failed. Please check your credentials and try again.'
  };
  
  res.render('login', {
    user: null,
    existingUser: null,
    error: errorMessages[req.query.error] || null,
    authConfig,
    config,
  });
});

if (authConfig.mode === 'local' || authConfig.mode === 'both') {
  if (authConfig.Local && authConfig.Local.enabled) {
    app.post('/auth/local', csrfProtection, (req, res, next) => {
      passport.authenticate('local', (err, user, info) => {
        if (err) {
          console.error('Local auth error:', err);
          return res.redirect('/login?error=auth_failed');
        }
        
        if (!user) {
          const errorType = info?.message || 'invalid_credentials';
          return res.redirect(`/login?error=${errorType}`);
        }
        
        req.logIn(user, (err) => {
          if (err) {
            console.error('Login error:', err);
            return res.redirect('/login?error=auth_failed');
          }
          
          const returnTo = req.session.returnTo || '/';
          delete req.session.returnTo;
          return res.redirect(returnTo);
        });
      })(req, res, next);
    });
  }
}

if (authConfig.mode === 'local' || authConfig.mode === 'both') {
  if (authConfig.Local && authConfig.Local.enabled) {
    app.post('/auth/local', csrfProtection, (req, res, next) => {
      passport.authenticate('local', (err, user, info) => {
        if (err) {
          console.error('Local auth error:', err);
          return res.redirect('/login?error=auth_failed');
        }
        
        if (!user) {
          const errorType = info?.message || 'invalid_credentials';
          return res.redirect(`/login?error=${errorType}`);
        }
        
        req.logIn(user, (err) => {
          if (err) {
            console.error('Login error:', err);
            return res.redirect('/login?error=auth_failed');
          }
          
          const returnTo = req.session.returnTo || '/';
          delete req.session.returnTo;
          return res.redirect(returnTo);
        });
      })(req, res, next);
    });
  }
}

    app.get('/register', csrfProtection, (req, res) => {
      if (req.isAuthenticated()) {
        return res.redirect('/');
      }
      
      res.render('register', {
        user: null,
        existingUser: null,
        error: null,
        success: null,
        authConfig,
        config,
      });
    });

app.post('/register', csrfProtection, async (req, res) => {
  try {
    const { username, email, password, confirmPassword } = req.body;
    
    if (!username || !email || !password || !confirmPassword) {
      return res.render('register', {
        user: null,
        existingUser: null,
        error: 'All fields are required.',
        success: null,
        authConfig,
        config,
        username,
        email
      });
    }
    
    if (username.trim().length < 3) {
      return res.render('register', {
        user: null,
        existingUser: null,
        error: 'Username must be at least 3 characters long.',
        success: null,
        authConfig,
        config,
        username,
        email
      });
    }
    
    if (username.trim().length > 20) {
      return res.render('register', {
        user: null,
        existingUser: null,
        error: 'Username must be 20 characters or less.',
        success: null,
        authConfig,
        config,
        username,
        email
      });
    }
    
    const usernameRegex = /^[a-zA-Z0-9_]+$/;
    if (!usernameRegex.test(username.trim())) {
      return res.render('register', {
        user: null,
        existingUser: null,
        error: 'Username can only contain letters, numbers, and underscores. No spaces or special characters allowed.',
        success: null,
        authConfig,
        config,
        username,
        email
      });
    }
    
    if (password !== confirmPassword) {
      return res.render('register', {
        user: null,
        existingUser: null,
        error: 'Passwords do not match.',
        success: null,
        authConfig,
        config,
        username,
        email
      });
    }
    
    const minPasswordLength = authConfig.Local.minPasswordLength || 8;
    if (password.length < minPasswordLength) {
      return res.render('register', {
        user: null,
        existingUser: null,
        error: `Password must be at least ${minPasswordLength} characters long.`,
        success: null,
        authConfig,
        config,
        username,
        email
      });
    }
    
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return res.render('register', {
        user: null,
        existingUser: null,
        error: 'Please enter a valid email address.',
        success: null,
        authConfig,
        config,
        username,
        email
      });
    }
    
    const existingUserByEmail = await userModel.findOne({ email: email.toLowerCase().trim() });
    const existingUserByUsername = await userModel.findOne({ username: username.trim() });
    
    if (existingUserByEmail) {
      return res.render('register', {
        user: null,
        existingUser: null,
        error: 'An account with this email already exists.',
        success: null,
        authConfig,
        config,
        username,
        email
      });
    }
    
    if (existingUserByUsername) {
      return res.render('register', {
        user: null,
        existingUser: null,
        error: 'This username is already taken. Please choose another one.',
        success: null,
        authConfig,
        config,
        username,
        email
      });
    }
    
    const hashedPassword = await bcrypt.hash(password, 12);
    
    const verificationToken = authConfig.Local.requireEmailVerification 
      ? crypto.randomBytes(32).toString('hex') 
      : null;
    
    const newUser = new userModel({
      username: username.trim(),
      email: email.toLowerCase().trim(),
      password: hashedPassword,
      authMethod: 'local',
      emailVerified: !authConfig.Local.requireEmailVerification,
      verificationToken,
      verificationTokenExpires: authConfig.Local.requireEmailVerification 
        ? new Date(Date.now() + 24 * 60 * 60 * 1000) 
        : null
    });
    
    await newUser.save();
    
    const now = new Date();
    const currentYear = now.getFullYear();
    const currentMonthIndex = now.getMonth();

    const stats = await statisticsModel.getStatistics();
    let yearlyStats = stats.yearlyStats.find(y => y.year === currentYear);
    if (!yearlyStats) {
        yearlyStats = {
            year: currentYear,
            months: Array(12).fill(null).map(() => ({ totalEarned: 0, totalPurchases: 0, userJoins: 0, totalSiteVisits: 0 }))
        };
        stats.yearlyStats.push(yearlyStats);
    }

    if (!yearlyStats.months || yearlyStats.months.length !== 12) {
        yearlyStats.months = Array(12).fill(null).map(() => ({ totalEarned: 0, totalPurchases: 0, userJoins: 0, totalSiteVisits: 0 }));
    }

    yearlyStats.months[currentMonthIndex].userJoins += 1;

    await stats.save();
    
    if (authConfig.Local.requireEmailVerification) {
      const settings = await settingsModel.findOne();
      
      if (settings.emailSettings && settings.emailSettings.enabled) {
        try {
          await utils.sendVerificationEmail(newUser, verificationToken, config, settings);
        } catch (emailError) {
          console.error('Failed to send verification email:', emailError);
        }
      }
    }
    
    if (authConfig.Local.requireEmailVerification) {
      return res.render('register', {
        user: null,
        existingUser: null,
        error: null,
        success: 'Registration successful! Please check your email to verify your account.',
        authConfig,
        config,
        email: newUser.email
      });
    } else {
      req.login({
        id: newUser._id.toString(),
        email: newUser.email,
        username: newUser.username,
        authMethod: 'local',
        emailVerified: true
      }, (err) => {
    if (err) {
        console.error('Auto-login error:', err);
        if (!res.headersSent) {
            return res.redirect('/login');
        }
        return;
    }
        return res.redirect('/');
      });
    }
    
  } catch (error) {
    console.error('Registration error:', error);
    res.render('register', {
      user: null,
      existingUser: null,
      error: 'An error occurred during registration. Please try again.',
      success: null,
      authConfig,
      config,
      username: req.body.username,
      email: req.body.email
    });
  }
});

if (authConfig.mode === 'local' || authConfig.mode === 'both') {
  if (authConfig.Local && authConfig.Local.enabled && authConfig.Local.requireEmailVerification) {
app.get('/verify-email/:token', async (req, res) => {
  try {
    const { token } = req.params;
    
    const user = await userModel.findOne({
      verificationToken: token,
      verificationTokenExpires: { $gt: Date.now() }
    });
    
    if (!user) {
      return res.render('verify-email', {
        user: null,
        existingUser: null,
        success: false,
        error: 'Invalid or expired verification link. Please request a new verification email.',
        config,
      });
    }
    
    if (user.emailVerified) {
      return res.render('verify-email', {
        user: null,
        existingUser: null,
        success: false,
        error: 'This email has already been verified. You can log in to your account.',
        config,
      });
    }
    
    user.emailVerified = true;
    user.verificationToken = undefined;
    user.verificationTokenExpires = undefined;
    await user.save();
    
    console.log(`Email verified for user: ${user.email}`);
    
    res.render('verify-email', {
      user: null,
      existingUser: null,
      success: true,
      error: null,
      config,
    });
    
  } catch (error) {
    console.error('Email verification error:', error);
    res.render('verify-email', {
      user: null,
      existingUser: null,
      success: false,
      error: 'An error occurred during verification. Please try again later.',
      config,
    });
  }
});
  }
}

app.post('/forgot-password', csrfProtection, async (req, res) => {
  try {
    const { email } = req.body;
    
    if (!email) {
      return res.json({ 
        success: false, 
        message: 'Email address is required' 
      });
    }
    
    const normalizedEmail = email.toLowerCase().trim();
    
    const rateLimitCheck = checkResendRateLimit(normalizedEmail);
    if (!rateLimitCheck.allowed) {
      return res.json({ 
        success: false, 
        message: `Too many requests. Please wait ${rateLimitCheck.waitTime} seconds before trying again.` 
      });
    }
    
    const user = await userModel.findOne({ 
      email: normalizedEmail,
      authMethod: { $in: ['local', 'both'] }
    });
    
    if (!user) {
      return res.json({ 
        success: true, 
        message: 'If an account with that email exists, a password reset link has been sent.' 
      });
    }
    
    const resetToken = crypto.randomBytes(32).toString('hex');
    user.resetPasswordToken = resetToken;
    user.resetPasswordExpires = new Date(Date.now() + 60 * 60 * 1000);
    await user.save();
    
    const settings = await settingsModel.findOne();
    
    if (settings.emailSettings && settings.emailSettings.enabled) {
      try {
        await utils.sendPasswordResetEmail(user, resetToken, config, settings);
        console.log(`Password reset email sent to: ${user.email}`);
        
        return res.json({ 
          success: true, 
          message: 'Password reset link sent! Please check your email.' 
        });
      } catch (emailError) {
        console.error('Failed to send password reset email:', emailError);
        return res.json({ 
          success: false, 
          message: 'Failed to send email. Please try again later.' 
        });
      }
    } else {
      return res.json({ 
        success: false, 
        message: 'Email service is not configured.' 
      });
    }
    
  } catch (error) {
    console.error('Forgot password API error:', error);
    res.json({ 
      success: false, 
      message: 'An error occurred. Please try again.' 
    });
  }
});

app.get('/reset-password/:token', csrfProtection, async (req, res) => {
  try {
    const { token } = req.params;
    
    const user = await userModel.findOne({
      resetPasswordToken: token,
      resetPasswordExpires: { $gt: Date.now() }
    });
    
    if (!user) {
      return res.render('reset-password', {
        user: null,
        existingUser: null,
        validToken: false,
        error: 'Invalid or expired password reset link.',
        config,
      });
    }
    
    res.render('reset-password', {
      user: null,
      existingUser: null,
      validToken: true,
      error: null,
      resetToken: token,
      config,
    });
    
  } catch (error) {
    console.error('Reset password page error:', error);
    res.render('reset-password', {
      user: null,
      existingUser: null,
      validToken: false,
      error: 'An error occurred. Please try again.',
      config,
    });
  }
});

app.post('/reset-password/:token', csrfProtection, async (req, res) => {
  try {
    const { token } = req.params;
    const { password, confirmPassword } = req.body;
    
    if (!password || !confirmPassword) {
      return res.json({
        success: false,
        message: 'All fields are required.'
      });
    }
    
    if (password !== confirmPassword) {
      return res.json({
        success: false,
        message: 'Passwords do not match.'
      });
    }
    
    const minPasswordLength = authConfig.Local.minPasswordLength || 8;
    if (password.length < minPasswordLength) {
      return res.json({
        success: false,
        message: `Password must be at least ${minPasswordLength} characters long.`
      });
    }
    
    const user = await userModel.findOne({
      resetPasswordToken: token,
      resetPasswordExpires: { $gt: Date.now() }
    });
    
    if (!user) {
      return res.json({
        success: false,
        message: 'Invalid or expired password reset link.'
      });
    }
    
    const hashedPassword = await bcrypt.hash(password, 12);
    
    user.password = hashedPassword;
    user.resetPasswordToken = undefined;
    user.resetPasswordExpires = undefined;
    await user.save();
    
    console.log(`Password reset successful for user: ${user.email}`);
    
    res.json({
      success: true,
      message: 'Password reset successful! You can now log in with your new password.'
    });
    
  } catch (error) {
    console.error('Reset password error:', error);
    res.json({
      success: false,
      message: 'An error occurred. Please try again.'
    });
  }
});

const resendRateLimiter = new Map();

function checkResendRateLimit(email) {
  const now = Date.now();
  const rateLimit = resendRateLimiter.get(email);
  
  if (!rateLimit) {
    resendRateLimiter.set(email, { count: 1, resetTime: now + 60000 });
    return { allowed: true };
  }
  
  if (now > rateLimit.resetTime) {
    resendRateLimiter.set(email, { count: 1, resetTime: now + 60000 });
    return { allowed: true };
  }
  
  if (rateLimit.count >= 3) {
    const waitTime = Math.ceil((rateLimit.resetTime - now) / 1000);
    return { allowed: false, waitTime };
  }
  
  rateLimit.count++;
  return { allowed: true };
}

setInterval(() => {
  const now = Date.now();
  for (const [email, data] of resendRateLimiter.entries()) {
    if (now > data.resetTime) {
      resendRateLimiter.delete(email);
    }
  }
}, 5 * 60 * 1000);

app.post('/api/resend-verification', csrfProtection, async (req, res) => {
  try {
    const { email } = req.body;
    
    if (!email) {
      return res.json({ 
        success: false, 
        message: 'Email address is required' 
      });
    }
    
    const normalizedEmail = email.toLowerCase().trim();
    
    const rateLimitCheck = checkResendRateLimit(normalizedEmail);
    if (!rateLimitCheck.allowed) {
      return res.json({ 
        success: false, 
        message: `Too many requests. Please wait ${rateLimitCheck.waitTime} seconds before trying again.` 
      });
    }
    
    const user = await userModel.findOne({ email: normalizedEmail });
    
    if (!user) {
      return res.json({ 
        success: true, 
        message: 'If an account exists, a verification email has been sent.' 
      });
    }
    
    if (user.emailVerified) {
      return res.json({ 
        success: false, 
        message: 'This email is already verified. You can log in to your account.' 
      });
    }
    
    const verificationToken = crypto.randomBytes(32).toString('hex');
    user.verificationToken = verificationToken;
    user.verificationTokenExpires = new Date(Date.now() + 24 * 60 * 60 * 1000);
    await user.save();
    
    const settings = await settingsModel.findOne();
    
    if (settings.emailSettings && settings.emailSettings.enabled) {
      try {
        await utils.sendVerificationEmail(user, verificationToken, config, settings);
        console.log(`Verification email resent to: ${user.email}`);
        
        return res.json({ 
          success: true, 
          message: 'Verification email sent successfully!' 
        });
      } catch (emailError) {
        console.error('Failed to send verification email:', emailError);
        return res.json({ 
          success: false, 
          message: 'Failed to send email. Please try again later.' 
        });
      }
    } else {
      return res.json({ 
        success: false, 
        message: 'Email service is not configured.' 
      });
    }
    
  } catch (error) {
    console.error('Resend verification API error:', error);
    res.json({ 
      success: false, 
      message: 'An error occurred. Please try again.' 
    });
  }
});

app.post('/api/change-email', csrfProtection, async (req, res) => {
  try {
    if (!req.isAuthenticated()) {
      return res.json({ 
        success: false, 
        message: 'You must be logged in to change your email' 
      });
    }
    
    const { newEmail } = req.body;
    
    if (!newEmail) {
      return res.json({ 
        success: false, 
        message: 'New email address is required' 
      });
    }
    
    const normalizedEmail = newEmail.toLowerCase().trim();
    
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(normalizedEmail)) {
      return res.json({ 
        success: false, 
        message: 'Please enter a valid email address' 
      });
    }
    
    const currentUser = await findUserById(req.user.id);

    if (!currentUser) {
      return res.json({ 
        success: false, 
        message: 'User not found' 
      });
    }

    const existingUser = await userModel.findOne({ 
      email: normalizedEmail,
      _id: { $ne: currentUser._id }
    });

    if (existingUser) {
      return res.json({ 
        success: false, 
        message: 'This email address is already in use by another account' 
      });
    }
    
    const user = await findUserById(req.user.id);
    
    if (!user) {
      return res.json({ 
        success: false, 
        message: 'User not found' 
      });
    }
    
    if (user.email && user.email.toLowerCase() === normalizedEmail) {
      return res.json({ 
        success: false, 
        message: 'This is already your current email address' 
      });
    }
    
    const rateLimitCheck = checkResendRateLimit(normalizedEmail);
    if (!rateLimitCheck.allowed) {
      return res.json({ 
        success: false, 
        message: `Too many requests. Please wait ${rateLimitCheck.waitTime} seconds before trying again.` 
      });
    }
    
    const emailChangeToken = crypto.randomBytes(32).toString('hex');
    user.pendingEmail = normalizedEmail;
    user.emailChangeToken = emailChangeToken;
    user.emailChangeTokenExpires = new Date(Date.now() + 60 * 60 * 1000);
    await user.save();
    
    const settings = await settingsModel.findOne();
    
    if (settings.emailSettings && settings.emailSettings.enabled) {
      try {
        await utils.sendEmailChangeEmail(user, emailChangeToken, normalizedEmail, config, settings);
        console.log(`Email change verification sent to: ${normalizedEmail}`);
        
        return res.json({ 
          success: true, 
          message: 'Verification email sent! Please check your new email address to confirm the change.' 
        });
      } catch (emailError) {
        console.error('Failed to send email change verification:', emailError);
        return res.json({ 
          success: false, 
          message: 'Failed to send verification email. Please try again later.' 
        });
      }
    } else {
      return res.json({ 
        success: false, 
        message: 'Email service is not configured.' 
      });
    }
    
  } catch (error) {
    console.error('Change email API error:', error);
    res.json({ 
      success: false, 
      message: 'An error occurred. Please try again.' 
    });
  }
});

app.get('/verify-email-change/:token', async (req, res) => {
  try {
    const { token } = req.params;
    
    const user = await userModel.findOne({
      emailChangeToken: token,
      emailChangeTokenExpires: { $gt: Date.now() }
    });
    
    if (!user || !user.pendingEmail) {
      return res.render('email-change-result', {
        user: null,
        existingUser: null,
        success: false,
        error: 'Invalid or expired email change link.',
        config,
      });
    }
    
    const oldEmail = user.email;
    user.email = user.pendingEmail;
    user.emailVerified = true;
    user.pendingEmail = undefined;
    user.emailChangeToken = undefined;
    user.emailChangeTokenExpires = undefined;
    await user.save();
    
    console.log(`Email changed from ${oldEmail} to ${user.email} for user: ${user.username || user.discordID}`);
    
    res.render('email-change-result', {
      user: null,
      existingUser: null,
      success: true,
      error: null,
      config,
    });
    
  } catch (error) {
    console.error('Email change verification error:', error);
    res.render('email-change-result', {
      user: null,
      existingUser: null,
      success: false,
      error: 'An error occurred during verification. Please try again later.',
      config,
    });
  }
});

app.use('/uploads', (req, res, next) => {
  const allowedExtensions = ['.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.ico'];
  const sanitizedPath = req.path.replace(/^\//, '');
  const filePath = path.join(__dirname, 'uploads', sanitizedPath);
  const fileExtension = path.extname(filePath).toLowerCase();

  if (!fs.existsSync(filePath)) {
      if(config.DebugMode) console.error(`Access denied: File does not exist - ${filePath}`);
      return res.status(403).send('Access denied');
  }

  if (fs.statSync(filePath).isDirectory()) {
    if(config.DebugMode) console.error(`Access denied: Requested path is a directory - ${filePath}`);
      return res.status(403).send('Access denied');
  }

  if (allowedExtensions.includes(fileExtension)) {
      return res.sendFile(filePath);
  }

  if(config.DebugMode) console.error(`Access denied: File extension not allowed - ${fileExtension}`);
  res.status(403).send('Access denied: File extension not allowed');
});

let visitCounter = 0;
const recentVisitors = new Map();

function trackSiteVisits(req, res, next) {
  if (!req.path.startsWith('/api') && !req.path.includes('static')) {
      const userIp = req.ip || req.connection.remoteAddress;
      const now = Date.now();

      if (!recentVisitors.has(userIp) || (now - recentVisitors.get(userIp) > 10 * 60 * 1000)) {
          visitCounter += 1;
          recentVisitors.set(userIp, now);
      }
  }
  next();
}


const uploadsDir = path.join(__dirname, 'uploads');

async function cleanupUploads() {
  fs.readdir(uploadsDir, (err, files) => {
      if (err) {
        if (config.DebugMode) console.error(`Unable to read directory: ${err.message}`);
        return;
      }

      files.forEach(file => {
          if (file.startsWith('temp-')) {
              const filePath = path.join(uploadsDir, file);
              fs.stat(filePath, (err, stats) => {
                  if (err) {
                    if (config.DebugMode) console.error(`Unable to get stats for file: ${err.message}`);
                    return;
                  }

                  if (stats && (stats.isFile() || stats.isDirectory())) {
                      fs.rm(filePath, { recursive: true, force: true }, (err) => {
                          if (err) {
                            if (config.DebugMode) console.error(`Error deleting file/folder: ${err.message}`);
                          } else {
                            if (config.DebugMode) console.log(`Deleted: ${filePath}`);
                          }
                      });
                  }
              });
          }
      });
  });
}

async function saveVisitsToDatabase() {
  try {
      const statistics = await statisticsModel.findOne() || new statisticsModel();
      statistics.totalSiteVisits += visitCounter;

      const now = new Date();
      const currentYear = now.getFullYear();
      const currentMonthIndex = now.getMonth();

      let yearlyStats = statistics.yearlyStats.find(y => y.year === currentYear);
      if (!yearlyStats) {
          yearlyStats = {
              year: currentYear,
              months: Array(12).fill(null).map(() => ({ totalEarned: 0, totalPurchases: 0, userJoins: 0, totalSiteVisits: 0 }))
          };
          statistics.yearlyStats.push(yearlyStats);
      }

      yearlyStats.months[currentMonthIndex].totalSiteVisits += visitCounter;

      await statistics.save();
      visitCounter = 0;

      const tenMinutesAgo = Date.now() - 10 * 60 * 1000;
      for (let [ip, time] of recentVisitors) {
          if (time < tenMinutesAgo) {
              recentVisitors.delete(ip);
          }
      }
  } catch (error) {
      console.error('Error saving visit count to the database:', error);
  }
}
app.use(trackSiteVisits);

async function checkExpiredSales() {
  try {
    const products = await productModel.find({
      onSale: true,
      saleEndDate: { $ne: null }
    });
 
    const now = new Date();
 
    for (const product of products) {
      if (product.saleEndDate < now) {
        await productModel.findByIdAndUpdate(product._id, {
          onSale: false,
          salePrice: null, 
          saleStartDate: null,
          saleEndDate: null
        });
      }
    }
  } catch (error) {
    console.error('Error checking expired sales:', error);
  }
 }

function performMaintenanceTasks() {
  saveVisitsToDatabase();
  cleanupUploads();
  checkExpiredSales();
 }
 

setInterval(performMaintenanceTasks, 5 * 60 * 1000);


app.get('/', async (req, res, next) => {
  try {
    let stats = cache.get('stats');
    let totalUsers = cache.get('totalUsers');
    let totalProducts = cache.get('totalProducts');
    let reviewsWithDiscordData = cache.get('randomReviews');
  
    if (!stats || !totalUsers || !totalProducts) {
      [stats, totalUsers, totalProducts] = await Promise.all([
        statisticsModel.getStatistics(),
        userModel.countDocuments({}),
        productModel.countDocuments({})
      ]);
      
      cache.set('stats', stats, 15 * 60);
      cache.set('totalUsers', totalUsers, 15 * 60);
      cache.set('totalProducts', totalProducts, 15 * 60);
    }

    if (!reviewsWithDiscordData) {
      const reviews = await reviewModel.aggregate([{ $sample: { size: 15 } }]).exec();
      
      reviewsWithDiscordData = await Promise.all(reviews.map(async (review) => {
        const cachedUser = cache.get(`discordUser_${review.discordID}`);
        if (cachedUser) {
          return {
            ...review,
            discordUsername: cachedUser.username,
            discordAvatar: cachedUser.avatar,
          };
        }
        
        if (review.discordID) {
          try {
            const discordUser = await client.users.fetch(review.discordID);
            const discordUserData = {
              username: discordUser.username,
              avatar: discordUser.displayAvatarURL({ dynamic: true }),
            };
            
            cache.set(`discordUser_${review.discordID}`, discordUserData);
            
            return {
              ...review,
              discordUsername: discordUserData.username,
              discordAvatar: discordUserData.avatar,
            };
          } catch (error) {
            return {
              ...review,
              discordUsername: review.discordUsername || review.username || 'Unknown User',
              discordAvatar: review.avatarPath || '/images/default-avatar.png',
            };
          }
        } else {
          return {
            ...review,
            discordUsername: review.username || 'Unknown User',
            discordAvatar: review.avatarPath || '/images/default-avatar.png',
          };
        }
      }));
      
      cache.set('randomReviews', reviewsWithDiscordData, 15 * 60);
    }
    
    let existingUser = null;
    if (req.user) {
      existingUser = await findUserById(req.user.id);
    }
    
    const currentDate = new Date();
    const currentMonth = currentDate.getMonth();
    const currentYear = currentDate.getFullYear();

    const lastMonth = currentMonth === 0 ? 11 : currentMonth - 1;
    const lastMonthYear = currentMonth === 0 ? currentYear - 1 : currentYear;

    const yearlyStats = stats.yearlyStats.find(y => y.year === currentYear);
    const previousYearStats = stats.yearlyStats.find(y => y.year === lastMonthYear);

    const thisMonthStats = yearlyStats?.months[currentMonth] || { totalEarned: 0, totalPurchases: 0, userJoins: 0, totalSiteVisits: 0 };
    const lastMonthStats = previousYearStats?.months[lastMonth] || { totalEarned: 0, totalPurchases: 0, userJoins: 0, totalSiteVisits: 0 };

    res.render('home', {
      user: req.user || null,
      existingUser,
      stats,
      thisMonthStats,
      lastMonthStats,
      totalUsers,
      totalProducts,
      reviews: reviewsWithDiscordData,
    });
  } catch (error) {
    next(error);
  }
});

app.get('/api/users/:userId', checkApiKey, async (req, res) => {
  try {
    const { userId } = req.params;
    
    const user = await findUserById(userId);
    if (!user) return res.status(404).json({ error: 'USER_NOT_FOUND' });

    await user.populate('cart', 'name productType');
    await user.populate('ownedProducts', 'name productType');

    res.json({
      discordID: user.discordID || null,
      userId: user._id.toString(),
      username: user.username || user.discordUsername,
      displayName: user.getDisplayName(),
      banned: user.banned,
      email: user.email,
      emailVerified: user.emailVerified,
      totalSpent: user.totalSpent,
      joinedAt: user.joinedAt,
      cart: user.cart,
      ownedProducts: user.ownedProducts,
      ownedSerials: user.ownedSerials,
      authMethod: user.authMethod
    });
  } catch (error) {
    console.error('Error fetching user data:', error);
    res.status(500).json({ error: 'SERVER_ERROR' });
  }
});

app.post('/api/users/:userId/addproduct/:urlId', checkApiKey, async (req, res) => {
  try {
    const { userId, urlId } = req.params;

    const user = await findUserById(userId);
    if (!user) return res.status(404).json({ error: 'USER_NOT_FOUND' });

    const product = await productModel.findOne({ urlId });
    if (!product) return res.status(404).json({ error: 'PRODUCT_NOT_FOUND' });

    if (user.ownedProducts.includes(product._id)) {
      return res.status(400).json({ error: 'PRODUCT_ALREADY_OWNED' });
    }
    
    user.ownedProducts.push(product._id);
    await user.save();

    if (user.discordID && (user.authMethod === 'discord' || user.authMethod === 'both')) {
      const guild = await client.guilds.fetch(config.GuildID);
      if (guild) {
        try {
          const guildMember = await guild.members.fetch(user.discordID);
          
          if (guildMember && product.discordRoleIds && product.discordRoleIds.length > 0) {
            for (const roleId of product.discordRoleIds) {
              const role = guild.roles.cache.get(roleId);
              if (role) {
                await guildMember.roles.add(role);
              } else {
                if(config.DebugMode) console.warn(`Role ID ${roleId} does not exist in the guild.`);
              }
            }
          }
        } catch (error) {
          if(config.DebugMode) console.error(`Failed to add Discord roles: ${error.message}`);
        }
      }
    }

    await user.populate('ownedProducts', 'name productType urlId');

    const userDisplayName = user.discordUsername || user.username || user.email.split('@')[0];
    const userIdentifier = user.getIdentifier();

    utils.sendDiscordLog('Product Added to User',
      `**[API Endpoint]** has added the product \`${product.name}\` to [${userDisplayName}](${config.baseURL}/profile/${userIdentifier})'s owned products.`
    );

    res.json({
      message: 'PRODUCT_ADDED_SUCCESSFULLY',
      user: {
        id: userIdentifier,
        discordID: user.discordID || null,
        email: user.email,
        authMethod: user.authMethod,
        ownedProducts: user.ownedProducts,
      },
      product: {
        name: product.name,
        urlId: product.urlId,
      },
    });
  } catch (error) {
    console.error('Error adding product to user:', error);
    res.status(500).json({ error: 'SERVER_ERROR' });
  }
});

app.post('/api/users/:userId/removeproduct/:urlId', checkApiKey, async (req, res) => {
  try {
    const { userId, urlId } = req.params;

    const user = await findUserById(userId);
    if (!user) return res.status(404).json({ error: 'USER_NOT_FOUND' });

    const product = await productModel.findOne({ urlId });
    if (!product) return res.status(404).json({ error: 'PRODUCT_NOT_FOUND' });

    const productIndex = user.ownedProducts.indexOf(product._id);
    if (productIndex === -1) {
      return res.status(400).json({ error: 'PRODUCT_NOT_OWNED' });
    }

    user.ownedProducts.splice(productIndex, 1);
    await user.save();

    if (user.discordID && (user.authMethod === 'discord' || user.authMethod === 'both')) {
      const guild = await client.guilds.fetch(config.GuildID);
      if (guild) {
        try {
          const guildMember = await guild.members.fetch(user.discordID);
          
          if (guildMember && product.discordRoleIds && product.discordRoleIds.length > 0) {
            for (const roleId of product.discordRoleIds) {
              const role = guild.roles.cache.get(roleId);
              if (role) {
                await guildMember.roles.remove(role);
              } else {
                if(config.DebugMode) console.warn(`Role ID ${roleId} does not exist in the guild.`);
              }
            }
          }
        } catch (error) {
          if(config.DebugMode) console.error(`Failed to remove Discord roles: ${error.message}`);
        }
      }
    }

    await user.populate('ownedProducts', 'name productType urlId');

    const userDisplayName = user.discordUsername || user.username || user.email.split('@')[0];
    const userIdentifier = user.getIdentifier();

    utils.sendDiscordLog('Product Removed from User',
      `**[API Endpoint]** has removed the product \`${product.name}\` from [${userDisplayName}](${config.baseURL}/profile/${userIdentifier})'s owned products.`
    );

    res.json({
      message: 'PRODUCT_REMOVED_SUCCESSFULLY',
      user: {
        id: userIdentifier,
        discordID: user.discordID || null,
        email: user.email,
        authMethod: user.authMethod,
        ownedProducts: user.ownedProducts,
      },
      product: {
        name: product.name,
        urlId: product.urlId,
      },
    });
  } catch (error) {
    console.error('Error removing product from user:', error);
    res.status(500).json({ error: 'SERVER_ERROR' });
  }
});


app.get('/api/payments/:transactionID', checkApiKey, async (req, res) => {
  try {
    const { transactionID } = req.params;
    const payment = await paymentModel.findOne({ transactionID });

    if (!payment) return res.status(404).json({ error: 'PAYMENT_NOT_FOUND' });

    res.json(payment);
  } catch (error) {
    console.error('Error fetching payment data:', error);
    res.status(500).json({ error: 'SERVER_ERROR' });
  }
});

app.get('/api/products', checkApiKey, async (req, res) => {
  try {
    const products = await productModel.find({}, 'name productType price totalPurchases totalEarned totalDownloads createdAt');

    if (products.length === 0) return res.status(404).json({ error: 'NO_PRODUCTS_FOUND' });

    res.json(products);
  } catch (error) {
    console.error('Error fetching products:', error);
    res.status(500).json({ error: 'SERVER_ERROR' });
  }
});


app.get('/api/statistics', checkApiKey, async (req, res) => {
  try {
    const statistics = await statisticsModel.findOne({}, 'totalPurchases totalEarned totalSiteVisits');

    if (!statistics) return res.status(404).json({ error: 'STATISTICS_NOT_FOUND' });

    const totalUsers = await userModel.countDocuments({});
    const totalProducts = await productModel.countDocuments({});

    res.json({
      totalPurchases: statistics.totalPurchases,
      totalEarned: statistics.totalEarned,
      totalSiteVisits: statistics.totalSiteVisits,
      totalUsers: totalUsers,
      totalProducts: totalProducts
    });
  } catch (error) {
    console.error('Error fetching statistics:', error);
    res.status(500).json({ error: 'SERVER_ERROR' });
  }
});

app.get('/api/reviews', checkApiKey, async (req, res) => {
  try {
    const reviews = await reviewModel.find({})
      .select('userId discordID discordUsername username avatarPath productName rating comment createdAt')
      .lean();

    if (reviews.length === 0) return res.status(404).json({ error: 'NO_REVIEWS_FOUND' });

    const formattedReviews = reviews.map(review => ({
      reviewId: review._id.toString(),
      userId: review.userId.toString(),
      discordID: review.discordID || null,
      username: review.username || review.discordUsername || 'Unknown User',
      avatarPath: review.avatarPath,
      productName: review.productName,
      rating: review.rating,
      comment: review.comment,
      createdAt: review.createdAt
    }));

    res.json(formattedReviews);
  } catch (error) {
    console.error('Error fetching reviews:', error);
    res.status(500).json({ error: 'SERVER_ERROR' });
  }
});

app.get('/tos', async(req, res, next) => {
  const settings = await settingsModel.findOne();
  
  if(!req.user) return res.render('tos', { 
    user: null, 
    existingUser: null,
    tosLastUpdated: settings.tosLastUpdated 
  });

  const existingUser = await findUserById(req.user.id);

  res.render('tos', { 
    user: req.user, 
    existingUser,
    tosLastUpdated: settings.tosLastUpdated 
  });
});

app.get('/privacy-policy', async(req, res, next) => {
  const settings = await settingsModel.findOne();
  
  if(!req.user) return res.render('privacy-policy', { 
    user: null, 
    existingUser: null,
    privacyPolicyLastUpdated: settings.privacyPolicyLastUpdated 
  });

  const existingUser = await findUserById(req.user.id);

  res.render('privacy-policy', { 
    user: req.user, 
    existingUser,
    privacyPolicyLastUpdated: settings.privacyPolicyLastUpdated 
  });
});

app.get('/staff/overview', checkAuthenticated, checkStaffAccess('canCreateProducts', 'canUpdateProducts', 'canDeleteProducts', 'canAddProducts', 'canRemoveProducts', 'canViewInvoices', 'canManageDiscounts', 'canManageSales', 'canManageAntiPiracy'), async (req, res, next) => {
  try {
    const stats = await statisticsModel.getStatistics();
    const totalUsers = await userModel.countDocuments();

    let existingUser = await findUserById(req.user.id);

    
    const currentMonth = new Date().getMonth();
    const previousMonth = currentMonth === 0 ? 11 : currentMonth - 1;

    
    const currentYear = new Date().getFullYear();
    const previousYear = currentMonth === 0 ? currentYear - 1 : currentYear;

    
    const yearlyStats = stats.yearlyStats.find(y => y.year === currentYear);
    const previousYearlyStats = stats.yearlyStats.find(y => y.year === previousYear);

    const thisMonthStats = yearlyStats?.months[currentMonth] || { totalEarned: 0, totalPurchases: 0, userJoins: 0, totalSiteVisits: 0 };
    const lastMonthStats = previousMonth === 11 
        ? previousYearlyStats?.months[previousMonth] || { totalEarned: 0, totalPurchases: 0, userJoins: 0, totalSiteVisits: 0 } 
        : yearlyStats?.months[previousMonth] || { totalEarned: 0, totalPurchases: 0, userJoins: 0, totalSiteVisits: 0 };

    
    const salesDifference = lastMonthStats.totalPurchases === 0 
        ? 100 
        : ((thisMonthStats.totalPurchases - lastMonthStats.totalPurchases) / lastMonthStats.totalPurchases) * 100;

    const joinsDifference = lastMonthStats.userJoins === 0 
        ? 100 
        : ((thisMonthStats.userJoins - lastMonthStats.userJoins) / lastMonthStats.userJoins) * 100;

    const revenueDifference = lastMonthStats.totalEarned === 0 
        ? 100 
        : ((thisMonthStats.totalEarned - lastMonthStats.totalEarned) / lastMonthStats.totalEarned) * 100;
    
    const visitsDifference = lastMonthStats.totalSiteVisits === 0 
        ? 100 
        : ((thisMonthStats.totalSiteVisits - lastMonthStats.totalSiteVisits) / lastMonthStats.totalSiteVisits) * 100;

    
    const monthlyUserJoins = yearlyStats?.months.map(m => m.userJoins) || Array(12).fill(0);
    const monthlyPurchases = yearlyStats?.months.map(m => m.totalPurchases) || Array(12).fill(0);
    const monthlyRevenue = yearlyStats?.months.map(m => m.totalEarned.toFixed(2)) || Array(12).fill(0);
    const monthlySiteVisits = yearlyStats?.months.map(m => m.totalSiteVisits) || Array(12).fill(0);

    
    const allYears = stats.yearlyStats.map(y => y.year).sort((a, b) => a - b);
    
    const yearlyUserJoins = allYears.map(year => {
      const yearData = stats.yearlyStats.find(y => y.year === year);
      return yearData ? yearData.months.reduce((total, month) => total + month.userJoins, 0) : 0;
    });

    const yearlyPurchases = allYears.map(year => {
      const yearData = stats.yearlyStats.find(y => y.year === year);
      return yearData ? yearData.months.reduce((total, month) => total + month.totalPurchases, 0) : 0;
    });

    const yearlyRevenue = allYears.map(year => {
      const yearData = stats.yearlyStats.find(y => y.year === year);
      return yearData ? parseFloat(yearData.months.reduce((total, month) => total + month.totalEarned, 0).toFixed(2)) : 0;
    });

    const yearlySiteVisits = allYears.map(year => {
      const yearData = stats.yearlyStats.find(y => y.year === year);
      return yearData ? yearData.months.reduce((total, month) => total + month.totalSiteVisits, 0) : 0;
    });

    
    const topUsers = await userModel.find().sort({ totalSpent: -1 }).limit(5).select('discordUsername totalSpent');

    
    const topProducts = await productModel.find().sort({ totalPurchases: -1 }).limit(5).select('name totalPurchases');

    res.render('staff/overview', {
      user: req.user,
      existingUser,
      stats,
      thisMonthStats,
      lastMonthStats,
      salesDifference,
      revenueDifference,
      joinsDifference,
      visitsDifference,
      totalUsers,
      monthlyUserJoins,
      monthlySiteVisits,
      monthlyPurchases,
      monthlyRevenue,
      allYears,
      yearlyUserJoins,
      yearlyPurchases,
      yearlyRevenue,
      yearlySiteVisits,
      topUsers,
      topProducts
    });
  } catch (error) {
    next(error);
  }
});



app.get('/staff/anti-piracy', checkAuthenticated, checkStaffAccess('canManageAntiPiracy'), async (req, res, next) => {
  try {

     let existingUser = await findUserById(req.user.id);

    res.render('staff/anti-piracy', { user: req.user, existingUser, downloadInfo: null });
  } catch (error) {
    console.error('Error fetching anti-piracy-placeholders:', error);
    next(error);
  }
});

app.post('/staff/anti-piracy', checkAuthenticated, checkStaffAccess('canManageAntiPiracy'), csrfProtection, async (req, res, next) => {
  try {
    let settings = await settingsModel.findOne();

    settings.antiPiracyEnabled = req.body.antiPiracyEnabled === 'true';

    await settings.save();
    cache.del('globalSettings');

    utils.sendDiscordLog('Settings Edited', `[${getUserDisplayName(req.user)}](${config.baseURL}/profile/${getUserIdentifier(req.user)}) has edited the anti-piracy placeholder settings`);

    res.redirect('/staff/anti-piracy');
  } catch (error) {
    console.error('Error saving anti-piracy placeholder:', error);
    next(error);
  }
});

app.get('/staff/anti-piracy/find', checkAuthenticated, checkStaffAccess('canManageAntiPiracy'), async (req, res, next) => {
  try {
    const { nonce } = req.query;
    if (!nonce) return res.status(400).json({ error: 'Nonce is required.' });

    const downloadInfo = await downloadsModel.findOne({ nonce });
    
    if (downloadInfo) {
      const user = await client.users.fetch(downloadInfo.discordUserId);

      const downloadInfoObj = downloadInfo.toObject();
      downloadInfoObj.discordUsername = user.username;

      res.json({ downloadInfo: downloadInfoObj });
    } else {
      res.json({ downloadInfo: null });
    }
  } catch (error) {
    console.error('Error fetching download by nonce:', error);
    res.status(500).json({ error: 'Server error. Please try again later.' });
  }
});

app.get('/staff/products', checkAuthenticated, checkStaffAccess('canCreateProducts', 'canUpdateProducts', 'canDeleteProducts'), async (req, res, next) => {
  try {

    let existingUser = await findUserById(req.user.id);

    const products = await productModel.find().sort({ position: 1 });

    res.render('staff/products', { user: req.user, existingUser, products });
  } catch (error) {
    console.error('Error fetching products:', error);
    next(error);
  }
});

app.post('/staff/products/sort', checkAuthenticated, checkStaffAccess('canUpdateProducts'), async (req, res) => {
  try {
      const { productOrder } = req.body;

      if (!Array.isArray(productOrder)) {
          console.error("Invalid product order format:", productOrder);
          return res.status(400).json({ success: false, message: 'Invalid product order.' });
      }

      for (let i = 0; i < productOrder.length; i++) {
          await productModel.updateOne(
              { _id: productOrder[i] },
              { $set: { position: i + 1 } }
          );
      }

      res.json({ success: true, message: 'Product positions updated.' });
  } catch (error) {
      console.error('Error updating product positions:', error);
      res.status(500).json({ success: false, message: 'An error occurred while updating product positions.' });
  }
});

app.get('/staff/products/create', checkAuthenticated, checkStaffAccess('canCreateProducts'), async (req, res, next) => {
  try {
      let existingUser = await findUserById(req.user.id);

    const guild = await client.guilds.fetch(config.GuildID);
    
    
    const botMember = await guild.members.fetch(client.user.id);
    const botHighestRole = botMember.roles.highest;

    const roles = guild.roles.cache
      .filter(role => 
        role.position < botHighestRole.position && 
        role.name !== '@everyone' && 
        !role.managed
      )
      .sort((a, b) => b.position - a.position)
      .map(role => ({
        id: role.id,
        name: role.name
      }));

    res.render('staff/create-product', { user: req.user, existingUser, roles });
  } catch (error) {
    next(error);
  }
});

app.post('/staff/products/delete/:id', checkAuthenticated, checkStaffAccess('canDeleteProducts'), async (req, res, next) => {
  try {
    const productId = req.params.id;
    const product = await productModel.findById(productId);
    
    await utils.sendDiscordLog('Product Deleted', `[${getUserDisplayName(req.user)}](${config.baseURL}/profile/${getUserIdentifier(req.user)}) has deleted the product \`${product.name}\``);
    
    await productModel.findByIdAndDelete(productId);

    await userModel.updateMany(
      { 
        $or: [
          { cart: productId },
          { ownedProducts: productId }
        ]
      },
      { 
        $pull: { 
          cart: productId,
          ownedProducts: productId
        }
      }
    );

    await bundleModel.updateMany(
      { products: productId },
      { $pull: { products: productId } }
    );

    const bundlesToDelete = await bundleModel.find({
      $expr: { $lt: [{ $size: "$products" }, 2] }
    });

    if (bundlesToDelete.length > 0) {
      const bundleIds = bundlesToDelete.map(b => b._id);
      const bundleNames = bundlesToDelete.map(b => b.name).join(', ');

      await userModel.updateMany(
        { 'cartBundles.bundleId': { $in: bundleIds } },
        { $pull: { cartBundles: { bundleId: { $in: bundleIds } } } }
      );

      await bundleModel.deleteMany({ _id: { $in: bundleIds } });

      await utils.sendDiscordLog('Bundles Auto-Deleted', `The following bundles were automatically deleted because they had fewer than 2 products after deleting \`${product.name}\`: \`${bundleNames}\``);
    }

    res.redirect('/staff/products');
  } catch (error) {
    next(error);
  }
});

app.post('/staff/products/create', checkAuthenticated, checkStaffAccess('canCreateProducts'), upload.fields([{ name: 'productFile' }, { name: 'bannerImage' }]), csrfProtection, async (req, res, next) => {
  try {
      const { name, description, price, productType, urlId, position, dependencies, discordRoleIds, category, serviceMessage, serialKeys, enableFileUpload } = req.body;

      const sanitizedUrlId = urlId.replace(/[^a-zA-Z0-9-]/g, '');

      const bannerImageTempPath = req.files.bannerImage[0].path;
      const bannerImageOptimizedPath = path.join('uploads', Date.now() + '.webp');

      await optimizeImage(bannerImageTempPath, bannerImageOptimizedPath);

      let serialsArray = [];
      if (productType === 'serials' && serialKeys) {
          serialsArray = serialKeys.split('\n')
              .map(key => key.trim())
              .filter(key => key !== '')
              .map(key => ({ key }));
      }

      let initialVersion = null;
      if ((productType !== 'serials' && productType !== 'service') || 
          (productType === 'serials' && enableFileUpload && req.files.productFile)) {
          
          const productFilePath = req.files.productFile[0].path;
          
          console.log(`Scanning product file for placeholders: ${productFilePath}`);
          const scanResult = await utils.scanFileForPlaceholders(productFilePath);
          
          initialVersion = {
              version: "First release",
              changelog: "Initial release",
              productFile: productFilePath,
              originalFileName: req.files.productFile[0].originalname,
              hasPlaceholders: scanResult.hasPlaceholders,
              placeholderLocations: scanResult.locations,
              lastScanned: new Date()
          };
          
          console.log(`Placeholder scan complete. Found placeholders: ${scanResult.hasPlaceholders}`);
      }

      const newProduct = new productModel({
          name,
          description,
          price: productType === 'digitalFree' ? 0 : parseFloat(price),
          productType,
          serviceMessage: productType === 'service' ? serviceMessage : undefined,
          urlId: sanitizedUrlId,
          position: parseInt(position, 10),
          bannerImage: bannerImageOptimizedPath,
          dependencies: dependencies,
          discordRoleIds: Array.isArray(discordRoleIds) ? discordRoleIds : [],
          versions: initialVersion ? [initialVersion] : [],
          category: category || '',
          serials: serialsArray,
          serialRequiresFile: productType === 'serials' ? !!enableFileUpload : undefined
      });

      await newProduct.save();

      utils.sendDiscordLog('Product Created', `[${getUserDisplayName(req.user)}](${config.baseURL}/profile/${getUserIdentifier(req.user)}) has created the product \`${name}\``);

      res.redirect(`/products/${urlId}`);
  } catch (error) {
      console.error('Error creating product:', error);
      next(error);
  }
});

app.get('/staff/invoices', checkAuthenticated, checkStaffAccess('canViewInvoices'), async (req, res, next) => {
  try {
    const existingUser = await findUserById(req.user.id);
    
    const page = parseInt(req.query.page) || 1;
    const limit = 10;
    const skip = (page - 1) * limit;
    
    
    const search = req.query.search || '';
    const paymentMethod = req.query.paymentMethod || '';
    const startDate = req.query.startDate ? new Date(req.query.startDate) : null;
    const endDate = req.query.endDate ? new Date(req.query.endDate) : null;
    
    
    if (endDate) {
      endDate.setHours(23, 59, 59, 999);
    }
    
    
    const searchCriteria = {};
    
    if (search) {
      
      const numericSearch = !isNaN(parseInt(search)) ? parseInt(search) : null;
      
      const searchConditions = [];
      
      
      if (numericSearch !== null) {
        searchConditions.push({ ID: numericSearch });
      }
      
      
      searchConditions.push(
        { transactionID: { $regex: search, $options: 'i' } },
        { username: { $regex: search, $options: 'i' } }
      );
      
      searchCriteria.$or = searchConditions;
    }
    
    if (paymentMethod) {
      searchCriteria.paymentMethod = paymentMethod;
    }
    
    
    if (startDate || endDate) {
      searchCriteria.createdAt = {};
      if (startDate) searchCriteria.createdAt.$gte = startDate;
      if (endDate) searchCriteria.createdAt.$lte = endDate;
    }
    
    
    const totalInvoices = await paymentModel.countDocuments(searchCriteria);
    
    
    let invoices = await paymentModel.find(searchCriteria)
      .sort({ createdAt: -1 }) 
      .skip(skip)
      .limit(limit)
      .lean();
    
    
    const invoicesWithUserInfo = await Promise.all(invoices.map(async (invoice) => {
      try {
        
        const cachedUser = cache.get(`user_${invoice.userID}`);
        if (cachedUser) {
          return {
            ...invoice,
            username: cachedUser.username,
            userAvatar: cachedUser.avatar
          };
        }
        
        
        const user = await userModel.findOne({ discordID: invoice.userID });
        let discordUser;
        
        try {
          discordUser = await client.users.fetch(invoice.userID);
        } catch (error) {
          
          return {
            ...invoice,
            username: user ? user.discordUsername : 'Unknown User',
            userAvatar: '/images/default-avatar.png'
          };
        }
        
        const userData = {
          username: discordUser.username,
          avatar: `https://cdn.discordapp.com/avatars/${invoice.userID}/${discordUser.avatar}.webp?size=64`
        };
        
        
        cache.set(`user_${invoice.userID}`, userData);
        
        return {
          ...invoice,
          username: userData.username,
          userAvatar: userData.avatar
        };
      } catch (error) {
        console.error(`Error fetching user for invoice ${invoice._id}:`, error);
        return {
          ...invoice,
          username: 'Unknown User',
          userAvatar: '/images/default-avatar.png'
        };
      }
    }));
    
    
    const allInvoices = await paymentModel.find({}).lean();

    
    
    const removeFilterUrl = (filterName) => {
      const url = new URL(req.originalUrl, `http://${req.headers.host}`);
      url.searchParams.delete(filterName);
      return url.pathname + url.search;
    };
    
    
    const hasFilters = search || paymentMethod || startDate || endDate;
    
    res.render('staff/invoices', {
      user: req.user,
      existingUser,
      invoices: invoicesWithUserInfo,
      totalPages: Math.ceil(totalInvoices / limit),
      currentPage: page,
      search,
      paymentMethod,
      status: '',
      startDate: startDate ? startDate.toISOString().split('T')[0] : '',
      endDate: endDate ? endDate.toISOString().split('T')[0] : '',
      hasFilters,
      removeFilterUrl,
      totalInvoiceCount: allInvoices.length,
    });
  } catch (error) {
    console.error('Error fetching invoices:', error);
    next(error);
  }
});

app.get('/staff/sales', checkAuthenticated, checkStaffAccess('canManageSales'), csrfProtection, async (req, res, next) => {
  try {
    const allProducts = await productModel.find().sort({ position: 1 });
    
    const products = allProducts.filter(product => product.price > 0);
    const existingUser = await findUserById(req.user.id);

    const activeSales = products.filter(product => product.onSale);

    res.render('staff/sales', { 
      user: req.user, 
      products, 
      existingUser, 
      activeSales,
    });
  } catch (error) {
    console.error('Error fetching products for sales:', error);
    next(error);
  }
});

app.post('/staff/sales', checkAuthenticated, checkStaffAccess('canManageSales'), csrfProtection, async (req, res) => {
  try {
      const { startDate, endDate, productIds, discounts } = req.body;

      if (!startDate || !endDate) return res.status(400).send('Start Date and End Date are required.');

      const saleStartDate = new Date(startDate);
      const saleEndDate = new Date(endDate);

      if (saleStartDate >= saleEndDate) return res.status(400).send('Start Date must be before End Date.');

      
      await productModel.updateMany({}, {
          $set: { onSale: false, salePrice: null, saleStartDate: null, saleEndDate: null }
      });

      
      if (productIds && Array.isArray(productIds)) {
          for (const productId of productIds) {
              const discount = parseFloat(discounts[productId]) || 0;
              const product = await productModel.findById(productId);

              if (product) {
                  const salePrice = product.price - (product.price * (discount / 100));
                  product.onSale = true;
                  product.salePrice = salePrice;
                  product.saleStartDate = saleStartDate;
                  product.saleEndDate = saleEndDate;

                  await product.save();
              }
          }
      }

      cache.del('globalSettings');

      res.redirect('/staff/sales');
  } catch (error) {
      console.error('Error saving sale details:', error);
      res.status(500).send('Internal Server Error');
  }
});

app.post('/staff/sales/event', checkAuthenticated, checkStaffAccess('canManageSales'), csrfProtection, async (req, res, next) => {
  try {
    const settings = await settingsModel.findOne();
    
    settings.saleEventEnabled = req.body.saleEventEnabled === 'true';
    settings.saleEventType = settings.saleEventEnabled ? req.body.saleEventType : null;
    settings.saleEventMessage = req.body.saleEventMessage || '';
    
    await settings.save();
    cache.del('globalSettings');

    utils.sendDiscordLog('Sale Event Updated', `[${getUserDisplayName(req.user)}](${config.baseURL}/profile/${getUserIdentifier(req.user)}) has ${settings.saleEventEnabled ? 'enabled' : 'disabled'} the sale event banner${settings.saleEventEnabled ? ` (${settings.saleEventType})` : ''}`);
    
    res.redirect('/staff/sales');
  } catch (error) {
    console.error('Error updating sale event:', error);
    next(error);
  }
});

app.post('/staff/sales/disable', checkAuthenticated, checkStaffAccess('canManageSales'), csrfProtection, async (req, res) => {
  try {
    const { productId } = req.body;

    if (!productId) return res.status(400).send('Product ID is required.');

    
    await productModel.findByIdAndUpdate(productId, {
      $set: { onSale: false, salePrice: null, saleStartDate: null, saleEndDate: null }
    });

    res.redirect('/staff/sales');
  } catch (error) {
    console.error('Error disabling sale:', error);
    res.status(500).send('Internal Server Error');
  }
});

app.get('/staff/products/update/:id', checkAuthenticated, checkStaffAccess('canUpdateProducts'), csrfProtection, async (req, res, next) => {
  try {
      const productId = req.params.id;
      let existingUser = await findUserById(req.user.id);

      const product = await productModel.findById(productId);
      if (!product) return res.status(404).render('error', { errorMessage: 'The requested product could not be found. Please check the URL or browse available products.' });

      if (product.versions && product.versions.length > 0) {
        product.versions.sort((a, b) => new Date(b.releaseDate) - new Date(a.releaseDate));
      }

      res.render('staff/update-product', { user: req.user, existingUser, product });
  } catch (error) {
      console.error('Error loading update product page:', error);
      next(error);
  }
});

app.get('/downloads/:urlId', checkAuthenticated, async (req, res, next) => {
  try {
      const urlId = req.params.urlId;
      const existingUser = await findUserById(req.user.id);

      const product = await productModel.findOne({ urlId });
      if (!product) return res.status(404).render('error', { errorMessage: 'The requested product could not be found. Please check the URL or browse available products.' });

      
      if (product.productType === 'digitalFree') {
          product.versions.sort((a, b) => b.releaseDate - a.releaseDate);

          const page = parseInt(req.query.page) || 1;
          const limit = 5;
          const startIndex = (page - 1) * limit;
          const endIndex = page * limit;

          const totalVersions = product.versions.length;
          const totalPages = Math.ceil(totalVersions / limit);
          const paginatedVersions = product.versions.slice(startIndex, endIndex);

          const paginatedProduct = {
              ...product.toObject(),
              versions: paginatedVersions
          };

          return res.render('downloads', { 
              user: req.user, 
              product: paginatedProduct,
              allVersionsCount: totalVersions,
              currentPage: page,
              totalPages: totalPages,
              existingUser 
          });
      }

      
      const validOwnedProducts = await productModel.find({_id: { $in: existingUser.ownedProducts.filter(id => id) }}).select('_id'); 

      
      const ownsProduct = validOwnedProducts.some(validProduct => validProduct._id.toString() === product._id.toString());
      if (!ownsProduct && !req.isOwner()) return res.redirect('/');

      
      product.versions.sort((a, b) => b.releaseDate - a.releaseDate);

      const page = parseInt(req.query.page) || 1;
      const limit = 5;
      const startIndex = (page - 1) * limit;
      const endIndex = page * limit;

      const totalVersions = product.versions.length;
      const totalPages = Math.ceil(totalVersions / limit);
      const paginatedVersions = product.versions.slice(startIndex, endIndex);

      const paginatedProduct = {
          ...product.toObject(),
          versions: paginatedVersions
      };

      res.render('downloads', { 
          user: req.user, 
          product: paginatedProduct,
          allVersionsCount: totalVersions,
          currentPage: page,
          totalPages: totalPages,
          existingUser 
      });
  } catch (error) {
      console.error('Error loading download page:', error);
      next(error);
  }
});

app.post('/downloads/:urlId/delete/:versionId', checkAuthenticated, checkStaffAccess('owner'), async (req, res, next) => {
  try {
      const { urlId, versionId } = req.params;

      const product = await productModel.findOne({ urlId });
      if (!product) return res.status(404).render('error', { errorMessage: 'The requested product could not be found. Please check the URL or browse available products.' });

      
      const versionIndex = product.versions.findIndex(version => version._id.toString() === versionId);
      if (versionIndex === -1) return res.status(404).send('Version not found');

      
      product.versions.splice(versionIndex, 1);

      
      await product.save();

      res.redirect(`/downloads/${urlId}`);
  } catch (error) {
      console.error('Error deleting version:', error);
      next(error);
  }
});

app.get('/downloads/:urlId/download/:versionId', checkAuthenticated, async (req, res, next) => {
  const downloadStartTime = Date.now();
  
  const ipAddress = req.headers['x-forwarded-for'] || req.headers['x-real-ip'] || req.ip || req.connection.remoteAddress;
  const userAgent = req.headers['user-agent'];
  const { urlId, versionId } = req.params;
  
  try {
    const product = await productModel.findOne({ urlId });
    if (!product) return res.status(404).render('error', { 
      errorMessage: 'The requested product could not be found. Please check the URL or browse available products.' 
    });

    const version = product.versions.id(versionId);
    if (!version) return res.status(404).send('Version not found');

    let fileSize = 0;
    try {
      fileSize = fs.existsSync(version.productFile) ? fs.statSync(version.productFile).size : 0;
    } catch (err) {
      console.error('Error getting file size:', err);
    }

    const generatedNonce = await utils.generateNonce();

    const replacements = {
      USER: req.user.id,
      PRODUCT: product.name,
      NONCE: generatedNonce,
      PLEXSTORE: 'true'
    };

    let currentUser = await findUserById(req.user.id);

    const payment = await paymentModel.findOne({
      $or: [
        { userID: req.user.id },
        { userId: currentUser._id }
      ],
      'products.name': product.name
    });

    const downloadRecord = new downloadsModel({
      productName: product.name,
      productId: product._id,
      versionId: versionId,
      versionNumber: version.version,
      userId: currentUser._id,
      discordUserId: currentUser.discordID || null,
      discordUsername: currentUser.discordUsername || null,
      username: currentUser.username || currentUser.discordUsername || 'Unknown',
      nonce: generatedNonce,
      downloadDate: new Date(),
      ipAddress: ipAddress,
      userAgent: userAgent,
      downloadCompleted: false,
      downloadAttemptTime: downloadStartTime,
      fileSize: fileSize,
      paymentId: payment ? payment._id : null,
      transactionId: payment ? payment.transactionID : null
    });

    await downloadRecord.save();

    version.downloadCount = (version.downloadCount || 0) + 1;
    product.totalDownloads = (product.totalDownloads || 0) + 1;
    await product.save();

    let hasAccess = false;
    if (product.productType === 'digitalFree') {
      hasAccess = true;
    } else {
      const validOwnedProducts = await productModel.find({
        _id: { $in: currentUser.ownedProducts.filter(id => id) }
      }).select('_id');
      
      hasAccess = validOwnedProducts.some(validProduct => 
        validProduct._id.toString() === product._id.toString()
      ) || req.isOwner();
      
      if (!hasAccess) return res.redirect('/');
    }

    let filePath = version.productFile;
    if (globalSettings.antiPiracyEnabled) {
      if (version.hasPlaceholders && version.placeholderLocations && version.placeholderLocations.length > 0) {
        console.log(`Processing file with optimized placeholder replacement (${version.placeholderLocations.length} files to process)`);
        filePath = await utils.processFileWithPlaceholdersOptimized(
          version.productFile, 
          replacements,
          version.placeholderLocations,
          version.hasPlaceholders
        );
      } else {
        console.log(`Processing file with full placeholder scan (legacy/fallback mode)`);
        filePath = await utils.processFileWithPlaceholders(version.productFile, replacements);
      }
    }

    res.on('finish', async () => {
      const downloadEndTime = Date.now();
      const downloadDuration = downloadEndTime - downloadStartTime;
      
      downloadRecord.downloadCompleted = true;
      downloadRecord.downloadCompletionTime = downloadEndTime;
      downloadRecord.timeToDownload = downloadDuration;
      await downloadRecord.save();
      
      if (payment) {
        if (!payment.downloadProof) {
          payment.downloadProof = [];
        }
        
        payment.downloadProof.push({
          downloadId: downloadRecord._id,
          productName: product.name,
          productId: product._id.toString(),
          versionNumber: version.version,
          downloadDate: new Date(),
          ipAddress: ipAddress,
          userAgent: userAgent,
          fileSize: fileSize,
          downloadDuration: downloadDuration,
          completed: true
        });
        
        await payment.save({ validateBeforeSave: false });
      }
    });
    
    res.on('error', async (err) => {
      console.error('Download error:', err);
      downloadRecord.downloadCompleted = false;
      downloadRecord.error = err.message;
      await downloadRecord.save();
    });

    return res.download(filePath, version.originalFileName, (err) => {
      if (err) {
        console.error('Download error:', err);
        next(err);
      }
    });
  } catch (error) {
    console.error('Error downloading version:', error);
    next(error);
  }
});


app.post('/staff/products/update/:id', checkAuthenticated, checkStaffAccess('canUpdateProducts'), upload.single('productFile'), csrfProtection, async (req, res, next) => {
  try {
      const productId = req.params.id;
      const { version, changelog } = req.body;

      const product = await productModel.findById(productId);
      if (!product) return res.status(404).render('error', { errorMessage: 'The requested product could not be found. Please check the URL or browse available products.' });

      if (req.file) {
          const productFilePath = req.file.path;
          
          console.log(`Scanning product file for placeholders: ${productFilePath}`);
          const scanResult = await utils.scanFileForPlaceholders(productFilePath);
          
          const newVersion = {
              version: version,
              changelog: changelog,
              productFile: productFilePath,
              originalFileName: req.file.originalname,
              releaseDate: new Date(),
              hasPlaceholders: scanResult.hasPlaceholders,
              placeholderLocations: scanResult.locations,
              lastScanned: new Date()
          };

          product.versions.push(newVersion);
          
          console.log(`Placeholder scan complete. Found placeholders: ${scanResult.hasPlaceholders}`);
      
          if (config.productVersions.autoDeleteOldFiles) {
              const maxVersionsToKeep = config.productVersions.maxVersionsToKeep;

              while (product.versions.length > maxVersionsToKeep) {
                  const oldestVersion = product.versions.shift();
                  
                  if(config.DebugMode) console.log(`Deleted old version: ${oldestVersion.version}`);
                  
                  try {
                      fs.unlinkSync(oldestVersion.productFile);
                      if(config.DebugMode) console.log(`File deleted: ${oldestVersion.productFile}`);
                  } catch (err) {
                      if(config.DebugMode) console.error(`Failed to delete file: ${oldestVersion.productFile}`, err);
                  }
              }
          }
      }

      await product.save();

      utils.sendDiscordLog('Product Updated', `[${getUserDisplayName(req.user)}](${config.baseURL}/profile/${getUserIdentifier(req.user)}) has updated the product \`${product.name}\` \`to ${version}\``);

      res.redirect(`/downloads/${product.urlId}`);
  } catch (error) {
      console.error('Error updating product:', error);
      next(error);
  }
});

app.get('/staff/products/edit/:id', checkAuthenticated, checkStaffAccess('canUpdateProducts'), async (req, res, next) => {
  try {
    const existingUser = await findUserById(req.user.id);

      const product = await productModel.findById(req.params.id);
      if (!product) return res.status(404).render('error', { errorMessage: 'The requested product could not be found. Please check the URL or browse available products.' });

      const guild = await client.guilds.fetch(config.GuildID);
    
      
      const botMember = await guild.members.fetch(client.user.id);
      const botHighestRole = botMember.roles.highest;
  
      const roles = guild.roles.cache
      .filter(role => 
        role.position < botHighestRole.position && 
        role.name !== '@everyone' && 
        !role.managed
      )
      .sort((a, b) => b.position - a.position)
      .map(role => ({
        id: role.id,
        name: role.name
      }));

      res.render('staff/edit-product', { user: req.user, product, existingUser, roles });
  } catch (err) {
      console.error(err);
      next(err);
  }
});

app.post('/staff/products/edit/:id', checkAuthenticated, checkStaffAccess('canUpdateProducts'), upload.fields([{ name: 'bannerImage' }, { name: 'productFile' }]), csrfProtection, async (req, res, next) => {
  try {
      const { 
          name, urlId, description, price, productType, position, 
          dependencies, discordRoleIds, category, hideProduct, 
          pauseSelling, serviceMessage, serialKeys, enableFileUpload
      } = req.body;

      const existingProduct = await productModel.findById(req.params.id);
      if (!existingProduct) {
          return res.status(404).render('error', { errorMessage: 'The requested product could not be found. Please check the URL or browse available products.' });
      }

      let serialsArray = [];
      if (productType === 'serials' && serialKeys) {
          serialsArray = serialKeys.split('\n')
              .map(key => key.trim())
              .filter(key => key !== '')
              .map(key => ({ key }));
      }

      const newPrice = productType === 'digitalFree' ? 0 : parseFloat(price);
      const priceChanged = existingProduct.price !== newPrice;

      const updateData = {
          name,
          urlId,
          description,
          price: newPrice,
          productType,
          serviceMessage: productType === 'service' ? serviceMessage : undefined,
          position,
          dependencies,
          discordRoleIds: Array.isArray(discordRoleIds) ? discordRoleIds : [],
          category: category || '',
          hideProduct: !!hideProduct,
          pauseSelling: !!pauseSelling,
          serials: productType === 'serials' ? serialsArray : [],
          serialRequiresFile: productType === 'serials' ? !!enableFileUpload : undefined
      };

      if (priceChanged && existingProduct.onSale) {
          updateData.onSale = false;
          updateData.salePrice = null;
          updateData.saleStartDate = null;
          updateData.saleEndDate = null;
      }

      if (req.files['bannerImage']) {
          const originalBannerPath = req.files['bannerImage'][0].path;
          const optimizedBannerPath = path.join('uploads', `${Date.now()}.webp`);

          try {
              await optimizeImage(originalBannerPath, optimizedBannerPath);
              updateData.bannerImage = optimizedBannerPath;
          } catch (error) {
              console.error(`Error optimizing banner image: ${error.message}`);
              throw new Error('Failed to optimize the banner image');
          }
      }

      if (req.files['productFile'] && productType !== 'serials' && productType !== 'service') {
          updateData.productFile = req.files['productFile'][0].path;
      }

      const product = await productModel.findByIdAndUpdate(req.params.id, updateData, { new: true });

      utils.sendDiscordLog('Product Edited', 
          `[${getUserDisplayName(req.user)}](${config.baseURL}/profile/${getUserIdentifier(req.user)}) has edited the product \`${name}\`` +
          (productType === 'serials' ? ` (${serialsArray.length} serial keys)` : '') +
          (priceChanged && existingProduct.onSale ? ' - **Sale disabled due to price change**' : '')
      );

      res.redirect(`/products/${urlId}`);
  } catch (error) {
      console.error(error);
      next(error);
  }
});


app.get('/staff/discount-codes', checkAuthenticated, checkStaffAccess('canManageDiscounts'), async (req, res, next) => {
  try {

    let existingUser = await findUserById(req.user.id);

    const codes = await DiscountCodeModel.find();

    res.render('staff/discount-codes', { user: req.user, codes, existingUser });
  } catch (error) {
    console.error('Error fetching discount codes:', error);
    next(error);
  }
});

app.post('/staff/discount-codes/delete/:id', checkAuthenticated, checkStaffAccess('canManageDiscounts'), csrfProtection, async (req, res, next) => {
  try {

    await DiscountCodeModel.findByIdAndDelete(req.params.id);

    res.redirect('/staff/discount-codes');
  } catch (error) {
    console.error('Error deleting discount code:', error);
    next(error);
  }
});

app.get('/staff/discount-codes/create', checkAuthenticated, checkStaffAccess('canManageDiscounts'), async (req, res, next) => {
  if (!req.user) {
      return res.redirect('/login');
  }
    let existingUser = await findUserById(req.user.id);

  res.render('staff/create-discount-code', { user: req.user, existingUser });
});

app.post('/staff/discount-codes/create', checkAuthenticated, checkStaffAccess('canManageDiscounts'), csrfProtection, async (req, res, next) => {
  try {

      const { name, discountPercentage, maxUses, expiresAt } = req.body;

      const existingCode = await DiscountCodeModel.findOne({ name, _id: { $ne: req.params.id } });
      if (existingCode) return res.status(404).render('error', { errorMessage: 'The discount code name is already in use. Please choose a different name.' });

      
      const newDiscountCode = new DiscountCodeModel({
          name: name,
          discountPercentage: discountPercentage,
          maxUses: maxUses ? parseInt(maxUses, 10) : null,
          expiresAt: expiresAt ? new Date(expiresAt) : null,
      });

      await newDiscountCode.save();

      utils.sendDiscordLog('Discount Created', `[${getUserDisplayName(req.user)}](${config.baseURL}/profile/${getUserIdentifier(req.user)}) has created the discount \`${name}\``);

      res.redirect('/staff/discount-codes');
  } catch (error) {
      console.error('Error creating discount code:', error);
      next(error);
  }
});

app.get('/staff/discount-codes/edit/:id', checkAuthenticated, checkStaffAccess('canManageDiscounts'), async (req, res, next) => {
  try {
      const discountCode = await DiscountCodeModel.findById(req.params.id);

      if (!discountCode) return res.status(404).send('Discount code not found.');

      let existingUser = await findUserById(req.user.id);

      res.render('staff/edit-discount-code', { user: req.user, existingUser, discountCode });
  } catch (error) {
      console.error('Error fetching discount code:', error);
      next(error);
  }
});

app.post('/staff/discount-codes/edit/:id', checkAuthenticated, checkStaffAccess('canManageDiscounts'), csrfProtection, async (req, res, next) => {
  try {
      const { name, discountPercentage, maxUses, expiresAt } = req.body;

      const existingCode = await DiscountCodeModel.findOne({ name, _id: { $ne: req.params.id } });
      if (existingCode) return res.status(404).render('error', { errorMessage: 'The discount code name is already in use. Please choose a different name.' });

      const discountCode = await DiscountCodeModel.findById(req.params.id);
      if (!discountCode) return res.status(404).send('Discount code not found.');

      
      discountCode.name = name;
      discountCode.discountPercentage = discountPercentage;
      discountCode.maxUses = maxUses ? parseInt(maxUses, 10) : null;
      discountCode.expiresAt = expiresAt ? new Date(expiresAt) : null;

      await discountCode.save();

      utils.sendDiscordLog('Discount Edited', `[${getUserDisplayName(req.user)}](${config.baseURL}/profile/${getUserIdentifier(req.user)}) has edited the discount \`${name}\``);

      res.redirect('/staff/discount-codes');
  } catch (error) {
      console.error('Error updating discount code:', error);
      next(error);
  }
});

app.post('/api/discounts/create', checkApiKey, async (req, res) => {
  try {
    const { name, discountPercentage, maxUses, expiresAt } = req.body;

    
    const existingCode = await DiscountCodeModel.findOne({ name });
    if (existingCode) return res.status(400).json({ error: 'DISCOUNT_CODE_ALREADY_EXISTS' });

    
    const newDiscountCode = new DiscountCodeModel({
      name: name,
      discountPercentage: discountPercentage,
      maxUses: maxUses ? parseInt(maxUses, 10) : null,
      expiresAt: expiresAt ? new Date(expiresAt) : null,
    });

    
    await newDiscountCode.save();

    res.json({
      message: 'DISCOUNT_CODE_CREATED_SUCCESSFULLY',
      discountCode: {
        name: newDiscountCode.name,
        discountPercentage: newDiscountCode.discountPercentage,
        maxUses: newDiscountCode.maxUses,
        expiresAt: newDiscountCode.expiresAt,
      },
    });
  } catch (error) {
    console.error('Error creating discount code:', error);
    res.status(500).json({ error: 'SERVER_ERROR' });
  }
});

app.get('/staff/users', checkAuthenticated, checkStaffAccess('owner'), async (req, res, next) => {
  try {
    const existingUser = await findUserById(req.user.id);

    const page = parseInt(req.query.page) || 1;
    const limit = 9; 
    const skip = (page - 1) * limit;
    const search = req.query.search || '';
    const sortBy = req.query.sortBy || 'joinedAt';
    const authFilter = req.query.authFilter || 'all';
    
    let sortOptions = {};
    if (sortBy === 'totalSpent') {
      sortOptions = { totalSpent: -1 };
    } else if (sortBy === 'authMethod') {
      sortOptions = { authMethod: 1, joinedAt: -1 };
    } else {
      sortOptions = { joinedAt: -1 };
    }

    let searchCriteria = {};
    
    if (authFilter !== 'all') {
      searchCriteria.authMethod = authFilter;
    }
    
    if (search) {
      searchCriteria.$or = [
        { discordUsername: { $regex: search, $options: 'i' } },
        { username: { $regex: search, $options: 'i' } },
        { email: { $regex: search, $options: 'i' } },
        { discordID: { $regex: search, $options: 'i' } }
      ];
    }

    const [totalUsers, users] = await Promise.all([
      userModel.countDocuments(searchCriteria),
      userModel.find(searchCriteria)
        .sort(sortOptions)
        .skip(skip)
        .limit(limit)
        .lean()
        .select('discordID discordUsername username email authMethod totalSpent joinedAt banned emailVerified _id')
    ]);

    const usersWithDiscordData = await Promise.all(users.map(async (user) => {
      const mongoId = user._id.toString();
      
      if (user.authMethod === 'local') {
        return {
          ...user,
          _id: mongoId,
          displayId: mongoId,
          discordUsername: user.username || user.email.split('@')[0],
          discordAvatar: '/images/default-avatar.png'
        };
      }
      
      if (user.discordID) {
        const cachedDiscordUser = cache.get(`discordUser_${user.discordID}`);
        if (cachedDiscordUser) {
          return {
            ...user,
            _id: mongoId,
            displayId: user.discordID,
            discordUsername: cachedDiscordUser.username,
            discordAvatar: cachedDiscordUser.avatar
          };
        }
        
        try {
          const discordUser = await client.users.fetch(user.discordID);
          const discordUserData = {
            username: discordUser.username,
            avatar: discordUser.avatar 
              ? `https://cdn.discordapp.com/avatars/${user.discordID}/${discordUser.avatar}.webp?size=128`
              : '/images/default-avatar.png'
          };
          
          cache.set(`discordUser_${user.discordID}`, discordUserData, 60 * 60);
          
          return {
            ...user,
            _id: mongoId,
            displayId: user.discordID,
            discordUsername: discordUserData.username,
            discordAvatar: discordUserData.avatar
          };
        } catch (error) {
          return {
            ...user,
            _id: mongoId,
            displayId: user.discordID,
            discordUsername: user.discordUsername || 'Unknown User',
            discordAvatar: '/images/default-avatar.png'
          };
        }
      }
      
      return {
        ...user,
        _id: mongoId,
        displayId: mongoId,
        discordUsername: user.username || user.email?.split('@')[0] || 'Unknown User',
        discordAvatar: '/images/default-avatar.png'
      };
    }));

    res.render('staff/users', {
      user: req.user,
      users: usersWithDiscordData,
      existingUser,
      totalPages: Math.ceil(totalUsers / limit),
      currentPage: page,
      search,
      sortBy,
      authFilter,
      config,
    });
  } catch (error) {
    console.error('Error fetching users:', error);
    next(error);
  }
});

app.get('/staff/team', checkAuthenticated, checkStaffAccess('owner'), csrfProtection, async (req, res, next) => {
  try {
    const existingUser = await findUserById(req.user.id);
    
    const staffMembers = await userModel.find({
      'staffPermissions.isStaff': true
    }).lean();

    const staffWithAvatars = await Promise.all(staffMembers.map(async (staff) => {
      if (staff.discordID) {
        const cachedDiscordUser = cache.get(`discordUser_${staff.discordID}`);
        if (cachedDiscordUser) {
          return {
            ...staff,
            discordAvatar: cachedDiscordUser.avatar,
            discordUsername: cachedDiscordUser.username
          };
        }
        
        try {
          const discordUser = await client.users.fetch(staff.discordID);
          const discordUserData = {
            username: discordUser.username,
            avatar: discordUser.avatar 
              ? `https://cdn.discordapp.com/avatars/${staff.discordID}/${discordUser.avatar}.webp?size=128`
              : '/images/default-avatar.png'
          };
          cache.set(`discordUser_${staff.discordID}`, discordUserData, 60 * 60);
          
          return {
            ...staff,
            discordAvatar: discordUserData.avatar,
            discordUsername: discordUserData.username
          };
        } catch (error) {
          return {
            ...staff,
            discordAvatar: '/images/default-avatar.png',
            discordUsername: staff.username || staff.email.split('@')[0]
          };
        }
      }
      
      return {
        ...staff,
        discordAvatar: '/images/default-avatar.png'
      };
    }));

    const staffMembersWithMethods = staffWithAvatars.map(staff => {
      const doc = new userModel(staff);
      doc.discordAvatar = staff.discordAvatar;
      doc.discordUsername = staff.discordUsername || staff.username;
      return doc;
    });

    res.render('staff/team', {
      user: req.user,
      existingUser,
      staffMembers: staffMembersWithMethods
    });
  } catch (error) {
    console.error('Error loading team page:', error);
    next(error);
  }
});

app.post('/staff/team/add', checkAuthenticated, checkStaffAccess('owner'), csrfProtection, async (req, res, next) => {
  try {
    const { 
      userId, 
      canCreateProducts,
      canUpdateProducts,
      canDeleteProducts,
      canAddProducts, 
      canRemoveProducts,
      canViewInvoices,
      canManageDiscounts,
      canManageSales,
      canManageAntiPiracy
    } = req.body;
    
    const staffUser = await findUserById(userId);
    if (!staffUser) {
      const existingUser = await findUserById(req.user.id);
      const staffMembers = await userModel.find({ 'staffPermissions.isStaff': true }).lean();
      const staffMembersWithMethods = staffMembers.map(staff => new userModel(staff));
      
      return res.render('staff/team', {
        user: req.user,
        existingUser,
        staffMembers: staffMembersWithMethods,
        error: 'User not found. Please check the User ID or Discord ID and try again.'
      });
    }

    if (config.OwnerID.includes(staffUser.getIdentifier())) {
      const existingUser = await findUserById(req.user.id);
      const staffMembers = await userModel.find({ 'staffPermissions.isStaff': true }).lean();
      const staffMembersWithMethods = staffMembers.map(staff => new userModel(staff));
      
      return res.render('staff/team', {
        user: req.user,
        existingUser,
        staffMembers: staffMembersWithMethods,
        error: 'Cannot modify owner permissions. This user is already an owner.'
      });
    }

    staffUser.staffPermissions = {
      isStaff: true,
      canCreateProducts: canCreateProducts === 'true',
      canUpdateProducts: canUpdateProducts === 'true',
      canDeleteProducts: canDeleteProducts === 'true',
      canAddProducts: canAddProducts === 'true',
      canRemoveProducts: canRemoveProducts === 'true',
      canViewInvoices: canViewInvoices === 'true',
      canManageDiscounts: canManageDiscounts === 'true',
      canManageSales: canManageSales === 'true',
      canManageAntiPiracy: canManageAntiPiracy === 'true'
    };

    await staffUser.save();

    utils.sendDiscordLog('Staff Member Added',
      `[${getUserDisplayName(req.user)}](${config.baseURL}/profile/${getUserIdentifier(req.user)}) has added [${staffUser.getDisplayName()}](${config.baseURL}/profile/${staffUser.getIdentifier()}) as a staff member`
    );

    res.redirect('/staff/team?success=1');
  } catch (error) {
    console.error('Error adding staff member:', error);
    next(error);
  }
});

app.post('/staff/team/edit/:userId', checkAuthenticated, checkStaffAccess('owner'), csrfProtection, async (req, res, next) => {
  try {
    const { 
      canCreateProducts,
      canUpdateProducts,
      canDeleteProducts,
      canAddProducts, 
      canRemoveProducts,
      canViewInvoices,
      canManageDiscounts,
      canManageSales,
      canManageAntiPiracy
    } = req.body;
    
    const staffUser = await findUserById(req.params.userId);
    if (!staffUser) {
      const existingUser = await findUserById(req.user.id);
      const staffMembers = await userModel.find({ 'staffPermissions.isStaff': true }).lean();
      const staffMembersWithMethods = staffMembers.map(staff => new userModel(staff));
      
      return res.render('staff/team', {
        user: req.user,
        existingUser,
        staffMembers: staffMembersWithMethods,
        error: 'Staff member not found.'
      });
    }

    if (config.OwnerID.includes(staffUser.getIdentifier())) {
      const existingUser = await findUserById(req.user.id);
      const staffMembers = await userModel.find({ 'staffPermissions.isStaff': true }).lean();
      const staffMembersWithMethods = staffMembers.map(staff => new userModel(staff));
      
      return res.render('staff/team', {
        user: req.user,
        existingUser,
        staffMembers: staffMembersWithMethods,
        error: 'Cannot edit owner permissions.'
      });
    }

    staffUser.staffPermissions = {
      isStaff: true,
      canCreateProducts: canCreateProducts === 'true',
      canUpdateProducts: canUpdateProducts === 'true',
      canDeleteProducts: canDeleteProducts === 'true',
      canAddProducts: canAddProducts === 'true',
      canRemoveProducts: canRemoveProducts === 'true',
      canViewInvoices: canViewInvoices === 'true',
      canManageDiscounts: canManageDiscounts === 'true',
      canManageSales: canManageSales === 'true',
      canManageAntiPiracy: canManageAntiPiracy === 'true'
    };

    await staffUser.save();

    utils.sendDiscordLog('Staff Permissions Updated',
      `[${getUserDisplayName(req.user)}](${config.baseURL}/profile/${getUserIdentifier(req.user)}) has updated permissions for [${staffUser.getDisplayName()}](${config.baseURL}/profile/${staffUser.getIdentifier()})`
    );

    res.redirect('/staff/team?success=1');
  } catch (error) {
    console.error('Error updating staff member:', error);
    next(error);
  }
});

app.post('/staff/team/remove/:userId', checkAuthenticated, checkStaffAccess('owner'), csrfProtection, async (req, res, next) => {
  try {
    const staffUser = await findUserById(req.params.userId);
    if (!staffUser) {
      const existingUser = await findUserById(req.user.id);
      const staffMembers = await userModel.find({ 'staffPermissions.isStaff': true }).lean();
      const staffMembersWithMethods = staffMembers.map(staff => new userModel(staff));
      
      return res.render('staff/team', {
        user: req.user,
        existingUser,
        staffMembers: staffMembersWithMethods,
        error: 'Staff member not found.'
      });
    }

    if (config.OwnerID.includes(staffUser.getIdentifier())) {
      const existingUser = await findUserById(req.user.id);
      const staffMembers = await userModel.find({ 'staffPermissions.isStaff': true }).lean();
      const staffMembersWithMethods = staffMembers.map(staff => new userModel(staff));
      
      return res.render('staff/team', {
        user: req.user,
        existingUser,
        staffMembers: staffMembersWithMethods,
        error: 'Cannot remove owner from staff.'
      });
    }

    staffUser.staffPermissions = {
      isStaff: false,
      canCreateProducts: false,
      canUpdateProducts: false,
      canDeleteProducts: false,
      canAddProducts: false,
      canRemoveProducts: false,
      canViewInvoices: false,
      canManageDiscounts: false,
      canManageSales: false,
      canManageAntiPiracy: false
    };

    await staffUser.save();

    utils.sendDiscordLog('Staff Member Removed',
      `[${getUserDisplayName(req.user)}](${config.baseURL}/profile/${getUserIdentifier(req.user)}) has removed [${staffUser.getDisplayName()}](${config.baseURL}/profile/${staffUser.getIdentifier()}) from staff`
    );

    res.redirect('/staff/team?success=1');
  } catch (error) {
    console.error('Error removing staff member:', error);
    next(error);
  }
});

app.get('/staff/settings', checkAuthenticated, checkStaffAccess('owner'), async (req, res, next) => {
  try {
    let settings = await settingsModel.findOne();

    
    const guild = await client.guilds.fetch(config.GuildID);
    const discordChannels = guild.channels.cache
      .filter(channel => channel.type === 0)
      .map(channel => ({
        id: channel.id,
        name: channel.name,
      }));

    res.render('staff/settings', { user: req.user,  existingUser: req.user, settings, discordChannels });
  } catch (error) {
    console.error('Error fetching settings:', error);
    next(error);
  }
});

app.post('/staff/settings', checkAuthenticated, checkStaffAccess('owner'), upload.fields([{ name: 'logo' }, { name: 'favicon' }]), csrfProtection, async (req, res, next) => {
  try {
    let settings = await settingsModel.findOne();

    if (req.body.termsOfService !== settings.termsOfService) {
      settings.tosLastUpdated = new Date();
    }
    
    if (req.body.privacyPolicy !== settings.privacyPolicy) {
      settings.privacyPolicyLastUpdated = new Date();
    }

    settings.termsOfService = req.body.termsOfService;
    settings.privacyPolicy = req.body.privacyPolicy;
    settings.aboutUsText = req.body.aboutUsText;
    settings.aboutUsVisible = req.body.aboutUsVisible === 'true';
    settings.displayStats = req.body.displayStats === 'true';
    settings.displayReviews = req.body.displayReviews === 'true';
    settings.displayProductReviews = req.body.displayProductReviews === 'true';
    settings.showProductStats = req.body.showProductStats === 'true';
    settings.displayCTABanner = req.body.displayCTABanner === 'true';
    settings.accentColor = req.body.accentColor || settings.accentColor;
    settings.discordInviteLink = req.body.discordInviteLink || settings.discordInviteLink;
    settings.salesTax = req.body.salesTax || settings.salesTax;
    settings.siteBannerText = req.body.siteBannerText;
    settings.storeName = req.body.storeName || settings.storeName;
    settings.paymentCurrency = req.body.paymentCurrency || settings.paymentCurrency;
    settings.discordLoggingChannel = req.body.discordLoggingChannel || settings.discordLoggingChannel;

    settings.sendReviewsToDiscord = req.body.sendReviewsToDiscord === 'true';
    settings.discordReviewChannel = req.body.discordReviewChannel || '';
    settings.minimumReviewLength = parseInt(req.body.minimumReviewLength) || 30;
    settings.allowReviewDeletion = req.body.allowReviewDeletion === 'true';

    settings.seoTitle = req.body.seoTitle || settings.seoTitle;
    settings.seoDescription = req.body.seoDescription || settings.seoDescription;
    settings.seoTags = req.body.seoTags || settings.seoTags;

    settings.apiEnabled = req.body.apiEnabled === 'true';
    if (req.body.apiKey) {
      settings.apiKey = req.body.apiKey;
    }

    settings.emailSettings = {
      enabled: req.body.emailEnabled === 'true',
      fromEmail: req.body.emailFromAddress || '',
      provider: req.body.emailProvider || 'smtp',
      sendGrid: {
        token: req.body.emailSendGridToken || ''
      },
      smtp: {
        host: req.body.emailSmtpHost || '',
        port: parseInt(req.body.emailSmtpPort) || 587,
        secure: req.body.emailSmtpSecure === 'true',
        user: req.body.emailSmtpUser || '',
        password: req.body.emailSmtpPassword || ''
      }
    };

settings.paymentMethods = {
  paypal: {
    enabled: req.body.paypalEnabled === 'true',
    accountType: req.body.paypalAccountType || 'business',
    mode: req.body.paypalMode || 'sandbox',
    clientId: req.body.paypalClientId ? encrypt(req.body.paypalClientId) : settings.paymentMethods?.paypal?.clientId || '',
    clientSecret: req.body.paypalClientSecret ? encrypt(req.body.paypalClientSecret) : settings.paymentMethods?.paypal?.clientSecret || '',
    personalEmail: req.body.paypalPersonalEmail || ''
  },
  stripe: {
    enabled: req.body.stripeEnabled === 'true',
    secretKey: req.body.stripeSecretKey ? encrypt(req.body.stripeSecretKey) : settings.paymentMethods?.stripe?.secretKey || ''
  },
  coinbase: {
    enabled: req.body.coinbaseEnabled === 'true',
    apiKey: req.body.coinbaseApiKey ? encrypt(req.body.coinbaseApiKey) : settings.paymentMethods?.coinbase?.apiKey || '',
    webhookSecret: req.body.coinbaseWebhookSecret ? encrypt(req.body.coinbaseWebhookSecret) : settings.paymentMethods?.coinbase?.webhookSecret || ''
  },
  vietqr: {
    enabled: req.body.vietqrEnabled === 'true',
    bankCode: (req.body.vietqrBankCode || settings.paymentMethods?.vietqr?.bankCode || '970405').trim(),
    accountNumber: (req.body.vietqrAccountNumber || settings.paymentMethods?.vietqr?.accountNumber || '').trim(),
    accountName: (req.body.vietqrAccountName || settings.paymentMethods?.vietqr?.accountName || '').trim(),
    accountType: req.body.vietqrAccountType === '1' ? 1 : 0,
    webhookUrl: (req.body.vietqrWebhookUrl || settings.paymentMethods?.vietqr?.webhookUrl || '').trim(),
    webhookSecret: (req.body.vietqrWebhookSecret || settings.paymentMethods?.vietqr?.webhookSecret || '').trim(),
    autoConfirmTimeout: Math.max(parseInt(req.body.vietqrAutoConfirmTimeout, 10) || settings.paymentMethods?.vietqr?.autoConfirmTimeout || 300000, 10000)
  }
};

    const currencySymbols = {
      USD: '$',
      EUR: '€',
      GBP: '£',
      JPY: '¥',
      AUD: 'A$',
      CAD: 'C$',
      CHF: 'CHF',
      CNY: '¥',
      SEK: 'kr',
      NZD: 'NZ$',
      SGD: 'S$',
      HKD: 'HK$',
      NOK: 'kr',
      KRW: '₩',
      TRY: '₺',
      RUB: '₽',
      INR: '₹',
      BRL: 'R$',
      ZAR: 'R',
      MYR: 'RM',
      THB: '฿',
      PLN: 'zł',
      PHP: '₱',
      HUF: 'Ft',
      CZK: 'Kč',
      ILS: '₪',
      DKK: 'kr',
      AED: 'د.إ',
    };
    settings.currencySymbol = currencySymbols[settings.paymentCurrency];

    if (req.files.logo) {
      settings.logoPath = '/' + req.files['logo'][0].path.replace(/\\/g, '/');
    }
    if (req.files.favicon) {
      settings.faviconPath = '/' + req.files['favicon'][0].path.replace(/\\/g, '/');
    }

    if (req.body.categories) {
      const categories = JSON.parse(req.body.categories);
      settings.productCategories = categories.map(category => ({
        name: category.name,
        url: category.url,
      }));
    }

    await settings.save();

    cache.del('paymentConfig');
    cache.del('globalSettings');
    cache.del('productCategories');
    
    utils.sendDiscordLog('Settings Edited', `[${getUserDisplayName(req.user)}](${config.baseURL}/profile/${getUserIdentifier(req.user)}) has edited the store settings`);

    res.redirect('/staff/settings');
  } catch (error) {
    console.error('Error saving settings:', error);
    next(error);
  }
});

app.post('/staff/test-email', checkAuthenticated, checkStaffAccess('owner'), csrfProtection, async (req, res) => {
  try {
    const { enabled, fromEmail, provider, sendGridToken, smtpHost, smtpPort, smtpUser, smtpPassword, smtpSecure } = req.body;
    
    if (!enabled) {
      return res.json({ success: false, error: 'Email sending is disabled' });
    }
    
    if (!fromEmail) {
      return res.json({ success: false, error: 'From email address is required' });
    }
    
    const testEmailContent = `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="UTF-8">
        <style>
          body { font-family: Arial, sans-serif; background-color: #0a0a0a; color: #ffffff; padding: 20px; }
          .container { max-width: 600px; margin: 0 auto; background-color: #1a1a1a; padding: 30px; border-radius: 12px; }
          h1 { color: #5e99ff; }
          p { line-height: 1.6; color: #a1a1aa; }
        </style>
      </head>
      <body>
        <div class="container">
          <h1>✅ Test Email Successful</h1>
          <p>This is a test email from your store's email configuration.</p>
          <p>If you received this, your email settings are working correctly!</p>
          <p><strong>Provider:</strong> ${provider === 'sendgrid' ? 'SendGrid' : 'SMTP'}</p>
          <p><strong>From:</strong> ${fromEmail}</p>
        </div>
      </body>
      </html>
    `;
    
    console.log('Attempting to send test email...');
    console.log('Provider:', provider);
    console.log('To:', req.user.email);
    console.log('From:', fromEmail);
    
    if (provider === 'sendgrid') {
      if (!sendGridToken) {
        return res.json({ success: false, error: 'SendGrid API token is required' });
      }
      
      const sgMail = require('@sendgrid/mail');
      sgMail.setApiKey(sendGridToken);
      
      await sgMail.send({
        to: req.user.email,
        from: fromEmail,
        subject: 'Test Email - Store Configuration',
        html: testEmailContent
      });
      
      console.log('SendGrid email sent successfully');
    } else {
      if (!smtpHost || !smtpUser || !smtpPassword) {
        return res.json({ success: false, error: 'SMTP host, username, and password are required' });
      }
      
      const nodemailer = require('nodemailer');
      const transporter = nodemailer.createTransport({
        host: smtpHost,
        port: parseInt(smtpPort),
        secure: smtpSecure,
        auth: {
          user: smtpUser,
          pass: smtpPassword,
        },
        tls: {
          rejectUnauthorized: false
        }
      });
      
      console.log('SMTP config:', {
        host: smtpHost,
        port: smtpPort,
        secure: smtpSecure,
        user: smtpUser
      });
      
      await transporter.sendMail({
        from: fromEmail,
        to: req.user.email,
        subject: 'Test Email - Store Configuration',
        html: testEmailContent
      });
      
      console.log('SMTP email sent successfully');
    }
    
    res.json({ success: true });
  } catch (error) {
    console.error('Test email error:', error);
    res.json({ success: false, error: error.message });
  }
});

app.get('/staff/page-customization', checkAuthenticated, checkStaffAccess('owner'), async (req, res, next) => {
  try {
    let settings = await settingsModel.findOne();

    res.render('staff/page-customization', { user: req.user, existingUser: req.user, settings });
  } catch (error) {
    console.error('Error fetching settings:', error);
    next(error);
  }
});

app.post('/staff/page-customization', checkAuthenticated, checkStaffAccess('owner'), csrfProtection, async (req, res, next) => {
  try {
    let settings = await settingsModel.findOne();

    settings.homePageTitle = req.body.homePageTitle;
    settings.homePageSubtitle = req.body.homePageSubtitle;
    settings.productsPageTitle = req.body.productsPageTitle;
    settings.productsPageSubtitle = req.body.productsPageSubtitle;
    settings.privacyPolicyPageTitle = req.body.privacyPolicyPageTitle;
    settings.privacyPolicyPageSubtitle = req.body.privacyPolicyPageSubtitle;
    settings.tosPageTitle = req.body.tosPageTitle;
    settings.tosPageSubtitle = req.body.tosPageSubtitle;
    settings.websiteFont = req.body.fontSelector;
    settings.customNavTabs = req.body.customNavTabs || [];
    settings.customFooterTabs = req.body.customFooterTabs || [];
    settings.footerDescription = req.body.footerDescription;
    settings.holidayEffectsEnabled = req.body.holidayEffectsEnabled === 'true';
    
    const validHolidayTypes = ['christmas', 'halloween', 'valentines', 'new-year', 'easter', 'black-friday'];
    settings.holidayEffectsType = settings.holidayEffectsEnabled && validHolidayTypes.includes(req.body.holidayEffectsType) 
      ? req.body.holidayEffectsType 
      : null;

    settings.displaySocialLinks = req.body.displaySocialLinks === 'true';
    settings.displayFAQ = req.body.displayFAQ === 'true';
    settings.displayFeatures = req.body.displayFeatures === 'true';
    
    if (req.body.socialLinks) {
      settings.socialLinks = {
        discord: req.body.socialLinks.discord || '',
        twitter: req.body.socialLinks.twitter || '',
        instagram: req.body.socialLinks.instagram || '',
        youtube: req.body.socialLinks.youtube || '',
        github: req.body.socialLinks.github || '',
        tiktok: req.body.socialLinks.tiktok || '',
        linkedin: req.body.socialLinks.linkedin || '',
        facebook: req.body.socialLinks.facebook || ''
      };
    }

    if (req.body.features && Array.isArray(req.body.features)) {
      settings.features = req.body.features
        .filter(feature => feature && feature.icon && feature.title && feature.description)
        .map(feature => ({
          icon: feature.icon,
          title: feature.title,
          description: feature.description
        }));
    } else {
      settings.features = [];
    }

    if (req.body.faqs) {
      const faqsArray = Array.isArray(req.body.faqs) ? req.body.faqs : [req.body.faqs];
      settings.faqs = faqsArray
        .filter(faq => faq && faq.question && faq.answer)
        .map(faq => ({
          question: Array.isArray(faq.question) ? faq.question[0] : faq.question,
          answer: Array.isArray(faq.answer) ? faq.answer[0] : faq.answer
        }));
    } else {
      settings.faqs = [];
    }

    await settings.save();
    
    cache.del('globalSettings');

    utils.sendDiscordLog('Settings Edited', `[${getUserDisplayName(req.user)}](${config.baseURL}/profile/${getUserIdentifier(req.user)}) has edited the page customization settings`);

    res.redirect('/staff/page-customization');
  } catch (error) {
    console.error('Error saving settings:', error);
    next(error);
  }
});

    app.get('/staff/bundles', checkAuthenticated, checkStaffAccess('owner'), async (req, res, next) => {
      try {
        const bundles = await bundleModel.find().populate('products').sort({ position: 1 });
        
        const bundlesWithPrices = await Promise.all(bundles.map(async (bundle) => {
          const originalPrice = await bundle.calculateOriginalPrice();
          const bundlePrice = await bundle.calculateBundlePrice();
          
          return {
            ...bundle.toObject(),
            originalPrice,
            bundlePrice
          };
        }));

        res.render('staff/bundles', { 
          user: req.user, 
          existingUser: req.user, 
          bundles: bundlesWithPrices 
        });
      } catch (error) {
        console.error('Error fetching bundles:', error);
        next(error);
      }
    });

app.post('/staff/bundles/edit/:id', checkAuthenticated, checkStaffAccess('owner'), csrfProtection, async (req, res, next) => {
  try {
    const { name, description, discountPercentage, products, active } = req.body;
    
    const bundle = await bundleModel.findById(req.params.id);
    
    if (!bundle) {
      return res.status(404).render('error', { 
        errorMessage: 'Bundle not found' 
      });
    }

    if (!products) {
      req.session.errorMessage = 'Please select at least 2 products for the bundle';
      return res.redirect(`/staff/bundles/edit/${req.params.id}`);
    }

    const productArray = Array.isArray(products) ? products : [products];

    if (productArray.length < 2) {
      req.session.errorMessage = 'Please select at least 2 products for the bundle';
      return res.redirect(`/staff/bundles/edit/${req.params.id}`);
    }

    bundle.name = name;
    bundle.description = description;
    bundle.discountPercentage = parseFloat(discountPercentage);
    bundle.products = productArray;
    bundle.active = active === 'on';

    await bundle.save();

    utils.sendDiscordLog('Bundle Updated', `[${getUserDisplayName(req.user)}](${config.baseURL}/profile/${getUserIdentifier(req.user)}) has updated the bundle \`${name}\``);

    req.session.successMessage = 'Bundle updated successfully';
    res.redirect('/staff/bundles');
  } catch (error) {
    console.error('Error updating bundle:', error);
    next(error);
  }
});

app.post('/staff/bundles/create', checkAuthenticated, checkStaffAccess('owner'), csrfProtection, async (req, res, next) => {
  try {
    const { name, description, discountPercentage, products } = req.body;

    if (!products) {
      req.session.errorMessage = 'Please select at least 2 products for the bundle';
      return res.redirect('/staff/bundles/create');
    }

    const productArray = Array.isArray(products) ? products : [products];

    if (productArray.length < 2) {
      req.session.errorMessage = 'Please select at least 2 products for the bundle';
      return res.redirect('/staff/bundles/create');
    }

    const newBundle = new bundleModel({
      name,
      description,
      discountPercentage: parseFloat(discountPercentage),
      products: productArray,
      active: true
    });

    await newBundle.save();

    utils.sendDiscordLog('Bundle Created', `[${getUserDisplayName(req.user)}](${config.baseURL}/profile/${getUserIdentifier(req.user)}) has created the bundle \`${name}\``);

    req.session.successMessage = 'Bundle created successfully';
    res.redirect('/staff/bundles');
  } catch (error) {
    console.error('Error creating bundle:', error);
    next(error);
  }
});

app.post('/staff/bundles/delete/:id', checkAuthenticated, checkStaffAccess('owner'), csrfProtection, async (req, res, next) => {
  try {
    const bundle = await bundleModel.findById(req.params.id);
    
    if (!bundle) {
      return res.status(404).send('Bundle not found');
    }

    const bundleName = bundle.name;
    const bundleId = bundle._id;

    await userModel.updateMany(
      { 'cartBundles.bundleId': bundleId },
      { $pull: { cartBundles: { bundleId: bundleId } } }
    );

    await bundleModel.findByIdAndDelete(bundleId);

    utils.sendDiscordLog('Bundle Deleted', `[${getUserDisplayName(req.user)}](${config.baseURL}/profile/${getUserIdentifier(req.user)}) has deleted the bundle \`${bundleName}\``);

    req.session.successMessage = 'Bundle deleted successfully and removed from all user carts';
    res.redirect('/staff/bundles');
  } catch (error) {
    console.error('Error deleting bundle:', error);
    next(error);
  }
});

app.get('/staff/bundles/edit/:id', checkAuthenticated, checkStaffAccess('owner'), async (req, res, next) => {
  try {
    const bundle = await bundleModel.findById(req.params.id).populate('products');
    
    if (!bundle) {
      return res.status(404).render('error', { 
        errorMessage: 'Bundle not found' 
      });
    }

    const products = await productModel.find({
      productType: { $ne: 'digitalFree' }
    }).sort({ position: 1 });

    const errorMessage = req.session.errorMessage;
    const successMessage = req.session.successMessage;
    delete req.session.errorMessage;
    delete req.session.successMessage;

    res.render('staff/edit-bundle', { 
      user: req.user, 
      existingUser: req.user, 
      bundle, 
      products,
      errorMessage,
      successMessage
    });
  } catch (error) {
    console.error('Error loading edit bundle page:', error);
    next(error);
  }
});

app.get('/staff/bundles/create', checkAuthenticated, checkStaffAccess('owner'), async (req, res, next) => {
  try {
    const products = await productModel.find({
      productType: { $ne: 'digitalFree' }
    }).sort({ position: 1 });

    const errorMessage = req.session.errorMessage;
    const successMessage = req.session.successMessage;
    delete req.session.errorMessage;
    delete req.session.successMessage;

    res.render('staff/create-bundle', { 
      user: req.user, 
      existingUser: req.user, 
      products,
      errorMessage,
      successMessage
    });
  } catch (error) {
    console.error('Error loading create bundle page:', error);
    next(error);
  }
});

app.get('/products', async (req, res, next) => {
  try {
    let products;

    if (!req.user) {
      products = cache.get('publicProducts');
    }

    if (req.user || !products) {
      products = await productModel
        .find({
          $or: [{ hideProduct: false }, { hideProduct: { $exists: false } }],
        })
        .sort({
          position: 1
        });
      
      if (!req.user) {
        cache.set('publicProducts', products);
      }
    }

    let existingUser = null;
    if (req.user) {
      existingUser = await findUserById(req.user.id);
    }

    res.render('products', { user: req.user, products, existingUser, currentCategory: null });
  } catch (error) {
    console.error('Error fetching products:', error);
    next(error);
  }
});


app.get('/products/category/:category', async (req, res, next) => {
  try {
    const category = req.params.category;

    const products = await productModel.find({ category, $or: [{ hideProduct: false }, { hideProduct: { $exists: false } }] }).sort({ position: 1 });

    let existingUser = null;
    if (req.user) {
      existingUser = await findUserById(req.user.id);
    }

    res.render('products', { user: req.user, products, existingUser, currentCategory: category });
  } catch (error) {
    console.error('Error fetching products by category:', error);
    next(error);
  }
});


app.get('/products/category/:category', async (req, res, next) => {
  try {
    const category = req.params.category;

    const products = await productModel.find({ category, $or: [{ hideProduct: false }, { hideProduct: { $exists: false } }] }).sort({ position: 1 });

    let existingUser = null;
    if (req.user) {
      
      existingUser = await findUserById(req.user.id);
    }

    res.render('products', { user: req.user, products, existingUser });
  } catch (error) {
    console.error('Error fetching products by category:', error);
    next(error);
  }
});

app.get('/products/:urlId', async (req, res, next) => {
  try {
    const product = await productModel.findOne({ urlId: req.params.urlId });
    if (!product) return res.status(404).render('error', { errorMessage: 'The requested product could not be found. Please check the URL or browse available products.' });

    const reviews = await reviewModel
      .find({ product: new mongoose.Types.ObjectId(product._id) })
      .sort({ createdAt: -1 })
      .lean();

    const reviewsWithDiscordData = await Promise.all(
      reviews.map(async (review) => {
        const cachedDiscordUser = cache.get(`discordUser_${review.discordID}`);

        if (cachedDiscordUser) {
          return {
            ...review,
            discordUsername: cachedDiscordUser.username,
            discordAvatar: cachedDiscordUser.avatar,
          };
        }

        try {
          const discordUser = await client.users.fetch(review.discordID);
          const discordUserData = {
            username: discordUser.username,
            avatar: discordUser.displayAvatarURL({ dynamic: true }),
          };

          cache.set(`discordUser_${review.discordID}`, discordUserData);

          return {
            ...review,
            discordUsername: discordUserData.username,
            discordAvatar: discordUserData.avatar,
          };
        } catch (error) {
          return {
            ...review,
            discordUsername: review.discordUsername || 'Unknown User',
            discordAvatar: review.discordAvatarLocalPath || '/images/default-avatar.png',
          };
        }
      })
    );

    const relatedBundles = await bundleModel
      .find({ 
        products: product._id,
        active: true 
      })
      .populate('products')
      .sort({ position: 1 })
      .lean();

    const bundlesWithPricing = await Promise.all(
      relatedBundles.map(async (bundle) => {
        const originalPrice = bundle.products.reduce((total, prod) => {
          if (prod.onSale && prod.salePrice) {
            return total + prod.salePrice;
          }
          return total + prod.price;
        }, 0);

        const bundlePrice = originalPrice * (1 - bundle.discountPercentage / 100);

        return {
          ...bundle,
          originalPrice,
          bundlePrice
        };
      })
    );

    const categoryFromQuery = req.query.category || null;

    if (!req.user) return res.render('view-product', { 
      user: null, 
      product, 
      existingUser: null, 
      reviews: reviewsWithDiscordData,
      relatedBundles: bundlesWithPricing,
      backCategory: categoryFromQuery
    });

    const existingUser = await findUserById(req.user.id);

    if (existingUser && existingUser.ownedProducts) {
      const validOwnedProducts = [];
      
      for (const productId of existingUser.ownedProducts) {
        if (productId) {
          const validProduct = await productModel.findById(productId);
          if (validProduct) {
            validOwnedProducts.push(productId);
          }
        }
      }
      
      existingUser.ownedProducts = validOwnedProducts;
    }

    res.render('view-product', { 
      user: req.user, 
      product, 
      existingUser, 
      reviews: reviewsWithDiscordData,
      relatedBundles: bundlesWithPricing,
      backCategory: categoryFromQuery
    });
  } catch (error) {
    console.error(error);
    next(error);
  }
});

app.post('/cart/add/:productId', checkAuthenticated, csrfProtection, async (req, res, next) => {
  try {
    let user = await findUserById(req.user.id);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    const product = await productModel.findById(req.params.productId);
    if (!product) {
      return res.status(404).render('error', { errorMessage: 'The requested product could not be found. Please check the URL or browse available products.' });
    }

    if (product.productType === 'serials' && product.serials.length === 0) {
      return res.redirect('/cart?message=out_of_stock');
    }

    if (user.cart.includes(product._id)) {
      return res.redirect('/cart?message=already_in_cart');
    }

    user.cart.push(product._id);
    await user.save();

    return res.redirect('/cart?message=product_added');
  } catch (error) {
    console.error(error);
    next(error);
  }
});

app.post('/cart/remove/:productId', checkAuthenticated, csrfProtection, async (req, res, next) => {
  try {
    let user = await findUserById(req.user.id);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    const productIndex = user.cart.indexOf(req.params.productId);

    
    if (productIndex > -1) {
      user.cart.splice(productIndex, 1); 
      await user.save();
    }

    
    return res.redirect('/cart');
  } catch (error) {
    console.error(error);
    next(error);
  }
});

app.post('/cart/add-bundle/:bundleId', checkAuthenticated, async (req, res) => {
    try {
        const bundleId = req.params.bundleId;
        
        let user = await userModel.findOne({ discordID: req.user.id });

        if (!user && mongoose.Types.ObjectId.isValid(req.user.id)) {
            user = await userModel.findById(req.user.id);
        }

        if (!user) {
            return res.status(404).json({ success: false, message: 'User not found' });
        }

        const bundle = await bundleModel.findById(bundleId).populate('products');

        if (!bundle || !bundle.active) {
            return res.status(404).json({ success: false, message: 'Bundle not found or inactive' });
        }

        const alreadyInCart = user.cartBundles?.some(item => 
            item.bundleId.toString() === bundleId
        );

        if (alreadyInCart) {
            return res.redirect('/cart?message=bundle_already_in_cart');
        }

        const ownedProducts = user.purchasedProducts || [];
        const allProductsOwned = bundle.products.every(product => 
            ownedProducts.some(owned => owned.toString() === product._id.toString())
        );

        if (allProductsOwned) {
            return res.redirect('/cart?message=already_own_all_products');
        }

        const hasOutOfStockProduct = bundle.products.some(product => 
            product.productType === 'serials' && (!product.serials || product.serials.length === 0)
        );

        if (hasOutOfStockProduct) {
            return res.redirect('/cart?message=bundle_out_of_stock');
        }

        const bundleProductIds = bundle.products.map(p => p._id.toString());
        const originalCartLength = user.cart.length;
        
        user.cart = user.cart.filter(productId => 
            !bundleProductIds.includes(productId.toString())
        );

        const removedCount = originalCartLength - user.cart.length;

        if (!user.cartBundles) {
            user.cartBundles = [];
        }

        user.cartBundles.push({
            bundleId: bundle._id,
            addedAt: new Date()
        });

        await user.save();

        if (removedCount > 0) {
            return res.redirect('/cart?message=bundle_added_products_removed');
        } else {
            return res.redirect('/cart?message=bundle_added');
        }

    } catch (error) {
        console.error('Error adding bundle to cart:', error);
        return res.status(500).json({ success: false, message: 'Server error' });
    }
});

app.post('/cart/remove-bundle/:bundleId', checkAuthenticated, csrfProtection, async (req, res, next) => {
    try {
        const bundleId = req.params.bundleId;
        
        let user = await userModel.findOne({ discordID: req.user.id });
        if (!user && mongoose.Types.ObjectId.isValid(req.user.id)) {
            user = await userModel.findById(req.user.id);
        }

        if (!user) {
            return res.status(404).send('User not found');
        }

        user.cartBundles = user.cartBundles.filter(b => b.bundleId.toString() !== bundleId);
        await user.save();

        res.redirect('/cart');
    } catch (error) {
        console.error('Error removing bundle from cart:', error);
        next(error);
    }
});

app.get('/cart', checkAuthenticated, async (req, res, next) => {
    try {
        let existingUser = await findUserById(req.user.id);
        
        let user = await userModel.findOne({ discordID: req.user.id })
            .populate('cart')
            .populate({
                path: 'cartBundles.bundleId',
                populate: { path: 'products' }
            });

        if (!user && mongoose.Types.ObjectId.isValid(req.user.id)) {
            user = await userModel.findById(req.user.id)
                .populate('cart')
                .populate({
                    path: 'cartBundles.bundleId',
                    populate: { path: 'products' }
                });
        }

        req.session.discountCode = null;

        if (!user || ((!user.cart || user.cart.length === 0) && (!user.cartBundles || user.cartBundles.length === 0))) {
            return res.render('cart', { 
                user: req.user, 
                cartProducts: [],
                cartBundles: [],
                subtotal: 0, 
                totalPrice: 0, 
                discountApplied: false, 
                discountError: null,
                discountAmount: 0,
                discountPercentage: 0,
                salesTaxAmount: 0,
                existingUser,
                message: req.query.message || null,
                recommendedBundles: []
            });
        }

        const updatedCart = [];
        const updatedBundles = [];
        let cartModified = false;
        
        for (const product of user.cart || []) {
            if (product.productType === 'serials' && (!product.serials || product.serials.length === 0)) {
                cartModified = true;
                continue; 
            }
            updatedCart.push(product._id); 
        }

        for (const bundleItem of user.cartBundles || []) {
            if (!bundleItem.bundleId || !bundleItem.bundleId.active) {
                cartModified = true;
                continue;
            }
            
            const hasOutOfStockProduct = bundleItem.bundleId.products.some(product => 
                product.productType === 'serials' && (!product.serials || product.serials.length === 0)
            );
            
            if (hasOutOfStockProduct) {
                cartModified = true;
                continue;
            }
            
            updatedBundles.push(bundleItem);
        }

        if (cartModified) {
            user.cart = updatedCart;
            user.cartBundles = updatedBundles;
            await user.save();
        }

        const validProducts = await productModel.find({ _id: { $in: updatedCart } });
        const currentDate = new Date();
        
        let productSubtotal = 0;
        const cartProducts = validProducts.map(product => {
            const isOnSale = product.onSale && 
                            product.saleStartDate <= currentDate && 
                            currentDate <= product.saleEndDate;
            const price = isOnSale ? product.salePrice : product.price;
            productSubtotal += price;
            return {
                ...product.toObject(),
                effectivePrice: price,
            };
        });

        const cartBundles = updatedBundles.map(bundleItem => {
            const bundle = bundleItem.bundleId;
            const originalPrice = bundle.products.reduce((total, product) => {
                const isOnSale = product.onSale && 
                                product.saleStartDate <= currentDate && 
                                currentDate <= product.saleEndDate;
                const price = isOnSale ? product.salePrice : product.price;
                return total + price;
            }, 0);
            
            const bundlePrice = originalPrice * (1 - bundle.discountPercentage / 100);
            
            return {
                ...bundle.toObject(),
                originalPrice,
                bundlePrice,
                savings: originalPrice - bundlePrice
            };
        });

        const bundleSubtotal = cartBundles.reduce((total, bundle) => total + bundle.bundlePrice, 0);
        const subtotal = productSubtotal + bundleSubtotal;

        let salesTaxAmount = 0;
        if (globalSettings.salesTax) {
            salesTaxAmount = parseFloat((subtotal * (globalSettings.salesTax / 100)).toFixed(2));
        }

        const totalPrice = parseFloat((subtotal + salesTaxAmount).toFixed(2));

        let recommendedBundles = [];
        if (updatedCart.length > 0 && updatedBundles.length === 0) {
            const cartProductIds = updatedCart.map(id => id.toString());
            
            const allBundles = await bundleModel.find({ active: true })
                .populate('products');
            
            recommendedBundles = allBundles
                .filter(bundle => {
                    return bundle.products.some(product => 
                        cartProductIds.includes(product._id.toString())
                    );
                })
                .map(bundle => {
                    const originalPrice = bundle.products.reduce((total, product) => {
                        const isOnSale = product.onSale && 
                                        product.saleStartDate <= currentDate && 
                                        currentDate <= product.saleEndDate;
                        const price = isOnSale ? product.salePrice : product.price;
                        return total + price;
                    }, 0);
                    
                    const bundlePrice = originalPrice * (1 - bundle.discountPercentage / 100);
                    
                    return {
                        ...bundle.toObject(),
                        originalPrice,
                        bundlePrice,
                        savings: originalPrice - bundlePrice,
                        matchingProducts: bundle.products.filter(product => 
                            cartProductIds.includes(product._id.toString())
                        )
                    };
                })
                .sort((a, b) => b.savings - a.savings)
                .slice(0, 2);
        }

        res.render('cart', { 
            user: req.user, 
            cartProducts,
            cartBundles,
            subtotal: parseFloat(subtotal.toFixed(2)),
            totalPrice,
            salesTaxAmount,
            discountApplied: false, 
            discountError: null,
            discountAmount: 0,
            discountPercentage: 0,
            existingUser,
            message: req.query.message || null,
            recommendedBundles
        });
    } catch (error) {
        console.error('Cart error:', error);
        next(error);
    }
});


app.post('/checkout/apply-discount', checkAuthenticated, csrfProtection, async (req, res, next) => {
  try {
    const discountCode = req.body.discountCode.toLowerCase();
    const existingUser = await findUserById(req.user.id);

    const code = await DiscountCodeModel.findOne({
      name: {
        $regex: new RegExp(`^${discountCode}$`, 'i'),
      },
    });

    let user = await userModel.findOne({ discordID: req.user.id })
      .populate('cart')
      .populate({
        path: 'cartBundles.bundleId',
        populate: { path: 'products' }
      });

    if (!user && mongoose.Types.ObjectId.isValid(req.user.id)) {
      user = await userModel.findById(req.user.id)
        .populate('cart')
        .populate({
          path: 'cartBundles.bundleId',
          populate: { path: 'products' }
        });
    }

    if (!user) {
      return res.status(404).render('cart', {
        user: req.user,
        cartProducts: [],
        cartBundles: [],
        subtotal: 0,
        totalPrice: 0,
        discountError: 'User not found',
        discountApplied: false,
        discountAmount: 0,
        salesTaxAmount: 0,
        discountPercentage: 0,
        existingUser,
        message: null
      });
    }

    const currentDate = new Date();

    const hasOnSaleProduct = user.cart.some((product) => {
      return (
        product.onSale &&
        product.saleStartDate <= currentDate &&
        currentDate <= product.saleEndDate
      );
    });

    const hasBundles = user.cartBundles && user.cartBundles.length > 0;

    let productSubtotal = user.cart.reduce((acc, product) => {
      const isOnSale =
        product.onSale &&
        product.saleStartDate <= currentDate &&
        currentDate <= product.saleEndDate;
      return acc + (isOnSale ? product.salePrice : product.price);
    }, 0);

    const cartBundles = (user.cartBundles || []).map(bundleItem => {
      const bundle = bundleItem.bundleId;
      if (!bundle) return null;
      
      const originalPrice = bundle.products.reduce((total, product) => {
        const isOnSale = product.onSale && 
                        product.saleStartDate <= currentDate && 
                        currentDate <= product.saleEndDate;
        const price = isOnSale ? product.salePrice : product.price;
        return total + price;
      }, 0);
      
      const bundlePrice = originalPrice * (1 - bundle.discountPercentage / 100);
      
      return {
        ...bundle.toObject(),
        originalPrice,
        bundlePrice,
        savings: originalPrice - bundlePrice
      };
    }).filter(b => b !== null);

    const bundleSubtotal = cartBundles.reduce((total, bundle) => total + bundle.bundlePrice, 0);
    const subtotal = productSubtotal + bundleSubtotal;

    let salesTaxAmountBeforeDiscount = globalSettings.salesTax
      ? parseFloat((subtotal * globalSettings.salesTax / 100).toFixed(2))
      : 0;
    const originalTotal = parseFloat((subtotal + salesTaxAmountBeforeDiscount).toFixed(2)); 

    let discountAmount = 0;
    let discountApplied = false;
    let discountPercentage = 0;
    let discountError = null;

    if (!code) {
      discountError = 'Invalid discount code';
    } else if (code.expiresAt && code.expiresAt < new Date()) {
      discountError = 'This discount code has expired';
    } else if (code.maxUses && code.uses >= code.maxUses) {
      discountError = 'This discount code has reached its maximum uses';
    } else if (hasBundles) {
      discountError = 'Discount codes cannot be applied when your cart contains bundles.';
    } else if (hasOnSaleProduct) {
      discountError = 'Discount codes cannot be applied when the cart contains on-sale products.';
    } else {
      discountPercentage = code.discountPercentage;
      discountAmount = parseFloat((subtotal * discountPercentage / 100).toFixed(2));
      discountApplied = true;
    }

    const discountedSubtotal = subtotal - discountAmount;

    let salesTaxAmount = globalSettings.salesTax
      ? parseFloat((discountedSubtotal * globalSettings.salesTax / 100).toFixed(2))
      : 0;

    const totalPrice = parseFloat((discountedSubtotal + salesTaxAmount).toFixed(2));

    if (discountApplied) {
      req.session.discountCode = discountCode;
    } else {
      req.session.discountCode = null;
    }

    const cartProducts = user.cart.map(product => ({
      ...product.toObject(),
      effectivePrice: product.onSale && 
                      product.saleStartDate <= currentDate && 
                      currentDate <= product.saleEndDate 
                      ? product.salePrice 
                      : product.price,
    }));

    return res.render('cart', {
      user: req.user,
      cartProducts,
      cartBundles,
      subtotal,
      totalPrice,
      originalTotal,
      discountApplied,
      discountError,
      discountAmount,
      discountPercentage,
      salesTaxAmount,
      existingUser,
      message: null
    });
  } catch (error) {
    console.error(error);
    next(error);
  }
});


app.post('/checkout/paypal', checkAuthenticated, csrfProtection, async (req, res, next) => {
  try {
    const paymentConfig = res.locals.paymentConfig;
    if (!paymentConfig.paypal.enabled) {
      return res.status(400).send('PayPal is not enabled');
    }

    if (paymentConfig.paypal.accountType === 'personal') {
      return res.redirect('/checkout/paypal-standard');
    }

    const paypalClient = await getPayPalClient();

    let user = await userModel.findOne({ discordID: req.user.id })
      .populate('cart')
      .populate({
        path: 'cartBundles.bundleId',
        populate: { path: 'products' }
      });

    if (!user && mongoose.Types.ObjectId.isValid(req.user.id)) {
      user = await userModel.findById(req.user.id)
        .populate('cart')
        .populate({
          path: 'cartBundles.bundleId',
          populate: { path: 'products' }
        });
    }
    
    if (!user || (!user.cart.length && (!user.cartBundles || !user.cartBundles.length))) {
      console.error('[DEBUG] User has no items in the cart.');
      return res.status(400).send('Cart is empty');
    }

    const ipAddress = req.headers['x-forwarded-for'] || req.headers['x-real-ip'] || req.ip || req.connection.remoteAddress;
    const userAgent = req.headers['user-agent'];

    let subtotal = 0;
    const items = [];
    const cartSnapshotItems = [];
    const cartSnapshotBundles = [];

    const currentDate = new Date();

    for (const cartItem of user.cart) {
      const product = await productModel.findById(cartItem._id);
    
      if (!product) {
        continue; 
      }
    
      const isOnSale =
        product.onSale &&
        product.saleStartDate <= currentDate &&
        currentDate <= product.saleEndDate;
      const salePrice = isOnSale ? product.salePrice : null;
      const validPrice = isOnSale ? product.salePrice : product.price;
    
      const validName = product.name?.trim() || 'Unnamed Item'; 
      
      const formattedPrice = parseFloat(validPrice.toFixed(2));
      subtotal += formattedPrice;
    
      items.push({
        name: validName,
        unit_amount: {
          currency_code: globalSettings.paymentCurrency,
          value: formattedPrice.toFixed(2),
        },
        quantity: '1',
      });
    
      cartSnapshotItems.push({
        productId: product._id,
        price: product.price,
        salePrice: salePrice || null,
        discountedPrice: validPrice,
      });
    }

for (const bundleItem of user.cartBundles || []) {
  const bundle = bundleItem.bundleId;
  
  if (!bundle || !bundle.active) {
    continue;
  }

  let bundleOriginalPrice = 0;
  const bundleProducts = [];

  for (const product of bundle.products) {
    const isOnSale =
      product.onSale &&
      product.saleStartDate <= currentDate &&
      currentDate <= product.saleEndDate;
    const salePrice = isOnSale ? product.salePrice : null;
    const basePrice = isOnSale ? product.salePrice : product.price;

    bundleOriginalPrice += basePrice;

    bundleProducts.push({
      productId: product._id,
      price: product.price,
      salePrice: salePrice || null,
      discountedPrice: basePrice,
    });
  }

  const bundlePrice = parseFloat((bundleOriginalPrice * (1 - bundle.discountPercentage / 100)).toFixed(2));
  const bundleDiscountMultiplier = bundlePrice / bundleOriginalPrice;

  bundleProducts.forEach(bp => {
    bp.discountedPrice = parseFloat((bp.discountedPrice * bundleDiscountMultiplier).toFixed(2));
  });

  subtotal += bundlePrice;

  items.push({
    name: `${bundle.name} (Bundle - ${bundle.discountPercentage}% OFF)`,
    unit_amount: {
      currency_code: globalSettings.paymentCurrency,
      value: bundlePrice.toFixed(2),
    },
    quantity: '1',
  });

  cartSnapshotBundles.push({
    bundleId: bundle._id,
    bundleName: bundle.name,
    discountPercentage: bundle.discountPercentage,
    originalPrice: bundleOriginalPrice,
    bundlePrice: bundlePrice,
    products: bundleProducts
  });
}

    if (!items.length) {
      return res.status(400).send('No valid items in the cart');
    }

    let discountAmount = 0;
    let discountPercentage = 0;
    if (req.session.discountCode) {
      const discountCode = await DiscountCodeModel.findOne({
        name: {
          $regex: new RegExp(`^${req.session.discountCode}$`, 'i'),
        },
      });

      if (discountCode) {
        discountPercentage = discountCode.discountPercentage;
        discountAmount = parseFloat((subtotal * (discountPercentage / 100)).toFixed(2));
      }
    }

    const discountedSubtotal = parseFloat((subtotal - discountAmount).toFixed(2));

    let salesTaxAmount = 0;
    if (globalSettings.salesTax) {
      salesTaxAmount = parseFloat((discountedSubtotal * (globalSettings.salesTax / 100)).toFixed(2));
    }

    const totalPrice = parseFloat((discountedSubtotal + salesTaxAmount).toFixed(2));

    const cartSnapshot = await CartSnapshot.create({
      userId: user._id,
      items: cartSnapshotItems,
      bundles: cartSnapshotBundles,
      total: totalPrice,
      ipAddress: ipAddress,
      userAgent: userAgent,
    });
    
    const requestBody = {
      intent: 'CAPTURE',
      purchase_units: [
        {
          amount: {
            currency_code: globalSettings.paymentCurrency,
            value: totalPrice.toFixed(2),
            breakdown: {
              item_total: {
                currency_code: globalSettings.paymentCurrency,
                value: subtotal.toFixed(2),
              },
              discount: discountAmount > 0 ? {
                currency_code: globalSettings.paymentCurrency,
                value: discountAmount.toFixed(2),
              } : undefined,
              tax_total: salesTaxAmount > 0 ? {
                currency_code: globalSettings.paymentCurrency,
                value: salesTaxAmount.toFixed(2),
              } : undefined,
            },
          },
          description: `${globalSettings.storeName} Cart Checkout | Account ID: ${req.user.id} | Terms of Service: ${config.baseURL}/tos`,
          items: items,
        },
      ],
      application_context: {
        brand_name: globalSettings.storeName,
        landing_page: 'NO_PREFERENCE',
        user_action: 'PAY_NOW',
        return_url: `${config.baseURL}/checkout/paypal/capture?snapshot_id=${cartSnapshot._id.toString()}`,
        cancel_url: `${config.baseURL}/cart`,
      },
    };
    
    const request = new paypal.orders.OrdersCreateRequest();
    request.prefer('return=representation');
    request.requestBody(requestBody);

    const order = await paypalClient.execute(request);

    res.redirect(order.result.links.find((link) => link.rel === 'approve').href);
  } catch (error) {
    console.error(`[ERROR] Failed to create PayPal order: ${error.message}`);
    console.error(`Stack Trace: ${error.stack}`);
    next(error);
  }
});




app.get('/checkout/paypal/capture', checkAuthenticated, async (req, res, next) => {
  try {
      const { token, snapshot_id } = req.query;
      
      const paypalClient = await getPayPalClient();
      
    const currentUser = await findUserById(req.user.id);
    if (!currentUser) {
      return res.redirect('/cart?error=user_not_found');
    }

    const cartSnapshot = await CartSnapshot.findOneAndUpdate(
      {
        _id: snapshot_id,
        status: 'pending',
        userId: currentUser._id
      },
      {
        status: 'processed',
        processedAt: new Date()
      },
      { new: true }
    );

      if (!cartSnapshot) {
          if(config.DebugMode) console.log('[DEBUG] Cart snapshot not found, already processed, or unauthorized access attempt');
          return res.redirect('/cart?error=invalid_order');
      }

      const request = new paypal.orders.OrdersCaptureRequest(token);
      request.requestBody({});

      const capture = await paypalClient.execute(request);

      if (capture.result.status === 'COMPLETED') {
          const user = await userModel.findOne({ _id: cartSnapshot.userId });

          const products = await Promise.all(cartSnapshot.items.map(async (snapshotItem) => {
              const product = await productModel.findById(snapshotItem.productId);
              if (!product) {
                  throw new Error(`Product with ID ${snapshotItem.productId} not found.`);
              }
              return {
                  id: product._id,
                  name: product.name,
                  price: snapshotItem.discountedPrice,
                  discordRoleIds: product.discordRoleIds,
                  productType: product.productType,
              };
          }));

          const bundleProducts = [];
          const processedBundleIds = [];

          for (const bundleSnapshot of cartSnapshot.bundles || []) {
            const bundle = await bundleModel.findById(bundleSnapshot.bundleId);
            
            if (!bundle) {
              console.error(`Bundle with ID ${bundleSnapshot.bundleId} not found.`);
              continue;
            }

            for (const bundleProduct of bundleSnapshot.products) {
              const product = await productModel.findById(bundleProduct.productId);
              
              if (!product) {
                console.error(`Product with ID ${bundleProduct.productId} not found in bundle.`);
                continue;
              }

              bundleProducts.push({
                id: product._id,
                name: product.name,
                price: bundleProduct.discountedPrice,
                discordRoleIds: product.discordRoleIds,
                productType: product.productType,
                bundleId: bundle._id,
                bundleName: bundle.name,
              });
            }

            processedBundleIds.push(bundle._id);
          }

          const allProducts = [...products, ...bundleProducts];

          const transactionId = capture.result.purchase_units[0].payments.captures[0].id;

          const discountCode = req.session.discountCode || null;
          let discountPercentage = 0;

          if (discountCode) {
              const code = await DiscountCodeModel.findOne({ 
                name: { 
                  $regex: new RegExp(`^${discountCode}$`, 'i') 
                } 
              });

              if (code) {
                  discountPercentage = code.discountPercentage;
                  code.uses += 1;
                  await code.save();
              }
          }

      const roundToTwo = (num) => Math.round(num * 100) / 100;

      const originalSubtotal = roundToTwo(
        allProducts.reduce((sum, product) => sum + product.price, 0)
      );
      if(config.DebugMode) console.log(`[DEBUG] Original Subtotal: ${originalSubtotal}`);

      const discountAmount = roundToTwo(originalSubtotal * (discountPercentage / 100));
      if(config.DebugMode) console.log(`[DEBUG] Discount Amount: ${discountAmount}`);

      const discountedSubtotal = roundToTwo(originalSubtotal - discountAmount);
      if(config.DebugMode) console.log(`[DEBUG] Discounted Subtotal: ${discountedSubtotal}`);

      let salesTaxAmount = 0;
      if (globalSettings.salesTax) {
        salesTaxAmount = roundToTwo(discountedSubtotal * (globalSettings.salesTax / 100));
        if(config.DebugMode) console.log(`[DEBUG] Sales Tax Amount: ${salesTaxAmount}`);
      }

      const totalPaid = roundToTwo(discountedSubtotal + salesTaxAmount);
      if(config.DebugMode) console.log(`[DEBUG] Total Paid: ${totalPaid}`);

if (
  !capture.result ||
  !capture.result.purchase_units ||
  !capture.result.purchase_units[0] ||
  !capture.result.purchase_units[0].payments ||
  !capture.result.purchase_units[0].payments.captures ||
  !capture.result.purchase_units[0].payments.captures[0] ||
  !capture.result.purchase_units[0].payments.captures[0].amount ||
  !capture.result.purchase_units[0].payments.captures[0].amount.value
) {
  if(config.DebugMode) console.error('[DEBUG] Invalid capture structure:', JSON.stringify(capture, null, 2));
  throw new Error('Invalid response structure from PayPal capture.');
}

const paypalCapturedAmount = parseFloat(capture.result.purchase_units[0].payments.captures[0].amount.value);
if(config.DebugMode) console.log(`[DEBUG] PayPal Captured Amount: ${paypalCapturedAmount}`);

          const nextPaymentId = await getNextPaymentId();

const payment = new paymentModel({
  ID: nextPaymentId,
  transactionID: transactionId,
  paymentMethod: "paypal",
  userId: user._id,
  userID: user.discordID || user._id.toString(),
  discordID: user.discordID || null,
  authMethod: user.authMethod,
  username: user.discordUsername || user.username,
  email: user.email,
  products: allProducts.map(p => {
    const snapshotItem = cartSnapshot.items.find(i => i.productId.toString() === p.id.toString());
    const bundleProductItem = cartSnapshot.bundles
      .flatMap(b => b.products)
      .find(bp => bp.productId.toString() === p.id.toString());
    
    const itemData = snapshotItem || bundleProductItem;
    
    return {
      name: p.bundleName ? `${p.name} (from ${p.bundleName})` : p.name,
      price: itemData?.discountedPrice || p.price,
      salePrice: itemData?.salePrice || null,
      originalPrice: itemData?.price || p.price,
    };
  }),
  discountCode,
  discountPercentage,
  salesTax: globalSettings.salesTax,
  originalSubtotal: parseFloat(originalSubtotal.toFixed(2)),
  salesTaxAmount: parseFloat(salesTaxAmount.toFixed(2)),
  discountAmount: parseFloat(discountAmount.toFixed(2)),
  ipAddress: cartSnapshot.ipAddress,
  userAgent: cartSnapshot.userAgent,
  totalPaid: parseFloat(totalPaid.toFixed(2)),
});

if(config.DebugMode) {
  console.log('[DEBUG] Payment object being saved:', {
    originalSubtotal: payment.originalSubtotal,
    discountAmount: payment.discountAmount,
    salesTaxAmount: payment.salesTaxAmount,
    totalPaid: payment.totalPaid,
    products: payment.products.map(p => ({
      name: p.name,
      price: p.price,
      originalPrice: p.originalPrice
    }))
  });
}

          await payment.save();

          const newProducts = allProducts.filter(p => !user.ownedProducts.includes(p.id));

          for (const product of allProducts) {
            const productDoc = await productModel.findById(product.id);
            if (productDoc) {
                productDoc.totalPurchases += 1;
                productDoc.totalEarned += product.price * (1 - discountPercentage / 100);
        
                if (productDoc.productType === 'serials') {
                    if (productDoc.serials && productDoc.serials.length !== 0) {
                    const randomIndex = Math.floor(Math.random() * productDoc.serials.length);
                    const serialKey = productDoc.serials[randomIndex];
                    productDoc.serials.splice(randomIndex, 1);
                    user.ownedSerials = user.ownedSerials || [];
                    user.ownedSerials.push({
                        productId: productDoc._id,
                        productName: productDoc.name,
                        key: serialKey.key,
                        purchaseDate: new Date()
                    });
                  }
                }
                await productDoc.save();
            }
        }

          for (const bundleId of processedBundleIds) {
            const bundle = await bundleModel.findById(bundleId);
            if (bundle) {
              const bundleSnapshot = cartSnapshot.bundles.find(b => b.bundleId.toString() === bundleId.toString());
              bundle.totalPurchases += 1;
              bundle.totalEarned += bundleSnapshot.bundlePrice * (1 - discountPercentage / 100);
              await bundle.save();
            }
          }

if (user.discordID && (user.authMethod === 'discord' || user.authMethod === 'both')) {
  const guild = await client.guilds.fetch(config.GuildID);
  if (guild) {
    try {
      const guildMember = await guild.members.fetch(user.discordID);
      
      if (guildMember) {
        for (const product of allProducts) {
          if (product.discordRoleIds && product.discordRoleIds.length > 0) {
            for (const roleId of product.discordRoleIds) {
              const role = guild.roles.cache.get(roleId);
              if (role) {
                await guildMember.roles.add(role);
              }
            }
          }
        }
      }
    } catch (error) {
      if(config.DebugMode) console.error(`Failed to add Discord roles: ${error.message}`);
    }
  }
}

          user.ownedProducts.push(...newProducts.map(p => p.id));
          user.totalSpent = (user.totalSpent || 0) + parseFloat(totalPaid.toFixed(2));
          user.cart = [];
          user.cartBundles = [];
          await user.save();

          delete req.session.discountCode;

          const now = new Date();
          const currentYear = now.getFullYear();
          const currentMonthIndex = now.getMonth();

          const stats = await statisticsModel.getStatistics();
          stats.totalEarned += parseFloat(totalPaid.toFixed(2));
          stats.totalPurchases += 1;
          stats.lastUpdated = Date.now();

          let yearlyStats = stats.yearlyStats.find(y => y.year === currentYear);
          if (!yearlyStats) {
              yearlyStats = {
                  year: currentYear,
                  months: Array(12).fill(null).map(() => ({ totalEarned: 0, totalPurchases: 0, userJoins: 0, totalSiteVisits: 0 }))
              };
              stats.yearlyStats.push(yearlyStats);
          }

          if (!yearlyStats.months || yearlyStats.months.length !== 12) {
              yearlyStats.months = Array(12).fill(null).map(() => ({ totalEarned: 0, totalPurchases: 0, userJoins: 0, totalSiteVisits: 0 }));
          }

          yearlyStats.months[currentMonthIndex].totalEarned += parseFloat(totalPaid.toFixed(2));
          yearlyStats.months[currentMonthIndex].totalPurchases += 1;

          await stats.save();

const settings = res.locals.settings || await settingsModel.findOne();

try {
const pdfBuffer = await utils.generateInvoicePdf(
  payment,
  config,
  settings
);
  
  await utils.saveInvoicePdf(pdfBuffer, payment);
  console.log(`Invoice PDF generated and saved for payment #${payment.ID}`);
  
  if (settings.emailSettings.enabled) {
    await utils.sendInvoiceEmail(payment, user, allProducts, config, settings, pdfBuffer);
  }
} catch (pdfError) {
  console.error('Failed to generate invoice PDF:', pdfError);
}

          const productNames = allProducts.map(product => product.name).join(', ');
          const bundleInfo = processedBundleIds.length > 0 ? ` (including ${processedBundleIds.length} bundle${processedBundleIds.length > 1 ? 's' : ''})` : '';
          utils.sendDiscordLog('Purchase Completed', `[${getUserDisplayName(req.user)}](${config.baseURL}/profile/${getUserIdentifier(req.user)}) has purchased \`${productNames}\`${bundleInfo} with \`PayPal\`.`);

          res.redirect(`/invoice/${transactionId}`);
      } else {
          res.redirect('/cart');
      }
  } catch (error) {
      console.error('\x1b[31m%s\x1b[0m', `[ERROR] Failed to capture PayPal order: ${error.message}`);
      console.error('\x1b[33m%s\x1b[0m', `Stack Trace: ${error.stack}`);
      
      if (error.message.includes('invalid_client')) {
          next(new Error('There was an issue with the PayPal API credentials. Please check your configuration.'));
      } else {
          next(error);
      }
  }
});

app.post('/checkout/paypal-standard', checkAuthenticated, csrfProtection, async (req, res, next) => {
  try {
    const paymentConfig = res.locals.paymentConfig;
    if (!paymentConfig.paypal.enabled) {
      return res.status(400).send('PayPal is not enabled');
    }

    if (paymentConfig.paypal.accountType !== 'personal') {
      return res.redirect('/checkout/paypal');
    }

    let user = await userModel.findOne({ discordID: req.user.id })
      .populate('cart')
      .populate({
        path: 'cartBundles.bundleId',
        populate: { path: 'products' }
      });

    if (!user && mongoose.Types.ObjectId.isValid(req.user.id)) {
      user = await userModel.findById(req.user.id)
        .populate('cart')
        .populate({
          path: 'cartBundles.bundleId',
          populate: { path: 'products' }
        });
    }

    if (!user || (!user.cart.length && (!user.cartBundles || !user.cartBundles.length))) {
      return res.status(400).send('Cart is empty');
    }

    const ipAddress = req.headers['x-forwarded-for'] || req.headers['x-real-ip'] || req.ip || req.connection.remoteAddress;
    const userAgent = req.headers['user-agent'];

    let subtotal = 0;
    const cartSnapshotItems = [];
    const cartSnapshotBundles = [];
    const currentDate = new Date();

    for (const cartItem of user.cart) {
      const product = await productModel.findById(cartItem._id);
      if (!product) continue;

      const isOnSale = product.onSale && product.saleStartDate <= currentDate && currentDate <= product.saleEndDate;
      const validPrice = isOnSale ? product.salePrice : product.price;

      subtotal += parseFloat(validPrice.toFixed(2));

      cartSnapshotItems.push({
        productId: product._id,
        price: product.price,
        salePrice: isOnSale ? product.salePrice : null,
        discountedPrice: validPrice,
      });
    }

for (const bundleItem of user.cartBundles || []) {
  const bundle = bundleItem.bundleId;
  
  if (!bundle || !bundle.active) {
    continue;
  }

  let bundleOriginalPrice = 0;
  const bundleProducts = [];

  for (const product of bundle.products) {
    const isOnSale = product.onSale && product.saleStartDate <= currentDate && currentDate <= product.saleEndDate;
    const salePrice = isOnSale ? product.salePrice : null;
    const basePrice = isOnSale ? product.salePrice : product.price;

    bundleOriginalPrice += basePrice;

    bundleProducts.push({
      productId: product._id,
      price: product.price,
      salePrice: salePrice || null,
      discountedPrice: basePrice,
    });
  }

  const bundlePrice = parseFloat((bundleOriginalPrice * (1 - bundle.discountPercentage / 100)).toFixed(2));
  const bundleDiscountMultiplier = bundlePrice / bundleOriginalPrice;

  bundleProducts.forEach(bp => {
    bp.discountedPrice = parseFloat((bp.discountedPrice * bundleDiscountMultiplier).toFixed(2));
  });

  subtotal += bundlePrice;

  cartSnapshotBundles.push({
    bundleId: bundle._id,
    bundleName: bundle.name,
    discountPercentage: bundle.discountPercentage,
    originalPrice: bundleOriginalPrice,
    bundlePrice: bundlePrice,
    products: bundleProducts
  });
}

    if (!cartSnapshotItems.length && !cartSnapshotBundles.length) {
      return res.status(400).send('No valid items in the cart');
    }

    let discountAmount = 0;
    let discountPercentage = 0;
    if (req.session.discountCode) {
      const discountCode = await DiscountCodeModel.findOne({
        name: { $regex: new RegExp(`^${req.session.discountCode}$`, 'i') }
      });

      if (discountCode) {
        discountPercentage = discountCode.discountPercentage;
        discountAmount = parseFloat((subtotal * (discountPercentage / 100)).toFixed(2));
      }
    }

    const discountedSubtotal = parseFloat((subtotal - discountAmount).toFixed(2));

    let salesTaxAmount = 0;
    if (globalSettings.salesTax) {
      salesTaxAmount = parseFloat((discountedSubtotal * (globalSettings.salesTax / 100)).toFixed(2));
    }

    const totalPrice = parseFloat((discountedSubtotal + salesTaxAmount).toFixed(2));

    const cartSnapshot = await CartSnapshot.create({
      userId: user._id,
      items: cartSnapshotItems,
      bundles: cartSnapshotBundles,
      total: totalPrice,
      ipAddress: ipAddress,
      userAgent: userAgent,
      discountCode: req.session.discountCode || null,
      discountPercentage: discountPercentage,
      discountAmount: discountAmount,
    });

    const paypalEmail = paymentConfig.paypal.personalEmail;
    const paypalUrl = 'https://www.paypal.com/cgi-bin/webscr';

    const itemCount = cartSnapshotItems.length + cartSnapshotBundles.length;
    const itemDescription = `${globalSettings.storeName} Cart Checkout (${itemCount} item${itemCount > 1 ? 's' : ''})`;

const formHtml = `
  <!DOCTYPE html>
  <html>
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Redirecting to PayPal...</title>
    <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
    <style>
      body { 
        font-family: Arial, sans-serif; 
        display: flex; 
        justify-content: center; 
        align-items: center; 
        height: 100vh; 
        margin: 0;
        background: #0a0a0a;
        color: white;
      }
      .container {
        text-align: center;
        max-width: 400px;
        padding: 40px;
      }
      .spinner {
        border: 4px solid rgba(255,255,255,0.1);
        border-left-color: ${globalSettings.accentColor};
        border-radius: 50%;
        width: 50px;
        height: 50px;
        animation: spin 1s linear infinite;
        margin: 0 auto 30px;
      }
      @keyframes spin {
        to { transform: rotate(360deg); }
      }
      h1 {
        font-size: 24px;
        margin-bottom: 15px;
        color: white;
      }
      p {
        color: #a1a1aa;
        margin-bottom: 30px;
        line-height: 1.6;
      }
      .paypal-btn {
        background: #0070ba;
        color: white;
        border: none;
        padding: 15px 40px;
        font-size: 16px;
        font-weight: bold;
        border-radius: 8px;
        cursor: pointer;
        transition: all 0.3s ease;
        display: inline-flex;
        align-items: center;
        gap: 10px;
      }
      .paypal-btn:hover {
        background: #005ea6;
        transform: translateY(-2px);
        box-shadow: 0 4px 12px rgba(0, 112, 186, 0.3);
      }
      .auto-redirect {
        margin-top: 20px;
        font-size: 14px;
        color: #71717a;
      }
    </style>
  </head>
  <body>
    <div class="container">
      <div class="spinner"></div>
      <h1>Complete Your Payment</h1>
      <p>Click the button below to complete your purchase securely with PayPal.</p>
      
      <form id="paypal-form" action="${paypalUrl}" method="post">
        <input type="hidden" name="cmd" value="_xclick">
        <input type="hidden" name="business" value="${paypalEmail}">
        <input type="hidden" name="item_name" value="${itemDescription}">
        <input type="hidden" name="item_number" value="${cartSnapshot._id.toString()}">
        <input type="hidden" name="amount" value="${totalPrice.toFixed(2)}">
        <input type="hidden" name="currency_code" value="${globalSettings.paymentCurrency}">
        <input type="hidden" name="return" value="${config.baseURL}/checkout/paypal-standard/return?snapshot_id=${cartSnapshot._id.toString()}">
        <input type="hidden" name="cancel_return" value="${config.baseURL}/cart">
        <input type="hidden" name="notify_url" value="${config.baseURL}/ipn/paypal">
        <input type="hidden" name="custom" value="${user._id.toString()}">
        <input type="hidden" name="no_shipping" value="1">
        <input type="hidden" name="no_note" value="1">
        
        <button type="submit" class="paypal-btn">
          <i class="fab fa-paypal"></i>
          Continue to PayPal
        </button>
      </form>
    </div>
  </body>
  </html>
`;

    res.send(formHtml);
  } catch (error) {
    console.error('[ERROR] PayPal Standard checkout failed:', error.message);
    next(error);
  }
});

const { verifyIPN } = require('./utils/paypalIPN');

app.post('/ipn/paypal', async (req, res) => {
  try {
    const ipnData = req.body;
    
    res.status(200).send('OK');

    const isVerified = await verifyIPN(ipnData);
    
    if (!isVerified) {
      console.error('[IPN] Verification failed - possible fraud attempt');
      return;
    }

    const paymentStatus = ipnData.payment_status;
    const txnId = ipnData.txn_id;
    const snapshotId = ipnData.item_number;
    const userId = ipnData.custom;
    const receiverEmail = ipnData.receiver_email;
    const paymentAmount = parseFloat(ipnData.mc_gross);
    const paymentCurrency = ipnData.mc_currency;

    if (receiverEmail.toLowerCase() !== paymentConfig.paypal.personalEmail.toLowerCase()) {
      console.error('[IPN] Payment sent to wrong email address');
      return res.status(400).send('INVALID_RECEIVER');
    }

    if (paymentCurrency !== globalSettings.paymentCurrency) {
      console.error('[IPN] Wrong currency received');
      return;
    }

    const existingPayment = await paymentModel.findOne({ transactionID: txnId });
    if (existingPayment) {
      if(config.DebugMode) console.log('[IPN] Duplicate transaction - already processed');
      return;
    }

    if (paymentStatus !== 'Completed') {
      if(config.DebugMode) console.log(`[IPN] Payment status is ${paymentStatus}, not processing`);
      return;
    }

    const cartSnapshot = await CartSnapshot.findOneAndUpdate(
      { _id: snapshotId, status: 'pending', userId: userId },
      { status: 'processed', processedAt: new Date() },
      { new: true }
    );

    if (!cartSnapshot) {
      console.error('[IPN] Cart snapshot not found or already processed');
      return;
    }

    if (Math.abs(paymentAmount - cartSnapshot.total) > 0.01) {
      console.error('[IPN] Payment amount mismatch');
      return;
    }

    const user = await userModel.findById(cartSnapshot.userId);
    if (!user) {
      console.error('[IPN] User not found');
      return;
    }

    const products = await Promise.all(cartSnapshot.items.map(async (snapshotItem) => {
      const product = await productModel.findById(snapshotItem.productId);
      if (!product) {
        throw new Error(`Product with ID ${snapshotItem.productId} not found.`);
      }
      return {
        id: product._id,
        name: product.name,
        price: snapshotItem.discountedPrice,
        discordRoleIds: product.discordRoleIds,
        productType: product.productType,
      };
    }));

    const bundleProducts = [];
    const processedBundleIds = [];

    for (const bundleSnapshot of cartSnapshot.bundles || []) {
      const bundle = await bundleModel.findById(bundleSnapshot.bundleId);
      
      if (!bundle) {
        console.error(`[IPN] Bundle with ID ${bundleSnapshot.bundleId} not found.`);
        continue;
      }

      for (const bundleProduct of bundleSnapshot.products) {
        const product = await productModel.findById(bundleProduct.productId);
        
        if (!product) {
          console.error(`[IPN] Product with ID ${bundleProduct.productId} not found in bundle.`);
          continue;
        }

        bundleProducts.push({
          id: product._id,
          name: product.name,
          price: bundleProduct.discountedPrice,
          discordRoleIds: product.discordRoleIds,
          productType: product.productType,
          bundleId: bundle._id,
          bundleName: bundle.name,
        });
      }

      processedBundleIds.push(bundle._id);
    }

    const allProducts = [...products, ...bundleProducts];

    const discountCode = cartSnapshot.discountCode || null;
    const discountPercentage = cartSnapshot.discountPercentage || 0;
    const discountAmount = cartSnapshot.discountAmount || 0;

    if (discountCode) {
      const code = await DiscountCodeModel.findOne({ 
        name: { $regex: new RegExp(`^${discountCode}$`, 'i') } 
      });
      if (code) {
        code.uses += 1;
        await code.save();
      }
    }

    const roundToTwo = (num) => Math.round(num * 100) / 100;

    const originalSubtotal = roundToTwo(
      allProducts.reduce((sum, product) => sum + product.price, 0)
    );

    const discountedSubtotal = roundToTwo(originalSubtotal - discountAmount);

    let salesTaxAmount = 0;
    if (globalSettings.salesTax) {
      salesTaxAmount = roundToTwo(discountedSubtotal * (globalSettings.salesTax / 100));
    }

    const totalPaid = roundToTwo(discountedSubtotal + salesTaxAmount);

    const nextPaymentId = await getNextPaymentId();

const payment = new paymentModel({
  ID: nextPaymentId,
  transactionID: txnId,
  paymentMethod: "paypal",
  userId: user._id,
  userID: user.discordID || user._id.toString(),
  discordID: user.discordID || null,
  authMethod: user.authMethod,
  username: user.discordUsername || user.username,
  email: user.email,
  products: allProducts.map(p => {
    const snapshotItem = cartSnapshot.items.find(i => i.productId.toString() === p.id.toString());
    const bundleProductItem = cartSnapshot.bundles
      .flatMap(b => b.products)
      .find(bp => bp.productId.toString() === p.id.toString());
    
    const itemData = snapshotItem || bundleProductItem;
    
    return {
      name: p.bundleName ? `${p.name} (from ${p.bundleName})` : p.name,
      price: itemData?.discountedPrice || p.price,
      salePrice: itemData?.salePrice || null,
      originalPrice: itemData?.price || p.price,
    };
  }),
  discountCode,
  discountPercentage,
  salesTax: globalSettings.salesTax,
  originalSubtotal: parseFloat(originalSubtotal.toFixed(2)),
  salesTaxAmount: parseFloat(salesTaxAmount.toFixed(2)),
  discountAmount: parseFloat(discountAmount.toFixed(2)),
  ipAddress: cartSnapshot.ipAddress,
  userAgent: cartSnapshot.userAgent,
  totalPaid: parseFloat(totalPaid.toFixed(2)),
});
    await payment.save();

    const newProducts = allProducts.filter(p => !user.ownedProducts.includes(p.id));

    for (const product of allProducts) {
      const productDoc = await productModel.findById(product.id);
      if (productDoc) {
        productDoc.totalPurchases += 1;
        productDoc.totalEarned += product.price * (1 - discountPercentage / 100);

        if (productDoc.productType === 'serials') {
          if (productDoc.serials && productDoc.serials.length !== 0) {
            const randomIndex = Math.floor(Math.random() * productDoc.serials.length);
            const serialKey = productDoc.serials[randomIndex];
            productDoc.serials.splice(randomIndex, 1);
            user.ownedSerials = user.ownedSerials || [];
            user.ownedSerials.push({
              productId: productDoc._id,
              productName: productDoc.name,
              key: serialKey.key,
              purchaseDate: new Date()
            });
          }
        }
        await productDoc.save();
      }
    }

    for (const bundleId of processedBundleIds) {
      const bundle = await bundleModel.findById(bundleId);
      if (bundle) {
        const bundleSnapshot = cartSnapshot.bundles.find(b => b.bundleId.toString() === bundleId.toString());
        bundle.totalPurchases += 1;
        bundle.totalEarned += bundleSnapshot.bundlePrice * (1 - discountPercentage / 100);
        await bundle.save();
      }
    }

    if (user.discordID && (user.authMethod === 'discord' || user.authMethod === 'both')) {
      const guild = await client.guilds.fetch(config.GuildID);
      if (guild) {
        try {
          const guildMember = await guild.members.fetch(user.discordID);
          if (guildMember) {
            for (const product of allProducts) {
              if (product.discordRoleIds && product.discordRoleIds.length > 0) {
                for (const roleId of product.discordRoleIds) {
                  const role = guild.roles.cache.get(roleId);
                  if (role) {
                    await guildMember.roles.add(role);
                  }
                }
              }
            }
          }
        } catch (error) {
          if(config.DebugMode) console.error(`[IPN] Failed to add Discord roles: ${error.message}`);
        }
      }
    }

    user.ownedProducts.push(...newProducts.map(p => p.id));
    user.totalSpent = (user.totalSpent || 0) + parseFloat(totalPaid.toFixed(2));
    user.cart = [];
    user.cartBundles = [];
    await user.save();

    const now = new Date();
    const currentYear = now.getFullYear();
    const currentMonthIndex = now.getMonth();

    const stats = await statisticsModel.getStatistics();
    stats.totalEarned += parseFloat(totalPaid.toFixed(2));
    stats.totalPurchases += 1;
    stats.lastUpdated = Date.now();

    let yearlyStats = stats.yearlyStats.find(y => y.year === currentYear);
    if (!yearlyStats) {
      yearlyStats = {
        year: currentYear,
        months: Array(12).fill(null).map(() => ({ totalEarned: 0, totalPurchases: 0, userJoins: 0, totalSiteVisits: 0 }))
      };
      stats.yearlyStats.push(yearlyStats);
    }

    if (!yearlyStats.months || yearlyStats.months.length !== 12) {
      yearlyStats.months = Array(12).fill(null).map(() => ({ totalEarned: 0, totalPurchases: 0, userJoins: 0, totalSiteVisits: 0 }));
    }

    yearlyStats.months[currentMonthIndex].totalEarned += parseFloat(totalPaid.toFixed(2));
    yearlyStats.months[currentMonthIndex].totalPurchases += 1;

    await stats.save();

    const settings = res.locals.settings || await settingsModel.findOne();

    try {
      const pdfBuffer = await utils.generateInvoicePdf(
        payment,
        config,
        settings
      );
      
      await utils.saveInvoicePdf(pdfBuffer, payment);
      console.log(`[IPN] Invoice PDF generated and saved for payment #${payment.ID}`);
      
      if (settings.emailSettings.enabled) {
        await utils.sendInvoiceEmail(payment, user, allProducts, config, settings, pdfBuffer);
      }
    } catch (pdfError) {
      console.error('[IPN] Failed to generate invoice PDF:', pdfError);
    }

    const productNames = allProducts.map(product => product.name).join(', ');
    const bundleInfo = processedBundleIds.length > 0 ? ` (including ${processedBundleIds.length} bundle${processedBundleIds.length > 1 ? 's' : ''})` : '';
    const displayUserId = user.discordID || user._id.toString();
    const displayUsername = user.discordUsername || user.username || 'User';
    utils.sendDiscordLog('Purchase Completed', `[${displayUsername}](${config.baseURL}/profile/${displayUserId}) has purchased \`${productNames}\`${bundleInfo} with \`PayPal\`.`);

    if(config.DebugMode) console.log('[IPN] Payment processed successfully');

  } catch (error) {
    console.error('[IPN] Error processing payment:', error.message);
    console.error(error.stack);
  }
});

app.get('/checkout/paypal-standard/return', checkAuthenticated, async (req, res) => {
  try {
    const { snapshot_id } = req.query;
    
    if (!snapshot_id) {
      return res.redirect('/cart?error=invalid_order');
    }

    let attempts = 0;
    const maxAttempts = 30;
    
    while (attempts < maxAttempts) {
      const cartSnapshot = await CartSnapshot.findById(snapshot_id);
      
      if (!cartSnapshot) {
        return res.redirect('/cart?error=order_not_found');
      }

      if (cartSnapshot.status === 'processed') {
        const payment = await paymentModel.findOne({ 
          userId: cartSnapshot.userId 
        }).sort({ createdAt: -1 }).limit(1);
        
        if (payment) {
          return res.redirect(`/invoice/${payment.transactionID}`);
        }
      }

      await new Promise(resolve => setTimeout(resolve, 1000));
      attempts++;
    }

    res.send(`
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Processing Payment - ${globalSettings.storeName}</title>
        <script src="https://cdn.tailwindcss.com"></script>
        <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
        <style>
          body { background: #0a0a0a; color: #ffffff; }
          .spinner {
            border: 4px solid rgba(255,255,255,0.1);
            border-left-color: ${globalSettings.accentColor};
            border-radius: 50%;
            width: 60px;
            height: 60px;
            animation: spin 1s linear infinite;
            margin: 0 auto;
          }
          @keyframes spin { to { transform: rotate(360deg); } }
        </style>
      </head>
      <body>
        <div style="min-height: 100vh; display: flex; align-items: center; justify-content: center; flex-direction: column; padding: 20px;">
          <div class="spinner"></div>
          <h1 style="margin-top: 30px; font-size: 24px; font-weight: bold;">Payment Processing</h1>
          <p style="margin-top: 15px; color: #a1a1aa; text-align: center; max-width: 500px;">
            Your payment is being confirmed by PayPal. This should only take a moment...
          </p>
          <p style="margin-top: 20px; color: #71717a; font-size: 14px;">
            Page will refresh automatically
          </p>
        </div>
        <script>
          setTimeout(() => {
            window.location.reload();
          }, 3000);
        </script>
      </body>
      </html>
    `);

  } catch (error) {
    console.error('[PayPal Return] Error:', error.message);
    res.redirect('/cart?error=processing_failed');
  }
});

app.get('/api/check-payment-status', checkAuthenticated, async (req, res) => {
  try {
    const { snapshot_id } = req.query;
    
    const cartSnapshot = await CartSnapshot.findById(snapshot_id);
    
    if (!cartSnapshot) {
      return res.json({ status: 'not_found' });
    }

    if (cartSnapshot.status === 'processed') {
      const payment = await paymentModel.findOne({ 
        userId: cartSnapshot.userId 
      }).sort({ createdAt: -1 });
      
      return res.json({ 
        status: 'processed', 
        transactionId: payment ? payment.transactionID : null 
      });
    }

    res.json({ status: cartSnapshot.status });
  } catch (error) {
    console.error('Error checking payment status:', error);
    res.status(500).json({ status: 'error' });
  }
});

app.post('/checkout/stripe', checkAuthenticated, csrfProtection, async (req, res, next) => {
  try {
    const paymentConfig = res.locals.paymentConfig;
    if (!paymentConfig.stripe.enabled) {
      return res.status(400).send('Stripe is not enabled');
    }

    const stripe = await getStripeClient();

    let user = await userModel.findOne({ discordID: req.user.id })
      .populate('cart')
      .populate({
        path: 'cartBundles.bundleId',
        populate: { path: 'products' }
      });

    if (!user && mongoose.Types.ObjectId.isValid(req.user.id)) {
      user = await userModel.findById(req.user.id)
        .populate('cart')
        .populate({
          path: 'cartBundles.bundleId',
          populate: { path: 'products' }
        });
    }
    
    if (!user || (!user.cart.length && (!user.cartBundles || !user.cartBundles.length))) {
      return res.status(400).send('Cart is empty');
    }

    const ipAddress = req.headers['x-forwarded-for'] || req.headers['x-real-ip'] || req.ip || req.connection.remoteAddress;
    const userAgent = req.headers['user-agent'];

    const currentDate = new Date();
    let subtotal = 0;
    const items = [];
    const cartSnapshotItems = [];
    const cartSnapshotBundles = [];
    let discountAmount = 0;
    let discountPercentage = 0;

    if (req.session.discountCode) {
      const discountCode = await DiscountCodeModel.findOne({
        name: { $regex: new RegExp(`^${req.session.discountCode}$`, 'i') },
      });

      if (discountCode) {
        discountPercentage = discountCode.discountPercentage;
      }
    }

    for (const cartItem of user.cart) {
      const product = await productModel.findById(cartItem._id);

      if (!product) continue;

      const isOnSale = product.onSale && product.saleStartDate <= currentDate && currentDate <= product.saleEndDate;
      const salePrice = isOnSale ? product.salePrice : null;
      const basePrice = isOnSale ? product.salePrice : product.price;

      subtotal += basePrice;

      const discountedPrice = basePrice * (1 - discountPercentage / 100);

      items.push({
        price_data: {
          currency: globalSettings.paymentCurrency,
          product_data: { name: product.name },
          unit_amount: Math.round(discountedPrice * 100), 
        },
        quantity: 1,
      });

      cartSnapshotItems.push({
        productId: product._id,
        price: product.price, 
        salePrice, 
        discountedPrice: parseFloat(discountedPrice.toFixed(2)), 
      });
    }

for (const bundleItem of user.cartBundles || []) {
  const bundle = bundleItem.bundleId;
  
  if (!bundle || !bundle.active) {
    continue;
  }

  let bundleOriginalPrice = 0;
  const bundleProducts = [];

  for (const product of bundle.products) {
    const isOnSale = product.onSale && product.saleStartDate <= currentDate && product.saleEndDate <= currentDate;
    const salePrice = isOnSale ? product.salePrice : null;
    const basePrice = isOnSale ? product.salePrice : product.price;

    bundleOriginalPrice += basePrice;

    bundleProducts.push({
      productId: product._id,
      price: product.price,
      salePrice: salePrice || null,
      discountedPrice: basePrice,
    });
  }

  const bundlePrice = parseFloat((bundleOriginalPrice * (1 - bundle.discountPercentage / 100)).toFixed(2));
  const bundleDiscountMultiplier = bundlePrice / bundleOriginalPrice;

  bundleProducts.forEach(bp => {
    bp.discountedPrice = parseFloat((bp.discountedPrice * bundleDiscountMultiplier).toFixed(2));
  });

  subtotal += bundlePrice;

  const finalBundlePrice = bundlePrice * (1 - discountPercentage / 100);

  items.push({
    price_data: {
      currency: globalSettings.paymentCurrency,
      product_data: { 
        name: `${bundle.name} (Bundle - ${bundle.discountPercentage}% OFF)`,
        description: `Includes ${bundle.products.length} products`
      },
      unit_amount: Math.round(finalBundlePrice * 100),
    },
    quantity: 1,
  });

  cartSnapshotBundles.push({
    bundleId: bundle._id,
    bundleName: bundle.name,
    discountPercentage: bundle.discountPercentage,
    originalPrice: bundleOriginalPrice,
    bundlePrice: bundlePrice,
    products: bundleProducts
  });
}

    discountAmount = subtotal * (discountPercentage / 100);

    const discountedSubtotal = subtotal - discountAmount;

    let salesTaxAmount = 0;
    if (globalSettings.salesTax) {
      salesTaxAmount = parseFloat((discountedSubtotal * (globalSettings.salesTax / 100)).toFixed(2));
    }

    const totalPrice = parseFloat((discountedSubtotal + salesTaxAmount).toFixed(2));

    if (config.DebugMode) {
      console.log('[DEBUG] Calculated amounts for Stripe checkout:');
      console.log({
        subtotal: subtotal.toFixed(2),
        discountAmount: discountAmount.toFixed(2),
        discountedSubtotal: discountedSubtotal.toFixed(2),
        salesTaxAmount: salesTaxAmount.toFixed(2),
        totalPrice: totalPrice.toFixed(2),
      });
    }

    const cartSnapshot = await CartSnapshot.create({
      userId: user._id,
      items: cartSnapshotItems,
      bundles: cartSnapshotBundles,
      total: totalPrice.toFixed(2),
      ipAddress: ipAddress,
      userAgent: userAgent,
    });

    if (salesTaxAmount > 0) {
      items.push({
        price_data: {
          currency: globalSettings.paymentCurrency,
          product_data: { name: 'Sales Tax' },
          unit_amount: Math.round(salesTaxAmount * 100), 
        },
        quantity: 1,
      });
    }

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: items,
      mode: 'payment',
      success_url: `${config.baseURL}/checkout/stripe/capture?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${config.baseURL}/cart`,
      client_reference_id: cartSnapshot._id.toString(),
    });

    res.redirect(303, session.url);
  } catch (error) {
    console.error(`[ERROR] Failed to create Stripe session: ${error.message}`);
    next(error);
  }
});

app.get('/checkout/stripe/capture', checkAuthenticated, async (req, res, next) => {
  try {
      const { session_id } = req.query;

      const stripe = await getStripeClient();
      const session = await stripe.checkout.sessions.retrieve(session_id);

      if (!session || session.payment_status !== 'paid') {
          return res.redirect('/cart');
      }

     const currentUser = await findUserById(req.user.id);
     if (!currentUser) {
         return res.redirect('/cart');
     }

     const cartSnapshot = await CartSnapshot.findOneAndUpdate(
         { 
             _id: session.client_reference_id, 
             status: 'pending',
             userId: currentUser._id
         },
         { 
             status: 'processed', 
             processedAt: new Date() 
         },
         { new: true }
     );

      if (!cartSnapshot) {
          if(config.DebugMode) console.log('[DEBUG] Cart snapshot not found, already processed, or unauthorized access attempt');
          return res.redirect('/cart?error=invalid_order');
      }

      const user = await userModel.findOne({ _id: cartSnapshot.userId });
      if (!user) {
          throw new Error('User not found for this cart snapshot.');
      }

      const products = await Promise.all(cartSnapshot.items.map(async (snapshotItem) => {
          const product = await productModel.findById(snapshotItem.productId);
          if (!product) {
              throw new Error(`Product with ID ${snapshotItem.productId} not found.`);
          }
          return {
              id: product._id,
              name: product.name,
              price: snapshotItem.discountedPrice,
              discordRoleIds: product.discordRoleIds,
              productType: product.productType,
          };
      }));

      const bundleProducts = [];
      const processedBundleIds = [];

      for (const bundleSnapshot of cartSnapshot.bundles || []) {
        const bundle = await bundleModel.findById(bundleSnapshot.bundleId);
        
        if (!bundle) {
          console.error(`Bundle with ID ${bundleSnapshot.bundleId} not found.`);
          continue;
        }

        for (const bundleProduct of bundleSnapshot.products) {
          const product = await productModel.findById(bundleProduct.productId);
          
          if (!product) {
            console.error(`Product with ID ${bundleProduct.productId} not found in bundle.`);
            continue;
          }

          bundleProducts.push({
            id: product._id,
            name: product.name,
            price: bundleProduct.discountedPrice,
            discordRoleIds: product.discordRoleIds,
            productType: product.productType,
            bundleId: bundle._id,
            bundleName: bundle.name,
          });
        }

        processedBundleIds.push(bundle._id);
      }

      const allProducts = [...products, ...bundleProducts];

      const transactionId = session.payment_intent || session.id; 

      const discountCode = req.session.discountCode || null;
      let discountPercentage = 0;

      if (discountCode) {
          const code = await DiscountCodeModel.findOne({ 
              name: { 
                  $regex: new RegExp(`^${discountCode}$`, 'i') 
              }
          });

          if (code) {
              discountPercentage = code.discountPercentage;
              code.uses += 1;
              await code.save();
          }
      }

      const newProducts = allProducts.filter(p => !user.ownedProducts.includes(p.id));

      for (const product of allProducts) {
        const productDoc = await productModel.findById(product.id);
        if (productDoc) {
            productDoc.totalPurchases += 1;
            productDoc.totalEarned += product.price * (1 - discountPercentage / 100);
    
            if (productDoc.productType === 'serials') {
                if (productDoc.serials && productDoc.serials.length !== 0) {
                const randomIndex = Math.floor(Math.random() * productDoc.serials.length);
                const serialKey = productDoc.serials[randomIndex];
                productDoc.serials.splice(randomIndex, 1);
                user.ownedSerials = user.ownedSerials || [];
                user.ownedSerials.push({
                    productId: productDoc._id,
                    productName: productDoc.name,
                    key: serialKey.key,
                    purchaseDate: new Date()
                });
              }
            }
            await productDoc.save();
        }
    }

      for (const bundleId of processedBundleIds) {
        const bundle = await bundleModel.findById(bundleId);
        if (bundle) {
          const bundleSnapshot = cartSnapshot.bundles.find(b => b.bundleId.toString() === bundleId.toString());
          bundle.totalPurchases += 1;
          bundle.totalEarned += bundleSnapshot.bundlePrice * (1 - discountPercentage / 100);
          await bundle.save();
        }
      }

if (user.discordID && (user.authMethod === 'discord' || user.authMethod === 'both')) {
  const guild = await client.guilds.fetch(config.GuildID);
  if (guild) {
    try {
      const guildMember = await guild.members.fetch(user.discordID);
      
      if (guildMember) {
        for (const product of allProducts) {
          if (product.discordRoleIds && product.discordRoleIds.length > 0) {
            for (const roleId of product.discordRoleIds) {
              const role = guild.roles.cache.get(roleId);
              if (role) {
                await guildMember.roles.add(role);
              }
            }
          }
        }
      }
    } catch (error) {
      if(config.DebugMode) console.error(`Failed to add Discord roles: ${error.message}`);
    }
  }
}

const originalSubtotal = parseFloat(cartSnapshot.total);

const discountAmount = 0;

let taxableSubtotal = originalSubtotal;

let salesTaxAmount = 0;
if (globalSettings.salesTax) {
    salesTaxAmount = parseFloat(((originalSubtotal / (1 + globalSettings.salesTax / 100)) * (globalSettings.salesTax / 100)).toFixed(2));
}

const totalPaid = parseFloat(originalSubtotal.toFixed(2));

if(config.DebugMode) console.log({
    originalSubtotal: (originalSubtotal - salesTaxAmount).toFixed(2),
    discountAmount: discountAmount.toFixed(2),
    taxableSubtotal: (originalSubtotal - salesTaxAmount).toFixed(2),
    salesTaxAmount: salesTaxAmount.toFixed(2),
    totalPaid: totalPaid.toFixed(2),
});

      const nextPaymentId = await getNextPaymentId();

const payment = new paymentModel({
  ID: nextPaymentId,
  transactionID: transactionId,
  paymentMethod: "stripe",
  userId: user._id,
  userID: user.discordID || user._id.toString(),
  discordID: user.discordID || null,
  authMethod: user.authMethod,
  username: user.discordUsername || user.username,
  email: user.email,
  products: allProducts.map(p => {
    const snapshotItem = cartSnapshot.items.find(i => i.productId.toString() === p.id.toString());
    const bundleProductItem = cartSnapshot.bundles
      .flatMap(b => b.products)
      .find(bp => bp.productId.toString() === p.id.toString());
    
    const itemData = snapshotItem || bundleProductItem;
    
    if (config.DebugMode) {
      console.log(`Product ${p.name}:`, {
        pPrice: p.price,
        itemDataDiscountedPrice: itemData?.discountedPrice,
        itemDataPrice: itemData?.price,
        itemDataSalePrice: itemData?.salePrice
      });
    }
    
    return {
      name: p.bundleName ? `${p.name} (from ${p.bundleName})` : p.name,
      price: itemData?.discountedPrice || p.price,
      salePrice: itemData?.salePrice || null,
      originalPrice: itemData?.price || p.price,
    };
  }),
  discountCode,
  discountPercentage,
  originalSubtotal: parseFloat((originalSubtotal - salesTaxAmount).toFixed(2)),
  salesTaxAmount: parseFloat(salesTaxAmount.toFixed(2)),
  discountAmount: parseFloat(discountAmount.toFixed(2)),
  ipAddress: cartSnapshot.ipAddress,
  userAgent: cartSnapshot.userAgent,
  totalPaid: parseFloat(totalPaid.toFixed(2)),
});
    await payment.save();

      user.ownedProducts.push(...newProducts.map(p => p.id));
      user.totalSpent = (user.totalSpent || 0) + parseFloat(totalPaid.toFixed(2));
      user.cart = [];
      user.cartBundles = [];
      await user.save();

      delete req.session.discountCode;

      const now = new Date();
      const currentYear = now.getFullYear();
      const currentMonthIndex = now.getMonth();

      const stats = await statisticsModel.getStatistics();
      stats.totalEarned += parseFloat(totalPaid.toFixed(2));
      stats.totalPurchases += 1;
      stats.lastUpdated = Date.now();

      let yearlyStats = stats.yearlyStats.find(y => y.year === currentYear);
      if (!yearlyStats) {
          yearlyStats = {
              year: currentYear,
              months: Array(12).fill(null).map(() => ({ totalEarned: 0, totalPurchases: 0, userJoins: 0, totalSiteVisits: 0 }))
          };
          stats.yearlyStats.push(yearlyStats);
      }

      if (!yearlyStats.months || yearlyStats.months.length !== 12) {
          yearlyStats.months = Array(12).fill(null).map(() => ({ totalEarned: 0, totalPurchases: 0, userJoins: 0, totalSiteVisits: 0 }));
      }

      yearlyStats.months[currentMonthIndex].totalEarned += parseFloat(totalPaid.toFixed(2));
      yearlyStats.months[currentMonthIndex].totalPurchases += 1;

      await stats.save();

const settings = res.locals.settings || await settingsModel.findOne();

try {
const pdfBuffer = await utils.generateInvoicePdf(
  payment,
  config,
  settings
);
  
  await utils.saveInvoicePdf(pdfBuffer, payment);
  console.log(`Invoice PDF generated and saved for payment #${payment.ID}`);
  
  if (settings.emailSettings.enabled) {
    await utils.sendInvoiceEmail(payment, user, allProducts, config, settings, pdfBuffer);
  }
} catch (pdfError) {
  console.error('Failed to generate invoice PDF:', pdfError);
}

      const productNames = allProducts.map(product => product.name).join(', ');
      const bundleInfo = processedBundleIds.length > 0 ? ` (including ${processedBundleIds.length} bundle${processedBundleIds.length > 1 ? 's' : ''})` : '';
      utils.sendDiscordLog('Purchase Completed', `[${getUserDisplayName(req.user)}](${config.baseURL}/profile/${getUserIdentifier(req.user)}) has purchased \`${productNames}\`${bundleInfo} with \`Stripe\`.`);

      res.redirect(`/invoice/${transactionId}`);
  } catch (error) {
      console.error('\x1b[31m%s\x1b[0m', `[ERROR] Failed to capture Stripe order: ${error.message}`);
      console.error('\x1b[33m%s\x1b[0m', `Stack Trace: ${error.stack}`);
      res.status(500).send('An unexpected error occurred. Please try again later.');
  }
});

app.post('/checkout/coinbase', checkAuthenticated, csrfProtection, async (req, res, next) => {
  try {
    const paymentConfig = res.locals.paymentConfig;
    if (!paymentConfig.coinbase.enabled) {
      return res.status(400).send('Coinbase is not enabled');
    }

    const Charge = await getCoinbaseClient();

    let user = await userModel.findOne({ discordID: req.user.id })
      .populate('cart')
      .populate({
        path: 'cartBundles.bundleId',
        populate: { path: 'products' }
      });

    if (!user && mongoose.Types.ObjectId.isValid(req.user.id)) {
      user = await userModel.findById(req.user.id)
        .populate('cart')
        .populate({
          path: 'cartBundles.bundleId',
          populate: { path: 'products' }
        });
    }
    
    if (!user || (!user.cart.length && (!user.cartBundles || !user.cartBundles.length))) {
      return res.status(400).send('Cart is empty');
    }

    const ipAddress = req.headers['x-forwarded-for'] || req.headers['x-real-ip'] || req.ip || req.connection.remoteAddress;
    const userAgent = req.headers['user-agent'];

    const currentDate = new Date();
    let subtotal = 0;
    const items = [];
    const cartSnapshotItems = [];
    const cartSnapshotBundles = [];
    let discountPercentage = 0;

    if (req.session.discountCode) {
      const discountCode = await DiscountCodeModel.findOne({
        name: {
          $regex: new RegExp(`^${req.session.discountCode}$`, 'i'),
        },
      });

      if (discountCode) {
        discountPercentage = discountCode.discountPercentage;
      }
    }

    for (let i = 0; i < user.cart.length; i++) {
      const productId = user.cart[i]._id;
      const product = await productModel.findById(productId);

      if (!product) {
        user.cart.splice(i, 1);
        i--;
      } else {
        const isOnSale =
          product.onSale &&
          product.saleStartDate &&
          product.saleEndDate &&
          product.saleStartDate <= currentDate &&
          currentDate <= product.saleEndDate;

        const productPrice = isOnSale ? product.salePrice : product.price || 0;
        subtotal += productPrice;

        const discountedPrice = discountPercentage
          ? productPrice * (1 - discountPercentage / 100)
          : productPrice;

        items.push({
          name: product.name,
          amount: discountedPrice.toFixed(2),
          currency: globalSettings.paymentCurrency,
          quantity: 1,
        });

        cartSnapshotItems.push({
          productId: product._id,
          price: product.price,
          salePrice: isOnSale ? product.salePrice : null,
          discountedPrice: parseFloat(discountedPrice.toFixed(2)),
        });
      }
    }

for (const bundleItem of user.cartBundles || []) {
  const bundle = bundleItem.bundleId;
  
  if (!bundle || !bundle.active) {
    continue;
  }

  let bundleOriginalPrice = 0;
  const bundleProducts = [];

  for (const product of bundle.products) {
    const isOnSale =
      product.onSale &&
      product.saleStartDate &&
      product.saleEndDate &&
      product.saleStartDate <= currentDate &&
      currentDate <= product.saleEndDate;

    const salePrice = isOnSale ? product.salePrice : null;
    const basePrice = isOnSale ? product.salePrice : product.price;

    bundleOriginalPrice += basePrice;

    bundleProducts.push({
      productId: product._id,
      price: product.price,
      salePrice: salePrice || null,
      discountedPrice: basePrice,
    });
  }

  const bundlePrice = parseFloat((bundleOriginalPrice * (1 - bundle.discountPercentage / 100)).toFixed(2));
  const bundleDiscountMultiplier = bundlePrice / bundleOriginalPrice;

  bundleProducts.forEach(bp => {
    bp.discountedPrice = parseFloat((bp.discountedPrice * bundleDiscountMultiplier).toFixed(2));
  });

  subtotal += bundlePrice;

  const finalBundlePrice = discountPercentage
    ? bundlePrice * (1 - discountPercentage / 100)
    : bundlePrice;

  items.push({
    name: `${bundle.name} (Bundle - ${bundle.discountPercentage}% OFF)`,
    amount: finalBundlePrice.toFixed(2),
    currency: globalSettings.paymentCurrency,
    quantity: 1,
  });

  cartSnapshotBundles.push({
    bundleId: bundle._id,
    bundleName: bundle.name,
    discountPercentage: bundle.discountPercentage,
    originalPrice: bundleOriginalPrice,
    bundlePrice: bundlePrice,
    products: bundleProducts
  });
}

    if (user.cart.length !== cartSnapshotItems.length) {
      await user.save();
    }

    let salesTaxAmount = 0;
    if (globalSettings.salesTax) {
      salesTaxAmount = subtotal * (globalSettings.salesTax / 100);
      salesTaxAmount = Math.round(salesTaxAmount * 100) / 100;
    }

    if (salesTaxAmount > 0) {
      items.push({
        name: 'Sales Tax',
        amount: salesTaxAmount.toFixed(2),
        currency: globalSettings.paymentCurrency,
        quantity: 1,
      });
    }

    const totalAmount = items.reduce((total, item) => total + parseFloat(item.amount) * item.quantity, 0);
    const roundedTotalAmount = Math.round(totalAmount * 100) / 100;

    const cartSnapshot = await CartSnapshot.create({
      userId: user._id,
      items: cartSnapshotItems,
      bundles: cartSnapshotBundles,
      total: roundedTotalAmount,
      ipAddress: ipAddress,
      userAgent: userAgent,
    });

    const itemCount = cartSnapshotItems.length + cartSnapshotBundles.length;

    const chargeData = {
      name: globalSettings.storeName,
      description: `Purchase from ${globalSettings.storeName} (${itemCount} item${itemCount > 1 ? 's' : ''})`,
      pricing_type: 'fixed_price',
      local_price: {
        amount: roundedTotalAmount.toFixed(2),
        currency: globalSettings.paymentCurrency,
      },
      metadata: {
        userId: req.user.id,
        snapshotId: cartSnapshot._id.toString(),
        discountPercentage: discountPercentage,
        salesTax: globalSettings.salesTax ? `${globalSettings.salesTax}%` : '0%',
      },
    };

    const charge = await Charge.create(chargeData);

    res.redirect(303, charge.hosted_url);
  } catch (error) {
    console.error('\x1b[31m%s\x1b[0m', `[ERROR] Failed to create Coinbase charge: ${error.message}`);
    console.error('\x1b[33m%s\x1b[0m', `Stack Trace: ${error.stack}`);
    next(error);
  }
});



app.post('/webhooks/coinbase', express.raw({ type: 'application/json' }), async (req, res) => {
  
  const paymentConfig = res.locals.paymentConfig;
  const webhookSecret = paymentConfig.coinbase.webhookSecret;
  const signature = req.headers['x-cc-webhook-signature'];

  if(config.DebugMode) console.log('\x1b[36m%s\x1b[0m', '[COINBASE WEBHOOK] Received webhook request');

  try {
      let rawBody = req.body;
      
      if (typeof rawBody === 'object' && !Buffer.isBuffer(rawBody)) rawBody = JSON.stringify(rawBody);
      
      const rawBodyString = Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : rawBody;

      try {
          Webhook.verifySigHeader(rawBodyString, signature, webhookSecret);
          if(config.DebugMode) console.log('\x1b[32m%s\x1b[0m', '[COINBASE WEBHOOK] Signature verified successfully');
      } catch (error) {
          if(config.DebugMode) console.error('\x1b[31m%s\x1b[0m', '[COINBASE WEBHOOK] Failed to verify signature:', error.message);
          return res.status(400).send('Invalid signature');
      }

      const event = JSON.parse(rawBodyString).event;

      if(config.DebugMode) console.log('\x1b[33m%s\x1b[0m', `[COINBASE WEBHOOK] Event Type: ${event.type}`);
      if(config.DebugMode) console.log('\x1b[33m%s\x1b[0m', `[COINBASE WEBHOOK] Event Data:`, JSON.stringify(event.data, null, 2));

      if (event.type === 'charge:created') {
          if(config.DebugMode) console.log('\x1b[33m%s\x1b[0m', '[COINBASE WEBHOOK] Charge created, waiting for payment...');
          return res.status(200).send('Charge created');
      }

      if (event.type === 'charge:pending') {
          if(config.DebugMode) console.log('\x1b[33m%s\x1b[0m', '[COINBASE WEBHOOK] Charge is pending, waiting for confirmation...');
          return res.status(200).send('Charge pending');
      }

      if (event.type === 'charge:confirmed' || event.type === 'charge:completed') {
          const charge = event.data;
          
          const isCompleted = charge.timeline && charge.timeline.some(t => t.status === 'COMPLETED');
          
          if (!isCompleted && event.type === 'charge:confirmed') {
              if(config.DebugMode) console.log('\x1b[33m%s\x1b[0m', '[COINBASE WEBHOOK] Charge confirmed but not completed yet, waiting...');
              return res.status(200).send('Charge confirmed but not completed');
          }

          if(config.DebugMode) console.log('\x1b[32m%s\x1b[0m', '[COINBASE WEBHOOK] ✓ Charge completed! Processing payment...');
          
          const snapshotId = charge.metadata.snapshotId;

          if(config.DebugMode) console.log('\x1b[36m%s\x1b[0m', `[COINBASE WEBHOOK] Snapshot ID: ${snapshotId}`);
          if(config.DebugMode) console.log('\x1b[36m%s\x1b[0m', `[COINBASE WEBHOOK] Charge ID: ${charge.id}`);

          const cartSnapshot = await CartSnapshot.findById(snapshotId);
          if (!cartSnapshot) return res.status(404).send('Cart snapshot not found');


          if (cartSnapshot.status === 'processed') {
              if(config.DebugMode) console.log('\x1b[33m%s\x1b[0m', '[COINBASE WEBHOOK] Payment already processed, skipping...');
              return res.status(200).send('Already processed');
          }

          cartSnapshot.status = 'processed';
          cartSnapshot.processedAt = new Date();
          await cartSnapshot.save();

          const user = await userModel.findOne({ _id: cartSnapshot.userId });

          if (!user) {
              return res.status(404).send('User not found');
          }

          const products = await Promise.all(cartSnapshot.items.map(async (snapshotItem) => {
              const product = await productModel.findById(snapshotItem.productId);
              if (!product) {
                  throw new Error(`Product with ID ${snapshotItem.productId} not found.`);
              }
              return {
                  id: product._id,
                  name: product.name,
                  price: snapshotItem.discountedPrice,
                  discordRoleIds: product.discordRoleIds,
                  productType: product.productType,
              };
          }));

          const bundleProducts = [];
          const processedBundleIds = [];

          for (const bundleSnapshot of cartSnapshot.bundles || []) {
            const bundle = await bundleModel.findById(bundleSnapshot.bundleId);
            
            if (!bundle) {
              console.error(`[COINBASE WEBHOOK] Bundle with ID ${bundleSnapshot.bundleId} not found.`);
              continue;
            }

            for (const bundleProduct of bundleSnapshot.products) {
              const product = await productModel.findById(bundleProduct.productId);
              
              if (!product) {
                console.error(`[COINBASE WEBHOOK] Product with ID ${bundleProduct.productId} not found in bundle.`);
                continue;
              }

              bundleProducts.push({
                id: product._id,
                name: product.name,
                price: bundleProduct.discountedPrice,
                discordRoleIds: product.discordRoleIds,
                productType: product.productType,
                bundleId: bundle._id,
                bundleName: bundle.name,
              });
            }

            processedBundleIds.push(bundle._id);
          }

          const allProducts = [...products, ...bundleProducts];

          const transactionId = charge.id;

          let discountPercentage = 0;
          const discountCode = charge.metadata.discountCode || null;

          if (discountCode) {
              const code = await DiscountCodeModel.findOne({ 
                  name: { 
                      $regex: new RegExp(`^${discountCode}$`, 'i') 
                  }
              });

              if (code) {
                  discountPercentage = code.discountPercentage;
                  code.uses += 1;
                  await code.save();
              }
          }

          const roundToTwo = (num) => Math.round(num * 100) / 100;

          const originalSubtotal = roundToTwo(
              allProducts.reduce((sum, product) => sum + product.price, 0)
          );

          const discountAmount = roundToTwo(originalSubtotal * (discountPercentage / 100));

          const discountedSubtotal = roundToTwo(originalSubtotal - discountAmount);

          let salesTaxAmount = 0;
          if (globalSettings.salesTax) {
              salesTaxAmount = roundToTwo(discountedSubtotal * (globalSettings.salesTax / 100));
          }

          const totalPaid = roundToTwo(discountedSubtotal + salesTaxAmount);

          const nextPaymentId = await getNextPaymentId();

const payment = new paymentModel({
  ID: nextPaymentId,
  transactionID: transactionId,
  paymentMethod: "coinbase",
  userId: user._id,
  userID: user.discordID || user._id.toString(),
  discordID: user.discordID || null,
  authMethod: user.authMethod,
  username: user.discordUsername || user.username,
  email: user.email,
  products: allProducts.map(p => {
    const snapshotItem = cartSnapshot.items.find(i => i.productId.toString() === p.id.toString());
    const bundleProductItem = cartSnapshot.bundles
      .flatMap(b => b.products)
      .find(bp => bp.productId.toString() === p.id.toString());
    
    const itemData = snapshotItem || bundleProductItem;
    
    return {
      name: p.bundleName ? `${p.name} (from ${p.bundleName})` : p.name,
      price: itemData?.discountedPrice || p.price,
      salePrice: itemData?.salePrice || null,
      originalPrice: itemData?.price || p.price,
    };
  }),
  discountCode,
  discountPercentage,
  salesTax: globalSettings.salesTax,
  originalSubtotal: parseFloat(originalSubtotal.toFixed(2)),
  salesTaxAmount: parseFloat(salesTaxAmount.toFixed(2)),
  discountAmount: parseFloat(discountAmount.toFixed(2)),
  ipAddress: cartSnapshot.ipAddress,
  userAgent: cartSnapshot.userAgent,
  totalPaid: parseFloat(totalPaid.toFixed(2)),
});
          await payment.save();

          const newProducts = allProducts.filter(p => !user.ownedProducts.includes(p.id));

          for (const product of allProducts) {
            const productDoc = await productModel.findById(product.id);
            if (productDoc) {
                productDoc.totalPurchases += 1;
                productDoc.totalEarned += product.price * (1 - discountPercentage / 100);
        
                if (productDoc.productType === 'serials') {
                    if (productDoc.serials && productDoc.serials.length !== 0) {
                        const randomIndex = Math.floor(Math.random() * productDoc.serials.length);
                        const serialKey = productDoc.serials[randomIndex];
                        productDoc.serials.splice(randomIndex, 1);
                        user.ownedSerials = user.ownedSerials || [];
                        user.ownedSerials.push({
                            productId: productDoc._id,
                            productName: productDoc.name,
                            key: serialKey.key,
                            purchaseDate: new Date()
                        });
                    }
                }
                await productDoc.save();
            }
          }

          for (const bundleId of processedBundleIds) {
            const bundle = await bundleModel.findById(bundleId);
            if (bundle) {
              const bundleSnapshot = cartSnapshot.bundles.find(b => b.bundleId.toString() === bundleId.toString());
              bundle.totalPurchases += 1;
              bundle.totalEarned += bundleSnapshot.bundlePrice * (1 - discountPercentage / 100);
              await bundle.save();
            }
          }

          if (user.discordID && (user.authMethod === 'discord' || user.authMethod === 'both')) {
            const guild = await client.guilds.fetch(config.GuildID);
            if (guild) {
              try {
                const guildMember = await guild.members.fetch(user.discordID);
                
                if (guildMember) {
                  for (const product of allProducts) {
                    if (product.discordRoleIds && product.discordRoleIds.length > 0) {
                      for (const roleId of product.discordRoleIds) {
                        const role = guild.roles.cache.get(roleId);
                        if (role) {
                          await guildMember.roles.add(role);
                        }
                      }
                    }
                  }
                }
              } catch (error) {
                if(config.DebugMode) console.error(`[COINBASE WEBHOOK] Failed to add Discord roles: ${error.message}`);
              }
            }
          }

          user.ownedProducts.push(...newProducts.map(p => p.id));
          user.totalSpent = (user.totalSpent || 0) + parseFloat(totalPaid.toFixed(2));
          user.cart = [];
          user.cartBundles = [];
          await user.save();

          const stats = await statisticsModel.getStatistics();
          stats.totalEarned += parseFloat(totalPaid.toFixed(2));
          stats.totalPurchases += 1;
          stats.lastUpdated = Date.now();

          const now = new Date();
          const currentYear = now.getFullYear();
          const currentMonthIndex = now.getMonth();

          let yearlyStats = stats.yearlyStats.find(y => y.year === currentYear);
          if (!yearlyStats) {
              yearlyStats = {
                  year: currentYear,
                  months: Array(12).fill(null).map(() => ({ totalEarned: 0, totalPurchases: 0, userJoins: 0, totalSiteVisits: 0 }))
              };
              stats.yearlyStats.push(yearlyStats);
          }

          yearlyStats.months[currentMonthIndex].totalEarned += parseFloat(totalPaid.toFixed(2));
          yearlyStats.months[currentMonthIndex].totalPurchases += 1;

          await stats.save();

const settings = res.locals.settings || await settingsModel.findOne();

try {
const pdfBuffer = await utils.generateInvoicePdf(
  payment,
  config,
  settings
);
  
  await utils.saveInvoicePdf(pdfBuffer, payment);
  if(config.DebugMode) console.log(`[COINBASE WEBHOOK] Invoice PDF generated and saved for payment #${payment.ID}`);
  
  if (settings.emailSettings.enabled) {
    await utils.sendInvoiceEmail(payment, user, allProducts, config, settings, pdfBuffer);
  }
} catch (pdfError) {
  console.error('[COINBASE WEBHOOK] Failed to generate invoice PDF:', pdfError);
}

          const productNames = allProducts.map(product => product.name).join(', ');
          const bundleInfo = processedBundleIds.length > 0 ? ` (including ${processedBundleIds.length} bundle${processedBundleIds.length > 1 ? 's' : ''})` : '';
          utils.sendDiscordLog('Purchase Completed', `[${user.discordUsername || user.username}](${config.baseURL}/profile/${user.discordID || user._id}) has purchased \`${productNames}\`${bundleInfo} with \`Coinbase\`.`);

          if(config.DebugMode) console.log('\x1b[32m%s\x1b[0m', '[COINBASE WEBHOOK] ========== PAYMENT PROCESSING COMPLETED ==========');

          return res.status(200).send('Webhook processed successfully');
      } else {
          if(config.DebugMode) console.log('\x1b[33m%s\x1b[0m', `[COINBASE WEBHOOK] Unhandled event type: ${event.type}`);
          return res.status(200).send('Event type not processed');
      }
  } catch (error) {
      if(config.DebugMode) console.error('\x1b[31m%s\x1b[0m', `[COINBASE WEBHOOK] ✗ ERROR: ${error.message}`);
      if(config.DebugMode) console.error('\x1b[31m%s\x1b[0m', `[COINBASE WEBHOOK] Stack: ${error.stack}`);
      return res.status(500).send('Server error');
  }
});

// =================== VIETQR PAYMENT INTEGRATION ===================

app.post('/checkout/vietqr', checkAuthenticated, csrfProtection, async (req, res, next) => {
  try {
    const paymentConfig = res.locals.paymentConfig;
    if (!paymentConfig.vietqr || !paymentConfig.vietqr.enabled) {
      return res.status(400).send('VietQR is not enabled');
    }

    let user = await userModel.findOne({ discordID: req.user.id })
      .populate('cart')
      .populate({
        path: 'cartBundles.bundleId',
        populate: { path: 'products' }
      });

    if (!user && mongoose.Types.ObjectId.isValid(req.user.id)) {
      user = await userModel.findById(req.user.id)
        .populate('cart')
        .populate({
          path: 'cartBundles.bundleId',
          populate: { path: 'products' }
        });
    }
    
    if (!user || (!user.cart.length && (!user.cartBundles || !user.cartBundles.length))) {
      return res.status(400).send('Cart is empty');
    }

    const ipAddress = req.headers['x-forwarded-for'] || req.headers['x-real-ip'] || req.ip || req.connection.remoteAddress;
    const userAgent = req.headers['user-agent'];

    const currentDate = new Date();
    let subtotal = 0;
    const cartSnapshotItems = [];
    const cartSnapshotBundles = [];
    let discountPercentage = 0;

    if (req.session.discountCode) {
      const discountCode = await DiscountCodeModel.findOne({
        name: { $regex: new RegExp(`^${req.session.discountCode}$`, 'i') }
      });

      if (discountCode) {
        discountPercentage = discountCode.discountPercentage;
      }
    }

    // Process cart items
    for (const cartItem of user.cart) {
      const product = await productModel.findById(cartItem._id);
      if (!product) continue;

      const isOnSale = product.onSale && product.saleStartDate <= currentDate && currentDate <= product.saleEndDate;
      const validPrice = isOnSale ? product.salePrice : product.price;

      subtotal += validPrice;

      cartSnapshotItems.push({
        productId: product._id,
        price: product.price,
        salePrice: isOnSale ? product.salePrice : null,
        discountedPrice: validPrice,
      });
    }

    // Process bundles
    for (const bundleItem of user.cartBundles || []) {
      const bundle = bundleItem.bundleId;
      
      if (!bundle || !bundle.active) {
        continue;
      }

      let bundleOriginalPrice = 0;
      const bundleProducts = [];

      for (const product of bundle.products) {
        const isOnSale = product.onSale && product.saleStartDate <= currentDate && currentDate <= product.saleEndDate;
        const salePrice = isOnSale ? product.salePrice : null;
        const basePrice = isOnSale ? product.salePrice : product.price;

        bundleOriginalPrice += basePrice;

        bundleProducts.push({
          productId: product._id,
          price: product.price,
          salePrice: salePrice || null,
          discountedPrice: basePrice,
        });
      }

      const bundlePrice = parseFloat((bundleOriginalPrice * (1 - bundle.discountPercentage / 100)).toFixed(2));
      const bundleDiscountMultiplier = bundlePrice / bundleOriginalPrice;

      bundleProducts.forEach(bp => {
        bp.discountedPrice = parseFloat((bp.discountedPrice * bundleDiscountMultiplier).toFixed(2));
      });

      subtotal += bundlePrice;

      cartSnapshotBundles.push({
        bundleId: bundle._id,
        bundleName: bundle.name,
        discountPercentage: bundle.discountPercentage,
        originalPrice: bundleOriginalPrice,
        bundlePrice: bundlePrice,
        products: bundleProducts
      });
    }

    const discountAmount = subtotal * (discountPercentage / 100);
    const discountedSubtotal = subtotal - discountAmount;

    let salesTaxAmount = 0;
    if (globalSettings.salesTax) {
      salesTaxAmount = parseFloat((discountedSubtotal * (globalSettings.salesTax / 100)).toFixed(2));
    }

    const totalPrice = parseFloat((discountedSubtotal + salesTaxAmount).toFixed(2));

    const cartSnapshot = await CartSnapshot.create({
      userId: user._id,
      items: cartSnapshotItems,
      bundles: cartSnapshotBundles,
      total: totalPrice,
      ipAddress: ipAddress,
      userAgent: userAgent,
    });

    // Generate VietQR code
    const transferData = {
      bankCode: paymentConfig.vietqr.bankCode,
      accountNumber: paymentConfig.vietqr.accountNumber,
      accountName: paymentConfig.vietqr.accountName,
      amount: totalPrice,
      description: `${globalSettings.storeName} - Payment ${cartSnapshot._id.toString().substring(0, 8)}`,
      transactionId: cartSnapshot._id.toString()
    };

    const qrResult = await vietqr.generateVietQRCode(transferData);

    if (!qrResult.success) {
      return res.status(500).render('error', {
        errorMessage: 'Failed to generate QR code. Please try again later.'
      });
    }

    // Render VietQR payment page
    res.render('checkout-vietqr', {
      user: req.user,
      existingUser: await findUserById(req.user.id),
      qrCode: qrResult.qrUrl,
      cartSnapshot,
      totalPrice: totalPrice.toFixed(2),
      storeName: globalSettings.storeName,
      transferData: vietqr.formatPaymentInfo(transferData),
      config: config
    });

  } catch (error) {
    console.error('[ERROR] VietQR checkout failed:', error.message);
    next(error);
  }
});

app.get('/checkout/vietqr/verify/:snapshotId', checkAuthenticated, async (req, res, next) => {
  try {
    const { snapshotId } = req.params;
    
    const cartSnapshot = await CartSnapshot.findById(snapshotId);
    if (!cartSnapshot) {
      return res.json({ success: false, message: 'Payment not found' });
    }

    if (cartSnapshot.status === 'processed') {
      const payment = await paymentModel.findOne({ userId: cartSnapshot.userId }).sort({ createdAt: -1 });
      return res.json({ 
        success: true, 
        message: 'Payment completed', 
        transactionId: payment ? payment.transactionID : null
      });
    }

    return res.json({ 
      success: false, 
      message: 'Waiting for payment confirmation',
      status: cartSnapshot.status
    });

  } catch (error) {
    console.error('Error verifying VietQR payment:', error);
    res.json({ success: false, message: 'Verification failed' });
  }
});

app.post('/checkout/vietqr/webhook', express.json(), async (req, res) => {
  try {
    const { snapshotId, status } = req.body;
    
    if (status === 'success' || status === 'completed') {
      const cartSnapshot = await CartSnapshot.findById(snapshotId);
      if (!cartSnapshot) {
        return res.json({ success: false });
      }

      cartSnapshot.status = 'processed';
      cartSnapshot.processedAt = new Date();
      await cartSnapshot.save();
    }

    res.json({ success: true });
  } catch (error) {
    console.error('[VietQR Webhook] Error:', error.message);
    res.status(500).json({ success: false });
  }
});

app.get('/download-history/:userId', checkAuthenticated, checkStaffAccess('owner'), async (req, res, next) => {
  try {
    const userId = req.params.userId;
    const page = parseInt(req.query.page) || 1;
    const limit = 10; 
    const skip = (page - 1) * limit;
    
    function formatFileSize(bytes) {
      if (!bytes || isNaN(bytes)) return 'Unknown';
      
      const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
      if (bytes === 0) return '0 Byte';
      const i = parseInt(Math.floor(Math.log(bytes) / Math.log(1024)));
      return Math.round(bytes / Math.pow(1024, i), 2) + ' ' + sizes[i];
    }
    
    function formatTime(milliseconds) {
      if (!milliseconds || isNaN(milliseconds)) return 'Unknown';
      
      if (milliseconds < 1000) {
        return `${milliseconds}ms`;
      } else if (milliseconds < 60000) {
        return `${(milliseconds / 1000).toFixed(2)}s`;
      } else {
        const minutes = Math.floor(milliseconds / 60000);
        const seconds = ((milliseconds % 60000) / 1000).toFixed(0);
        return `${minutes}m ${seconds}s`;
      }
    }

    const selectedProduct = req.query.product || '';
    const selectedStatus = req.query.status || '';
    const dateFrom = req.query.dateFrom || '';
    const dateTo = req.query.dateTo || '';
    
const userInfo = await findUserById(userId);
if (!userInfo) {
  return res.redirect('/');
}

let fullUser = null;
let displayName = userInfo.username || userInfo.email || 'User';

if (userInfo.discordID) {
  try {
    fullUser = await client.users.fetch(userInfo.discordID, { force: true });
    displayName = fullUser.username;
  } catch (err) {
    console.log('Could not fetch Discord user, using stored username');
  }
}
    
    
let baseFilter = { 
  $or: [
    { discordUserId: userId },
    { discordUserId: userInfo.discordID },
    { userId: userInfo._id }
  ]
};

const filter = { $and: [baseFilter] };

if (selectedProduct) {
  filter.$and.push({ productId: new mongoose.Types.ObjectId(selectedProduct) });
}

if (selectedStatus === 'completed') {
  filter.$and.push({ downloadCompleted: true });
} else if (selectedStatus === 'failed') {
  filter.$and.push({ downloadCompleted: false });
}

if (dateFrom) {
  filter.$and.push({ downloadDate: { $gte: new Date(dateFrom) } });
}

if (dateTo) {
  const toDate = new Date(dateTo);
  toDate.setHours(23, 59, 59, 999);
  filter.$and.push({ downloadDate: { $lte: toDate } });
}
    
    
    const totalItems = await downloadsModel.countDocuments(filter);
    const totalPages = Math.ceil(totalItems / limit);
    
    
    const downloads = await downloadsModel.find(filter)
      .sort({ downloadDate: -1 })
      .skip(skip)
      .limit(limit)
      .lean();
    
    
    const productList = await productModel.find().select('_id name').lean();
    
    
    let paginationUrl = `/download-history/${userId}?`;
    if (selectedProduct) paginationUrl += `product=${selectedProduct}&`;
    if (selectedStatus) paginationUrl += `status=${selectedStatus}&`;
    if (dateFrom) paginationUrl += `dateFrom=${dateFrom}&`;
    if (dateTo) paginationUrl += `dateTo=${dateTo}&`;
    
    
    res.render('download-history', {
      userInfo,
      fullUser,
      downloads,
      productList,
      selectedProduct,
      selectedStatus,
      dateFrom,
      dateTo,
      displayName,
      currentPage: page,
      totalPages,
      totalItems,
      paginationUrl,
      formatFileSize,
      formatTime,
      user: req.user,
      existingUser: req.user
    });
  } catch (error) {
    console.error('Error fetching download history:', error);
    next(error);
  }
});

app.get('/profile', checkAuthenticated, (req, res) => {
  if (!req.user) return res.redirect('/login');
  
  
  return res.redirect(`/profile/${req.user.id}`);
});

app.get('/profile/:userId', async (req, res, next) => {
  try {
    const userId = req.params.userId;
    const isAuthenticated = req.isAuthenticated && req.isAuthenticated();
    const currentUserId = isAuthenticated ? getUserIdentifier(req.user) : null;
    const isOwner = isAuthenticated && req.isOwner();
    const isOwnProfile = isAuthenticated && currentUserId === userId;

    let existingUser = null;
    let staffPermissions = null;
    
    if (req.user) {
      existingUser = await findUserById(req.user.id);
      staffPermissions = await req.getStaffPermissions();
    }

    const hasProfileAccess = isOwner || (staffPermissions && (
      staffPermissions.canAddProducts ||
      staffPermissions.canRemoveProducts ||
      staffPermissions.canViewInvoices
    ));

    const user = await findUserById(userId);
    
    if (!user) return res.redirect('/');
    
    let fullUser = null;
    if (user.discordID) {
      try {
        fullUser = await client.users.fetch(user.discordID, { force: true });
      } catch (error) {
        console.log('Could not fetch Discord user:', error.message);
      }
    }

    if (!isOwnProfile && !hasProfileAccess) {
      return res.render('profile', {
        userInfo: user,
        fullUser,
        ownedProducts: [],
        existingUser: isAuthenticated ? await findUserById(currentUserId) : null,
        user: req.user || null,
        products: [],
        serialProducts: [],
        invoices: [],
        isOwner: false,
        staffPermissions: null,
        isBanned: user.banned || false,
        isPublicView: true
      });
    }

    const [ownedProducts, allProducts, invoices] = await Promise.all([
      productModel.find({ _id: { $in: user.ownedProducts } }).lean(),
      productModel.find({}).lean(),
      (isOwnProfile || isOwner || (staffPermissions && staffPermissions.canViewInvoices))
        ? paymentModel.find({ 
            $or: [
              { userID: user.discordID },
              { userID: user._id.toString() }
            ]
          }).sort({ createdAt: -1 }).lean()
        : []
    ]);

    const serialProducts = allProducts
      .filter(p => p.productType === 'serials')
      .map(p => ({
        ...p,
        stockCount: (p.serials || []).length
      }));

    const products = allProducts.filter(p => 
      !user.ownedProducts.includes(p._id) && 
      p.productType !== "digitalFree" &&
      (p.productType !== "serials" || p.serialRequiresFile)
    );

    const renderedOwnedProducts = ownedProducts.map(product => {
      if (product.productType === 'service' && product.serviceMessage) {
        product.renderedServiceMessage = md.render(product.serviceMessage);
      } else {
        product.renderedServiceMessage = '';
      }
      return product;
    });

let effectivePermissions = null;

if (isOwnProfile) {
  effectivePermissions = {
    canAddProducts: isOwner,
    canRemoveProducts: isOwner,
    canViewInvoices: true,
    canBanUser: false,
    canTransferProducts: false,
    canViewDownloadHistory: false
  };
} else if (isOwner || (staffPermissions && staffPermissions.isStaff)) {
  effectivePermissions = {
    canAddProducts: isOwner || (staffPermissions && staffPermissions.canAddProducts),
    canRemoveProducts: isOwner || (staffPermissions && staffPermissions.canRemoveProducts),
    canViewInvoices: isOwner || (staffPermissions && staffPermissions.canViewInvoices),
    canBanUser: isOwner,
    canTransferProducts: isOwner,
    canViewDownloadHistory: isOwner
  };
}

    res.render('profile', {
      userInfo: user,
      fullUser,
      ownedProducts: renderedOwnedProducts,
      existingUser,
      user: req.user,
      products: products,
      serialProducts: serialProducts,
      invoices: invoices,
      isOwner: isOwner,
      staffPermissions: effectivePermissions,
      isBanned: user.banned || false,
      isPublicView: false
    });
  } catch (error) {
    console.error('Error fetching user profile:', error);
    next(error);
  }
});

app.post('/profile/:userId/transfer', checkAuthenticated, checkStaffAccess('owner'), async (req, res) => {
  try {
    const sourceUserId = req.params.userId;
    const targetUserId = req.body.targetUserId;
    
    if (!sourceUserId || !targetUserId) {
      return res.status(400).json({ 
        success: false, 
        message: 'Source and target user IDs are required' 
      });
    }

    const sourceUser = await findUserById(sourceUserId);
    if (!sourceUser) {
      return res.status(404).json({ 
        success: false, 
        message: 'Source user not found' 
      });
    }
    
    const targetUser = await findUserById(targetUserId);
    if (!targetUser) {
      return res.status(404).json({ 
        success: false, 
        message: 'Target user does not exist in the database. They must log in at least once before products can be transferred.' 
      });
    }
    
    if (sourceUser._id.toString() === targetUser._id.toString()) {
      return res.status(400).json({ 
        success: false, 
        message: 'Cannot transfer products to the same user' 
      });
    }
    
    let transferredProducts = 0;
    let transferredSerials = 0;
    
    if (sourceUser.ownedProducts && sourceUser.ownedProducts.length > 0) {
      const newProducts = sourceUser.ownedProducts.filter(
        productId => !targetUser.ownedProducts.some(
          ownedProductId => ownedProductId.toString() === productId.toString()
        )
      );
      
      transferredProducts = newProducts.length;
      targetUser.ownedProducts = [...targetUser.ownedProducts, ...newProducts];
    }
    
    if (sourceUser.ownedSerials && sourceUser.ownedSerials.length > 0) {
      transferredSerials = sourceUser.ownedSerials.length;
      targetUser.ownedSerials = [...targetUser.ownedSerials, ...sourceUser.ownedSerials];
    }
    
    await targetUser.save();
    
    sourceUser.ownedProducts = [];
    sourceUser.ownedSerials = [];
    await sourceUser.save();
    
    const sourceIdentifier = sourceUser.discordUsername || sourceUser.username || sourceUser.email;
    const targetIdentifier = targetUser.discordUsername || targetUser.username || targetUser.email;
    
    console.log(`Admin ${req.user.id} transferred ${transferredProducts} products and ${transferredSerials} serials from ${sourceIdentifier} (${sourceUser.getIdentifier()}) to ${targetIdentifier} (${targetUser.getIdentifier()})`);
    
    utils.sendDiscordLog('Products Transferred', `[${getUserDisplayName(req.user)}](${config.baseURL}/profile/${getUserIdentifier(req.user)}) has transferred ${transferredProducts} product(s) and ${transferredSerials} serial(s) from \`${sourceIdentifier}\` to \`${targetIdentifier}\``);
    
    return res.status(200).json({ 
      success: true, 
      message: `Successfully transferred ${transferredProducts} product(s) and ${transferredSerials} serial(s) to ${targetIdentifier}`,
      redirect: `/profile/${sourceUserId}`
    });
    
  } catch (error) {
    console.error('Error transferring products:', error);
    return res.status(500).json({ 
      success: false, 
      message: 'An error occurred during the transfer' 
    });
  }
});

app.get('/invoice/:transactionId', checkAuthenticated, async (req, res, next) => {
  try {
    const { transactionId } = req.params;
    
    const payment = await paymentModel.findOne({ transactionID: transactionId });
    
    if (!payment) {
      return res.status(404).render('error', { 
        errorMessage: 'Invoice not found.' 
      });
    }
    
    const staffPermissions = await req.getStaffPermissions();
    const canViewInvoice = payment.userID === req.user.id || 
                          req.isOwner() || 
                          (staffPermissions && staffPermissions.canViewInvoices);
    
    if (!canViewInvoice) {
      return res.status(403).render('error', { 
        errorMessage: 'You do not have permission to access this invoice.' 
      });
    }
    
    const existingUser = await findUserById(req.user.id);
    
    res.render('invoice-detail', {
      user: req.user,
      existingUser,
      payment,
      settings: await settingsModel.findOne()
    });
  } catch (error) {
    console.error('Error displaying invoice details:', error);
    next(error);
  }
});

app.get('/invoice/:transactionId/view', checkAuthenticated, async (req, res, next) => {
  try {
    const { transactionId } = req.params;
    
    const payment = await paymentModel.findOne({ transactionID: transactionId });
    
    if (!payment) {
      return res.status(404).render('error', { 
        errorMessage: 'Invoice not found.' 
      });
    }
    
    const staffPermissions = await req.getStaffPermissions();
    const canViewInvoice = payment.userID === req.user.id || 
                          req.isOwner() || 
                          (staffPermissions && staffPermissions.canViewInvoices);
    
    if (!canViewInvoice) {
      return res.status(403).render('error', { 
        errorMessage: 'You do not have permission to access this invoice.' 
      });
    }

    if (payment.invoicePath && fs.existsSync(path.join(__dirname, payment.invoicePath))) {
      res.setHeader('Content-Type', 'application/pdf');
      return res.sendFile(path.join(__dirname, payment.invoicePath));
    }
    
    return res.status(404).render('error', {
      errorMessage: 'Invoice not found. Please contact support.'
    });
    
  } catch (error) {
    console.error('Error viewing invoice:', error);
    next(error);
  }
});

app.get('/invoice/:transactionId/download', checkAuthenticated, async (req, res, next) => {
  try {
    const { transactionId } = req.params;
    
    const payment = await paymentModel.findOne({ transactionID: transactionId });
    
    if (!payment) {
      return res.status(404).render('error', { 
        errorMessage: 'Invoice not found.' 
      });
    }
    
    const staffPermissions = await req.getStaffPermissions();
    const canViewInvoice = payment.userID === req.user.id || 
                          req.isOwner() || 
                          (staffPermissions && staffPermissions.canViewInvoices);
    
    if (!canViewInvoice) {
      return res.status(403).render('error', { 
        errorMessage: 'You do not have permission to access this invoice.' 
      });
    }

    if (payment.invoicePath && fs.existsSync(path.join(__dirname, payment.invoicePath))) {
      return res.download(path.join(__dirname, payment.invoicePath), `invoice-${payment.ID}.pdf`);
    }
    
    return res.status(404).render('error', {
      errorMessage: 'Invoice not found. Please contact support.'
    });
    
  } catch (error) {
    console.error('Error downloading invoice:', error);
    next(error);
  }
});

app.post('/profile/:userId/delete/:productId', checkAuthenticated, csrfProtection, async (req, res, next) => {
  try {
    const { userId, productId } = req.params;
    
    const staffPermissions = await req.getStaffPermissions();
    const canRemoveProducts = req.isOwner() || (staffPermissions && staffPermissions.canRemoveProducts);
    
    if (!canRemoveProducts) {
      return res.status(403).send('Access Denied: You do not have permission to remove products from users');
    }

    let user = await userModel.findOne({ discordID: userId });
    if (!user) {
      user = await userModel.findById(userId);
    }
    if (!user) return res.status(404).send('User not found');

    const product = await productModel.findById(productId);
    if (!product) return res.status(404).render('error', { errorMessage: 'The requested product could not be found. Please check the URL or browse available products.' });

    user.ownedProducts = user.ownedProducts.filter(p => p && p.toString() !== productId);
    await user.save();

    if (user.discordID && (user.authMethod === 'discord' || user.authMethod === 'both')) {
      const guild = await client.guilds.fetch(config.GuildID);
      if (guild) {
        try {
          const guildMember = await guild.members.fetch(user.discordID);
          
          if (guildMember && product.discordRoleIds && product.discordRoleIds.length > 0) {
            for (const roleId of product.discordRoleIds) {
              const role = guild.roles.cache.get(roleId);
              if (role) {
                await guildMember.roles.remove(role);
              } else {
                if(config.DebugMode) console.warn(`Role ID ${roleId} does not exist in the guild.`);
              }
            }
          }
        } catch (error) {
          if(config.DebugMode) console.error(`Failed to remove Discord roles: ${error.message}`);
        }
      }
    }

    let targetUserDisplayName;
    let targetUserProfileId;
    
    if (user.discordID) {
      try {
        const discordUser = await client.users.fetch(user.discordID);
        targetUserDisplayName = discordUser.username;
      } catch (error) {
        targetUserDisplayName = user.discordUsername || user.username || user.email?.split('@')[0] || 'Unknown User';
      }
      targetUserProfileId = user.discordID;
    } else {
      targetUserDisplayName = user.username || user.email?.split('@')[0] || 'Unknown User';
      targetUserProfileId = user._id.toString();
    }

    utils.sendDiscordLog('Product Removed from User',`[${getUserDisplayName(req.user)}](${config.baseURL}/profile/${getUserIdentifier(req.user)}) has removed the product \`${product.name}\` from [${targetUserDisplayName}](${config.baseURL}/profile/${targetUserProfileId})'s owned products.`);

    res.redirect(`/profile/${userId}`);
  } catch (error) {
    console.error('Error deleting product from user:', error);
    next(error);
  }
});

app.post('/profile/:userId/add-product', checkAuthenticated, csrfProtection, async (req, res, next) => {
  try {
    const { userId } = req.params;
    const { productId } = req.body;
    
    const staffPermissions = await req.getStaffPermissions();
    const canAddProducts = req.isOwner() || (staffPermissions && staffPermissions.canAddProducts);
    
    if (!canAddProducts) {
      return res.status(403).send('Access Denied: You do not have permission to add products to users');
    }

    let user = await userModel.findOne({ discordID: userId });
    if (!user) {
      user = await userModel.findById(userId);
    }
    if (!user) return res.status(404).send('User not found');

    const product = await productModel.findById(productId);
    if (!product) return res.status(404).render('error', { errorMessage: 'The requested product could not be found. Please check the URL or browse available products.' });

    if (!user.ownedProducts.includes(productId)) {
      user.ownedProducts.push(productId);

      if (user.discordID && (user.authMethod === 'discord' || user.authMethod === 'both')) {
        const guild = await client.guilds.fetch(config.GuildID);
        if (guild) {
          try {
            const guildMember = await guild.members.fetch(user.discordID);
            
            if (guildMember && product.discordRoleIds && product.discordRoleIds.length > 0) {
              for (const roleId of product.discordRoleIds) {
                const role = guild.roles.cache.get(roleId);
                if (role) {
                  await guildMember.roles.add(role);
                } else {
                  if(config.DebugMode) console.warn(`Role ID ${roleId} does not exist in the guild.`);
                }
              }
            }
          } catch (error) {
            if(config.DebugMode) console.error(`Failed to add Discord roles: ${error.message}`);
          }
        }
      }

      await user.save();

      let targetUserDisplayName;
      let targetUserProfileId;
      
      if (user.discordID) {
        try {
          const discordUser = await client.users.fetch(user.discordID);
          targetUserDisplayName = discordUser.username;
        } catch (error) {
          targetUserDisplayName = user.discordUsername || user.username || user.email?.split('@')[0] || 'Unknown User';
        }
        targetUserProfileId = user.discordID;
      } else {
        targetUserDisplayName = user.username || user.email?.split('@')[0] || 'Unknown User';
        targetUserProfileId = user._id.toString();
      }

      utils.sendDiscordLog('Product Added to User',`[${getUserDisplayName(req.user)}](${config.baseURL}/profile/${getUserIdentifier(req.user)}) has added the product \`${product.name}\` to [${targetUserDisplayName}](${config.baseURL}/profile/${targetUserProfileId})'s owned products.`);
    }

    res.redirect(`/profile/${userId}`);
  } catch (error) {
    console.error('Error adding product to user:', error);
    next(error);
  }
});

app.post('/profile/:userId/add-serial', checkAuthenticated, csrfProtection, async (req, res, next) => {
  try {
    const { userId } = req.params;
    const { productId } = req.body;
    
    const staffPermissions = await req.getStaffPermissions();
    const canAddProducts = req.isOwner() || (staffPermissions && staffPermissions.canAddProducts);
    
    if (!canAddProducts) {
      return res.status(403).send('Access Denied: You do not have permission to add serials to users');
    }

    let user = await userModel.findOne({ discordID: userId });
    if (!user) {
      user = await userModel.findById(userId);
    }
    if (!user) return res.status(404).send('User not found');

    const product = await productModel.findById(productId);
    if (!product) return res.status(404).render('error', { 
      errorMessage: 'The requested product could not be found. Please check the URL or browse available products.' 
    });

    if (!product.serials || product.serials.length === 0) {
      return res.status(400).render('error', { 
        errorMessage: 'This product has no available serial keys.' 
      });
    }

    const randomIndex = Math.floor(Math.random() * product.serials.length);
    const serialKey = product.serials[randomIndex];

    product.serials.splice(randomIndex, 1);
    await product.save();

    if (!user.ownedProducts.includes(productId)) user.ownedProducts.push(productId);

    user.ownedSerials = user.ownedSerials || [];
    user.ownedSerials.push({
      productId: product._id,
      productName: product.name,
      key: serialKey.key,
      purchaseDate: new Date()
    });

    if (user.discordID && (user.authMethod === 'discord' || user.authMethod === 'both')) {
      const guild = await client.guilds.fetch(config.GuildID);
      if (guild) {
        try {
          const guildMember = await guild.members.fetch(user.discordID);
          
          if (guildMember && product.discordRoleIds && product.discordRoleIds.length > 0) {
            for (const roleId of product.discordRoleIds) {
              const role = guild.roles.cache.get(roleId);
              if (role) {
                await guildMember.roles.add(role);
              } else {
                if(config.DebugMode) console.warn(`Role ID ${roleId} does not exist in the guild.`);
              }
            }
          }
        } catch (error) {
          if(config.DebugMode) console.error(`Failed to add Discord roles: ${error.message}`);
        }
      }
    }

    await user.save();

    let targetUserDisplayName;
    let targetUserProfileId;
    
    if (user.discordID) {
      try {
        const discordUser = await client.users.fetch(user.discordID);
        targetUserDisplayName = discordUser.username;
      } catch (error) {
        targetUserDisplayName = user.discordUsername || user.username || user.email?.split('@')[0] || 'Unknown User';
      }
      targetUserProfileId = user.discordID;
    } else {
      targetUserDisplayName = user.username || user.email?.split('@')[0] || 'Unknown User';
      targetUserProfileId = user._id.toString();
    }

    utils.sendDiscordLog(
      'Serial Key Added to User',
      `[${getUserDisplayName(req.user)}](${config.baseURL}/profile/${getUserIdentifier(req.user)}) has given a serial key for \`${product.name}\` to [${targetUserDisplayName}](${config.baseURL}/profile/${targetUserProfileId}).`
    );

    res.redirect(`/profile/${userId}#serials`);
  } catch (error) {
    console.error('Error adding serial to user:', error);
    next(error);
  }
});

app.post('/profile/:userId/ban', checkAuthenticated, checkStaffAccess('owner'), async (req, res, next) => {
  try {
      const userId = req.params.userId;

      const user = await findUserById(userId);
      if (!user) return res.status(404).render('error', { errorMessage: 'User not found' });

      let displayUsername = user.username || user.discordUsername || user.email?.split('@')[0] || 'Unknown User';
      
      if (user.discordID) {
        try {
          const discordUser = await client.users.fetch(user.discordID);
          displayUsername = discordUser.username;
        } catch (err) {
          console.log('Could not fetch Discord user, using stored username');
        }
      }

      user.banned = !user.banned;
      await user.save();

      const actionText = user.banned ? 'banned' : 'unbanned';
      
      const targetUserProfileId = user.discordID || user._id.toString();
      
      utils.sendDiscordLog(
        `User ${user.banned ? 'Banned' : 'Unbanned'}`, 
        `[${getUserDisplayName(req.user)}](${config.baseURL}/profile/${getUserIdentifier(req.user)}) ${actionText} [${displayUsername}](${config.baseURL}/profile/${targetUserProfileId})`
      );

      res.redirect(`/profile/${userId}`);
  } catch (error) {
      console.error('Error toggling ban status:', error);
      next(error);
  }
});


app.get('/reviews', async (req, res, next) => {
  try {
    const perPage = 9; 
    const page = parseInt(req.query.page) || 1;

    let products = [];
    let existingUser = null;
    let reviews, totalReviews, allReviews;

    if (req.user) {
      existingUser = await findUserById(req.user.id);
      
      if (existingUser) {
        products = await productModel.find({ _id: { $in: existingUser.ownedProducts } });
        
        const freeProducts = await productModel.find({ productType: 'digitalFree' });
        products = [...products, ...freeProducts];

        const userReviews = await reviewModel.find({ userId: existingUser._id });
        const reviewedProductIds = userReviews.map(review => review.product.toString());
        products = products.filter(product => !reviewedProductIds.includes(product._id.toString()));
      }
      
      totalReviews = await reviewModel.countDocuments();
      reviews = await reviewModel
        .find()
        .sort({ createdAt: -1 })
        .skip((page - 1) * perPage)
        .limit(perPage);
      
      allReviews = await reviewModel.find();
    } else {
      const cacheKey = `reviews_page_${page}`;
      const cachedData = cache.get(cacheKey);
      
      if (cachedData) {
        reviews = cachedData.reviews;
        totalReviews = cachedData.totalReviews;
        allReviews = cachedData.allReviews;
      } else {
        totalReviews = await reviewModel.countDocuments();
        reviews = await reviewModel
          .find()
          .sort({ createdAt: -1 })
          .skip((page - 1) * perPage)
          .limit(perPage);
        
        allReviews = await reviewModel.find();
        
        cache.set(cacheKey, {
          reviews,
          totalReviews,
          allReviews
        }, 30 * 60);
      }
    }

    const reviewsWithDisplayData = await Promise.all(reviews.map(async (review) => {
      const reviewObj = review.toObject ? review.toObject() : review;
      
      if (reviewObj.discordID) {
        const cachedDiscordUser = cache.get(`discordUser_${reviewObj.discordID}`);
        
        if (cachedDiscordUser) {
          return {
            ...reviewObj,
            displayUsername: cachedDiscordUser.username,
            displayAvatar: cachedDiscordUser.avatar
          };
        }
        
        try {
          const discordUser = await client.users.fetch(reviewObj.discordID);
          const discordUserData = {
            username: discordUser.username,
            avatar: discordUser.displayAvatarURL({ dynamic: true })
          };
          
          cache.set(`discordUser_${reviewObj.discordID}`, discordUserData);
          
          return {
            ...reviewObj,
            displayUsername: discordUserData.username,
            displayAvatar: discordUserData.avatar
          };
        } catch (error) {
          return {
            ...reviewObj,
            displayUsername: reviewObj.discordUsername || reviewObj.username || 'Unknown User',
            displayAvatar: reviewObj.avatarPath || '/images/default-avatar.png'
          };
        }
      } 
      else {
        return {
          ...reviewObj,
          displayUsername: reviewObj.username || 'Unknown User',
          displayAvatar: reviewObj.avatarPath || '/images/default-avatar.png'
        };
      }
    }));

    const totalPages = Math.ceil(totalReviews / perPage);

    const totalReviews2 = allReviews.length;
    const averageRating = totalReviews2 > 0 
      ? (allReviews.reduce((sum, review) => sum + review.rating, 0) / totalReviews2).toFixed(1)
      : 0;

    res.render('reviews', {
      user: req.user,
      reviews: reviewsWithDisplayData,
      products,
      existingUser,
      currentPage: page,
      totalPages,
      stats: {
        averageRating,
        totalReviews
      }
    });
  } catch (error) {
    console.error('Error fetching reviews:', error);
    next(error);
  }
});

app.post('/reviews', checkAuthenticated, csrfProtection, async (req, res, next) => {
  try {
    const { productId, rating, comment } = req.body;

    const product = await productModel.findById(productId);
    if (!product) return res.status(404).send('Product not found.');

    const existingUser = await findUserById(req.user.id);
    if (!existingUser) return res.status(404).send('User not found.');
    const existingReview = await reviewModel.findOne({ 
      userId: existingUser._id,
      product: productId 
    });
    if (existingReview) return res.redirect('/reviews');

    const settings = await settingsModel.findOne();

    let canReview = false;
    if (product.productType === 'digitalFree') {
      canReview = true;
    } else {
      const validOwnedProducts = await productModel.find({ 
        _id: { $in: existingUser.ownedProducts.filter(id => id) }
      }).select('_id');
      const ownsProduct = validOwnedProducts.some(validProduct => 
        validProduct._id.toString() === product._id.toString()
      );
      if (ownsProduct) canReview = true;
    }

    if (!canReview) {
      return res.status(400).send('You can only review products you own or free products.');
    }

    let displayUsername;
    let avatarUrl = null;
    let avatarLocalPath = '/images/default-avatar.png';
    
    if (existingUser.discordID) {
      try {
        const discordUser = await client.users.fetch(existingUser.discordID);
        avatarUrl = discordUser.displayAvatarURL({ format: 'png', size: 256 });
        displayUsername = discordUser.username;
      } catch (error) {
        console.log('Could not fetch Discord user for review');
        displayUsername = existingUser.discordUsername || existingUser.username;
      }
      
      if (avatarUrl) {
        const avatarFileName = `avatar-${existingUser._id}-${Date.now()}.png`;
        avatarLocalPath = `/uploads/reviews/${avatarFileName}`;
        const fullAvatarPath = path.join(__dirname, 'uploads/reviews', avatarFileName);

        try {
          const response = await axios.get(avatarUrl, { responseType: 'stream' });
          response.data.pipe(fs.createWriteStream(fullAvatarPath));
          await new Promise(resolve => response.data.on('end', resolve));
        } catch (error) {
          console.error('Failed to download avatar:', error);
          avatarLocalPath = '/images/default-avatar.png';
        }
      }
    } else {
      displayUsername = existingUser.username || existingUser.email?.split('@')[0];
      avatarLocalPath = '/images/default-avatar.png';
    }

    const newReview = new reviewModel({
      userId: existingUser._id,
      discordID: existingUser.discordID || null,
      discordUsername: existingUser.discordUsername || null,
      username: existingUser.username || null,
      avatarPath: avatarLocalPath,
      productName: product.name,
      product: productId,
      rating,
      comment
    });

    await newReview.save();

    if (settings.sendReviewsToDiscord && settings.discordReviewChannel) {
      try {
        const reviewChannel = await client.channels.fetch(settings.discordReviewChannel);
        if (reviewChannel) {
          const reviewEmbed = new Discord.EmbedBuilder()
            .setAuthor({ 
              name: displayUsername, 
              iconURL: avatarUrl || undefined 
            })
            .setTitle(product.name)
            .setURL(`${config.baseURL}/products/${product.urlId}`)
            .setColor(settings.accentColor)
            .setDescription(`${comment}\n\n${'⭐'.repeat(rating)}`)

          await reviewChannel.send({ embeds: [reviewEmbed] });
        }
      } catch (error) {
        console.error('Failed to send review to Discord:', error);
      }
    }

    const userProfileId = existingUser.discordID || existingUser._id.toString();
    utils.sendDiscordLog(
      'New Review', 
      `[${displayUsername}](${config.baseURL}/profile/${userProfileId}) has reviewed \`${product.name}\``
    );

    res.redirect('/reviews');
  } catch (error) {
    console.error('Error creating review:', error);
    next(error);
  }
});

app.post('/reviews/:id/delete', checkAuthenticated, csrfProtection, async (req, res, next) => {
  try {
    const reviewId = req.params.id;
    const review = await reviewModel.findById(reviewId);

    if (!review) return res.redirect('/reviews');

    const settings = await settingsModel.findOne();
    const currentUser = await findUserById(req.user.id);

    if (req.isOwner()) {
      await reviewModel.findByIdAndDelete(reviewId);
      return res.redirect('/reviews');
    }

    if (settings.allowReviewDeletion && currentUser && review.userId.toString() === currentUser._id.toString()) {
      await reviewModel.findByIdAndDelete(reviewId);
      return res.redirect('/reviews');
    }

    return res.status(403).send('You are not authorized to delete this review');
  } catch (error) {
    console.error('Error deleting review:', error);
    next(error);
  }
});

app.get('/logout', (req, res, next) => {
  req.logout((err) => {
    if (err) {
      console.error('Error during logout:', err);
      return next(err);
    }
    res.redirect('/');
  });
});


if (config.Redirects && Array.isArray(config.Redirects)) {
  config.Redirects.forEach((redirect) => {
    const { path, target, method = "GET", statusCode = 301 } = redirect;

    
    app[method.toLowerCase()](path, (req, res) => {
      const wildcard = req.params[0] || "";
      const redirectUrl = target.replace(":wildcard", wildcard);

      if(config.DebugMode) console.log(`Redirecting ${req.originalUrl} to ${redirectUrl}`);
      res.redirect(statusCode, redirectUrl);
    });
  });
}


app.get('/error', (req, res) => {
  const errorMessage = "This is a test error message to verify the error page design.";
  res.status(500).render('error', {
      errorMessage,
  });
});

app.use((req, res, next) => {
  res.status(404).render('error', {
      errorMessage: 'Page not found. The page you are looking for might have been removed, had its name changed, or is temporarily unavailable.'
  });
});


app.use(async(err, req, res, next) => {
  console.error(err.stack);

  const products = await productModel.find().sort({ position: 1 });

  const errorPrefix = `[${new Date().toLocaleString()}] [v${packageFile.version}]`;
  const errorMsg = `\n\n${errorPrefix}\n${err.stack}\n\nProducts:\n${products}`;
  fs.appendFile("./logs.txt", errorMsg, (e) => {
    if (e) console.log(e);
  });

  res.status(500).render('error', { errorMessage: 'Something went wrong on our end. Please try again later.' });
});


app.listen(config.Port, async () => {

  console.log("――――――――――――――――――――――――――――――――――――――――――――――――――――――――――――――――――――――――――――");
  console.log("                                                                          ");
  if (config.LicenseKey) console.log(`${color.green.bold.underline(`Plex Store v${packageFile.version} is now Online!`)} (${color.gray(`${config.LicenseKey.slice(0, -10)}`)})`);
  if (!config.LicenseKey) console.log(`${color.green.bold.underline(`Plex Store v${packageFile.version} is now Online! `)}`);
  console.log(`• Join our discord server for support, ${color.cyan(`discord.gg/plexdev`)}`);
  console.log(`• Documentation can be found here, ${color.cyan(`docs.plexdevelopment.net`)}`);
  console.log(`• By using this product you agree to all terms located here, ${color.yellow(`plexdevelopment.net/tos`)}`);
  if (config.LicenseKey) console.log("                                                                          ");
  if (config.LicenseKey) console.log(`${color.green.bold.underline(`Source Code:`)}`);
  if (config.LicenseKey) console.log(`• You can buy the full source code at ${color.yellow(`plexdevelopment.net/products/pstoresourcecode`)}`);
  if (config.LicenseKey) console.log(`• Use code ${color.green.bold.underline(`PLEX`)} for 10% OFF!`);
  console.log("                                                                          ");
  console.log("――――――――――――――――――――――――――――――――――――――――――――――――――――――――――――――――――――――――――――");
  console.log(color.yellow("[DASHBOARD] ") + `Web Server has started and is accessible with port ${color.yellow(`${config.Port}`)}`)
});
