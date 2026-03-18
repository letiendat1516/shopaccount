const mongoose = require('mongoose');

const bundleSchema = new mongoose.Schema({
    name: { type: String, required: true, trim: true },
    description: { type: String, required: true, trim: true },
    discountPercentage: { type: Number, required: true, min: 1, max: 95 },
    products: [{ 
        type: mongoose.Schema.Types.ObjectId, 
        ref: 'Product',
        required: true 
    }],
    active: { type: Boolean, default: true },
    totalPurchases: { type: Number, default: 0 },
    totalEarned: { type: Number, default: 0.0 },
    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now }
});

bundleSchema.pre('save', function(next) {
    this.updatedAt = Date.now();
    next();
});

bundleSchema.methods.calculateOriginalPrice = async function() {
    await this.populate('products');
    return this.products.reduce((total, product) => {
        if (product.onSale && product.salePrice) {
            return total + product.salePrice;
        }
        return total + product.price;
    }, 0);
};

bundleSchema.methods.calculateBundlePrice = async function() {
    const originalPrice = await this.calculateOriginalPrice();
    return originalPrice * (1 - this.discountPercentage / 100);
};

module.exports = mongoose.model('Bundle', bundleSchema);