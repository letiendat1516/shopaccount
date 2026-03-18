const mongoose = require('mongoose');

const productSchema = new mongoose.Schema({
    name: String,
    price: Number,
    salePrice: Number, 
    originalPrice: Number,
});

const downloadProofSchema = new mongoose.Schema({
    downloadId: { type: mongoose.Schema.Types.ObjectId, ref: 'Download' },
    productName: String,
    productId: String,
    versionNumber: String,
    downloadDate: Date,
    ipAddress: String,
    userAgent: String,
    fileSize: Number,
    downloadDuration: Number,
    completed: Boolean
}, { _id: false });

const paymentSchema = new mongoose.Schema({
    ID: { type: Number, required: true, unique: true },
    transactionID: { type: String, required: true },
    paymentMethod: { type: String, required: true },
    userId: { 
        type: mongoose.Schema.Types.ObjectId, 
        ref: 'User',
        required: true
    },
    userID: { 
        type: String, 
        required: true 
    },
    username: { type: String, required: true },
    email: { type: String, required: true },
    discordID: { type: String, sparse: true },
    authMethod: { 
        type: String, 
        enum: ['discord', 'local', 'both'],
        default: 'discord'
    },
    products: [productSchema],
    discountCode: { type: String, default: null },
    discountPercentage: { type: Number, default: 0 },
    salesTax: { type: Number, default: 0 },
    originalSubtotal: { type: Number, required: true },
    salesTaxAmount: { type: Number, required: true },
    discountAmount: { type: Number, required: true },
    totalPaid: { type: Number, required: true },
    invoicePath: { type: String },
    ipAddress: { type: String },
    userAgent: { type: String },
    downloadProof: [downloadProofSchema],
    createdAt: { type: Date, default: Date.now },
});

module.exports = mongoose.model('Payment', paymentSchema);