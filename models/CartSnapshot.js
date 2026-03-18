const mongoose = require('mongoose');

const CartSnapshotSchema = new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    items: [
        {
            productId: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true },
            price: { type: Number, required: true },
            salePrice: { type: Number },
            discountedPrice: { type: Number, required: true },
            quantity: { type: Number, default: 1 },
        }
    ],
    bundles: [
        {
            bundleId: { type: mongoose.Schema.Types.ObjectId, ref: 'Bundle', required: true },
            bundleName: { type: String, required: true },
            discountPercentage: { type: Number, required: true },
            originalPrice: { type: Number, required: true },
            bundlePrice: { type: Number, required: true },
            products: [
                {
                    productId: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true },
                    price: { type: Number, required: true },
                    salePrice: { type: Number },
                    discountedPrice: { type: Number, required: true },
                }
            ]
        }
    ],
    total: { type: Number, required: true },
    ipAddress: { type: String },
    userAgent: { type: String },
    discountCode: { type: String },
    discountPercentage: { type: Number, default: 0 },
    discountAmount: { type: Number, default: 0 },
    status: { 
        type: String, 
        enum: ['pending', 'processed', 'expired'], 
        default: 'pending' 
    },
    processedAt: { type: Date },
    createdAt: { type: Date, default: Date.now, expires: '1h' },
});

CartSnapshotSchema.index({ status: 1, createdAt: 1 });

module.exports = mongoose.model('CartSnapshot', CartSnapshotSchema);