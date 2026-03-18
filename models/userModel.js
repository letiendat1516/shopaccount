const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
  discordID: { type: String, sparse: true },
  discordUsername: { type: String },

  username: { type: String, sparse: true, unique: true },
  email: { type: String, required: true, unique: true },
  password: { type: String },

  authMethod: {
    type: String,
    enum: ['discord', 'local', 'both'],
    required: true,
    default: 'discord'
  },

  emailVerified: { type: Boolean, default: false },
  verificationToken: { type: String },
  verificationTokenExpires: { type: Date },

  resetPasswordToken: { type: String },
  resetPasswordExpires: { type: Date },

  pendingEmail: { type: String, default: null },
  emailChangeToken: { type: String, default: null },
  emailChangeTokenExpires: { type: Date, default: null },

  banned: { type: Boolean, required: true, default: false },
  totalSpent: { type: Number, default: 0.0, required: true },
  joinedAt: { type: Date, default: Date.now },
  cart: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Product' }],
  ownedProducts: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Product' }],
  ownedSerials: [{
    productId: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true },
    productName: { type: String, required: true },
    key: { type: String, required: true },
    purchaseDate: { type: Date, default: Date.now },
  }],
  staffPermissions: {
    isStaff: { type: Boolean, default: false },
    canCreateProducts: { type: Boolean, default: false },
    canUpdateProducts: { type: Boolean, default: false },
    canDeleteProducts: { type: Boolean, default: false },
    canAddProducts: { type: Boolean, default: false },
    canRemoveProducts: { type: Boolean, default: false },
    canViewInvoices: { type: Boolean, default: false },
    canManageDiscounts: { type: Boolean, default: false },
    canManageSales: { type: Boolean, default: false },
    canManageAntiPiracy: { type: Boolean, default: false }
  },
  cartBundles: [{
    bundleId: { type: mongoose.Schema.Types.ObjectId, ref: 'Bundle' },
    addedAt: { type: Date, default: Date.now }
  }]
});

userSchema.methods.getIdentifier = function () {
  return this.discordID || this._id.toString();
};

userSchema.methods.getDisplayName = function () {
  return this.discordUsername || this.username || this.email.split('@')[0];
};

module.exports = mongoose.model('User', userSchema);